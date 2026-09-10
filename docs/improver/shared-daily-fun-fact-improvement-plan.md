# Improvement Plan — Bucketed, non-repeating lunch fun fact per cron run

## Goal
1. The lunch-slot (12:00 WIB) nutrition "fun fact" (`generateMealFact`) is generated **once per
   distinct trimester bucket present among that run's subscribers** — not once per user — while
   still staying trimester-relevant for each user. Buckets: `t1`, `t2`, `t3`, `unknown` (HPHT not
   set) — at most 4 Gemini calls per lunch run instead of one per subscriber.
2. A new table stores every Gemini-generated fun fact (per bucket); generation is told to avoid
   repeating any fact used for that same bucket in the **last 7 days**.
3. Per your answers: **only** the lunch fun fact changes — the morning/dinner/night affirmation-or-
   fact nudge (`generateDailyNudge`) stays exactly as-is, personalized per user, one Gemini call per
   user, untouched. No other personalized feature in the app (Dashboard targets, verdicts,
   gestational-age display, chat, etc.) is touched.
4. (Added mid-session, folded into this same plan) Separate the Gemini **API key** used by the
   interactive chat/transcribe features from the one used by cron notifications/utilities, so a
   quota issue on one doesn't affect the other and each can be monitored/rotated independently.

## Current behavior (see `docs/improver/shared-daily-fun-fact-assessment.md` for full detail)
- `app/api/cron/reminders/route.js:143-211` calls `generateMealFact({ trimester, weeks })`
  **inside** the per-user `Promise.all(userIds.map(...))` loop for `kind === "lunch"` — one Gemini
  call per subscriber, each tailored to that user's own pregnancy stage (`trimester`/`weeks`
  computed per user at lines 144-148 from `profiles.hpht`).
- `lib/gemini.js:824-847` (`generateMealFact`) takes `{trimester, weeks}`, builds a context line
  from it, and asks Gemini (low tier, `generateContent`, non-streaming) for one nutrition fact.
- `lib/reminderLogic.js:156-158` (`pickMealFactFallback`) is the fallback when Gemini fails, seeded
  by `${userId}:${today}:lunch` today — same seed always picks the same static-bank line.
- No table exists anywhere for storing generated facts/nudges; every existing table in
  `supabase/schema.sql` is user-owned with owner RLS. The only service-role (RLS-bypassing) client
  is `lib/supabaseAdmin.js`, used exclusively by this cron route.
- `lib/gemini.js:376-379` (`getApiKeyChain`) returns one API key chain shared by every Gemini call
  site (chat, transcribe, both cron generators) — no tiering, unlike the model chains which already
  split "chat" vs "low" (`getChatModelChain`/`getLowModelChain`).

## Proposed change

### 1) `supabase/schema.sql` — new `meal_fact_history` table, bucketed by trimester
```sql
create table if not exists public.meal_fact_history (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'lunch',
  trimester text check (trimester in ('t1','t2','t3') or trimester is null), -- null = "unknown" bucket
  fact text not null,
  created_at timestamptz not null default now()
);
create index if not exists meal_fact_history_bucket_created_idx on public.meal_fact_history (kind, trimester, created_at desc);

alter table public.meal_fact_history enable row level security;
-- No policies -> RLS default-deny for anon/authenticated roles; only the
-- service-role client (cron route) bypasses RLS, which is the only writer/
-- reader this table ever needs (not a user-owned table -- no user_id).
```
`kind` defaults to (and today only ever holds) `'lunch'` — kept as a column rather than hardcoding a
single-purpose table, so if a future improvement extends the same bucketed-fact treatment to another
slot it's a data-only change, not a new migration. `trimester` is nullable specifically to represent
the "unknown" bucket (a user with no `profiles.hpht` set) as a real, queryable value (`is null`),
not a magic string. This is the one table in the schema with no owner RLS policy, since it holds no
per-user data at all — only aggregate, non-personal generated text.

### 2) `lib/gemini.js` — `generateMealFact` keeps trimester, gains a per-bucket avoid-list
- Signature changes from `generateMealFact({ trimester, weeks })` to
  `generateMealFact({ trimester, avoidFacts } = {})` — `weeks` is dropped (bucketing is by trimester
  only, not exact week, so an exact week number has nothing left to do here); `avoidFacts`: array of
  fact strings already used for this same trimester bucket in the last 7 days.
