# Improvement Plan — Per-user configurable nutrient targets/limits (fixed + custom)

## Goal
1. A new "Konfigurasi nutrisi" section on the Profile page lets a user set, per nutrient, a goal
   **direction** (reach-at-least / avoid-exceeding) and a **target value** — for both the app's 15
   fixed tracked nutrients (`ALL_TRACKED_NUTRIENTS`) and any custom "extra nutrient" slug they've
   ever logged (e.g. "Laktosa"). Every nutrient's direction is user-editable, even fixed ones.
2. Every fixed nutrient is **seeded** with its current global default (direction + value, per the
   user's trimester) the first time they open this section — a real, stored row from then on, not a
   computed fallback.
3. **Full wiring**: the Dashboard's rings/limit-bars/warning banner/trend/history, and Gemini's
   food-verdict prompt + daily-context hint, all read the user's *effective* goal (their own row, or
   today's global default when unconfigured) instead of the hardcoded `TARGETS`/`LIMITS` constants.
4. Custom nutrients get a lighter touch: a goal shows as a progress bar in the existing "Nutrisi
   lain" Dashboard panel; they do **not** get a ring, and do **not** join the trend chart or
   history-table average (those stay scoped to the fixed 15, see Out of scope).

## Current behavior (see `docs/improver/custom-nutrient-targets-assessment.md` for full detail)
- `TARGETS`/`LIMITS` (`lib/nutrition.js:7-11,75-81`) are global constants — same for every user,
  varying only by trimester (`TARGETS[trimester]`) for the floor-type set. No per-user override
  exists anywhere; `profiles.trimester` is a vestigial dead column.
- Every read site assumes a **static** floor-vs-ceiling split: `NUTRIENT_ORDER` (10 keys, always
  "target minimum") vs. `LIMIT_ORDER` (5 keys, always "batas maksimum harian") — Dashboard rings vs.
  limit-bars, Gemini's `NUTRIENT_LIST_FOR_PROMPT`/`LIMIT_LIST_FOR_PROMPT` + the VERDICT section's
  hardcoded "gula/natrium/kolesterol/lemak jenuh/kafein" prose, and `exceededLimitLabels`'s
  hardcoded `LIMIT_ORDER`/`LIMITS` iteration (shared by the Dashboard warning banner AND the cron
  dinner-reminder trigger).
- `extra_nutrients` are informational-only (`lib/nutrition.js:280`) — no target concept, and no
  existing query scans a user's full history to discover which custom slugs they've ever logged
  (the only aggregation, `app/dashboard/page.js`'s `extraTotals(date)`, is per-day only).
- `SYSTEM_PROMPT` (`lib/gemini.js:102-196`) is a private, unexported module-level constant, built
  once at import — confirmed safe to convert into a function (its only reader is the same file's
  `streamNutritionChatTurn`, line 606).
- `buildResponseSchema()` (`lib/gemini.js:68-88`) is already a function, already rebuilt fresh every
  turn from `ALL_TRACKED_NUTRIENTS` — **no change needed there**: it defines which DB columns Gemini
  fills in, not their direction, so it's unaffected by per-user direction overrides.
- `app/api/nutrition-chat/route.js` has **zero** `profiles`/trimester logic today — it derives
  nothing about the user's pregnancy stage at all.
- `app/api/cron/reminders/route.js` already derives per-user trimester from `profileByUser`'s
  `hpht` (lines 205-210) — only a `nutrient_goals` fetch is missing there.
- `groupLimitTotalsByUser`/`mergeUserTotals` (`lib/nutrition.js:121-144`) hardcode iteration over
  `LIMIT_ORDER` internally — both call sites (cron route, nutrition-chat route) need the broader
  `ALL_TRACKED_NUTRIENTS` set once direction is per-user.
- Profile page (`app/dashboard/profile/page.js`) has two reusable precedents: the `profiles`-upsert
  pattern (`saveHpht`/`saveBio`) and the `baby_names` add/edit/delete list pattern (state at
  `:90-96`, fetch at `:119-125`, handlers at `:328-352`, render at `:816-886`).

## Proposed change

### 1) `supabase/schema.sql` — new `nutrient_goals` table
```sql
-- 13) Target/batas gizi per pengguna (fixed ATAU custom/extra), lihat
-- lib/nutrition.js's resolveEffectiveGoals, app/dashboard/profile/page.js's
-- "Konfigurasi nutrisi" section, dan setiap tempat yang tadinya membaca
-- TARGETS/LIMITS langsung (Dashboard, Gemini chat, cron pengingat).
create table if not exists public.nutrient_goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  nutrient_key text not null,          -- salah satu ALL_TRACKED_NUTRIENTS, atau slug custom (mis. 'laktosa')
  label text not null,
  unit text not null default '',
  goal_type text not null check (goal_type in ('min','max')),
  target_value numeric not null check (target_value > 0),
  is_custom boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, nutrient_key)
);
create index if not exists nutrient_goals_user_idx on public.nutrient_goals (user_id);

alter table public.nutrient_goals enable row level security;
create policy "nutrient_goals: owner select" on public.nutrient_goals for select using (auth.uid() = user_id);
create policy "nutrient_goals: owner insert" on public.nutrient_goals for insert with check (auth.uid() = user_id);
create policy "nutrient_goals: owner update" on public.nutrient_goals for update using (auth.uid() = user_id);
create policy "nutrient_goals: owner delete" on public.nutrient_goals for delete using (auth.uid() = user_id);
```
`unique(user_id, nutrient_key)` enables a clean `upsert(..., { onConflict: "user_id,nutrient_key" })`
for both seeding and edits. Standard 4-policy owner-RLS, matching every normal (non-`meal_fact_history`)
table in this file.

### 2) `lib/nutrition.js` — the new shared "effective goal" logic
- **`resolveEffectiveGoals(goalRows, trimester)`** — the one function every consumer (Profile,
  Dashboard, Gemini route, cron route) calls. For each of the 15 `ALL_TRACKED_NUTRIENTS` keys: uses
  the matching `goalRows` entry if present, else falls back to today's global default (`LIMIT_ORDER`
  membership → `{goalType: "max", targetValue: LIMITS[key]}`, else → `{goalType: "min", targetValue:
  TARGETS[trimester][key]}`) — same defaults as today, just computed through one seam instead of
  scattered across every reader. Also folds in any `goalRows` entry whose key ISN'T one of the 15
  (a custom nutrient) as `{..., isCustom: true}`. Returns `{ [key]: {label, unit, goalType,
  targetValue, isCustom} }`.
- **`collectKnownExtraNutrientSlugs(rows)`** — scans an array of `meals`/`vitamins` rows' own
  `extra_nutrients` maps and returns a sorted `[{slug, label, unit}]` of every distinct custom slug
  ever logged (last-seen label/unit wins per slug, same precedent as `buildExtraNutrientsMap`). Used
  by the Profile page to offer "nutrients you've logged before" as add-candidates.
- **`exceededGoalLabels(totals, effectiveGoals)`** — replaces `exceededLimitLabels(totals)`.
  Iterates `effectiveGoals` entries with `goalType === "max"` (not the fixed `LIMIT_ORDER` array) and
  returns the labels of any strictly exceeded. **Breaking rename** (both call sites — Dashboard,
  cron route — and all 5 existing `exceededLimitLabels` tests must move to the new name/signature).
- **`statusForGoal(pct, goalType)`** — tiny new helper: `goalType === "max" ? limitStatusForPct(pct)
  : statusForPct(pct)`, so every render site picks the right status-tier direction without an
  inline ternary repeated at each call site.
- **`groupLimitTotalsByUser(rows, keys = LIMIT_ORDER)` / `mergeUserTotals(a, b, keys = LIMIT_ORDER)`**
  — both gain an optional 3rd `keys` parameter (default preserves today's exact behavior — existing
  2-arg call sites and their 4 existing tests are untouched). New callers (cron route, nutrition-chat
  route) pass `ALL_TRACKED_NUTRIENTS` explicitly, since which columns matter for a daily-limit-style
  sum is now per-user, not fixed to `LIMIT_ORDER`.
- `computeActiveNutrients`/`computeActiveLimitNutrients` are **left untouched** (still exported,
  still tested) but the Dashboard stops calling them directly — see step 3. Explicitly not removed,
  to keep this change additive rather than a cleanup pass (see Out of scope).

### 3) `app/dashboard/page.js` — Dashboard rewiring
- New `goalRows` state, fetched alongside `profiles`/`vitamins`/`meals`/`vitamin_checks` in the
  bootstrap effect (`supabase.from("nutrient_goals").select("*").eq("user_id", u.id)`).
- New `effectiveGoals = useMemo(() => resolveEffectiveGoals(goalRows, trimester), [goalRows, trimester])`
  right after the existing `trimester`/`targets` lines (`:201-202`) — `const targets = TARGETS[trimester]`
  is removed; every downstream reader switches to `effectiveGoals[key]`.
- `activeNutrients`/`activeLimitNutrients` (`:203,208`, currently two separately-imported functions)
  become one `activeTrackedNutrients = computeActiveTrackedNutrients(meals)` (new function, presence
  check over all 15 `ALL_TRACKED_NUTRIENTS`, same shape as the two it replaces), then split
  dynamically: `activeFloorNutrients = activeTrackedNutrients.filter(k => effectiveGoals[k].goalType === "min")`,
  `activeCeilingNutrients = ...filter(k => ... === "max")`. Everywhere the old `activeNutrients`/
  `activeLimitNutrients` were read (rings, ring legend, nutrient-detail bars, trend geometry, history
  table, summary `pcts`, "batas harian" bars, limit-trend geometry) switches to these two dynamically-
  split lists instead — same downstream JSX/SVG structure, no re-architecture of the render blocks
  themselves.
- Every `targets[key]`/`TARGETS[trimester][key]`/`LIMITS[key]` read (rings `:811,837`, nutrient bars
  `:980-981`, trend `:488`, limit-trend `:510`, history `:1126`, water widget `:259`, summary `:465`,
  batas-harian bars `:1055`) becomes `effectiveGoals[key].targetValue`.
- Every `NUTRIENT_META[key]`/`LIMIT_META[key]` read in these same blocks (`:835,978,1053,474`)
  becomes `effectiveGoals[key].label`/`.unit`.
- Status-tier selection (`statusForPct(...)` at rings/bars/history, `limitStatusForPct(...)` at the
  batas-harian bars) becomes `statusForGoal(pct, effectiveGoals[key].goalType)` uniformly — this is
  what makes a flipped-direction nutrient automatically render with the *correct* status semantics
  ("higher is better" vs "lower is safer") no matter which section it lands in.
- `exceededToday = exceededLimitLabels(limitTotals)` (`:254`) → `exceededGoalLabels(limitTotals,
  effectiveGoals)`.
- **Custom nutrients with a goal** — the existing "Nutrisi lain" panel (`:901-916`, currently plain
  `{label} {value}{unit}` chips from `todaysExtraTotals`) gets one addition: for a slug present in
  `effectiveGoals` (i.e. `effectiveGoals[slug]?.isCustom`), render a small progress bar (value vs.
  `effectiveGoals[slug].targetValue`, status via `statusForGoal`) instead of a plain chip; slugs with
  no configured goal keep rendering as plain chips, unchanged.
- The manual meal/vitamin entry forms (`:627-658,726-757`, which iterate `NUTRIENT_ORDER`/
  `LIMIT_ORDER` to build input grids) are **untouched** — they're about logging raw consumption
  amounts, a fixed DB-column question, not a goal-direction question.

### 4) `lib/gemini.js` — per-user-aware system prompt + daily-context hint
- `SYSTEM_PROMPT` (constant) → `buildSystemPrompt(effectiveGoals)` (function). Its two static
  clauses `NUTRIENT_LIST_FOR_PROMPT`/`LIMIT_LIST_FOR_PROMPT` are replaced by per-call lists built
  from `effectiveGoals`: every non-custom entry with `goalType === "min"` → the "target minimum"
  list; every non-custom entry with `goalType === "max"` → the "batas maksimum harian" list. The
  VERDICT section's hardcoded prose (line ~174, "asupan gula/natrium/kolesterol/lemak jenuh/kafein")
  becomes a dynamically-joined list of whichever labels are currently max-type for this user.
  `buildResponseSchema()` is **unchanged** (already direction-agnostic, see Current behavior).
- `buildDailyContextHint(dailyLimitTotals, effectiveGoals)` — gains the second param; iterates
  max-type, non-custom `effectiveGoals` entries instead of the hardcoded `LIMIT_ORDER`/`LIMITS`.
- `streamNutritionChatTurn({ message, image, history, dailyLimitTotals, effectiveGoals }, onDelta)` —
  new destructured param, threaded into both of the above at its one call site (line ~606-607).
- **Scope boundary**: custom/extra nutrients are explicitly **not** wired into Gemini's verdict
  reasoning or daily-context hint in this change (see Out of scope) — only the 15 fixed nutrients'
  *direction and value* become per-user; extras stay exactly as informational as they are today.

### 5) `app/api/nutrition-chat/route.js` — compute + pass `effectiveGoals`
- New: fetch `profiles.hpht` + `nutrient_goals` for the authenticated user (parallel with the
  existing daily-totals fetch), derive `trimester` via `trimesterForDate(hpht, body.today)` (new
  import from `lib/pregnancy`), compute `effectiveGoals = resolveEffectiveGoals(goalRows, trimester)`.
- `fetchDailyLimitTotals` → renamed `fetchDailyNutrientTotals`, broadens its `select()` projection
  from `LIMIT_ORDER.join(",")` to `ALL_TRACKED_NUTRIENTS.join(",")` and passes `ALL_TRACKED_NUTRIENTS`
  as the new 3rd arg to `groupLimitTotalsByUser`/`mergeUserTotals`.
- `streamNutritionChatTurn({ message, image, history, dailyLimitTotals, effectiveGoals }, ...)` at
  the existing call site (line ~107) gains the new argument.

### 6) `app/api/cron/reminders/route.js` — per-user effective goals for the dinner-slot check
- New `nutrient_goals` fetch (admin client, `in("user_id", userIds)`), grouped into a `goalsByUser`
  Map alongside the existing `profileByUser` (lines 82-86).
- Dinner slot's meal/vitamin-check query broadens from `LIMIT_ORDER.join(",")` to
  `ALL_TRACKED_NUTRIENTS.join(",")`; its `groupLimitTotalsByUser`/`mergeUserTotals` calls pass
  `ALL_TRACKED_NUTRIENTS` as the 3rd arg.
- Inside the per-user loop (trimester already derived at lines 208-209): compute
  `const userEffectiveGoals = resolveEffectiveGoals(goalsByUser.get(userId) || [], trimester);` and
  call `exceededGoalLabels(limitTotalsByUser[userId] || {}, userEffectiveGoals)` instead of
  `exceededLimitLabels(...)`.

### 7) `app/dashboard/profile/page.js` — the "Konfigurasi nutrisi" section
- New imports: `ALL_TRACKED_NUTRIENTS, ALL_TRACKED_META, resolveEffectiveGoals,
  collectKnownExtraNutrientSlugs, slugifyNutrientLabel` from `@/lib/nutrition`.
- New state: `goalRows`, `knownExtraSlugs` (fetched/derived on mount), per-fixed-nutrient edit
  drafts (`goalDrafts: { [key]: { goalType, targetValue, saving, error } }`), and a custom-goal add
  form (`customGoalForm: { nutrientKey, label, unit, goalType, targetValue }` + saving/error) — same
  draft/saving/error triplet convention as `saveHpht`/`saveBio`.
- On mount, after the profile/trimester load already there: fetch `nutrient_goals`; **if no fixed-key
  rows exist yet** (first visit), seed all 15 in one `insert` from `resolveEffectiveGoals({}, trimester)`'s
  defaults (per your "seed on first visit" answer) — this becomes the new source of truth for that
  user going forward, including for future trimester changes (an explicit, called-out trade-off, see
  Risks). Also fetch just the `extra_nutrients` column off the user's `meals`/`vitamins` (light
  projection) and run `collectKnownExtraNutrientSlugs` to populate the "known extras" add-candidates.
