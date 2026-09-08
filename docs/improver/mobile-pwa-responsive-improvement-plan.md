# Improvement Plan — Mobile display when installed as a PWA

## Goal

Fix the mobile display specifically for when Bloom is installed as a PWA
(Android, via Chrome "Install app" — the platform the user confirmed):
content overlapped by the status bar/gesture-navigation area, text/elements
that feel small and cramped, and the top nav not fitting well — per the
user's answers, resolved as a bottom tab bar rather than squeezing/
scrolling the existing top pills.

## Current behavior

- `public/manifest.json`: `display: "standalone"`.
- `app/layout.js` ([layout.js:4-13](../../app/layout.js#L4-L13)): `appleWebApp.statusBarStyle:
  "black-translucent"`, `viewport` export has only `{ themeColor:
  "#251722" }` — no `viewportFit: "cover"`, so `env(safe-area-inset-*)`
  never activates anywhere in the app (confirmed via grep — zero
  occurrences repo-wide).
- `app/globals.css`: `.topbar` ([globals.css:40](../../app/globals.css#L40), `padding: 20px 0 0`) and
  `.wrap` ([globals.css:18](../../app/globals.css#L18), `padding: 0 20px 60px`) have no safe-area
  padding. `.topbar-nav`/`.nav-link` ([globals.css:47-50](../../app/globals.css#L47-L50)) render as a
  top row of pills, identical markup duplicated across all 4 dashboard
  pages. The existing `@media (max-width: 560px)` block
  ([globals.css:414-474](../../app/globals.css#L414-L474)) already handles touch-target sizing, form
  stacking, and a `dvh`-aware full-height layout for `.chat-page`, but has
  no safe-area or bottom-nav handling, and several label/detail texts
  remain under 12px (e.g. `.summary-card .lbl` at 66, `.meal-list-detail`
  at 152, `.vitamin-detail` at 214, `.pregnancy-stat-label` at 205,
  `.mini-calendar-weekdays span` at 183, `.ring-legend-value` at 165,
  `.extra-nutrient-label` at 114, `.transcript-preview-label` at 318).

## Proposed change

1. **Safe-area support** — add `viewportFit: "cover"` to `layout.js`'s
   `viewport` export; pad `.topbar`'s top and `.wrap`'s left/right with
   `env(safe-area-inset-*)`. Resolves to `0` outside standalone/edge-to-
   edge mode, so this is a no-op in a normal browser tab.
2. **Bottom tab bar (mobile only)** — restyle the *existing*
   `.topbar-nav` markup (no JSX changes) into a fixed bottom bar inside
   the `560px` breakpoint: `position: fixed; bottom: 0`, even-width flex
   row, `env(safe-area-inset-bottom)` padding, emoji icons injected via
   `::before` keyed off each link's `href` attribute (matches the app's
   existing emoji-icon style). `.wrap` and `.chat-page`'s mobile layout
   get bottom clearance added so the fixed bar doesn't cover content.
3. **Targeted text/tap-target bumps (mobile only)** — bump the sub-12px
   label/detail selectors listed above by ~1–1.5px; enlarge padding on
   list-row action buttons used often (vitamin/meal/journal-entry/baby-
   name remove, journal-entry edit, extra-nutrient remove) and the mini-
   calendar prev/next-month buttons (currently fixed 24×24px) toward a
   ~40px tap area. Left alone: the small corner remove-badges on photo/
   video attachment thumbnails (different UI convention, out of scope).

## Scope

### In scope
- `app/layout.js` — `viewportFit: "cover"` on the `viewport` export.
- `app/globals.css` — safe-area padding (`.topbar`, `.wrap`), the new
  fixed bottom-tab-bar ruleset for `.topbar-nav`/`.nav-link` inside the
  mobile breakpoint, `.chat-page` bottom-clearance, and the targeted
  font-size/tap-target selector bumps.

### Out of scope / non-goals
- No icon library — emoji icons, consistent with the app's existing style.
- No change to desktop/tablet (>560px) layout at all.
- No broad font-size/padding pass beyond the specific selectors listed
  (user chose "targeted" over "menyeluruh").
- The small circular remove-badges on attachment thumbnails
  (`.pending-remove-btn`, `.entry-attachment-remove`) — different,
  arguably-fine corner-badge convention, higher regression risk to touch.
- iOS-specific code: none needed — `env(safe-area-inset-*)`/
  `viewport-fit=cover` are the standard cross-browser mechanism (Chrome
  and Safari both honor them), so iOS benefits too without extra code.

## Steps

1. `app/layout.js`: add `viewportFit: "cover"` to the `viewport` export.
2. `app/globals.css`: add `env(safe-area-inset-top)` to `.topbar`'s top
   padding and `env(safe-area-inset-left/right)` to `.wrap`'s side
   padding (base rules, harmless outside standalone mode).
3. `app/globals.css`, inside `@media (max-width: 560px)`:
   a. Restyle `.topbar-nav` as a fixed bottom bar (even-width flex row,
      background, top border, `env(safe-area-inset-bottom)` padding);
      add `::before` icon rules keyed off each link's `href`.
   b. Increase `.wrap`'s mobile `padding-bottom` to clear the bar's
      height + safe-area inset; add matching bottom clearance to
      `.chat-page`'s innermost flex container.
   c. Bump the listed sub-12px label/detail selectors by ~1–1.5px.
   d. Increase padding on the listed list-row action buttons and the
      mini-calendar prev/next-month buttons toward a ~40px tap area.
4. `npm run build` + `npm test` to confirm no regressions.

## Data / schema impact

None — CSS/metadata only.

## Risks & mitigations

- **Fixed bottom bar covering content on a page with its own bottom-
  pinned UI** (`.chat-page`'s input row) — mitigated by adding matching
  bottom clearance to that page's flex container specifically, not just
  `.wrap`.
- **`::before` icon selectors keyed off `href` silently matching nothing**
  if a `<Link>`'s href ever changes — low risk (these 4 routes are stable,
  named directly in each page's nav), and a missing icon degrades to
  "text-only pill" (the current look), not breakage.
- **Safe-area padding regressing desktop/non-standalone layout** —
  mitigated by `env()` resolving to `0` whenever `viewport-fit=cover`
  isn't in effect, confirmed as the documented behavior of the CSS Env
  Variables spec this relies on.

## Test plan

- No new pure-logic function is introduced (CSS/metadata-only change), so
  no new unit tests apply. Regression guard: `npm test` (existing 23
  tests) must stay green; `npm run build` must still succeed.
- Manual verification: resize to ≤560px and confirm the bottom tab bar
  renders with the correct active tab per page, page content isn't hidden
  behind it, and devtools' notched-device preset shows `.topbar` clearing
  the simulated status bar. Real on-device confirmation (Android, Chrome
  "Install app") is the actual proof for the safe-area fix — devtools
  can't fully simulate standalone-mode insets — left to the user as a
  documented follow-up.

## Standards notes

No `kredivo-docs` areas touched (not auth/SSO, WIF/GCP, Terraform/IaC, or
Dockerfile/compose) — this is a CSS/PWA-metadata change only.
