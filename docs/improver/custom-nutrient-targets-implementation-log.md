# Implementation Log — Per-user configurable nutrient targets/limits

Branch: `feat/gemini-chat-flexible` (per user's explicit choice at the branch-resolution step —
continuing on the same branch as the earlier improver runs this session).

## Clarifying answers that shaped the plan
1. Scope: **config + full wiring** — Dashboard, Gemini chat, and cron reminders all consume the
   per-user goals, not just the Profile UI storing them.
2. Storage model: **new `nutrient_goals` table**, one row per (user, nutrient_key).
3. Fixed-nutrient defaults: **seeded on first Profile visit** (a real stored row from then on, not a
   computed fallback) — an explicit trade-off: a later change to the app's global defaults won't
   retroactively apply to a user who's already opened the section.
4. Direction flexibility: **any nutrient's direction is user-editable**, fixed or custom — this is
   what made the Dashboard's ring-vs-bar split and Gemini's prompt need to become dynamic per-user
   rather than just substituting values into the existing static structure.

## Step 1 — `supabase/schema.sql`: new `nutrient_goals` table
- `id, user_id, nutrient_key, label, unit, goal_type (check min/max), target_value (check > 0),
  is_custom, created_at, updated_at`, `unique(user_id, nutrient_key)`, standard 4-policy owner-RLS.
- **Manual deploy step required**: run the updated schema.sql in the Supabase SQL editor before this
  table exists live — same as every prior schema change in this repo.

