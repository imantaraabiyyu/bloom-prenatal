# Assessment — Tap-to-copy chat bubbles + clearer chat errors

Branch: feat/gemini-chat-flexible (existing)

## Current behavior
- app/dashboard/chat/page.js:586-651 renders each message as `.chat-bubble`; no click/copy handler. Bubble content is assembled from `m.text`, `formatAnalysisText(m.analysis)` / `formatVitaminAnalysisText`, plus verdict badge and action buttons (Simpan / Hapus) inside the same bubble.
- Errors (page.js:304-309, 339-343, 354-356): all become an assistant bubble prefixed "⚠ ..." and are persisted to chat_messages. Non-ok responses use `data.error`; stream errors use `evt.error`; catch-all is "Ada gangguan, coba kirim ulang...".
- app/api/nutrition-chat/route.js:90-93 returns 401 `{error:"Kamu perlu login dulu."}`; the client treats it like any other error (no redirect, no re-login affordance, and the "⚠" message is saved to history).
- Stream errors are only two strings: Gemini busy (lib/gemini.js GEMINI_BUSY_MESSAGE) or generic "Ada gangguan pas memproses pesannya". 413/400 have their own messages. Network failure (fetch throws) is lumped into the generic catch.
- Tests: vitest covers lib/*.test.js only; no component test setup.

## Files in scope
- app/dashboard/chat/page.js, app/api/nutrition-chat/route.js, possibly app/globals.css (copied feedback style), a new small lib helper for error classification (testable).

## Unresolved ambiguities
1. What does "chat card" copy: just the reply text, or the whole bubble including nutrient detail/verdict? Both user and assistant bubbles?
2. Tap vs buttons/links inside the bubble (Simpan, Hapus) and text selection on desktop.
3. Feedback on copy (toast / "Tersalin" label).
4. Re-login: auto-redirect to /login, or a message with a "Login ulang" button? Also handle expired session before send (supabase.auth.getSession) and 401s?
5. Which other errors should be made more specific (offline/network, timeout, too-large photo, Gemini busy vs other)? Should error bubbles still be persisted to chat history?

Triage: COMPLEX — open ambiguity on scope/behavior (items 1-5) and touches auth handling; defaulting to the approval gate.
