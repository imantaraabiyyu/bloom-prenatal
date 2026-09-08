# Improvement Plan — Two-tier Gemini model selection with 429 fallback

## Goal
Split Gemini model selection into two independent tiers, each with its own primary + optional
fallback chain, so a 429 on one model doesn't have to mean total failure:
- **Chat tier** (nutrition-chat + journal transcribe — both interactive, user-facing, multimodal): always tries the best available model(s) first.
- **Low tier** (cron daily nudge + cron meal fact — text-only, no user watching): uses the cheapest model(s).
- **Cross-tier last resort**: if the *entire* chat tier chain 429s, fall through to try the low tier too, rather than failing outright — but flag the resulting reply/tidied-note so the user knows to double-check it, since it came from a much smaller model than the feature normally uses.

## Current behavior
- Each of the 4 call sites independently reads `process.env.GEMINI_MODEL || "gemini-3.6-flash"` and builds one URL for it: [lib/gemini.js:335](../../lib/gemini.js#L335) `streamNutritionChatTurn`, [:423](../../lib/gemini.js#L423) `streamTranscribeVoiceNote`, [:522](../../lib/gemini.js#L522) `generateDailyNudge`, [:574](../../lib/gemini.js#L574) `generateMealFact`.
- `fetchGeminiWithRetries` ([lib/gemini.js:234-265](../../lib/gemini.js#L234-L265)) retries 500/502/503/504 per URL; 429 throws immediately (no retry, per [[gemini-429-quota-handling]]), no concept of a second model.
- `README.md:68-71` documents `GEMINI_MODEL` as the only model-related env var, shared by all 4 calls today.
- Frontend render paths that will end up showing the cross-tier caveat automatically once it's folded into `reply`/`tidiedNote` (no frontend code changes needed — confirmed by reading both):
  - [app/dashboard/chat/page.js:46-51](../../app/dashboard/chat/page.js#L46-L51) `formatAnalysisText` and [:59-68](../../app/dashboard/chat/page.js#L59-L68) `formatVitaminAnalysisText` both end with `... 💬 ${result.reply}`; the plain-chat branch at [:273](../../app/dashboard/chat/page.js#L273) shows `finalResult.reply` directly.
  - [app/dashboard/journal/page.js:664-665](../../app/dashboard/journal/page.js#L664-L665) renders `v.tidiedNote` directly in the "Draf jurnal dari voice note ini:" preview panel, and [:376-382](../../app/dashboard/journal/page.js#L376-L382) `useTidiedNote` is what the user explicitly clicks to copy that text into their real journal note — they see and can edit/remove the caveat before it's actually saved anywhere.

## Proposed change

### Model IDs (looked up live, Sept 2026 — see sources)
- **Chat tier default**: `gemini-2.5-pro` — confirmed GA ("Stable: gemini-2.5-pro"), multimodal (image/audio/video/text/PDF input), and supports structured JSON output via `responseSchema`/`responseMimeType`. ([ai.google.dev/gemini-api/docs/models/gemini-2.5-pro](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro))
- **Low tier default**: `gemini-3.5-flash-lite` — newest, cheapest/fastest lite model, released in the same announcement as the app's existing `gemini-3.6-flash` default. Text-only usage here (cron nudge/fact take no image/audio), so multimodal support wasn't a requirement to verify. ([ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models))

### Config (env vars)
- **`GEMINI_CHAT_MODEL`** (new, optional, default `gemini-2.5-pro`) — chat tier's primary model.
- **`GEMINI_CHAT_FALLBACK_MODELS`** (new, optional, comma-separated, default empty) — further chat-tier models to try, in order, before falling through to the low tier.
- **`GEMINI_MODEL`** (existing var, **repurposed**: now only drives the low tier, default changes from `gemini-3.6-flash` to `gemini-3.5-flash-lite`) — low tier's primary model. Per the answered question: if you already have `GEMINI_MODEL` set in Vercel/`.env.local`, it will apply to cron nudge/fact only once this ships, not chat — flagged clearly in the README so this isn't a silent surprise.
- **`GEMINI_FALLBACK_MODELS`** (existing var from the already-approved single-chain design, now scoped to the low tier) — further low-tier models to try, in order.
- All four are read directly via `process.env.*`, same scattered-read pattern the file already uses for `GEMINI_MODEL`/`GEMINI_API_KEY` — no config-module introduced (matches this repo's existing convention, not a drive-by refactor).

### Code structure (`lib/gemini.js`)
1. `parseModelList(envValue)` — splits a comma-separated env value into a trimmed, non-empty array (shared by both tiers).
2. `getChatModelChain()` → `[GEMINI_CHAT_MODEL || "gemini-2.5-pro", ...parseModelList(GEMINI_CHAT_FALLBACK_MODELS)]`.
3. `getLowModelChain()` → `[GEMINI_MODEL || "gemini-3.5-flash-lite", ...parseModelList(GEMINI_FALLBACK_MODELS)]`.
4. `tryModelChain(models, buildUrl, requestBody, opts)` — iterates `models` in order, calling `fetchGeminiWithRetries(buildUrl(model), requestBody, opts)` per model (same retry policy as today, unchanged: 500/502/503/504 retried, 429 immediate). Moves to the next model **only** on a `GeminiHttpError` with `status === 429`; any other error (network failure, a 5xx that outlasted its own retries, etc.) propagates immediately — falling back only ever helps a rate-limit/quota problem. `console.warn`s the model transition when it happens. Returns `{ res, model }` for whichever model served the request.
5. `fetchGeminiForChat(buildUrl, requestBody, opts)` — tries `getChatModelChain()` via `tryModelChain`; if that whole chain 429s, `console.warn`s the cross-tier drop and tries `getLowModelChain()` as a last resort. Returns `{ res, model, usedLowerTier }`.
6. `fetchGeminiForLowTier(buildUrl, requestBody, opts)` — just `tryModelChain(getLowModelChain(), ...)`, no cross-tier fallback (nothing lower to fall to). Returns `res` (same shape callers already expect).
7. **`GEMINI_LOWER_TIER_NOTICE`** (new export) — the caveat string appended to the reply/tidied-note when `usedLowerTier` is true: *"Balasan ini dari model cadangan yang lebih sederhana karena model utama lagi penuh kuotanya — cek ulang dulu ya sebelum disimpan, siapa tahu ada detail yang kurang pas."*
8. `streamNutritionChatTurn`: replace the `const model = ...` + direct `fetchGeminiWithRetries` call with `fetchGeminiForChat`. After `sanitizeChatTurnResult`, if `usedLowerTier`, append `\n\n${GEMINI_LOWER_TIER_NOTICE}` to `safe.reply` — the existing "any tail we hadn't emitted yet" `onDelta` call right after already streams whatever's new in `safe.reply`, so the appended notice is streamed to the client automatically with **no other code path changes**.
9. `streamTranscribeVoiceNote`: same `fetchGeminiForChat` swap; append the notice to `safe.tidiedNote` (not `transcript`, which stays a verbatim transcript) right before the final `onProgress?.(safe)` call.
10. `generateDailyNudge`, `generateMealFact`: replace their `const model = ...` + direct `fetchGeminiWithRetries` call with `fetchGeminiForLowTier` — no other change, no cross-tier fallback, no notice (nothing "lower" for them to fall to; the cron route already swallows any failure via its own fallback copy, per [[gemini-429-quota-handling]]'s assessment).
11. `README.md`: replace the `GEMINI_MODEL` block (lines 68-71) with all four env vars documented together, explicit about the repurposing (existing `GEMINI_MODEL` values now apply to cron only) and the new default.

## Scope
### In scope
- `lib/gemini.js` — tier chain helpers, `tryModelChain`/`fetchGeminiForChat`/`fetchGeminiForLowTier`, `GEMINI_LOWER_TIER_NOTICE`, all 4 call sites' model/URL construction.
- `lib/gemini.test.js` — new tests (see Test plan).
- `README.md` — env var documentation.

### Out of scope / non-goals
- No frontend changes — confirmed above that `reply`/`tidiedNote` already reach the user through every render path, so folding the notice into those fields is enough.
- No fallback (same-tier or cross-tier) on non-429 errors — unchanged from the already-approved single-chain design.
- No change to `MAX_ATTEMPTS`/`RETRY_BASE_DELAY_MS`, `GEMINI_BUSY_MESSAGE`/`isGeminiBusyError`, or anything from the already-shipped [[gemini-429-quota-handling]] run.
- Not building a dedicated "this reply used a fallback model" UI banner/badge — the caveat rides inside the existing reply/tidied-note text, which the user already reads before trusting or saving it (chat) or before clicking "pakai draf ini" into their journal (transcribe). Accepted tradeoff: if the user clicks straight through without reading, the caveat text itself gets carried into their saved journal note verbatim (they'd need to manually trim it) — judged acceptable since this only happens when the entire chat tier has already 429'd, expected to be rare.

## Data / schema impact
None.

## Risks & mitigations
- **Risk:** an existing `GEMINI_MODEL` value already set in Vercel/`.env.local` silently starts applying to cron only instead of everything, once this ships (the answered/accepted tradeoff from the env-var-naming question).
  **Mitigation:** called out explicitly in the README's rewritten env var block, same visibility as the existing `GEMINI_MODEL` retirement-risk comment.
- **Risk:** `gemini-2.5-pro` being one generation behind the flash line's `gemini-3.6-flash` could mean a different (possibly stricter) free-tier daily quota, and pro-tier calls are typically costlier per request than flash — nutrition-chat/transcribe usage patterns could hit their own daily cap sooner than before.
  **Mitigation:** `GEMINI_CHAT_FALLBACK_MODELS` exists precisely to let the user add more chat-tier candidates (e.g. `gemini-3.1-pro-preview`) without a code change if `gemini-2.5-pro` alone proves too tight; the cross-tier last-resort to the low tier is exactly the final safety net for this.
- **Risk:** cross-tier fallback's caveat text is carried into a saved journal note if the user clicks through without reading it.
  **Mitigation:** documented above as an accepted, expected-to-be-rare tradeoff rather than silently ignored.

## Test plan
`lib/gemini.test.js`, extending the existing `fetchGeminiWithRetries status policy (via generateDailyNudge)` describe block's approach (mock `global.fetch`, key behavior off the URL's model segment) plus new streaming tests using a small `fakeSseBody(jsonText)` test helper (single-chunk fake `ReadableStream` mimicking Gemini's SSE format, sufficient for testing the final sanitized result — delta-by-delta granularity is unchanged and already covered by production usage). Every test explicitly sets and cleans up (try/finally) whichever of `GEMINI_CHAT_MODEL`/`GEMINI_CHAT_FALLBACK_MODELS`/`GEMINI_MODEL`/`GEMINI_FALLBACK_MODELS` it touches.

**Low tier (via `generateDailyNudge`, non-streaming — same vehicle/tests as the already-approved single-chain design, now explicitly exercising the low tier):**
1. Falls back and succeeds on the next low-tier model on a 429; `fetch` called exactly twice.
2. Does not fall back on a non-429 failure (503 exhausting its own retries); only the primary low-tier model's URL is ever called.
3. Exhausts the whole low-tier chain when every model 429s; `fetch` called once per model, final error is `GeminiHttpError` `status: 429`.
4. No fallback configured (env unset) behaves exactly as before — regression guard.

**Chat tier + cross-tier fallback (via `streamNutritionChatTurn` and `streamTranscribeVoiceNote`, streaming):**
5. Chat tier succeeds directly (`GEMINI_CHAT_MODEL` responds 200 immediately) → `usedLowerTier` never surfaces, `reply`/`tidiedNote` do **not** contain `GEMINI_LOWER_TIER_NOTICE` — regression guard for the common case.
6. Chat tier's whole chain 429s (`GEMINI_CHAT_MODEL` + one `GEMINI_CHAT_FALLBACK_MODELS` entry, both 429) → falls through to the low tier, which succeeds → returned `reply` (for `streamNutritionChatTurn`) and `tidiedNote` (for `streamTranscribeVoiceNote`) both end with `GEMINI_LOWER_TIER_NOTICE`; `fetch` called once per chat-tier model plus once for the low tier.
7. Chat tier fails with a non-429 error (500, retries exhausted) → rejects with `GeminiHttpError` `status: 500`; the low tier's URL is **never** called — proves cross-tier fallback is 429-only, same rule as same-tier fallback.

## Standards notes
No kredivo-docs areas touched (no auth/SSO, GCP/WIF, Terraform, or Docker changes) — reads 4 app-level env vars the same direct `process.env.*` way the file already reads `GEMINI_MODEL`/`GEMINI_API_KEY`.

## Addendum — always show which model answered (added mid-session, during implementation)

While implementing the plan above, the user asked for one more thing: nutrition-chat and journal
transcribe should also show a small text of which model actually answered — not just when the
cross-tier fallback notice fires, but on every reply, so it's always visible which model handled
it. Answered (both recommended): show it **always** (not fallback-only), and use the **same
zero-frontend-change mechanism** as `GEMINI_LOWER_TIER_NOTICE` — append a small caption directly to
`reply`/`tidiedNote` rather than building a separate UI element (which would need frontend changes
and, for plain-chat replies that only ever persist `text`, a schema change to survive reload).

**Change**: new export `formatGeminiModelCaption(model)` → `"(model: ${model})"`. Both
`streamNutritionChatTurn` and `streamTranscribeVoiceNote` already receive back the `model` that
actually served the request from `fetchGeminiForChat`'s `{ res, model, usedLowerTier }` — appended
unconditionally (after the fallback notice, when present) to `reply`/`tidiedNote`, in that order:
```
<reply/tidiedNote text>

[GEMINI_LOWER_TIER_NOTICE, only if usedLowerTier]

(model: <actual model name>)
```
No new files — this rides entirely inside `lib/gemini.js`'s existing 2 chat-tier functions, same as
the notice. `generateDailyNudge`/`generateMealFact` (cron) are explicitly untouched — the user asked
for this on "chat and transcribe" only, and a "(model: ...)" caption inside a push-notification
sentence would read oddly there.

Test plan addition: extend tests 5 and 6 above (chat tier direct success, cross-tier fallback) to
assert the exact caption is present (`formatGeminiModelCaption(<model>)`) in both the success-only
and fallback+notice cases, instead of asserting a bare reply/tidiedNote string.
