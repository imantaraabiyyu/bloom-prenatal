# Improvement Plan — Full visual redesign + lucide-react icons

## Goal

Make the app (web + installed-PWA mobile) feel more elegant — color/
contrast, typography/spacing, cross-page consistency together — and
replace every emoji with `lucide-react` icons, per the user's answers:
lucide-react, convert everything including the mood picker and the `⚠`
warning glyph, and a richer/more premium dark palette direction.

## Current behavior

Single theme source: `app/globals.css`'s `:root` block (`--bg1/2/3`,
`--text*`, `--accent`, `--lilac`/`--sage`/`--rose`, `--panel*`) plus
Fraunces/Work Sans/IBM Plex Mono. No per-page style duplication — every
page consumes the same shared classes (`.panel`, `.panel h2/h3`,
`.bloom-title`, etc.), so retuning tokens/shared rules cascades
everywhere in one edit. No icon library dependency exists yet
(`package.json` confirmed). Emoji are used directly as JSX text across
`app/dashboard/{page,journal/page,chat/page,profile/page}.js`, as a mood
picker's actual data values (`lib/journal.js`'s `MOODS`), as a CSS
`::before { content: "🏠" }` rule for the mobile bottom nav (added in a
prior run this session — can't hold an SVG, needs to become real JSX),
and as a leading `"⚠ "` glyph in ~33+ message strings feeding 14 distinct
`.error-box` JSX render sites plus a few standalone inline warnings.
Separately, `⚠` also appears inside `app/dashboard/chat/page.js`'s
`saveMessage({ text: "⚠ ..." })` calls — persisted `chat_messages.text`
DB content rendered back as plain message-bubble text, not app chrome.

## Proposed change

See the approved plan at the session's plan file for full detail
(mirrored here): install `lucide-react`; retune `app/globals.css`'s
palette (`--bg1/2/3` deepened, `--accent` deepened), add
`--panel-shadow`/stronger `--panel-border` for elevation, bump
`.panel h2/h3` and `.bloom-title` sizing; replace every genuine-UI-icon
emoji (nav, panel headers, attach/action buttons) with a named
`lucide-react` icon at an appropriate size per context; give `lib/journal.js`'s
`MOODS` entries an `icon` field and render `<m.icon/>` in the mood
picker instead of `{m.emoji}`; strip the leading `"⚠ "` from every
app-chrome message string and render one `<AlertTriangle/>` per
`.error-box`/inline-warning render site instead. `⚠` inside persisted
chat message text is deliberately left as literal text (stored
conversational content, not app chrome — see the plan file's reasoning).

## Scope

### In scope
- `package.json`/`package-lock.json` — `lucide-react`.
- `app/globals.css` — palette/elevation/type tokens; remove the mobile
  bottom-nav `::before` icon rule.
- `app/dashboard/page.js`, `app/dashboard/journal/page.js`,
  `app/dashboard/chat/page.js`, `app/dashboard/profile/page.js` — icon
  imports/swaps throughout (nav, headers, buttons, mood picker,
  error-box icons).
- `lib/journal.js` — `MOODS` gains an `icon` field.

### Out of scope / non-goals
- `public/icons/*.png` — bitmap/export task.
- `lib/reminderLogic.js` notification-title emoji — OS-rendered, not
  in-app.
- `⚠` inside persisted chat message text — left as literal text.

## Steps

1. `npm install lucide-react`; confirm it resolves.
2. `app/globals.css`: palette/elevation/type token changes; remove the
   `::before` bottom-nav icon rule.
3. Mobile bottom-nav real-icon JSX across all 4 dashboard pages
   (`<Home/>`/`<NotebookText/>`/`<MessageCircle/>`/`<User/>`).
4. Panel-header + attach/action-button icon swaps, file by file
   (`app/dashboard/page.js`, then `journal/page.js`, then `chat/page.js`,
   then `profile/page.js`).
5. Mood picker: `lib/journal.js`'s `MOODS` gets an `icon` field;
   `journal/page.js`'s two mood-picker render sites (compose + edit)
   swap `{m.emoji}` for `<m.icon size={16}/>`.
6. `⚠` → `AlertTriangle`: strip the leading glyph from app-chrome
   message strings, add the icon once per `.error-box`/inline-warning
   render site across the 3 affected page files; leave chat message
   content untouched.
7. `npm run build` + `npm test` to confirm no regressions.

## Data / schema impact

None — presentational + a new npm dependency only.

## Risks & mitigations

- **New dependency failing to install/resolve** (offline, registry
  issue) — `npm ping` already confirmed reachability before planning;
  `npm run build` at the end re-confirms the import graph resolves.
- **Mood-icon mappings not landing well visually** (best-effort, no
  direct lucide equivalent for "nauseous"/"anxious") — flagged
  explicitly in the plan as interpretive; easy to swap individual icon
  names later since each mood's icon is one import + one table row.
- **Breaking the mobile bottom nav** while converting it from CSS
  `::before` to real JSX — the nav's fixed-position/safe-area/active-tab
  CSS from the prior run stays untouched; only the icon *source*
  changes (generated content → an actual child element), verified via
  `npm run build` and a visual check at a mobile width.
- **Losing the distinct look of "which chat message is a warning"** once
  `⚠` inside persisted chat text is left alone while every other warning
  in the app gets an icon — accepted intentionally per the reasoning
  above (that text is stored conversational content the icon-replacement
  approach doesn't reach cleanly); noted as a deferred follow-up if the
  user wants a different resolution later.

## Test plan

- No pure-logic function introduced beyond `lib/journal.js`'s data-table
  addition (an `icon` field, not new logic) — regression guard: `npm
  test` (existing suite, untouched) stays green, `npm run build`
  succeeds (also validates every icon import name is real/exists in
  `lucide-react`).
- Manual: visually confirm the palette/elevation/type changes across all
  4 pages; confirm every icon renders where an emoji used to be (nav,
  headers, buttons, mood picker, warning icon); confirm mobile bottom
  nav still works at a narrow width; confirm chat messages containing
  `⚠` still render as plain text unaffected.

## Standards notes

No `kredivo-docs` areas touched — presentational + a new client-side
npm dependency only.
