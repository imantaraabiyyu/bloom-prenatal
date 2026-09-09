# Improvement Plan — Move weight tracker to Profile, redesign per reference

## Goal
Relocate the weight tracker entirely from Dashboard to Profil as one consolidated section
(featured stat card + quick-add + range indicator + daily trend + monthly-gain bar chart), styled
in Bloom's own dark theme/typography rather than the light-themed reference screenshots, with the
trend chart visible even below 2 entries (empty-state placeholder, single point plotted at 1 entry
— the fix already agreed in this session's earlier polish round).

## Current behavior
See `docs/improver/move-weight-tracker-to-profile-assessment.md` for the full file-by-file read.

## Proposed change

### `lib/weight.js` — new monthly-gain helper
```js
// Groups weight_logs rows by calendar month (YYYY-MM, each month's LAST
// logged entry represents that month), then chains month-over-month deltas:
// month M's gain = (last weight in M) - baseline, where baseline is the
// last weight in the most recent PRIOR month that has data, or
// prePregWeightKg for the very first data month (if set), or — if neither
// exists — that month is simply omitted (not shown as a misleading 0 bar).
export function computeMonthlyGain(weightRows, prePregWeightKg) { ... }
```
Returns `[{ month: "YYYY-MM", gainKg }]`, sorted ascending by month. Pure, no I/O — same
convention as every other `lib/weight.js` function.

### `app/dashboard/profile/page.js` — the consolidated section
Inserted as a new panel (or pair of panels) right after the existing "Berat & tinggi badan sebelum
hamil" panel (keeps the two weight-related panels adjacent):
- Bootstrap: fetch `weight_logs` for the user (same `useEffect`, same `.eq("user_id", u.id)`
  pattern the rest of this file already uses), sorted by date ascending.
- Derived: `latestWeightRow` (max date), `firstWeightRow` (min date), `bmi`/`bmiCat` (already
  computed in this file), `gaForLatest` (via `computeGestationalAge(hpht, latestWeightRow.date)`),
  `expectedRangeLatest`/`actualGainLatest`/`gainStatusLatest` (via `lib/weight.js`, mirroring the
  Dashboard version's logic 1:1 but anchored to the latest entry instead of a day-nav date),
  `monthlyGain` (via the new `computeMonthlyGain`).
- **Featured stat card**: latest weight as a large Fraunces-serif number on an accent-tinted
  background box (new `.weight-feature-card`/`.weight-feature-value` classes, sized between
  `.summary-card .big` and something larger to read as "the" number, mirroring the reference's
  prominence) + a label + a full-width pill-shaped "+ Tambahkan berat" button (new
  `.weight-add-btn`, `border-radius: 999px`, same accent color as `.manual-form-save`) that reveals
  a quick-add form.
- **Quick-add form** (revealed by the button, mirrors the meal/vitamin manual-form open/close
  pattern already in this codebase): a kg number input + "Simpan" button, defaulting to
  `date: todayISO()`; a small de-emphasized "Catat untuk tanggal lain" toggle reveals a date input
  for backfilling a past day (carries over the earlier-agreed de-emphasized-date-field decision).
  Upserts via `onConflict: "user_id,date"`, same as the Dashboard version's `handleSaveWeight`.
  Latest entry shows a small delete (`ConfirmButton`, mirrors `.meal-list-remove`'s existing style).
- **BMI/target info** (already built for the "Berat & tinggi" panel — extended here with the
  gain-so-far + status line, ported from the Dashboard version, anchored to `latestWeightRow`).
- **Range indicator**: a static "Mulai {firstKg}kg — Ubah {delta}kg — Sekarang {latestKg}kg" bar
  (new `.weight-range-bar` classes), shown once there are 2+ entries (a single entry has no
  meaningful "start vs now" range).
- **Daily trend chart**: ported from the Dashboard version's geometry block (raw kg, dynamic axis,
  optional shaded IOM band) — same math, now driven directly by the fetched `weight_logs` array
  instead of a day-nav-derived list. Empty-state (`.rings-empty`, reused) at 0 entries; renders
  (already-correct) single-point plot at 1 entry; unchanged from before at 2+.
- **Monthly bar chart**: a new hand-rolled SVG block (4th such block in this app, following the
  same house style — inline `<svg>`, no charting library) — one bar per `monthlyGain` entry, height
  proportional to `|gainKg|`, extending up from a zero-line for positive gain and down for negative
  (a weight dip is possible and shouldn't be hidden), single accent color for every bar (matches
  the reference's single-color bars; no per-bar status coloring, since there's no monthly-specific
  IOM target to compare against — only the total/daily one already shown elsewhere).

### `app/dashboard/page.js` — remove the relocated feature
Delete: the "Berat badan" panel, the "Tren berat badan" panel, `weightLogs` state + its bootstrap
fetch, `weightByDate`/`datesWithWeight`/`todaysWeightRow`/`bmi`/`bmiCat`/`totalGainRange`/
`gaForCurrentDate`/`expectedRangeToday`/`actualGainToday`/`gainStatusToday`, the weight-form-sync
`useEffect`, `handleSaveWeight`/`handleDeleteWeight`, the weight-trend geometry block
(`weightTrendData` through `expectedMaxPoints`), the weight-related manual-form state
(`weightDraft`/`weightFormDate`/`weightSaving`/`weightError`), and the `weightLogs` fold-in inside
`dates`/`datesWithData`. Remove now-unused imports (`Scale` from `lucide-react`; `computeGestationalAge`
from `lib/pregnancy` — confirmed only used for weight on this page; the whole `@/lib/weight` import
line). The disclaimer's IOM sentence moves to the Profile page's own disclaimer instead.

### `app/globals.css`
New classes only (nothing shared/existing is edited): `.weight-feature-card`,
`.weight-feature-value`, `.weight-feature-label`, `.weight-add-btn`, `.weight-range-bar` (+ its
inner elements), and bar-specific SVG-adjacent classes if needed (most of the monthly chart reuses
`.trend-svg-wrap`/`.legend` as-is).

## Scope
### In scope
Exactly the files/changes listed above.

### Out of scope / non-goals
- No separate detail page or home-feed card (per the answered question — single consolidated
  Profil section only).
- No per-bar IOM status coloring on the monthly chart (no monthly-specific target exists).
- No edit/delete UI for non-latest historical entries beyond what backfill-by-date (upsert)
  already allows — matches the reference, which shows charts only, no raw editable history list.
- No change to `weight_logs`/`profiles` schema — already exists from the prior session.

## Steps
1. `lib/weight.js` + `lib/weight.test.js` — `computeMonthlyGain` + tests.
2. `app/globals.css` — new dedicated classes (additive only).
3. `app/dashboard/profile/page.js` — bootstrap fetch, derived state, featured card + quick-add +
   range indicator + daily trend + monthly bar chart.
4. `app/dashboard/page.js` — remove the relocated panels/state/handlers/imports.
5. Full test suite run; syntax-check every touched file; commit per step.

## Data / schema impact
None (see assessment).

## Risks & mitigations
- **Removing code from Dashboard breaks something still relied on elsewhere** — mitigated by
  grepping for every weight-related identifier before deleting it, confirming each is used only
  within the block being removed (e.g. `computeGestationalAge` — check no other Dashboard code
  path uses it before dropping the import).
- **Porting the trend/BMI logic introduces a subtle divergence from the Dashboard version's
  math** — mitigated by copying the existing, already-tested formulas verbatim (same
  `expectedGainRangeAtWeek`/`gainStatusForWeek` calls, same geometry approach), only changing what
  drives the input list (all `weight_logs`, not a day-nav-scoped subset).
- **Monthly chart's baseline logic (pre-pregnancy weight vs. chained prior month) reads
  ambiguous** — mitigated by explicit unit tests covering both the with/without-pre-pregnancy-
  weight cases and a data gap across months.

## Test plan
- `lib/weight.test.js`: `computeMonthlyGain` — single month with a pre-pregnancy baseline; single
  month with no baseline (omitted, not a 0 bar); multiple consecutive months chaining correctly;
  a gap month (no data) doesn't break the chain — the next data month still compares against the
  last *data-bearing* month, not literally the prior calendar month; empty input → `[]`.
- Full `npx vitest run` after every step — regression guard for the rest of the suite.
- Manual/visual note (no component-test harness in this repo): confirm the Dashboard no longer
  shows any weight UI, and the Profil page's new section renders the featured card, quick-add,
  range indicator, daily trend (with its empty/single-point states), and monthly bars correctly.

## Standards notes
No `kredivo-docs` areas touched — app-level UI relocation/redesign.