- `MEAL_FACT_SYSTEM_PROMPT` **keeps** its existing trimester-tailoring clause unchanged (this was
  the part I'd originally proposed dropping — reverted per your correction) and gains one new
  instruction: don't repeat any fact in the given avoid-list.
- The context line keeps the existing trimester clause and appends the avoid-list block after it
  when `avoidFacts` is non-empty (same one-line "extra context" shape `generateDailyNudge` also
  uses, just with one more optional clause).

### 3) `app/api/cron/reminders/route.js` — bucket subscribers, one Gemini call per bucket
- Right alongside the file's existing "compute once per run, not once per user" values (the
  dinner-only `mealUserIds`/`vitaminUserIds`/`limitTotalsByUser`, the morning-only
  `weighedUserIds`), add a lunch-only block that runs **before** the per-user `Promise.all`:
  1. For every `userId`, compute its trimester the same way the per-user loop already does
     (`profiles.hpht` → `computeGestationalAge` → `trimesterForWeeks`), reduced to a bucket key:
     `"t1"|"t2"|"t3"|"unknown"`. (Computed twice overall — once here for bucketing, once more inside
     the per-user loop below for building each user's own message — both cheap, pure, no I/O; this
     avoids restructuring the loop's existing per-kind logic that morning/dinner/night still need
     untouched.)
  2. For each **distinct** bucket present today (≤4), concurrently: query `meal_fact_history` for
     `kind = 'lunch' AND trimester {= bucket | is null} AND created_at >= today - 6 days` (new
     `MEAL_FACT_HISTORY_WINDOW_DAYS = 6` constant, matching the file's existing
     `WEIGHT_NUDGE_WINDOW_DAYS` naming) → `avoidFacts`.
  3. `try { fact = await generateMealFact({ trimester: bucketTrimester, avoidFacts }); }` → insert
     `{ kind: "lunch", trimester: bucketTrimester, fact }` into `meal_fact_history`. Per your answer,
     if the result exactly matches one of `avoidFacts` anyway, **use it and log a warning** — no
     retry, no rejection.
  4. `catch { fact = pickMealFactFallback(`${today}:${bucketKey}`); }` — seed changes from
     `${userId}:${today}:lunch` (per-user) to `${today}:${bucketKey}` (per-bucket, per-run), so a
     Gemini outage still shows the same fallback line to everyone sharing a bucket that run.
     Fallback text is **not** written to `meal_fact_history` (not a Gemini output — recording it
     would pollute future avoid-lists with static-bank text Gemini never said).
  5. Collect results into `mealFactByBucket: Map<bucketKey, fact>`.
- Inside the per-user loop, the lunch branch stops calling Gemini per-user and just looks up its own
  bucket's already-computed fact:
  ```js
  } else { // lunch
    body = buildLunchBody({ name, mealFact: mealFactByBucket.get(trimester || "unknown") });
  }
  ```

### 4) `lib/gemini.js` + README — tier-aware API key chains
Today, `getApiKeyChain()` (`lib/gemini.js:376-379`) returns one key chain
(`GEMINI_API_KEY` + `GEMINI_API_KEY_FALLBACKS`) shared by **every** call site — chat, transcribe,
and both cron generators alike. This mirrors exactly the situation `GEMINI_MODEL` was in before this
repo already split it into `GEMINI_CHAT_MODEL` (chat tier) vs `GEMINI_MODEL` (low tier) — same
precedent, applied to keys instead of models:

- `getApiKeyChain(tier)` becomes tier-aware:
  - `tier === "chat"` **and** `GEMINI_CHAT_API_KEY` is set → use
    `GEMINI_CHAT_API_KEY` + `GEMINI_CHAT_API_KEY_FALLBACKS` (its own independent chain).
  - Otherwise (low/utility tier, or chat tier with no dedicated key configured) → use the existing
    `GEMINI_API_KEY` + `GEMINI_API_KEY_FALLBACKS`, unchanged.
  - This makes the split **entirely opt-in and backward-compatible**: a deployment that only ever
    set `GEMINI_API_KEY` keeps working identically (chat and utilities keep sharing it) — nothing
    breaks until you deliberately add `GEMINI_CHAT_API_KEY`.
