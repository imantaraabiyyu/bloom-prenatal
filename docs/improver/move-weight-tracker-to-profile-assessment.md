# Assessment — Move weight tracker to Profile, redesign per reference screenshots

**Supersedes** `polish-weight-tracker-ui-{assessment,improvement-plan}.md` — that SIMPLE plan was
written but never implemented (no code was touched under it) before the user provided reference
screenshots and asked to relocate the whole feature to Profil, which is a materially bigger scope.
This run replaces it.

## Current behavior (as built in the prior weight-tracker session)
- **Dashboard** (`app/dashboard/page.js`): a "Berat badan — {currentDate}" panel (day-nav-scoped:
  one kg value per viewed date, upsert, manual date field, delete) and a "Tren berat badan" trend
  panel (raw-kg SVG line + optional shaded IOM expected-gain band), both driven by `weightLogs`
  state fetched in the page's bootstrap `useEffect`, plus derived state (`weightByDate`,
  `datesWithWeight`, `todaysWeightRow`, `bmi`/`bmiCat`, `gaForCurrentDate`, `expectedRangeToday`,
  `actualGainToday`, `gainStatusToday`) and the trend's geometry block (`weightTrendData`, `wtw`/
  `wpadL`.../`wxPos`/`wyPos`/`wGridTicks`, `canShowGainBand`). `dates`/`datesWithData` (the day-nav
  and calendar) also fold in `weight_logs` dates.
- **Profile** (`app/dashboard/profile/page.js`): already has the pre-pregnancy weight/height inputs
  panel (added in the same prior session) with inline BMI/category feedback — this stays, and is
  the natural home for the new consolidated section since it's already fetching/using
  `lib/weight.js`'s `computeBMI`/`bmiCategory`/`BMI_CATEGORY_META`.
- **`lib/weight.js`**: `computeBMI`, `bmiCategory`, `BMI_CATEGORY_META`, `TOTAL_GAIN_RANGE_KG`,
  `WEEKLY_GAIN_RATE_KG_T2T3`, `T1_GAIN_RANGE_KG`, `expectedGainRangeAtWeek`, `gainStatusForWeek`,
  `GAIN_STATUS_META` — all still needed, all reusable as-is by the relocated feature. No monthly-
  aggregation helper exists yet.
- **Reusable CSS precedents**: `.summary-card .big` (28px Fraunces serif, `app/globals.css:74`) and
  `.pregnancy-stat-value` (22px Fraunces serif, `app/globals.css:230`) are the two existing
  "big number" treatments; `.status-pill` (`app/globals.css:77`) already uses
  `border-radius: 100px` — the pill shape the reference's button wants; `.rings-empty`
  (`app/globals.css:185`) is the existing "not enough data" placeholder pattern.

## Reference screenshots (user-provided)
1. A dedicated "Berat Badan Saya" detail page: an "Ikhtisar" (Overview) section with an area-filled
   line trend chart + a static "Mulai — Ubah {delta}kg — Sekarang" range indicator underneath, and
   a "Riwayat — Peningkatan berat bulanan" (History — monthly weight increase) section with a bar
   chart (one bar per month).
2. A compact home-feed card: a large "68,8 KG" stat in a light-blue box + a "Berat Badan Saya"
   label + a pill-shaped "Tambahkan berat" (Add weight) button.
Both use a light theme (white background, blue accent) — the opposite of Bloom's existing dark
theme (dark plum background, warm gold accent, Fraunces/IBM Plex Mono fonts throughout).

## Clarifying answers (via AskUserQuestion this session)
1. **Structure**: single consolidated section on Profil — no separate detail page, no home-feed
   card (Profil has no day-by-day home feed to put one on).
2. **Visual style**: match Bloom's existing dark theme/typography — same layout/structure as the
   reference, not its literal light-blue-on-white colors.
3. **Monthly chart**: build it — a new "Peningkatan berat bulanan" bar chart, one bar per calendar
   month, requires new monthly-aggregation logic (doesn't exist anywhere yet).
4. **Range indicator**: add it — a static (non-interactive) "Mulai → total change → Sekarang" bar
   using the earliest and latest logged weights.

## Files/functions in scope
- `app/dashboard/page.js` — **remove** the "Berat badan" panel, the "Tren berat badan" panel, all
  weight-specific derived state/geometry/handlers, the `weightLogs` bootstrap fetch, the
  `dates`/`datesWithData` fold-in of weight dates, and now-unused imports (`Scale`,
  `computeGestationalAge`, the `lib/weight.js` imports) — reverting this file to its pre-weight-
  tracker shape for anything weight-related.
- `app/dashboard/profile/page.js` — **add** the consolidated "Berat badan" section: bootstrap fetch
  of `weight_logs`, a featured stat card (latest weight) + pill "Tambahkan berat" button revealing
  a quick-add form (defaults to today, de-emphasized date toggle for backfill — carried over from
  the earlier clarifying-question answer on the Dashboard version), the static range indicator, the
  ported daily trend chart (+ optional IOM band, empty-state below 2 entries per the earlier
  agreed fix), and the new monthly bar chart.
- `lib/weight.js` — new `computeMonthlyGain(weightRows, prePregWeightKg)` pure helper (chained
  month-over-month deltas, pre-pregnancy weight as the first month's baseline when set).
- `lib/weight.test.js` — tests for the new helper.
- `app/globals.css` — new classes: featured stat card, pill button, range-indicator bar, monthly
  bar-chart bars (reusing `.trend-svg-wrap`/`.legend` where the shape already fits).

## Data / schema impact
None — `weight_logs`/`profiles.pre_pregnancy_weight_kg`/`profiles.height_cm` already exist from the
prior session; this run only moves/adds UI and one new pure aggregation function.

## Triage
COMPLEX — this removes a built feature from one page and rebuilds a redesigned version (2 new
chart types: an empty-state-aware trend + a brand-new monthly bar chart) on a different page,
touching derived state, bootstrap data-fetching, and CSS across 2 page components; well past the
"≤3 files, no new logic" SIMPLE bar. Full plan + approval gate follow.