- **"Nutrisi tetap" section**: one row per fixed nutrient — label, a min/max direction toggle, a
  numeric target input, a Save button that upserts `{ user_id, nutrient_key, label, unit, goal_type,
  target_value, is_custom: false }` with `onConflict: "user_id,nutrient_key"`. No delete option
  (always present once seeded, per your seeding answer).
- **"Nutrisi kustom" section**: one row per `is_custom` goal — label/unit (read-only), the same
  direction toggle + target input + Save, plus a `ConfirmButton` delete (mirrors `baby_names`'
  add/list/delete exactly).
- **"Tambah nutrisi kustom" form**: a picker over `knownExtraSlugs` not yet configured (quick-fill
  label/unit) OR free-text label/unit entry (mirrors the "nutrisi lain" row inputs), plus direction +
  target value, "Tambah" button → inserts a new row with `is_custom: true`,
  `nutrient_key: slugifyNutrientLabel(label)`. A unique-constraint conflict (already configured) is
  caught and surfaced as a clear inline message rather than a raw Postgres error string.

## Scope

### In scope
- `supabase/schema.sql` — new `nutrient_goals` table + RLS.
- `lib/nutrition.js` — `resolveEffectiveGoals`, `collectKnownExtraNutrientSlugs`,
  `exceededGoalLabels` (replaces `exceededLimitLabels`), `statusForGoal`,
  `computeActiveTrackedNutrients` (new), `groupLimitTotalsByUser`/`mergeUserTotals` (additive 3rd
  param).
