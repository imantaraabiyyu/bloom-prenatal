# Assessment — Trend chart scrollability + >100% display

## Request (verbatim, translated)

Screenshot from the user's installed Android PWA, real data (~18 days of
history, several nutrients routinely over 100% — Zat besi 143%, Kalsium
124%, Folat 230%):

1. "jika data grafik terisi banyak tampilan jadi kurang bagus, buat
   grafiknya jadi scrolable" — when the trend chart has a lot of data
   filled in, the display looks bad; make it scrollable.
2. "perbaiki tampilan nya jika ada zat yang lebih dari 100%" — fix the
   display when a nutrient is over 100%.

## Current behavior

### The trend chart already scales width + already has a scroll container

`app/dashboard/page.js` ([page.js:440-454](../../app/dashboard/page.js#L440-L454)): `trendData` is built from
*every* `datesWithMeals` entry, unbounded — no recent-N-days limit. The
SVG's own pixel width already grows with day count:
`tw = Math.max(560, trendData.length * 90)` — with ~18 days that's
`1620px`, rendered inside `.trend-svg-wrap` ([globals.css:271](../../app/globals.css#L271) area,
`width: 100%; overflow-x: auto;`). Mechanically, this **should already be
horizontally scrollable** — the user reporting it isn't is either (a) a
real interaction issue (nested vertical-page-scroll vs. horizontal-chart-
scroll ambiguity on touch, a known mobile pattern that sometimes needs
explicit `touch-action` handling or a visible scroll affordance), or (b)
it *is* technically scrollable but still looks bad even when scrolled —
which points at the second issue below as the more likely actual
complaint.

### The shared y-axis auto-scales to the single highest value across ALL
    nutrients and ALL days

`page.js:449-451`:
```js
let maxVal = 100;
trendData.forEach((d) => activeNutrients.forEach((n) => { if (d[n] > maxVal) maxVal = d[n]; }));
maxVal = Math.ceil(maxVal / 20) * 20 + 20;
```
Every line on the chart shares one `yPos()` scale derived from the single
highest percentage in the *entire* dataset. With Folat hitting 230% on one
day, the y-axis stretches to ~260%, compressing every other
line/nutrient/day into the bottom ~40% of the chart's vertical space —
this is very likely the actual "kurang bagus"/cramped-and-overlapping
look, independent of horizontal width entirely, and would look bad even
if horizontal scrolling worked perfectly.

### Bars already cap their fill width at 100% — but give zero visual
    signal that a value is *over* target

Three bar-fills all already do `width: ${Math.min(pct, 100)}%` (confirmed
via grep — `.water-bar-fill` at [page.js:776](../../app/dashboard/page.js#L776), `.nutrient-bar-fill` at
[page.js:830](../../app/dashboard/page.js#L830), `.hist-bar-fill` at [page.js:898](../../app/dashboard/page.js#L898)) — so there is
**no CSS overflow bug**; a 230% value renders as a normal, contained,
full-width bar. The actual gap: `.nutrient-bar-fill`'s color is
`meta.color` (the nutrient's own fixed brand color, e.g. purple for Zat
besi — same color used for its ring, its trend-chart line, and its
legend dot), so a bar at exactly 100% and one at 230% render **identically**
— nothing distinguishes "just met target" from "way over".

Contrast: the **rings** (same page, [page.js:658-680](../../app/dashboard/page.js#L658-L680)) already solve this
exact problem, just for rings, not bars — `frac > 1.02` draws a small
white marker dot at the ring's 12 o'clock position to flag "this went past
full circle" ([page.js:675-677](../../app/dashboard/page.js#L675-L677)), on top of using `statusForPct()`'s
3-tier good/mid/low semantic color (not the nutrient's brand color) for
the ring stroke itself. The bars use a different, pre-existing color
convention (brand color, matching the trend chart) — not something to
casually unify without the user weighing in, but the "small marker when
over 100%" idea is a directly reusable, already-established pattern in
this same file worth extending to the bars rather than inventing
something new.

## Files/functions likely in scope (pending clarification)

- `app/dashboard/page.js` — `trendData`/`maxVal`/`yPos` (y-axis capping +
  clipped-point marker), the 3 bar-fill JSX blocks (over-100% marker).
- `app/globals.css` — any new marker/badge styling, possibly
  `touch-action` on `.trend-svg-wrap` if the scroll-interaction theory is
  confirmed.
- `lib/nutrition.js` — no change expected (existing `STATUS_TIERS`/
  `statusForPct` likely reused as-is, not modified).

## Ambiguities (unresolved — block a SIMPLE classification)

1. Is the horizontal-scroll complaint a genuine "swiping does nothing"
   interaction bug, or (more likely per the code) just "still looks bad
   even scrolled" — pointing at the y-axis distortion as the real fix
   needed, not the scroll mechanism itself?
2. Desired treatment for the y-axis when one value spikes far over 100% —
   cap the scale at a fixed ceiling and mark clipped points distinctly
   (mirrors the ring's existing "over" marker), vs. some other approach?
3. Desired treatment for the bar-fills at >100% — add a small marker
   (mirroring the ring's `frac > 1.02` dot) without changing their
   existing brand-color scheme, vs. a different treatment entirely (badge
   text, color change, etc.)?

## Triage

**Triage: COMPLEX** — spans 2 distinct root causes across the same
report, involves a design decision (how to visually denote "over target")
that has real precedent in this codebase (the ring marker) but hasn't
been confirmed with the user as the intended direction, and touches
multiple rendering paths (bars, rings-adjacent consistency, chart y-axis)
whose exact scope depends on the answers.
