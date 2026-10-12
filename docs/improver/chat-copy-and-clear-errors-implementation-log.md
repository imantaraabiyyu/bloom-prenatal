# Implementation Log — Tap-to-copy chat bubbles + clearer chat errors

Branch: feat/gemini-chat-flexible (existing). Track: COMPLEX, plan approved.

1. lib/chatErrors.js (+ lib/chatErrors.test.js): classifyChatError, buildBubbleCopyText, fixed Indonesian messages per error kind.
2. app/api/nutrition-chat/route.js: 401 reworded; `code` added to JSON errors (auth/invalid/too_large) and stream error events (busy/generic).
3. app/dashboard/chat/page.js: error paths now show local-only notices (not saved to chat_messages), "Login ulang" link for auth, network detection via fetch TypeError; tap-to-copy on bubbles (ignores taps on buttons/links and when text is selected; clipboard fallback), "Tersalin" tag for 1.5s. toHistoryEntry skips error notices.
4. app/globals.css: copyable/error/copied styles.

Tests: `npm test` -> 5 files, 166 tests passed (incl. 11 new in lib/chatErrors.test.js). `next build` compiled successfully.
Note: node lives at /opt/homebrew/bin (not on the default PATH in this shell).
Not verified in a browser (clipboard + tap behavior is untested by automated tests).
CLAUDE.md: already contains the improver-routing section (without the marker comment); not modified.