- `app/dashboard/page.js` — full rewiring described in step 3.
- `lib/gemini.js` — `buildSystemPrompt` (was `SYSTEM_PROMPT`), `buildDailyContextHint`,
  `streamNutritionChatTurn` signature.
- `app/api/nutrition-chat/route.js` — profile/goals fetch, `effectiveGoals` computation + threading.
- `app/api/cron/reminders/route.js` — `nutrient_goals` fetch, per-user `effectiveGoals`,
  `exceededGoalLabels` call site.
- `app/dashboard/profile/page.js` — new "Konfigurasi nutrisi" section (seed + edit fixed, add/edit/
  delete custom).
- `app/globals.css` — new CSS for the goal-editor rows/toggles/add-form (mirroring `.extra-nutrient-*`
  / `baby_names` list styling).
- `lib/nutrition.test.js` — updated `exceededLimitLabels` tests → `exceededGoalLabels`; new tests for
  `resolveEffectiveGoals`, `collectKnownExtraNutrientSlugs`, `statusForGoal`,
  `computeActiveTrackedNutrients`, and the new 3rd `keys` param on `groupLimitTotalsByUser`/
  `mergeUserTotals`.

### Out of scope / non-goals
- Custom/extra nutrients are **not** wired into Gemini's verdict reasoning or daily-context hint —
  only the Dashboard's "Nutrisi lain" panel shows their progress. Extending Gemini's per-turn
  extraction to reason about arbitrary user-defined custom thresholds is a materially different,
  open-ended prompt-engineering problem left for a future run if wanted.