- `tryModelChain` (currently calls the untiered `getApiKeyChain()` internally) takes an explicit
  `keyTier` argument instead; its 3 call sites pass it through:
  - `fetchGeminiForChat`'s primary attempt → `"chat"`.
  - `fetchGeminiForChat`'s last-resort drop to the low tier → `"low"` (once you're already using the
    low-tier *model* as a fallback, you use the low-tier *key* too — consistent tier pairing).
  - `fetchGeminiForLowTier` (cron's only path, including the bucketed lunch fact above) → `"low"`.
- `README.md` gets a new block documenting `GEMINI_CHAT_API_KEY`/`GEMINI_CHAT_API_KEY_FALLBACKS`,
  matching the existing `GEMINI_CHAT_MODEL`/`GEMINI_MODEL` explanation's style and placement (section
  5, right after the existing API-key/model env var block).

## Scope

### In scope
- `supabase/schema.sql` — new `meal_fact_history` table (with `trimester` bucket column) + index +
  RLS-enabled/no-policy.
- `lib/gemini.js` — `generateMealFact` signature (`trimester` kept, `weeks` dropped, `avoidFacts`
  added) + `MEAL_FACT_SYSTEM_PROMPT` avoid-list instruction; `getApiKeyChain` becomes tier-aware;
  `tryModelChain`/`fetchGeminiForChat`/`fetchGeminiForLowTier` thread the tier through.
- `app/api/cron/reminders/route.js` — bucket lunch subscribers by trimester; one history-query +
  generate + insert/fallback per distinct bucket, before the per-user `Promise.all`; per-user lunch
  branch looks up its own bucket's shared fact.
- `README.md` — document `GEMINI_CHAT_API_KEY`/`GEMINI_CHAT_API_KEY_FALLBACKS`.
- `lib/gemini.test.js` — new tests for `generateMealFact`'s trimester+avoid-list request-body
  content, and for the tiered API key routing.

### Out of scope / non-goals
- `generateDailyNudge` (morning/dinner/night) — unchanged, stays personalized per-user, one Gemini
  call per user, per your scope answer.
- Any other personalized feature (Dashboard nutrient targets/verdicts, gestational-age display,
  chat) — untouched.
- Retry-on-duplicate logic — explicitly not built, per your dedup answer (accept + log instead).
- No RLS owner policy on `meal_fact_history` — it holds no user data, so there's no owner to scope
  policies to; deliberately the one table in this schema without them.
- No forced key separation — `GEMINI_CHAT_API_KEY` is optional; not setting it keeps today's
  single-shared-key behavior exactly as-is.
- Not bucketing by exact gestational week, only by trimester — matches the granularity
  `trimesterForWeeks` already exposes and keeps the bucket count fixed at 4 regardless of subscriber
  count.

## Steps
1. **`supabase/schema.sql`** — append the `meal_fact_history` table (with `trimester` column) +
   index + RLS (no policies), following the file's existing numbered-comment-header convention.
2. **`lib/gemini.js`** — change `generateMealFact`'s signature (drop `weeks`, add `avoidFacts`) and
   extend `MEAL_FACT_SYSTEM_PROMPT` with the avoid-list instruction (trimester clause unchanged).
3. **`app/api/cron/reminders/route.js`** — add `MEAL_FACT_HISTORY_WINDOW_DAYS`; add the lunch-only
   bucket-and-generate block before the per-user `Promise.all`; simplify the loop's lunch branch to
   look up its own bucket's shared fact.
4. **`lib/gemini.js`** — make `getApiKeyChain` tier-aware; thread `keyTier` through `tryModelChain`,
   `fetchGeminiForChat`, `fetchGeminiForLowTier`.
5. **`README.md`** — document `GEMINI_CHAT_API_KEY`/`GEMINI_CHAT_API_KEY_FALLBACKS`.
6. **`lib/gemini.test.js`** — add request-body content assertions for `generateMealFact`'s
   trimester+avoid-list behavior, and new API-key-tiering tests (dedicated chat key picked up when
   set, utilities/low-tier never uses it, backward-compat fallback to the shared key, and the
   cross-tier-drop case using the low-tier key).

## Data / schema impact
- New table `public.meal_fact_history` (id, kind, trimester, fact, created_at) + one composite
  index. RLS enabled, zero policies (service-role-only access) — the one non-user-owned table in
  this schema.
- No backfill needed — history starts accumulating from the first post-deploy lunch cron run;
  `avoidFacts` is simply empty per bucket until then (`generateMealFact` already handles that case).
