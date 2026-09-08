# Improvement Plan — Trend chart page zoom-out + >100% bar markers

## Goal

Fix the trend chart so it doesn't force the whole page to zoom out once
enough days of history accumulate (the user's exact words: "chart tren
dari hari ke hari panjang, halaman jadi zoom out"), and add a small
over-target marker to the bar-fills that can exceed 100% — mirroring the
existing ring-chart convention — per the user's chosen treatment.

## Current behavior (root cause, re-diagnosed from the user's answer)

`app/dashboard/page.js:446` already scales the trend SVG's width with day
count (`tw = Math.max(560, trendData.length * 90)` — ~1620px at 18 days),
and `.trend-svg-wrap` (`app/globals.css`) already has
`width:100%; overflow-x:auto` — this *should* make it a self-contained
horizontally-scrollable region. It doesn't, because of a classic CSS Grid
sizing bug: `.trend-svg-wrap` sits inside `.panel.full`, a grid item of
`.bloom-grid`, whose track is declared as a bare `1fr`
(`grid-template-columns: 1fr`, and `340px 1fr` at ≥820px). A `1fr` track's
automatic minimum size is `auto` (the content's min-content size) unless
the track itself uses `minmax(0, 1fr)` — so the grid track (and everything
in it) refuses to shrink below the *intrinsic* width of its content,
which includes the 1620px SVG several levels down. The nested
`overflow-x:auto` never gets a chance to activate, because the grid
track — and therefore the whole page's rendered layout width — grows to
fit it instead. On a mobile viewport (`width=device-width`), a page whose
actual layout is wider than the device is exactly what makes the browser
render everything zoomed out to fit — matching the user's description
precisely.

Separately, three bar-fills already correctly cap their own `width` at
`Math.min(pct, 100)%` (`water-bar-fill` at page.js:776,
`nutrient-bar-fill` at page.js:830, `hist-bar-fill` at page.js:898) — no
overflow bug there — but give zero visual signal that a value is *over*
100%, unlike the rings (page.js:675-677), which already draw a small
marker dot when `frac > 1.02`.

**One of the three doesn't actually need a marker**: `hist-bar-fill`'s
value (`a`, page.js:891) is an *average of already-capped-at-100
per-nutrient values* (`p.reduce((x, y) => x + Math.min(y, 100), 0) /
p.length`) — mathematically it can never exceed 100, so there's nothing
to mark there. Only `nutrient-bar-fill` (`pct`, uncapped at the source,
page.js:826) and `water-bar-fill` (`waterPct`, uncapped, page.js:224) can
genuinely exceed 100% and need the marker.

## Proposed change

1. **Grid blowout fix** (`app/globals.css`) — change `.bloom-grid`'s
   `grid-template-columns` from `1fr` to `minmax(0, 1fr)` (both the base
   single-column rule and the `@media (min-width: 820px)` two-column
   override's second track). This lets `.trend-svg-wrap`'s existing
   `overflow-x:auto` (and `.hist-table-wrap`'s, same mechanism, same
   benefit) actually take effect instead of blowing out the page — the
   chart becomes a properly bounded, horizontally-scrollable region at
   whatever width it needs, and the page stops zooming out. No change to
   `tw`/day-count scaling or the y-axis logic — the width-scaling code was
   already correct, it just never got to work.
2. **Over-100% marker on bars** (`app/dashboard/page.js` +
   `app/globals.css`) — add a small marker (visually consistent with the
   ring's existing white dot, not a color change to the bar itself) shown
   when the underlying percentage exceeds 102% (same 2%-tolerance
   threshold the rings already use), on `nutrient-bar-fill` and
   `water-bar-fill` only (`hist-bar-fill` is mathematically capped at
   ≤100%, so excluded — see above). Implemented as a conditional class +
   an absolutely-positioned `::after` dot sitting inside the fill's own
   box at its right edge (tracks already have `overflow:hidden`, so the
   marker stays visually contained within the rounded track, not poking
   outside it).

## Scope

### In scope
- `app/globals.css` — `.bloom-grid` grid-template-columns (both rules);
  new marker styling for `.nutrient-bar-fill.over`/`.water-bar-fill.over`.
- `app/dashboard/page.js` — conditionally add an `over` class to the
  nutrient-rincian and water bar-fill divs when their percentage exceeds
  102.

### Out of scope / non-goals
- `.hist-bar-fill` — excluded, mathematically can't exceed 100% (see
  above); adding dead code for an unreachable case would be pointless.
- The trend chart's shared y-axis scale (`maxVal`/`yPos`) — a separate,
  related-but-distinct visual issue found during assessment (one extreme
  day compresses every other line vertically), but the user's own
  description of the problem was specifically the grid-blowout/zoom-out
  symptom, not this — not touched here. Noted as a deferred follow-up.
- No change to the per-nutrient brand-color scheme used by
  `nutrient-bar-fill`/rings-legend/trend-chart-lines — the marker is
  additive, not a recolor (per the user's chosen "Recommended" option).

## Steps

1. `app/globals.css`: `.bloom-grid { grid-template-columns: 1fr; }` →
   `minmax(0, 1fr)`; same for the `@media (min-width: 820px)` override's
   `340px 1fr` → `340px minmax(0, 1fr)`.
2. `app/globals.css`: add `.nutrient-bar-fill`/`.water-bar-fill`
   `position: relative`; add a shared `::after`-based marker rule (small
   circle, `background: var(--text)`, positioned at the fill's right
   edge) gated on a new `.over` modifier class.
3. `app/dashboard/page.js`: compute `pct > 102`/`waterPct > 102` at the
   two call sites and conditionally append `" over"` to the existing
   `className="nutrient-bar-fill"` / `className="water-bar-fill"`.
4. `npm run build` + `npm test` to confirm no regressions.

## Data / schema impact

None — CSS/JSX rendering only.

## Risks & mitigations

- **`minmax(0, 1fr)` changing desktop/tablet layout unexpectedly** —
  `minmax(0, 1fr)` behaves identically to `1fr` whenever content already
  fits (the vast majority of this app's panels); it only changes behavior
  for content that would otherwise have forced a blowout, which is
  exactly the bug being fixed. Verified via `npm run build`; a full
  visual check across breakpoints is still worth the user's own on-device
  look, same as the earlier mobile-PWA improver run.
- **Marker overlapping the bar-track's rounded end-cap oddly** — sized and
  inset conservatively (small circle, a few px from the true edge) to sit
  inside the existing rounded track, matching the ring marker's scale
  relative to its own track.

## Test plan

- No new pure-logic function introduced — regression guard only:
  `npm test` (existing 23 tests) must stay green, `npm run build` must
  succeed.
- Manual check: with the user's real ~18-day dataset (or any dataset
  producing a chart wider than the viewport), confirm the page no longer
  zooms out and the chart scrolls horizontally within its own panel;
  confirm a nutrient/water value over 100% shows the small marker while
  under-100% values don't.

## Standards notes

No `kredivo-docs` areas touched — CSS/JSX rendering change only.
