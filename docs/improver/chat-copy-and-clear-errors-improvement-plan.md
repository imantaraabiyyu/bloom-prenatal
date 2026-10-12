# Improvement Plan — Tap-to-copy chat bubbles + clearer chat errors

## Goal
1. Tapping a chat bubble (user or Bloom) copies that bubble's visible text; a short "Tersalin ✓" label confirms.
2. Chat errors become specific and actionable. Session expiry shows a clear message + "Login ulang" button. Error notices are local-only (not saved to chat history).

## Current behavior
See chat-copy-and-clear-errors-assessment.md (page.js:304-356 error paths; route.js:90-93 401).

## Proposed change
- New pure helper `lib/chatErrors.js` (unit-testable): `classifyChatError({ status, serverMessage, streamError, networkFailure })` → `{ kind, message, needsLogin }`. Kinds: `auth` ("Sesi kamu sudah habis, silakan login ulang."), `network` ("Koneksi internet terputus..."), `busy` (GEMINI_BUSY_MESSAGE text passed through), `too_large`/`invalid` (server message passed through), `generic`.
- New pure helper `bubbleCopyText(message)` in the same lib (or lib/chatCopy.js): returns visible text = m.text, or formatted analysis text (+ verdict line) / vitamin text; empty for streaming/error notices.
- page.js: replace the 3 "⚠ ..." saveMessage calls with a local-only `{ role:"assistant", isError:true, errorKind, text }` message (not inserted into chat_messages); render with the existing `.chat-save-error`-style notice; for `auth` also render a `Link` to /login ("Login ulang"). Add bubble onClick → `navigator.clipboard.writeText` (fallback: hidden textarea + execCommand) → set `copiedId` for ~1.5s showing "Tersalin ✓". Taps on buttons/links inside the bubble and tapping while text is selected are ignored. Keyboard: bubble gets role="button"/tabIndex/Enter.
- Server (route.js): 401 text reworded to match; stream error for non-busy keeps generic message. Add a `code` field (`"auth"|"busy"|...`) to JSON error responses and stream error events so the client doesn't string-match.
- Error notices are excluded from `toHistoryEntry` automatically since they're not persisted (and isError messages are filtered defensively).
- globals.css: `.chat-bubble[data-copyable]` cursor/hover, `.chat-copied-tag`, `.chat-error-notice`.

## Scope
### In scope
- app/dashboard/chat/page.js, app/api/nutrition-chat/route.js, app/globals.css, new lib/chatErrors.js + lib/chatErrors.test.js
### Out of scope
- journal/transcribe route errors, Gemini fallback logic, DB schema, copying from the streaming placeholder, rich-format copy.

## Steps
1. lib/chatErrors.js + tests (classifyChatError, bubbleCopyText).
2. route.js: add `code` to error responses/stream errors; reword 401.
3. page.js: local error notices, Login ulang link, network detection (fetch throws TypeError), no persistence.
4. page.js + css: tap-to-copy with "Tersalin ✓".
5. Run tests/build; commit.

## Data / schema impact
None. Previously-saved "⚠ ..." history rows still render as plain text.

## Risks & mitigations
- Tap conflicting with Simpan/Hapus buttons → ignore clicks from interactive descendants (closest('button,a')).
- Clipboard API unavailable on http → fallback path.
- Error no longer persisted: reload loses it (intended).

## Test plan
- classifyChatError: 401→auth+needsLogin, fetch network failure→network, busy stream error→busy, 413→too_large, unknown→generic.
- bubbleCopyText: plain text, food analysis (with verdict), vitamin analysis, user text, error/streaming → "".
- Regression: sanitize/other lib tests still pass (`npm test`); `next build` compiles.

## Standards notes
no kredivo-docs areas touched