- **Manual deploy step required**, same as every prior schema change in this repo (no migration
  runner): run the updated `supabase/schema.sql` in the Supabase SQL editor before this table exists
  in the live database. Until then, each bucket's history query returns an error the code doesn't
  specially handle — degrades gracefully to `avoidFacts = []` (same "best effort, never block the
  send" philosophy the file's existing `fetchDailyLimitTotals`-style reads use elsewhere), and the
  insert attempt fails silently too — so lunch notifications keep working, they just won't dedupe
  until the table exists.

## Risks & mitigations
- **Gemini still repeats a recent fact** for a bucket despite the avoid-list instruction (LLMs don't
  perfectly follow negative constraints) — accepted per your answer; mitigated only by a console
  warning for visibility, not blocked.
- **Schema not yet applied** — degrades gracefully to "no dedup, but lunch notifications still send"
  as described above, never a hard failure.
- **Fallback seed change** (`${userId}:...` → `${today}:${bucketKey}`) means a Gemini outage now
  shows the same fallback line to everyone sharing a trimester bucket that day, not a per-user-varied
  one — this is the explicit goal (shared per bucket), called out here so it's not mistaken for a
  regression.
- **No route-level test coverage** (this repo has none for any route handler, confirmed in the prior
  gemini-chat-flexible run too) — mitigated by `lib/gemini.test.js` covering the actual behavioral
  change (`generateMealFact`'s prompt/request content) plus a production build as a syntax check.
- **API key tiering silently breaks existing single-key deployments** — mitigated by design: the
  fallback path (`GEMINI_CHAT_API_KEY` unset → use `GEMINI_API_KEY`) is unconditional, and the
  existing "composes with the chat tier + cross-tier drop" test in `lib/gemini.test.js` already
  exercises exactly this no-dedicated-key scenario end-to-end, so it doubles as a regression guard
  with no changes needed to that test.
- **Cross-tier drop uses the wrong key** (e.g. still tries the exhausted chat key on the low-tier
  fallback model) — mitigated by explicitly passing `keyTier: "low"` on that specific
  `tryModelChain` call and a dedicated test asserting the fallback request's URL carries the
  low-tier key, not the chat one.

## Test plan
- `lib/gemini.test.js` (automated):
  - `generateMealFact({ trimester: "t2", avoidFacts: [...] })` → request body's
    `contents[0].parts[0].text` contains the trimester-2 context clause AND every avoid-listed fact
    plus an explicit "don't repeat" instruction.
  - `generateMealFact({ trimester: null, avoidFacts: [] })` (unknown bucket, no history yet) →
    context text reflects "trimester unknown" and omits the avoid-list block entirely (not an empty
    one).
  - All existing `generateDailyNudge`-based tests must keep passing unchanged — regression guard
    proving the untouched nudge path wasn't affected by this change.
  - New: with `GEMINI_CHAT_API_KEY` set, `streamNutritionChatTurn`'s request URL carries that key,
    not `GEMINI_API_KEY`.
  - New: with `GEMINI_CHAT_API_KEY` **unset**, `streamNutritionChatTurn` falls back to
    `GEMINI_API_KEY` (backward-compat guard).
  - New: `generateDailyNudge`/`generateMealFact` (low tier) always use `GEMINI_API_KEY` even when
    `GEMINI_CHAT_API_KEY` is set — utilities never pick up the chat-only key.
  - New: when every chat-tier model fails and the call drops to the low tier, the low-tier request
    uses `GEMINI_API_KEY` (or its fallbacks), not `GEMINI_CHAT_API_KEY`, even when a dedicated chat
    key is configured.
  - Existing "API key fallback ... composes with the chat tier + cross-tier drop" test must keep
    passing unchanged (no `GEMINI_CHAT_API_KEY` set in that test → today's shared-key behavior).
- Manual verification (no route-test harness exists in this repo, see Risks):
  - After running the schema SQL, trigger the lunch cron manually with 2+ subscribers in the *same*
    trimester bucket and confirm both get the identical fun fact text; subscribers in a *different*
    bucket get a different (but still trimester-relevant) fact.
  - Confirm one `meal_fact_history` row per distinct bucket was inserted.
  - Trigger it again the next day for the same bucket and confirm that bucket's avoid-list actually
    reaches Gemini and its fact differs from the previous day's when possible.
  - `npm run build` passes with no errors after the code changes.
  - (Optional, your choice whether/when to do this) Create a second free API key at
    https://aistudio.google.com/apikey, set it as `GEMINI_CHAT_API_KEY` in `.env.local`/Vercel, and
    confirm chat keeps working while cron notifications keep using the original `GEMINI_API_KEY`.

## Standards notes
No `$KDOCS` areas touched (no auth/SSO, no WIF/GCP, no Terraform/IaC, no Dockerfile/compose changes).
