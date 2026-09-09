# Implementation Log — Track sugar/sodium/cholesterol/saturated fat/caffeine + limit warnings + soft Gemini verdict

Branch: `feat/sugar_and_natrium` (existing branch, already matched this work's scope — user chose
"use current branch" at Step 0).

## Mid-session scope additions (both explicitly requested by the user, folded into the approved
plan before implementing)
1. **Soft verdict tone** — the verdict enum was changed from an initially-drafted
   "aman/waspada/sebaiknya_dihindari" to "aman/waspada/kurangi_dulu", plus explicit prompt bans on
   alarming words and a requirement to pair any caution with a gentle, constructive suggestion. UI
   badge colors avoid red entirely for a non-"aman" verdict (see `app/dashboard/chat/page.js`'s
   `VERDICT_BADGES` / `app/globals.css`'s `.verdict-caution`).
2. **`meals.extra_nutrients`** — the user asked mid-implementation whether `meals` could get the
   same free-form `extra_nutrients` jsonb column `vitamins` already has, for composition facts
   outside the fixed nutrient lists. Added: new column (`supabase/schema.sql`), a new top-level
   `extra_nutrients` field in Gemini's food-category schema/prompt (reusing the same
   `{label,unit,value}` shape a vitamin item's own `extra_nutrients` already uses — see
   `buildExtraNutrientItemSchema` in `lib/gemini.js`), a new "nutrisi lain" sub-section on the
   manual add-meal form (mirroring the existing vitamin form's), and wiring through
   `saveAnalysisToMeals`/`handleAddMeal` so the value actually persists. Reused the already-generic
   `buildExtraNutrientsMap`/`mergeExtraNutrients` (lib/nutrition.js) unchanged.

## Steps

1. **`lib/nutrition.js`** — `LIMIT_ORDER`/`LIMIT_META`/`LIMITS`/`LIMIT_STATUS_TIERS` +
   `limitStatusForPct`/`exceededLimitLabels`/`computeActiveLimitNutrients`/
   `groupLimitTotalsByUser`/`mergeUserTotals`/`ALL_TRACKED_NUTRIENTS`/`ALL_TRACKED_META`; extended
   `groupMealsByDay`, `MEAL_ALIASES`/`VIT_ALIASES` (new `LIMIT_ALIASES` shared block), sample CSVs,
   `DEFAULT_VITAMINS`, `vitaminItemToRow`. Verified via `npx vitest run lib/nutrition.test.js`
   before committing (existing 11 tests still passed unmodified).
2. **`supabase/schema.sql`** — 10 new `alter table add column if not exists ... numeric default 0`
   (5 cols × `meals`/`vitamins`) + `meals.extra_nutrients jsonb` (mid-session addition, see above).
3. **`lib/gemini.js`** — widened `buildResponseSchema`/`buildVitaminItemSchema`/
   `NUTRIENT_LIST_FOR_PROMPT` to `ALL_TRACKED_NUTRIENTS`/new `LIMIT_LIST_FOR_PROMPT`; added
   `verdict`/`verdict_reason` (inserted before `reply`, which must stay last for streaming) +
   top-level `extra_nutrients`; `sanitizeChatTurnResult`/`sanitizeVitaminItem` extended
   (new shared `sanitizeExtraNutrientsList` helper); `streamNutritionChatTurn` gained
   `dailyLimitTotals` + `buildDailyContextHint`; `SYSTEM_PROMPT` got the VERDICT section + soft-tone
   rules. Verified via `npx vitest run lib/gemini.test.js` (existing 33 tests unmodified, still
   passed) before committing.
4. **`app/api/nutrition-chat/route.js`** — accepts client-supplied `today`; new
   `fetchDailyLimitTotals` (read-only, RLS-scoped via the existing authenticated client) feeds
   `dailyLimitTotals` into `streamNutritionChatTurn`. Best-effort (a fetch failure never blocks the
   chat turn). Updated the file's own "never touches the database" comment.
5. **`app/dashboard/chat/page.js`** — sends `today`; renders `VERDICT_BADGES` (soft, never red)
   under a food-category analysis; `formatAnalysisText`/`formatVitaminAnalysisText` extended to
   `ALL_TRACKED_NUTRIENTS`/`ALL_TRACKED_META` + `extra_nutrients`; `saveAnalysisToMeals` persists
   the new fields + `extra_nutrients`. New CSS: `.verdict-badge`/`.verdict-safe`/`.verdict-caution`
   in `app/globals.css`.
6. **`app/dashboard/page.js`** — new `activeLimitNutrients`/`dayLimitTotals`/`limitTotals`/
   `exceededToday` derived state; red warning banner (`.limit-warning-banner`, new CSS) right after
   the page header; new "Batas harian" today panel + a parallel "Tren batas harian" trend `<svg>`
   (deliberately not refactored to share code with the existing floor-type trend); manual-form
   sub-grids for the 5 new nutrients on both forms + a new "nutrisi lain" sub-section on the meal
   form (mid-session addition); extended detail lines (meal + vitamin rows) and the "Format kolom
   CSV" help text.
7. **`lib/reminderLogic.js`** — `buildLimitWarningClause` (pure); `buildReminderBody`'s new
   `limitWarning` param, space-joined after the nudge in every lead branch.
8. **`app/api/cron/reminders/route.js`** — dinner slot now also fetches meals limit-columns +
   checked-vitamins limit-columns for `today`, sums per user, and changes the skip condition to
   `!missingMeal && !missingVitamin && exceededLabels.length === 0` (previously just the first two).
9. **`README.md`** — doc note on the 5 new nutrients + limits + meals' new `extra_nutrients`.
10. **Tests** — extended `lib/nutrition.test.js` (+15 tests: `exceededLimitLabels`,
    `computeActiveLimitNutrients`, `groupLimitTotalsByUser`/`mergeUserTotals`, a `vitaminItemToRow`
    regression guard for the 5 new fields), `lib/gemini.test.js` (+16 tests: verdict pass-through/
    downgrade/category-blanking, top-level `extra_nutrients` pass-through/dropping/category-
    blanking, a schema-shape assertion that `reply` stays last, and daily-context-hint
    presence/absence via the actual Gemini request body), `lib/reminderLogic.test.js` (+6 tests:
    `buildLimitWarningClause`, `buildReminderBody`'s new `limitWarning` param including the
    "everything already logged" branch the dinner-trigger change unlocks).

    One test bug caught and fixed during this run (not a production bug): the "omits the hint...”
    test initially reused one `mockResolvedValue` body object across two `streamNutritionChatTurn`
    calls — the second call got an already-drained stream reader. Fixed by using
    `vi.fn(async () => ({...}))` so each call gets a fresh `fakeSseBody()`.

    Two test-expectation bugs caught and fixed (also not production bugs): two
    `computeActiveLimitNutrients` tests assumed "nonzero" semantics, but the function (correctly)
    mirrors `computeActiveNutrients`'s actual "field present, even at 0" semantics — corrected the
    test expectations to match the existing, intentional behavior instead of changing the code.

    Final run: `npx vitest run` → **98/98 passed** (was 66/66 before this run; +32 new tests).

## Deferred / follow-ups (noted, not done this run)
- CSV upload doesn't support `extra_nutrients` for meals or vitamins (manual form / Gemini only) —
  consistent with the pre-existing vitamin CSV behavior, not a new gap.
- No migration path for backfilling real historical sugar/sodium/etc. values — explicitly out of
  scope per the approved plan.
- This repo has no `pyproject.toml`/`uv` (it's a Next.js/JS project) — N/A, tests ran via the
  existing `npm test` (`vitest run`).
