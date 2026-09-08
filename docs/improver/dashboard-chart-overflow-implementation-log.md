# Implementation Log — Trend chart page zoom-out + >100% bar markers

Branch: `main` (per the user's explicit choice — working tree was already
clean and in sync with origin at Step 0, consistent with this session's
established pattern of working directly on main).

## Step 1 — `app/globals.css`: grid blowout fix

Changed `.bloom-grid`'s `grid-template-columns` from `1fr` to
`minmax(0, 1fr)` (base rule), and the `@media (min-width: 820px)`
override's `340px 1fr` to `340px minmax(0, 1fr)`. This is the root-cause
fix: the trend chart's SVG and scroll-container CSS were already correct
(confirmed during assessment — `tw` already scales with day count,
`.trend-svg-wrap` already had `overflow-x: auto`), they just never got the
chance to activate because the grid track upstream refused to shrink
below the SVG's intrinsic width, forcing the whole page's layout (and,
per the user's own description, the mobile browser's effective zoom) to
grow to fit it instead.

## Step 2 — `app/globals.css`: over-100% marker styling

- Added `position: relative` to `.water-bar-fill` and `.nutrient-bar-fill`
  (needed for the marker's `position: absolute`).
- Added one shared rule,
  `.nutrient-bar-fill.over::after, .water-bar-fill.over::after` — a small
  5px dot (`background: var(--text)`) positioned at the fill's right
  edge, inset 2px so it stays inside the track's existing
  `overflow: hidden` instead of getting clipped by it.
- `.hist-bar-fill` deliberately not touched — confirmed during assessment
  its value is an average of already-100-capped per-nutrient percentages,
  so it's mathematically incapable of exceeding 100; adding a marker rule
  for an unreachable case would be dead code.

## Step 3 — `app/dashboard/page.js`: gate the marker class

- `water-bar-fill`: `className` now
  `` `water-bar-fill${waterPct > 102 ? " over" : ""}` `` ([page.js:776](../../app/dashboard/page.js#L776)).
- `nutrient-bar-fill`: same pattern with `pct > 102`
  ([page.js:830](../../app/dashboard/page.js#L830)).
- `102` (not `100`) matches the ring's own existing `frac > 1.02`
  tolerance ([page.js:675](../../app/dashboard/page.js#L675)) — kept consistent rather than
  introducing a second, different threshold for the same concept.
- The bar's own fill color/width logic (`Math.min(pct, 100)%`,
  `meta.color`/`waterStatus.color`) is completely unchanged — this is
  purely additive, per the user's chosen "small marker, no recolor"
  option.

## Tests

No new pure-logic function was introduced (CSS + a conditional className
string, no new exported function) — matching what the plan's Test plan
said to expect. Ran the regression guard:

```
$ npm test
 Test Files  2 passed (2)
      Tests  23 passed (23)

$ npm run build
✓ Compiled successfully
✓ Generating static pages (13/13)
```

Both green, no regressions. Manual/on-device verification — confirming
the page no longer zooms out with the user's real ~18-day dataset, and
that the marker actually shows on their over-100% nutrients (Zat besi,
Kalsium, Folat per the original screenshot) — is left to the user, same
as the prior mobile-PWA run's safe-area fix.

## CLAUDE.md (Step 10)

Marker `<!-- beehive:improver-skill-auto-invoke -->` already present —
already enabled, no question asked, no edit made.

## Deferred / follow-ups (not in scope for this fix)

- The trend chart's shared y-axis scale (`maxVal`/`yPos` in page.js) still
  auto-stretches to the single highest percentage across the entire
  dataset — a real, related visual issue (one extreme day compresses
  every other line vertically) found during assessment, but the user's
  own description of the problem was specifically the grid-blowout/
  zoom-out symptom (now fixed), not this. Worth a separate run if the
  chart still looks visually cramped once the zoom-out is gone.
- `minmax(0, 1fr)` benefits `.hist-table-wrap` (same underlying grid-track
  exposure) as a side effect, at no extra implementation cost — not
  independently verified beyond the shared root-cause reasoning, since it
  wasn't a separately reported issue.
