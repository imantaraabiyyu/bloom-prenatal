# Assessment — Shared, non-repeating fun fact per cron run

## Request (as given)
1. The "fun fact" shown in push notifications should be the **same for every user** in a given cron
   run, instead of generated per-user — meaning Gemini gets called **once per cron run**, not once
   per user, and that one result is reused for everyone notified in that run.
2. Add a **database table** to store generated fun facts, with a rule that a newly-generated fact
   must not repeat any fact used in the **last 7 days**.

## Current behavior

### Where "facts" are generated (`lib/gemini.js`)
There are actually **two** distinct Gemini-generated strings both fed by cron notifications, and the
request's wording ("fun fact") is ambiguous between them:

- **`generateMealFact({ trimester, weeks })`** (`lib/gemini.js:824-847`) — lunch-slot-only (12:00
  WIB). System prompt (`MEAL_FACT_SYSTEM_PROMPT`, lines 812-822) explicitly asks for a **nutrition
  fact** (protein/iron/calcium/folate/etc.), optionally tailored to trimester/weeks if provided.
  This is the one place in the codebase actually called "a fact" as opposed to a nudge.
- **`generateDailyNudge({ trimester, weeks })`** (`lib/gemini.js:774-798`) — used by morning (07:00),
  dinner (19:00, conditional), and night (21:30) slots. Its system prompt (`NUDGE_SYSTEM_PROMPT`,
  around lines 755-758, not fully re-quoted here) asks for **either** (a) an affirmation/encouragement
  **or** (b) "a light, already-commonly-known pregnancy fact" — so this function *can* also produce
  what a user would call a "fun fact", just less consistently than `generateMealFact`.

### Where they're called (`app/api/cron/reminders/route.js`)
Both are called **inside** the per-user `Promise.all(userIds.map(async (userId) => { ... }))` block
(`route.js:143-211`), each user getting their own Gemini call with their own `{trimester, weeks}`
derived from their own `profiles.hpht` (lines 144-148):
```js
if (kind === "dinner") {
  ...
  try { nudge = await generateDailyNudge({ trimester, weeks }); }
  catch { nudge = pickFallbackNudge(`${userId}:${today}:dinner`); }
  ...
} else if (kind === "morning" || kind === "night") {
  try { nudge = await generateDailyNudge({ trimester, weeks }); }
  catch { nudge = pickFallbackNudge(`${userId}:${today}:${kind}`); }
  ...
} else { // lunch
  try { mealFact = await generateMealFact({ trimester, weeks }); }
  catch { mealFact = pickMealFactFallback(`${userId}:${today}:lunch`); }
  ...
}
```
So today, a run with 50 subscribers makes up to 50 separate Gemini calls (one per user), each
personalized to that user's own pregnancy stage. The dinner slot additionally **skips** a user
entirely (`route.js:157`, no Gemini call at all) when nothing needs nudging for them this run.

### Fallback behavior (`lib/reminderLogic.js`)
Both fallback banks (`FALLBACK_NUDGES`, `MEAL_FACT_FALLBACKS`) are static arrays; `pickFallbackNudge`/
`pickMealFactFallback` deterministically pick one entry via a string-hash of a seed
(`${userId}:${today}:{kind}`, `pickFromBank`, lines 120-127) — same seed always picks the same line,
so a retried cron run or a user with two devices doesn't see two different fallback lines the same
day. This per-user seed will need to become a per-run (not per-user) seed once the fact is shared,
or the fallback path would defeat the "same for everyone" goal on the one day Gemini is down.

### No existing table for this
`supabase/schema.sql` has no table for storing generated nudges/facts — every existing table is
**user-owned** with an `auth.uid() = user_id` RLS policy (see the RLS section, lines 215-298
pre-this-run's earlier commit). A fact/nudge history table is a genuinely new kind of table for this
schema: **not** user-owned, written only by the cron route's admin/service-role client
(`lib/supabaseAdmin.js` — the only service-role client in this codebase, bypasses RLS, used
exclusively by `app/api/cron/reminders/route.js`).

### Cron schedule (`vercel.json`)
Four separate scheduled invocations of the same route, one per `kind`/time slot — "once per cron
run" naturally means once per HTTP invocation of this route (already scoped to one `kind`), not
once globally across all four daily slots.

## Files / functions in scope
- `app/api/cron/reminders/route.js` — hoist whichever Gemini call(s) are in scope out of the
  per-user loop to run once per invocation (lazily, only if at least one user in this run would
  actually receive it — relevant for the conditional dinner slot).
- `lib/gemini.js` — `generateMealFact`/`generateDailyNudge` (or a new shared wrapper) needs to accept
  a "facts to avoid" list (recent history) and stop taking per-user `{trimester, weeks}` for the
  slot(s) now shared, since a single shared result can't be personalized per user.
- `lib/reminderLogic.js` — `pickFallbackNudge`/`pickMealFactFallback` seeding changes from per-user to
  per-run so the fallback path also stays "same for everyone this run".
- `supabase/schema.sql` — new table for fact/nudge history (not user-owned), used only by the
  service-role client.
- Tests: `lib/gemini.test.js` (new generation-with-avoid-list behavior), `lib/reminderLogic.test.js`
  (fallback seeding change).

## Ambiguities the description doesn't resolve
1. **Scope** — does "fun fact" mean only the lunch-slot `generateMealFact`, or does it also cover
   `generateDailyNudge` (morning/dinner/night), which can itself produce a pregnancy fact as one of
   its two possible outputs?
2. **Loss of per-user personalization** — today's fact/nudge is tailored to each user's own
   trimester/weeks. Making it shared-per-run necessarily drops that (there's no single trimester that
   fits every subscriber). Confirming this trade-off is intentional, not an oversight.
3. **History table scope** — one shared "facts" table across every slot in scope, or a separate
   history per slot/kind (so the lunch fact's 7-day window never collides with the morning nudge's)?
4. **Duplicate-avoidance mechanism** — feed Gemini the last 7 days' facts as a "don't repeat these"
   instruction (best-effort, since an LLM can still ignore it), a hard client-side reject-and-retry
   if the new result exactly matches recent history, or both? And if it still collides after a retry,
   fall back to the existing static fallback bank, or accept the repeat with a log line?
5. **What "the last 7 days" is measured against** — calendar days from `created_at`, or the last 7
   *rows* regardless of gaps (e.g. cron didn't run for 2 days)? Assumed calendar-day window
   (`created_at >= today - 6 days`) unless corrected, matching the existing `WEIGHT_NUDGE_WINDOW_DAYS`
   convention already in this same route file.

## Triage
**Triage: COMPLEX** — fails multiple SIMPLE criteria at once: (a) **schema/data impact** — a brand
new, non-user-owned table with a new access pattern for this schema; (b) **open ambiguity** — scope
(which generator(s)), personalization trade-off, table scope, and duplicate-handling policy are all
unresolved by the description; (c) **blast radius** — touches the cron route's core per-user loop,
`lib/gemini.js`'s two generator functions, and `lib/reminderLogic.js`'s fallback seeding together.
Proceeding to clarifying questions before any plan is written.
