# Assessment — Full visual redesign + icon library

## Request (verbatim, translated + follow-ups)

"Make the web/mobile display more elegant, add cuter icons." Follow-up
answers already collected: elegance gap is color/contrast + typography/
spacing + cross-page consistency all together (not one narrow area);
icons should move from emoji to a real SVG icon library, not stay emoji.

## Current behavior

### Visual theme

`app/globals.css:1-8` — one `:root` block: `--bg1/2/3` (radial-gradient
dark plum background), `--text`/`--text-dim`/`--text-dimmer`/
`--text-faint`, `--accent` (gold), `--lilac`, `--sage`, `--rose`,
`--panel`/`--panel-border`. Three fonts via one Google Fonts `@import`:
Fraunces (serif, headings), Work Sans (body), IBM Plex Mono (labels/
data/mono accents). No dark/light mode split — single fixed dark theme.
This is the *only* theme definition in the app; every page/component
consumes these same variables, so a redesign is concentrated in this one
`:root` block plus whatever per-component overrides already exist
throughout the file's ~500 lines.

### Emoji inventory (grepped across `app/`, `lib/`)

46 files/call-sites use `⚠` alone (inline warning-message prefixes in
JS string literals — `"⚠ Tulis catatan dulu."` etc. — these are
message-formatting punctuation, not clickable/navigational icons).
Genuine **UI icons** (candidates for an icon library):
- Mobile bottom-nav (`app/globals.css`'s `::before` rule, prior run this
  session): 🏠📓💬👤.
- Panel/section headers: 🍽️ (Menu makan), 💊 (Vitamin dari dokter),
  💧 (Cairan), 🌱 (empty states).
- Attach/action buttons: 🖼️📷🎬🎙️📎📝 (photo/video/record/transcribe),
  ✏️✕✓ (edit/delete/confirm), ★☆ (baby-name favorite).
- Chat: 💬 (source badge).

**Separate, semantically different — NOT generic decoration**: the mood
picker (`lib/journal.js`'s `MOODS`, 😊😐😟😢😴🤢) — these emoji *are* the
selectable values for a real feature (each one represents a specific
mood a journal entry can be tagged with); swapping them for arbitrary
icon-library glyphs risks losing immediate emotional recognizability that
emoji are specifically good at, unlike a generic action icon.

**Different rendering context entirely**: `lib/reminderLogic.js`'s
`TITLES`/notification-title strings (`"☀️ Bloom"`, `"🍽️ Bloom"`, etc.)
render inside the *operating system's own push-notification chrome*
(Android/iOS notification tray), not this app's React/CSS — an in-app
icon-library swap has no effect there; that emoji would need to stay
emoji (OS notifications don't render arbitrary SVG).

### No icon library today

`package.json` has zero icon-related dependency. `npm ping` confirms
registry access works in this environment, so installing one is
feasible. The bottom-nav icons specifically are CSS `::before { content:
"🏠"; }` (added in a prior run this session) — a real SVG icon can't be
injected this way; that mechanism needs to change to an actual `<Icon
/>` element in the (currently icon-free) `<Link>` JSX across 4 page files
if the bottom nav is in scope.

### PWA icon files — a different kind of asset entirely

`public/icons/*.png` (README already flags these as "placeholder polos")
are exported bitmap images for the home-screen/app-icon slot, not
in-app UI icons — regenerating actual branded PNGs is an image/export
task, not something this skill can meaningfully do by editing code.

## Files/functions likely in scope

- `app/globals.css` — the `:root` theme block (color refinement,
  possibly a type scale), plus every rule that would need adjusting for
  consistency once the palette/scale changes.
- `app/dashboard/page.js`, `app/dashboard/journal/page.js`,
  `app/dashboard/chat/page.js`, `app/dashboard/profile/page.js` — every
  genuine-icon emoji site (not `⚠`, not mood emoji).
- `package.json` — new icon-library dependency.
- Out of scope by nature, not oversight: `lib/journal.js`'s `MOODS`,
  `lib/reminderLogic.js`'s notification titles, `public/icons/*.png`,
  the 46 `⚠` message-prefix sites.

## Ambiguities (unresolved — block a SIMPLE classification)

1. **Which icon library** — no candidate named yet.
2. **Icon scope confirmation** — does "icons" mean the genuine-UI-icon
   list above (nav/headers/buttons), or does the user also want the mood
   picker and/or the `⚠` message-prefixes touched despite the concerns
   above?
3. **Color/typography direction** — "more elegant" is a creative,
   subjective call with no concrete target named; the user explicitly
   declined a mockup-preview pass, so this needs to be pinned down via
   concrete either/or choices rather than open-ended prose.
4. **PWA icon PNGs** — confirm out of scope (image-asset work, not code).

## Triage

**Triage: COMPLEX** — new dependency (icon library), 4+ files touched,
multiple genuinely open creative/scope decisions, and this session's own
prior work (mobile bottom-nav `::before` icons) needs deliberate rework
rather than being silently broken.