- Custom nutrients do **not** get a ring, and do **not** join the trend chart or history-table
  average — those three visualizations stay scoped to the fixed 15 `ALL_TRACKED_NUTRIENTS`, per the
  "lighter touch for customs" framing in the Goal section. A future run could extend this.
- `computeActiveNutrients`/`computeActiveLimitNutrients` are left in place (still exported, still
  tested) even though the Dashboard stops calling them — not removed, to avoid an unrelated cleanup
  diff riding along with this feature.
- No change to the manual meal/vitamin entry forms' input grids (`NUTRIENT_ORDER`/`LIMIT_ORDER`-
  driven) — those log raw consumption, unrelated to goal configuration.
- No historical-day trimester recomputation fix for the history table's pre-existing quirk (it
  averages every past day against the *currently-viewed* day's trimester/effective-goals, not that
  historical day's own) — this is a pre-existing quirk the assessment surfaced, not introduced by
  this change; flagged, not fixed, to keep this change additive.
- `profiles.trimester` (vestigial/dead column) is left alone — unrelated to this feature.

## Data / schema impact
- New table `public.nutrient_goals` (id, user_id, nutrient_key, label, unit, goal_type, target_value,
  is_custom, created_at, updated_at) + unique constraint + index + standard 4-policy owner-RLS.