## Step 2 — `lib/nutrition.js`: the shared "effective goal" logic
- `resolveEffectiveGoals(goalRows, trimester)` — the one seam every consumer reads through.
- `collectKnownExtraNutrientSlugs(rows)` — scans a user's full meal/vitamin history for custom
  extra_nutrients slugs (used by the Profile page's add-candidate picker).
- `exceededGoalLabels(totals, effectiveGoals)` replaces `exceededLimitLabels(totals)` — breaking
  rename; both call sites (Dashboard, cron route) and all 5 of its old tests were migrated together.
- `statusForGoal(pct, goalType)`, `computeActiveTrackedNutrients(rows)` — new, additive.
- `groupLimitTotalsByUser`/`mergeUserTotals` gain an additive 3rd `keys` param (default `LIMIT_ORDER`
  preserves every existing 2-arg call site/test unchanged).
- Tests: `npx vitest run lib/nutrition.test.js` → **38 passed (38)**.
- Commit: `1b71489`.

## Step 3+4 — Dashboard + Gemini rewiring
- `app/dashboard/page.js`: `effectiveGoals` replaces `targets`/`TARGETS`/`LIMITS`; rings/bars split
  dynamically by each key's current `goalType` instead of fixed `NUTRIENT_ORDER`/`LIMIT_ORDER`
  membership; `dayNutrientTotals` replaces the two parallel `dayTotals`/`dayLimitTotals`; custom
  nutrients with a configured goal get a progress bar in the "Nutrisi lain" panel.
  - **Bug caught and fixed during implementation**: the trend-chart legends read
    `NUTRIENT_META[n]`/`LIMIT_META[n]` directly, which would throw (`undefined.color`) for a
    flipped-direction nutrient not in that specific meta object (e.g. `sodium_mg` flipped to
    min-type isn't in `NUTRIENT_META`). Fixed to read `ALL_TRACKED_META[n]` (covers all 15 keys)
    instead, before this ever shipped.
- `lib/gemini.js`: `SYSTEM_PROMPT` (private constant) → `buildSystemPrompt(effectiveGoals)`
  (function); `buildDailyContextHint` gains the same param. Both fall back to today's exact global
  split when `effectiveGoals` is omitted (confirmed via the existing 55 tests passing unchanged with
  no code changes needed there).
- Tests: `npx vitest run lib/gemini.test.js` → **59 passed (59)** (55 pre-existing + 4 new, after two
  test-writing corrections caught by actually running them — see below).
- Full suite: **155 passed (155)**. Build: succeeds.
- Commit: `d447a9e`.

### Test-writing corrections (caught by running tests, not assumed)
- A test asserting a fully-min effectiveGoals map without providing every `ALL_TRACKED_NUTRIENTS`
  key crashed (`buildMinMaxListsForPrompt` reads `effectiveGoals[k].unit` for every key in the
  filtered min/max lists) — fixed by building test fixtures via the real `resolveEffectiveGoals`
  (which always returns a complete map), not hand-rolled partial objects. This mirrors the actual
  contract every real caller relies on, so no defensive code was added to `lib/gemini.js` for an
  input shape that can't occur in this codebase.
- A test asserting the VERDICT prose's exact old lowercase wording ("asupan gula/natrium/...") failed
  because the dynamic version derives labels from `LIMIT_META`/`effectiveGoals` (Title Case, e.g.
  "Gula") rather than reproducing the original hand-written lowercase sentence. Fixed the test
  expectation to match the new (correct, consistent-with-the-rest-of-the-app) capitalized output
  rather than forcing a casing-preservation shim into the code for a stylistic difference with no
  functional impact.
- A test asserting a custom nutrient's label text doesn't leak into the prompt failed because
  "Laktosa" already appears generically as an example in the exhaustive-extraction instructions
  regardless of any configured goal — fixed to assert on the nutrient_key ("laktosa_intoleransi")
  instead, the actually-discriminating string.

## Step 5+6 — Route wiring
- `app/api/nutrition-chat/route.js`: `fetchDailyLimitTotals` → `fetchDailyNutrientTotals` (broadened
  to `ALL_TRACKED_NUTRIENTS`); new `fetchEffectiveGoals` (profile + nutrient_goals fetch →
  `resolveEffectiveGoals`); both threaded into `streamNutritionChatTurn`. Both best-effort — a
  failure degrades to today's global defaults, never blocks the chat turn.
- `app/api/cron/reminders/route.js`: new `nutrient_goals` fetch grouped by user alongside
  `profileByUser`; dinner slot's query broadened to `ALL_TRACKED_NUTRIENTS`; per-user loop resolves
  `userEffectiveGoals` before calling `exceededGoalLabels`.
- Full suite: **155 passed (155)**. Build: succeeds.
- Commit: `83d8487`.

## Step 7 — Profile page "Konfigurasi nutrisi" section
- New state (`goalRows`, `knownExtraSlugs`, per-key drafts/saving/errors, custom-add-form fields);
  bootstrap effect seeds all 15 fixed nutrients on first visit (using the profile row just loaded,
  not stale `hpht` state) and scans the user's full meal/vitamin history for known custom slugs.
- "Nutrisi tetap" (always-present, edit-only rows) + "Nutrisi kustom" (add/edit/delete, mirrors the
  `baby_names` list pattern) + "Tambah nutrisi kustom" (pick a known extra or type one freehand).
- New `.goal-*` CSS added near the existing `.babyname-*`/`.nutrient-row` rules; `.goal-remove` added
  to the mobile touch-target bump list.
- Full suite: **155 passed (155)**. Build: succeeds.
- Commit: `32a44d8`.

## Deployment note (flagged per plan's Risks section)
`supabase/schema.sql`'s new `nutrient_goals` table must be run by hand in the Supabase Dashboard →
SQL Editor before this feature works against the live database. Until then: the Profile section's
seeding/fetch/save calls fail gracefully (empty state, upsert errors surfaced inline); the
Dashboard/Gemini/cron all degrade to today's exact global-default behavior via
`resolveEffectiveGoals`'s own fallback — nothing breaks, the feature just isn't visibly active yet.

## Manual verification still recommended (no component/route-test harness exists in this repo)
- After running the schema SQL: open Profile → confirm all 15 fixed nutrients auto-seed with
  today's defaults; edit one's direction and value, reload, confirm it persisted.
- Log a meal/vitamin with a custom extra nutrient, confirm it appears as an add-candidate in the
  custom-goal picker; configure a goal; confirm the Dashboard's "Nutrisi lain" panel shows a bar.
- Flip a fixed nutrient's direction (e.g. `sodium_mg` → min-type) and confirm the Dashboard moves it
  from "batas harian" into the rings/detail-bars section (and vice versa).
- Confirm the Dashboard's warning banner and the chat's food-verdict/daily-context hint both reflect
  a customized target value for at least one edited nutrient.

## Test summary
- `npx vitest run` → **4 test files, 155 tests, all passed** across every step of this run.
- `npm run build` → production build succeeds after every step (5 separate runs across this session).
