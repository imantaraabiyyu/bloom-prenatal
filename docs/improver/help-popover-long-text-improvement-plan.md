# Improvement Plan — Hide long inline hint text behind a "?" popup

## Goal

Replace 8 long, always-visible static hint/explainer text blocks across
the Dashboard, Journal, and Profile pages with a "?" icon that reveals
the same text in a small popup on click — per the user's answers: all 8
identified blocks, a tooltip-style popup (not a modal), closing on a
second click or an outside tap.

## Current behavior

Grepped `.format-hint`/`.attach-hint`/`.trend-note`/`.disclaimer` across
`app/dashboard/page.js`, `app/dashboard/journal/page.js`,
`app/dashboard/profile/page.js`. 8 blocks are long, static "how this
works" reference text (CSV column list, page.js:523-528; vitamin CSV
accuracy note, page.js:579-582; "nutrisi lain" note, page.js:762; trend
chart note, page.js:847; journal attachment limits,
journal/page.js:583-586; profile "Nama" field explainer,
profile/page.js:272-275; profile push-notification explainer,
profile/page.js:297-303; profile HPHT definition, profile/page.js:330-335).
4 similar-looking blocks are deliberately excluded (confirmed with the
user): the HPHT-not-set warning-with-link (page.js:489-493, actionable,
not reference info), a one-line push-unsupported status message
(profile/page.js:292-294), a live computed value ("→ HPHT dihitung
otomatis...", profile/page.js:362), and every page's `.disclaimer` block
(medical/privacy notices meant to always be visible).

No existing "?"/popover/tooltip component exists (confirmed via grep for
`popover`/`tooltip`). The closest existing pattern is
`app/dashboard/chat/page.js`'s `attachMenuOpen`/`attachMenuRef` toggle-
dropdown (lines ~72, 104-117) — a `useEffect` gated on the open boolean,
listening for `mousedown`+`touchstart` outside the ref'd element to
close, cleaned up on unmount/toggle.

## Proposed change

1. New `components/HelpTip.js` — a small "?" button (`<span
   className="help-tip">`) that toggles a bubble (`<span
   className="help-tip-bubble">{children}</span>`) on click, using the
   exact same `mousedown`+`touchstart` outside-click-close technique as
   `chat/page.js`'s existing dropdown, for consistency rather than a new
   pattern.
2. New `app/globals.css` rules: `.help-tip` (positioning context),
   `.help-tip-trigger` (small circular "?" button, matches this app's
   existing small-icon-button sizing), `.help-tip-bubble` (dark card,
   absolutely positioned below the trigger, `max-width: min(280px,
   calc(100vw - 40px))` so it can't overflow a narrow mobile viewport).
3. Replace each of the 8 blocks in place with `<HelpTip>` wrapping the
   same text, anchored next to the heading it explains (or, for the two
   sites with no adjacent heading, a small inline label + the icon
   replacing the old paragraph). Dynamic/conditional content at each site
   (status messages, computed values) is untouched.

## Scope

### In scope
- `components/HelpTip.js` — new.
- `app/globals.css` — new popover styles.
- `app/dashboard/page.js` (4 sites), `app/dashboard/journal/page.js`
  (1 site), `app/dashboard/profile/page.js` (3 sites).

### Out of scope / non-goals
- The 4 excluded blocks stay exactly as-is.
- The separate "more elegant + cuter icons" request — its own follow-up.
- No icon library dependency — plain "?" text trigger.

## Steps

1. `components/HelpTip.js`: implement the toggle + outside-click-close
   component.
2. `app/globals.css`: add `.help-tip`/`.help-tip-trigger`/
   `.help-tip-bubble`.
3. `app/dashboard/page.js`: import `HelpTip`; convert the 4 sites.
4. `app/dashboard/journal/page.js`: import `HelpTip`; convert the 1 site.
5. `app/dashboard/profile/page.js`: import `HelpTip`; convert the 3 sites.
6. `npm run build` + `npm test` to confirm no regressions.

## Data / schema impact

None — presentational change only.

## Risks & mitigations

- **Bubble overflowing a narrow mobile viewport** — mitigated by the
  `max-width: min(280px, calc(100vw - 40px))` cap; verified visually
  post-implementation at a mobile width.
- **Losing the excluded blocks' distinct visibility** by mistakenly
  converting one of them — mitigated by only touching the 8 confirmed
  sites, leaving the 4 excluded ones' JSX completely untouched (verified
  by diffing exactly which lines change per file).
- **Two different toggle mechanisms coexisting** (the new HelpTip vs.
  chat's existing attach-menu) drifting apart over time — mitigated by
  HelpTip deliberately mirroring chat's exact outside-click technique
  rather than inventing a different one.

## Test plan

- No pure-logic function introduced — regression guard only: `npm test`
  (existing 23 tests, untouched) stays green, `npm run build` succeeds.
- Manual: click each of the 8 "?" icons and confirm the right text shows;
  confirm a second click and an outside tap/click both close it; confirm
  the 4 excluded blocks still render exactly as before (unconverted);
  check the bubble doesn't overflow at a mobile viewport width.

## Standards notes

No `kredivo-docs` areas touched — client-side presentational component
only.
