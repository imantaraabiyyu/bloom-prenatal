# Assessment — Hide long inline hint text behind a "?" popup

## Request (verbatim, translated)

"Hide all long text like [example], put it into a popup that appears when
the ? icon is clicked." Example given: the CSV column-format hint
("Kolom yang dikenali: date, meal, calories, ... Baris dengan tanggal
sama akan dijumlahkan otomatis.").

## Current behavior — inventory of long inline hint text

Grepped every dashboard page for the existing hint-style classes
(`.format-hint`, `.attach-hint`, `.trend-note`) plus `.disclaimer`.
Found across 4 files:

### Strong candidates (long, static "how this works" explainers — good fit for a popup)

1. `app/dashboard/page.js:523-528` — CSV meal column format hint (the
   user's exact example).
2. `app/dashboard/page.js:579-582` — vitamin CSV data-accuracy disclaimer.
3. `app/dashboard/page.js:762` — "nutrisi tambahan" one-liner (no target
   yet for free-form nutrients).
4. `app/dashboard/page.js:847` — trend chart's dashed-line-at-100%
   explanation.
5. `app/dashboard/journal/page.js:583-586` — attachment size/count/mic
   limits.
6. `app/dashboard/profile/page.js:272-275` — what the "Nama" field is for.
7. `app/dashboard/profile/page.js:297-303` — what push notifications do +
   the iOS Add-to-Home-Screen caveat (the longest one found).
8. `app/dashboard/profile/page.js:330-335` — HPHT definition.

### Found but NOT good candidates (excluded — different purpose)

- `app/dashboard/page.js:489-493` (`.format-hint.trimester-hint`) — a
  conditional **warning with a call-to-action link** ("HPHT belum
  diset... atur di tab Profil"), not reference documentation — hiding an
  actionable warning behind an extra click works against its own purpose.
- `app/dashboard/profile/page.js:292-294` — a one-line status message
  ("push tidak didukung di browser ini"), too short to need a popup.
- `app/dashboard/profile/page.js:362` — a live **computed value** ("→
  HPHT dihitung otomatis: ..."), not documentation — it's feedback on
  what you just typed, needs to stay visible inline.
- Every `.disclaimer` block (4 total, one per page bottom) — medical/
  privacy notices (AI-generated content caveats, data storage practices).
  These exist specifically to always be visible, not tucked-away
  reference info; converting them would work against their safety/legal
  purpose.

### No existing "?"-triggered popup/tooltip component anywhere

Confirmed via grep (`grep -rn "popover\|tooltip\|Popover\|Tooltip"`) —
nothing exists yet. This is new shared UI, likely used from 3 files
(`app/dashboard/page.js`, `app/dashboard/journal/page.js`,
`app/dashboard/profile/page.js`), which argues for one small reusable
component (e.g. `components/HelpTip.js`) rather than 8 copies of the same
click-to-toggle logic.

## Files/functions likely in scope

- New: a shared `components/HelpTip.js` (or similar) — a "?" button that
  toggles a small popover containing arbitrary children, plus its CSS.
- `app/dashboard/page.js`, `app/dashboard/journal/page.js`,
  `app/dashboard/profile/page.js` — replace each of the 8 "strong
  candidate" blocks above with `<HelpTip>...</HelpTip>` (or similar),
  removing the always-visible text.
- `app/globals.css` — new popover styling.

## Ambiguities (unresolved — block a SIMPLE classification)

1. **Scope**: convert all 8 identified blocks, or a subset? (The 4
   excluded ones above are a judgment call the user should confirm, not
   assume.)
2. **Interaction model**: a tooltip anchored to the "?" (opens near the
   icon, closes on click-outside or a second click) vs. a small modal/
   dialog (centered, explicit close button) — different complexity and
   feel.
3. **New, unrelated request arrived mid-assessment**: "buat tampilan web
   dan mobile lebih elegan dan tambahkan icon yang lebih lucu" (make the
   web/mobile look more elegant, add cuter icons) — far broader and
   vaguer than this popover request (which pages, what "elegant" means
   concretely, which icons, emoji vs. an icon library). Bundling it into
   this plan would blow up scope well past what "hide long text in a
   popup" needs. Needs its own separate clarifying round — asking below
   whether the user wants it queued as a follow-up run after this one, or
   wants to fold in something specific right now.

## Triage

**Triage: COMPLEX** — no existing "?"/popover UI pattern to reuse (new
shared component needed), 3 files touched with a real interaction-design
decision undetermined, and genuine scope ambiguity (which blocks qualify).