- No backfill/migration of existing users' data — each user's first visit to the new Profile section
  seeds their own 15 fixed rows on the spot; nothing is seeded server-side in bulk.
- **Manual deploy step required**, same as every prior schema change in this repo (no migration
  runner): run the updated `supabase/schema.sql` in the Supabase SQL editor before this feature works
  against the live database. Until then, `nutrient_goals` queries error and every consumer degrades
  to today's exact behavior (`resolveEffectiveGoals([], trimester)` returns the same global defaults
  `TARGETS`/`LIMITS` always did) — never a hard failure, same best-effort philosophy as this repo's
  other optional per-user reads.

## Risks & mitigations
- **Large, multi-file rewrite of the Dashboard's central render logic** (the single riskiest part of
  this change) — mitigated by keeping the existing two-list (floor/ceiling) render structure intact
  and only swapping *where the split and the numbers come from* (dynamic `effectiveGoals` instead of
  static constants), rather than re-architecting the JSX; manual verification (below) explicitly
  covers every affected section before considering this done.
- **Seeding freezes a user's fixed-nutrient goals at whatever the global default was on first visit**
  — a later change to the app's own `TARGETS`/`LIMITS` constants won't automatically reach a user who
  already opened this section (their seeded row is now their own data). This is the explicit,
  intended trade-off of your "seed on first visit" answer — called out here, not a bug.
  Trimester-dependent seeding also means a later `hpht`/trimester change won't retroactively adjust
  an already-seeded `calories` goal; the user would need to re-edit it manually.
