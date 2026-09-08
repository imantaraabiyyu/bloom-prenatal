# Implementation Log — Two-tier Gemini model selection with 429 fallback

Branch: `main` (user chose to stay on main again, carrying pre-existing unrelated uncommitted work — journal page/globals.css/lib/journal.js + visual-redesign docs — as-is, same as the prior run).

## Steps

1. **`lib/gemini.js` — tier chain infrastructure** ([lib/gemini.js:269-353](../../lib/gemini.js#L269-L353))
   - `parseModelList(envValue)` — comma-separated env value → trimmed, non-empty array.
   - `getChatModelChain()` → `[GEMINI_CHAT_MODEL || "gemini-2.5-pro", ...parseModelList(GEMINI_CHAT_FALLBACK_MODELS)]`.
   - `getLowModelChain()` → `[GEMINI_MODEL || "gemini-3.5-flash-lite", ...parseModelList(GEMINI_FALLBACK_MODELS)]` (GEMINI_MODEL repurposed per the answered question).
   - `tryModelChain(models, buildUrl, requestBody, opts)` — iterates models, `console.warn`s + moves to the next only on a 429 `GeminiHttpError`; anything else propagates immediately. Returns `{ res, model }`.
   - `GEMINI_LOWER_TIER_NOTICE` (exported) — the caveat string for when a chat-tier call had to drop to the low tier.
   - `fetchGeminiForChat(buildUrl, requestBody, opts)` — chat-tier chain first; on total chat-tier 429 exhaustion, `console.warn`s and tries the low-tier chain. Returns `{ res, model, usedLowerTier }`.
   - `fetchGeminiForLowTier(buildUrl, requestBody, opts)` — low-tier chain only, no cross-tier fallback. Returns `res`.
   - `formatGeminiModelCaption(model)` (exported) — `"(model: ${model})"`, added mid-session per the user's follow-up request (see below).

2. **`streamNutritionChatTurn`** ([lib/gemini.js:423-470](../../lib/gemini.js#L423-L470)) — swapped `fetchGeminiWithRetries` for `fetchGeminiForChat`; after `sanitizeChatTurnResult`, appends `GEMINI_LOWER_TIER_NOTICE` to `reply` when `usedLowerTier`, then unconditionally appends `formatGeminiModelCaption(model)` — the existing "any tail we hadn't emitted yet" `onDelta` call already streams both additions to the client with no further changes needed.

3. **`streamTranscribeVoiceNote`** ([lib/gemini.js:516-582](../../lib/gemini.js#L516-L582)) — same swap; notice + model caption appended to `tidiedNote` (not `transcript`, which stays verbatim), right before the final `onProgress?.(safe)` call.

4. **`generateDailyNudge`, `generateMealFact`** ([lib/gemini.js:610-693](../../lib/gemini.js#L610-L693)) — swapped `fetchGeminiWithRetries` for `fetchGeminiForLowTier`. No notice/caption (cron-only, text goes straight into a push notification body — a "(model: ...)" caption would read oddly there, and the user's follow-up request was scoped to "chat and transcribe" only).

5. **`README.md`** — replaced the old single `GEMINI_MODEL` block with all 4 env vars (`GEMINI_CHAT_MODEL`, `GEMINI_CHAT_FALLBACK_MODELS`, `GEMINI_MODEL` — repurposed, new default — `GEMINI_FALLBACK_MODELS`), explicit about the repurposing and the cross-tier-fallback/caveat behavior.

6. **`.env.local`** (gitignored, local-only — not part of the commit) — updated the `GEMINI_MODEL=gemini-3.6-flash` line to the new 4-var block with real defaults, plus a full ordered reference list of every Gemini model found during research (Pro → Flash → Flash-Lite, newest/most-capable first within each tier), added per the user's follow-up ask ("buatkan rekomendasi gemini models nya ... list sebanyak mungkin ... dan urutkan").

7. **Tests — `lib/gemini.test.js`**
   - Import extended: `streamNutritionChatTurn, streamTranscribeVoiceNote, GEMINI_LOWER_TIER_NOTICE, formatGeminiModelCaption`.
   - New `fakeSseBody(fullJsonText)` helper — single-chunk fake `ReadableStream` mimicking Gemini's SSE format, enough to drive both streaming functions to their final result.
   - New describe `low-tier model fallback chain (GEMINI_MODEL / GEMINI_FALLBACK_MODELS, via generateDailyNudge)`: falls back + succeeds on next model (2 fetch calls), does not fall back on non-429 (3 calls, all to the primary model), exhausts the whole chain on all-429 (3 calls, one per model).
   - New describe `chat tier + cross-tier fallback (streamNutritionChatTurn, streamTranscribeVoiceNote)`: chat tier succeeds directly (reply carries only the model caption, no notice); whole chat tier 429s → falls to low tier, `reply`/`tidiedNote` carry notice + caption in that order, `onDelta`'s streamed deltas reconstruct the exact final `reply`; a non-429 chat-tier failure (500) never touches the low tier's URL.

## Test run (Bash, real output)

```
$ npx vitest run lib/gemini.test.js
 Test Files  1 passed (1)
      Tests  24 passed (24)
   Duration  5.70s

$ npx vitest run   (full suite)
 Test Files  3 passed (3)
      Tests  56 passed (56)
   Duration  5.80s
```

No lint script exists in this repo — skipped, nothing to run (same as the prior gemini-429-quota-handling run).

## Deviations from plan

Two requirements arrived mid-session, after the plan was written/approved but folded in before implementing further:
1. **Two-tier model selection** (chat vs. low) — arrived while the *first* round of fallback-chain clarifying questions was still being answered, before any code was written. Assessed, researched live (WebFetch against `ai.google.dev`), a second round of clarifying questions asked and answered, and the plan rewritten in full *before* the approval gate — so this was folded into the approved plan itself, not a post-approval deviation.
2. **Model-name caption** ("in chat and transcribe also add small text of model name used") — arrived *during* implementation (after approval, mid-Step-8). Clarified with 2 quick questions (always-show vs. fallback-only; caption-in-text vs. separate UI), both resolved to the simpler/recommended option, then implemented and documented as an addendum to the improvement plan (see its "Addendum" section) before continuing. No source file was edited on unconfirmed guesses at intent.

Otherwise implemented exactly as planned — no other deviations.

## Follow-ups (not in scope, noted per plan's Out-of-scope section)
- No dedicated UI badge/label for the model name or fallback notice — both ride inside `reply`/`tidiedNote` text, per the answered questions. If the user later wants a visually distinct badge, that's a separate, larger change (frontend components in both `app/dashboard/chat/page.js` and `app/dashboard/journal/page.js`, likely a schema change too so it survives reload for plain-chat replies).
- `gemini-2.5-pro`'s free-tier quota/cost profile relative to `gemini-3.6-flash` (the old shared default) hasn't been measured in production — `GEMINI_CHAT_FALLBACK_MODELS` and the cross-tier drop to the low tier exist as the safety net if it proves too tight, per the plan's risk section.
- An already-set `GEMINI_MODEL` value in Vercel now applies to cron only, not chat — flagged in README, not something code can auto-migrate (no way to know if the user intended it for chat historically vs. cron).
