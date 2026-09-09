# Assessment — Polish weight-tracker trend visibility + input layout

## Current behavior

### Trend chart hidden until 2+ entries (`app/dashboard/page.js:1319` area)
The "Tren berat badan" panel is gated on `datesWithWeight.length > 1` — with 0 or 1 logged
weigh-ins, the whole panel renders nothing (no placeholder, no message). This is almost certainly
why the user's ask read as "make a trend graph" — a fresh account (or one with a single entry)
never sees the panel exist at all. The underlying geometry (`wxPos`/`wyPos`, computed a few hundred
lines above the JSX) already special-cases `weightTrendData.length === 1` (centers the single point
instead of dividing by zero) — so the SVG itself already renders sensibly with exactly one point;
only the outer `.length > 1` gate needs to change.

### Weight-input row (`app/dashboard/page.js:1118-1141`)
Reuses the water widget's `.water-widget`/`.water-widget-label`/`.water-widget-value`/
`.water-custom-row` classes as-is. `.water-custom-row` (`app/globals.css:164`) is `display:flex;
gap:8px` with `input { flex:1 }` — designed for water's one input + one button. Squeezing a date
input + a number input + a button into that same row gives all three equal width with no visual
hierarchy, and today's value is shown as small mono text (`.water-widget-value`), not as a
prominent stat the way the Profile page's gestational-age numbers are
(`.pregnancy-stat-value`, `app/globals.css:230` — 22px Fraunces serif).

**Constraint**: `.water-widget`/`.water-custom-row`/`.water-widget-label`/`.water-widget-value`
are also used by the actual water-intake panel above this one (`app/dashboard/page.js:1007-1029`)
— any restyle must use new, dedicated classes for the weight panel rather than editing these
shared ones, or the water widget's appearance changes too (a real blast-radius risk, avoided by
not touching those class definitions at all).

### Reusable precedents already in the codebase
- `.pregnancy-stat`/`.pregnancy-stats`/`.pregnancy-stat-value`/`.pregnancy-stat-label`
  (`app/globals.css:228-231`) — the "big focal number + small label underneath" pattern the user
  picked, already used on the Profile page's gestational-age card.
- `.rings-empty` (`app/globals.css:185`) — the existing "not enough data yet" placeholder pattern
  (icon + centered muted text), used when the rings panel has nothing to show.
- `.meal-list-remove` (`app/globals.css:179`) — the existing small muted icon-button delete
  affordance (rose on hover), already shared across meal/vitamin/babyname rows.
- `.manual-form-row input[type="text"], .manual-form-row input[type="date"]`
  (`app/globals.css:126`) — styles text/date inputs inside a `.manual-form-row`, but **not**
  `input[type="number"]` yet (nothing currently puts a number input directly in one) — extending
  this selector list is additive and touches no existing usage.

## Clarifying answers (via AskUserQuestion this session)
1. **Trend visibility**: show something even with <2 entries — an empty-state placeholder at 0
   entries, and plot the single point (as a dot) at exactly 1 entry.
2. **Input layout**: "big focal stat + form below" — today's weight as a large serif number (same
   treatment as the Profile page's gestational-age stat), full-width Simpan button, date field
   de-emphasized as a small secondary control (not shown by default).

## Files/functions in scope
- `app/dashboard/page.js` — the "Berat badan" panel JSX (stat row + form), the "Tren berat badan"
  panel's gating condition + empty-state branch. New local state: a boolean to toggle the
  de-emphasized date field open/closed (defaults closed, resets on day-nav).
- `app/globals.css` — new dedicated classes for the weight panel's stat row + de-emphasized date
  toggle; one additive extension to the existing `.manual-form-row` input-type selector list
  (adds `input[type="number"]`, affecting only new usage).

## Triage
Bounded scope (2 files, both already identified above); no schema/data impact (pure UI + one
rendering-threshold change); no `$KDOCS` area (app-level presentational work); no open ambiguity
(both design directions confirmed via AskUserQuestion above); low blast radius (new dedicated CSS
classes for the weight panel, shared `.water-*` classes left untouched, the one extended selector
only ever matched nothing before).

Triage: SIMPLE — 2 files, no schema/KDOCS impact, ambiguity resolved via clarifying questions
before this triage line, blast radius contained by using new/additive CSS rather than editing the
water widget's shared classes.
