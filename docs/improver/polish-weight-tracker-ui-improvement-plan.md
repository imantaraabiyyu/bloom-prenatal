# Improvement Plan — Polish weight-tracker trend visibility + input layout (SIMPLE)

## Goal
Make the "Tren berat badan" trend chart visible (with a graceful empty/single-point state) instead
of disappearing entirely below 2 logged entries, and restyle the "Berat badan" input panel so
today's value reads as a large focal stat with the form below it, the date field de-emphasized as
a small secondary toggle instead of sitting in the same row as the weight input and button.

## Current behavior
See `docs/improver/polish-weight-tracker-ui-assessment.md` for the full read — summary: the trend
panel is gated on `datesWithWeight.length > 1` (`app/dashboard/page.js`, "Tren berat badan"
section) so it renders nothing below 2 entries even though the underlying SVG geometry already
handles a single point correctly; the input panel reuses the water widget's shared
`.water-widget`/`.water-custom-row` classes, which must not be edited directly (the water panel
uses them too).

## Proposed change
- **Weight panel**: a new stat row (today's weight as a big `.pregnancy-stat-value`-style number,
  plus gain-so-far + status as a second stat when computable) with the delete action inline
  top-right; the BMI/target info paragraphs kept as-is below the stats; the form restyled as one
  clear number input + a full-width "Simpan" button, with the date field collapsed by default
  behind a small "Catat untuk tanggal lain" toggle (mirrors the de-emphasized-secondary-control
  pattern the user picked) that resets to closed whenever the viewed day changes.
- **Trend panel**: always render once `currentDate` is set; show `.rings-empty`'s existing
  "not enough data" placeholder pattern when `datesWithWeight.length === 0`; render the existing
  SVG unchanged otherwise (it already positions a lone point correctly for `length === 1`, so no
  geometry change is needed there — only the outer gate).

## Scope
- `app/dashboard/page.js` — restructure the "Berat badan" panel's JSX (stat row, form, date
  toggle + its new state), change the "Tren berat badan" panel's gating condition and add its
  empty-state branch.
- `app/globals.css` — new classes for the weight stat row + date-toggle link; extend
  `.manual-form-row`'s input-type selector to also style `input[type="number"]` (additive, no
  existing usage affected).

## Steps
1. `app/globals.css` — add the new weight-panel classes + the additive `input[type="number"]`
   selector extension.
2. `app/dashboard/page.js` — restructure the "Berat badan" panel (stat row, delete action,
   collapsed-by-default date toggle, restyled form) and its `useEffect` (close the date toggle on
   day-nav, alongside the existing `weightFormDate`/`weightDraft` resync).
3. `app/dashboard/page.js` — change the "Tren berat badan" panel's gate + add the empty-state
   branch.
4. Syntax-check + run the full existing test suite (no new pure/testable logic is introduced —
   this is JSX/CSS presentation plus a rendering-threshold conditional, matching the existing
   convention that similarly-gated panels like the rings/other trends have no dedicated tests
   either); confirm no regressions.

## Test plan
- `npx vitest run` — full suite, confirm still green (regression guard; nothing new to unit-test
  here since no pure function is added or changed).
- Manual/visual check (not automated, no component-test harness in this repo): with 0 entries the
  trend panel shows the empty-state placeholder instead of vanishing; with 1 entry it shows a
  single centered point; with 2+ it's unchanged from before. The input panel's date field stays
  hidden until "Catat untuk tanggal lain" is clicked, and saving/day-nav still upserts correctly
  (no change to `handleSaveWeight`'s logic, only to when its date field is visible).

## Triage
SIMPLE — see `polish-weight-tracker-ui-assessment.md`'s closing line: 2 files, no schema/KDOCS
impact, ambiguity resolved via clarifying questions, blast radius contained to new/additive CSS.
