# Implementation Log — Mobile display when installed as a PWA

Branch: plan approved and implemented on `improve/mobile-pwa-responsive`
(agent-proposed name, created off `main`). Mid-implementation, concurrent
activity outside this conversation (the user, working in parallel)
committed an unrelated one-line `vercel.json` fix on that same branch,
opened PR #15, and merged it into `main` — then checked the working tree
back out to `main` and pulled the merge. This repo's uncommitted mobile
CSS/layout edits rode along through all of it intact (verified via `git
diff --stat` immediately after: `app/globals.css` +67/-4, `app/layout.js`
+6, nothing lost or conflicting), and the merged PR touched only
`vercel.json` (confirmed via `git show`), not `globals.css`/`layout.js` —
no overlap with this run's scope. Per the user's explicit choice, this
run's work is committed directly to `main` (where the working tree already
sat) rather than re-routed back through the now-superseded
`improve/mobile-pwa-responsive` branch.

## Step 1 — `app/layout.js`

Added `viewportFit: "cover"` to the `viewport` export — the one flag that
turns on non-zero `env(safe-area-inset-*)` values at all; without it every
safe-area rule below would just resolve to `0` even in standalone mode.

## Step 2 — `app/globals.css`: base safe-area padding

- `.wrap`: added `env(safe-area-inset-left)`/`-right` to its horizontal
  padding.
- `.topbar`: added `env(safe-area-inset-top)` to its top padding.

Both resolve to `0` outside standalone/edge-to-edge mode, so a normal
browser tab is unaffected — confirmed by the successful `npm run build`
(no runtime behavior depends on the env() value at build time, and the
existing test suite doesn't touch rendering, so this is a build-only
sanity check for now; real confirmation is the manual/on-device check
below).

**Deviation caught before it caused a bug:** the existing mobile breakpoint
(`@media max-width: 560px`) already *overrides* `.wrap` and `.topbar`'s
padding for mobile specifically (`.wrap { padding: 0 14px 40px; }`,
`.topbar { padding: 14px 0 0; }`) — meaning the base-rule safe-area
addition above would have been silently discarded on exactly the
screens/mode this fix targets. Caught this by re-reading the full mobile
block before moving on, and folded the safe-area calc() into those
mobile-specific overrides too (see Step 3) rather than only the base
rules.

## Step 3 — `app/globals.css`: bottom tab bar (mobile only)

Inside the existing `@media (max-width: 560px)` block:
- Added a `--bottom-nav-h: 58px` custom property (on `:root`, scoped to
  the media query) so the bar's own height and every place that needs to
  clear it share one number.
- `.wrap`'s mobile override: bottom padding now
  `calc(var(--bottom-nav-h) + env(safe-area-inset-bottom) + 12px)`
  instead of a flat `40px`; left/right now carry the safe-area calc too.
- `.topbar`'s mobile override: top padding now
  `calc(14px + env(safe-area-inset-top))`.
- `.topbar-nav` (the *existing* markup, unchanged in every page's JSX):
  `position: fixed; bottom: 0`, flex row, background + top border,
  `env(safe-area-inset-bottom)` padding.
- `.nav-link`: restyled as a flex column (icon over label) at this
  breakpoint only; `.nav-link.active`'s existing 2-class rule still wins
  by specificity regardless of source order, so the active-tab highlight
  is unaffected.
- Icons added via `::before { content: "..." }` keyed off each link's
  `href` attribute (`a[href="/dashboard"]`, etc.) — confirmed Next's
  `<Link>` renders a plain `<a href>`, so this needed **zero JSX changes**
  across the 4 dashboard pages, exactly as planned.

**Simplification found during implementation:** the plan called for adding
separate bottom-clearance to `.chat-page`'s inner flex container. Checked
`app/dashboard/chat/page.js` first and found `.chat-page` and `.wrap` are
the *same element* (`className="wrap chat-page"`) — so the `.wrap`
mobile-padding fix above already covers it, and no `.chat-page`-specific
rule was needed. Noted here rather than adding a redundant/drifting extra
rule.

## Step 4 — `app/globals.css`: targeted text/tap-target bumps (mobile only)

- Bumped 8 sub-12px label/detail selectors (`.summary-card .lbl`,
  `.extra-nutrient-label`, `.meal-list-detail`, `.ring-legend-value`,
  `.pregnancy-stat-label`, `.vitamin-detail`,
  `.mini-calendar-weekdays span`, `.transcript-preview-label`) to
  12–12.5px.
- Grew tap-target padding (to `10px`, from 2–6px) on 6 list-row action
  buttons (`.vitamin-remove`, `.meal-list-remove`, `.babyname-remove`,
  `.journal-entry-edit`, `.journal-entry-remove`,
  `.extra-nutrient-row button`) and the mini-calendar's prev/next-month
  buttons (24×24px → 36×36px).
- Left untouched, as planned: `.pending-remove-btn` /
  `.entry-attachment-remove` (corner badges on attachment thumbnails).

## Tests

No new pure-logic function was introduced — this is a CSS/PWA-metadata-only
change, matching what the plan's Test plan said to expect. Ran the
regression guard:

```
$ npm test
 Test Files  2 passed (2)
      Tests  23 passed (23)

$ npm run build
✓ Compiled successfully
✓ Generating static pages (13/13)
```

Both green, no regressions. Manual/on-device verification (resizing to
≤560px, devtools notched-device preset, and — the real confirmation for
the safe-area fix specifically — installing via Chrome's "Install app" on
an actual Android phone) is left to the user, exactly as the approved plan
said devtools can't fully simulate standalone-mode safe-area insets.

## CLAUDE.md (Step 10)

Marker `<!-- beehive:improver-skill-auto-invoke -->` already present
(added by an earlier run) — already enabled, no question asked, no edit
made.

## Deferred / follow-ups (not in scope for this fix)

- Real-device confirmation of the safe-area fix (Android, Chrome "Install
  app") — the one thing this run couldn't verify itself.
- The "menyeluruh" (broad) font-size/padding pass was explicitly declined
  in favor of "targeted" — worth a separate run if the targeted bump
  turns out insufficient once seen on a real device.
- `vercel.json`'s duplicate `kind=night` cron entry (flagged earlier this
  conversation, unrelated to this fix) is now merged into `main` — still
  unresolved, the user's own item.
