# Implementation Log — Hide long inline hint text behind a "?" popup

Branch: `main` (per the user's choice; working tree had only the user's
own unrelated untracked docs files at Step 0, no conflict).

## Step 1 — `components/HelpTip.js` (new)

Toggle "?" button + bubble, mirroring `app/dashboard/chat/page.js`'s
existing `attachMenuOpen`/`attachMenuRef` outside-click-close technique
(`mousedown`+`touchstart` listeners, cleaned up on unmount/toggle) rather
than inventing a second pattern for the same interaction.

## Step 2 — `app/globals.css`

Added `.help-tip`/`.help-tip-trigger`/`.help-tip-bubble`, placed next to
the existing `.attach-menu*` rules it mirrors. Bubble capped at
`max-width: min(280px, calc(100vw - 40px))` so it can't overflow a narrow
mobile viewport (same concern this session's earlier mobile-PWA run dealt
with for other overlay elements).

## Steps 3-5 — the 8 conversion sites

All 8 confirmed sites from the assessment converted, each anchored next
to its heading (`<h2>`/`<h3>`) via `<HelpTip>` — except the journal
attachment-limits hint, which has no adjacent heading (it sits inside a
shared `renderAttachSection(target)` helper used by both the composer and
edit form), so it kept its existing `.attach-hint` wrapper div but with a
short "Batas lampiran" label + the icon replacing the old always-visible
paragraph.

- `app/dashboard/page.js` (4): "Menu makan" (CSV column list),
  "Vitamin dari dokter" (data-accuracy note), "Nutrisi lain — {date}"
  (no-target-yet note), "Tren dari hari ke hari" (dashed-line note).
- `app/dashboard/journal/page.js` (1): attach-row limits, inside
  `renderAttachSection` — converts it for both the composer and edit form
  in one place, consistent with that function already being shared
  between them (see the prior journal improver run this session).
- `app/dashboard/profile/page.js` (3): "Nama" (field purpose),
  "Notifikasi" (what push does + iOS caveat), "Usia kehamilan" (HPHT
  definition).

**One small behavior change beyond a pure move, decided during
implementation**: the "Notifikasi" push explainer used to only render
inside the `pushSupported` branch (so a browser without push support
never saw it at all). Moved it to the `<h2>` itself, unconditional —
explaining what push *would* do is still useful information even in an
unsupported browser, and keeping it conditional would have meant writing
the same `<HelpTip>` block twice (once per branch) for no real benefit.
The `!pushSupported` short status message and the `pushPermission ===
"denied"` error box are both untouched, still conditional as before.

Confirmed via `grep` that all 4 excluded blocks (HPHT-not-set warning,
push-unsupported status message, HPHT-computed-value line, and every
`.disclaimer`) are still present, unconverted, exactly as they were.

## Tests

No pure-logic function introduced — presentational component + JSX
rewiring only. Regression guard:

```
$ npm run build
✓ Compiled successfully
✓ Generating static pages (13/13)

$ npm test
 Test Files  3 passed (3)
      Tests  43 passed (43)
```

Both green. Note: the test count (43, across 3 files) reflects concurrent
work already in this repo from outside this run (`lib/gemini.test.js` is
new, `lib/nutrition.test.js` is modified) — neither belongs to this
improvement and neither is staged in this run's commit; confirmed via
`git status` that only this run's own files (`components/HelpTip.js`,
`app/globals.css`, the 3 page files, and this run's own `docs/improver/*`
triple) are included.

## CLAUDE.md (Step 10)

Marker `<!-- beehive:improver-skill-auto-invoke -->` already present —
already enabled, no question asked, no edit made.

## Deferred / follow-ups (not in scope for this run)

- The separate "make the web/mobile look more elegant, add cuter icons"
  request — per the user's own choice, queued as its own follow-up
  clarifying round, not folded into this run.
- Manual on-device check of the 8 "?" icons (open/close behavior, mobile
  viewport overflow) — left to the user, same as prior runs this session.