- **`exceededGoalLabels` rename is a breaking signature change** touching 2 call sites (Dashboard,
  cron route) and all 5 of `exceededLimitLabels`'s existing tests — mitigated by doing this as one
  atomic step with all call sites + tests updated together (never left half-migrated), verified by
  the full test suite passing before that step's commit.
- **Gemini prompt rewrite is prompt-engineering-sensitive** (a wrong dynamic-list construction could
  silently produce malformed/confusing prompt text) — mitigated by request-body content tests
  (mirroring the pattern from this session's earlier `SYSTEM_PROMPT content` test block) asserting
  the dynamically-built lists appear correctly for a few representative `effectiveGoals` shapes
  (all-default, one flipped-direction nutrient, one custom nutrient present-but-excluded).
- **No route-level or component-level test coverage exists in this repo** (confirmed absent for
  `page.js`/route handlers in every prior improver run this session) — mitigated by unit tests on
  every new/changed pure function in `lib/nutrition.js` and `lib/gemini.js`'s request-body content,
  plus a production build as a syntax/type smoke check, plus a detailed manual verification pass
  (below) given how much of this change is Dashboard/Profile UI.
- **Schema not yet applied in production** — degrades gracefully everywhere (see Data/schema impact).

## Test plan
- `lib/nutrition.test.js` (automated):
  - `resolveEffectiveGoals`: no goal rows → returns today's exact global defaults (direction +
    value) for all 15 keys; a fixed-key override row → returned verbatim; a custom-key row → folded
    in with `isCustom: true`; mixed fixed + custom rows together.
  - `collectKnownExtraNutrientSlugs`: dedupes by slug across meals + vitamins rows, last-seen
    label/unit wins (mirrors `buildExtraNutrientsMap`'s own precedent), empty input → `[]`.
  - `exceededGoalLabels`: only `goalType: "max"` entries are ever eligible (a `min`-type entry over
    its "target" is never flagged), strictly-over (not at-or-over) still holds, empty/undefined
    totals doesn't throw — same edge cases the old `exceededLimitLabels` suite covered, re-expressed
    against the new signature.
  - `statusForGoal`: `"max"` routes to `limitStatusForPct`, `"min"` (and anything else) routes to
    `statusForPct`.
  - `computeActiveTrackedNutrients`: presence check spans all 15 `ALL_TRACKED_NUTRIENTS` keys
    (regression guard: a `LIMIT_ORDER` key with data is detected, not just `NUTRIENT_ORDER` ones).
  - `groupLimitTotalsByUser`/`mergeUserTotals`: existing 2-arg tests pass unchanged (default `keys`
    guard); new tests with an explicit `ALL_TRACKED_NUTRIENTS` 3rd arg sum the broader key set.
- `lib/gemini.test.js` (automated):
  - `buildSystemPrompt`(-equivalent, tested via `streamNutritionChatTurn`'s request body per this
    session's existing pattern): a flipped-direction `effectiveGoals` (e.g. `protein_g` as max-type)
    moves it out of the "target minimum" list and into the "batas maksimum harian" one in the
    resulting prompt text.
  - `buildDailyContextHint`-equivalent: the context hint's numbers/labels reflect a per-user
    `targetValue` override, not the hardcoded `LIMITS` constant.
- Manual verification (no component/route-test harness exists in this repo, see Risks):
  - After running the schema SQL: open Profile → confirm all 15 fixed nutrients auto-seed with
    today's current defaults; edit one's direction and value, confirm it persists on reload.
  - Log a meal with a custom extra nutrient (e.g. "Laktosa"), confirm it appears as an add-candidate
    in Profile's custom-goal picker; configure a goal for it; confirm the Dashboard's "Nutrisi lain"
    panel now shows a progress bar instead of a plain chip.
  - Flip a fixed nutrient's direction (e.g. `sodium_mg` → min-type) and confirm the Dashboard moves
    it from the "batas harian" bars into the rings/detail-bars section (and vice versa flipping e.g.
    `protein_g` → max-type moves it into "batas harian").
  - Confirm the Dashboard's warning banner and the chat's food-verdict/daily-context hint both
    reflect a customized target value (not the old hardcoded default) for at least one edited
    nutrient.
  - `npm run build` passes with no errors after every code change.

## Standards notes
No `$KDOCS` areas touched (no auth/SSO, no WIF/GCP, no Terraform/IaC, no Dockerfile/compose changes).
