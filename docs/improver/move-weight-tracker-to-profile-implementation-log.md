# Implementation Log — Move weight tracker to Profile, redesign per reference

Branch: `feat/weight_tracker` (continued — same branch this whole feature has lived on).

## Session arc (for context)
This run started as a small "polish" ask ("buatkan grafik tren dan perbaiki input nya" / "perbagus
tampilan input nya") aimed at the Dashboard's weight-tracker UI. A trimmed SIMPLE plan was written
(`polish-weight-tracker-ui-{assessment,improvement-plan}.md`) but **never implemented** — before any
code changed, the user shared reference screenshots from another pregnancy app and asked to move
the whole feature to Profil in that style. That materially larger scope superseded the SIMPLE plan
(left in place as a historical record, not deleted, per the skill's "never overwrite a previous
run's docs" rule) and this run's `move-weight-tracker-to-profile-*` docs took over as the actual
plan that got built.

## Steps
1. **`lib/weight.js`** — `computeMonthlyGain(weightRows, prePregWeightKg)`: groups by month, keeps
   each month's last entry, chains deltas off the prior data-bearing month (or pre-pregnancy weight
   for the first data month). `lib/weight.test.js`: +7 tests (empty input, with/without
   pre-pregnancy baseline, chained months, a data-gap month, negative gain, rows with no date) —
   verified via `npx vitest run lib/weight.test.js` (27/27) before committing.
2. **`app/globals.css`** — `.weight-feature-card`/`.weight-feature-value`/`.weight-feature-label`
   (big Fraunces-serif stat in an accent-tinted box), `.weight-add-btn` (pill-shaped,
   `border-radius: 999px`), `.weight-date-toggle` (de-emphasized secondary control),
   `.weight-range-bar` + inner elements (static start/change/now indicator). All new — nothing
   shared (`.water-*`, `.manual-form-*`) was touched.
3. **`app/dashboard/profile/page.js`** — the consolidated "Berat badan" section: bootstrap fetch of
   `weight_logs`; derived `latestWeightRow`/`firstWeightRow`/`gaForLatest`/`expectedRangeLatest`/
   `actualGainLatest`/`gainStatusLatest`/`monthlyGain`; featured stat card + pill "+Tambahkan berat"
   button revealing a quick-add form (de-emphasized date toggle, defaults to today);
   BMI/target-range/gain-status info; the static range indicator; the ported daily trend chart
   (empty-state at 0 entries via the reused `.rings-empty` pattern, correct single-point plot at 1
   entry — the underlying geometry already handled that case, only the panel's own gate needed to
   change from `> 1` to always-render); a new 4th hand-rolled SVG chart for monthly gain (bars
   diverging from a zero-line for negative months). Moved the IOM disclaimer sentence here too.
4. **`app/dashboard/page.js`** — removed everything weight-related: the two panels, all derived
   state/geometry (`weightByDate` through `expectedMaxPoints`), the weight-form-sync `useEffect`,
   `handleSaveWeight`/`handleDeleteWeight`, the `weightLogs` fold-in inside `dates`/`datesWithData`,
   and the now-unused `Scale`/`computeGestationalAge`/`@/lib/weight` imports (confirmed via grep
   that neither `computeGestationalAge` nor `Scale` was used anywhere else on this page before
   removing their imports).

## Verification
- `npx vitest run` after every step → **128/128 passed** throughout (was 121/121 at the start of
  this run; +7 from `computeMonthlyGain`'s tests).
- Every touched file syntax-checked individually via `esbuild --loader:.js=jsx` (this repo has no
  component-test harness or build step run as part of this workflow).
- Final broad `grep` across the repo confirmed no stray references to the removed Dashboard
  identifiers (`todaysWeightRow`, `weightByDate`, `datesWithWeight`) anywhere, and that
  `handleSaveWeight`/`handleDeleteWeight` now exist only on the Profile page.

## Deferred / follow-ups (noted, not done this run)
- No separate detail page or home-feed card (explicit non-goal — single consolidated Profil
  section only, per the answered question).
- No per-bar IOM status coloring on the monthly chart (no monthly-specific target exists to
  compare against).
- No edit/delete UI for non-latest historical weight entries beyond backfill-by-date (upsert) —
  matches the reference, which shows charts only, no raw editable history list.
- Manual smoke-testing this feature end-to-end against a real Supabase project (fill in
  pre-pregnancy weight/height, log several weigh-ins across different months, confirm the featured
  card/range bar/daily trend/monthly bars all render correctly, confirm the Dashboard no longer
  shows any weight UI) was not run in this session (no live Supabase/Vercel environment available
  here) — recommended before merging/deploying.
