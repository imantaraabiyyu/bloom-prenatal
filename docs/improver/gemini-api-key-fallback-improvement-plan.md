# Improvement Plan — Fall back across multiple Gemini API keys (key-inner)

## Goal
Add a second, independent fallback dimension — API key — nested *inside* the existing per-model
attempt: for each model in a tier's chain, try every configured API key (in order) before moving
to the next model. A dead/exhausted key doesn't have to mean total failure as long as some
key+model combination still works, and a genuinely broken model still isn't masked by cycling keys
forever on it.

## Current behavior
- Each of the 4 call sites reads `process.env.GEMINI_API_KEY` once, throws synchronously if unset, and closes over that single value in its `buildUrl(model)` closure: [lib/gemini.js:436-437](../../lib/gemini.js#L436-L437) (`streamNutritionChatTurn`), [:529-530](../../lib/gemini.js#L529-L530) (`streamTranscribeVoiceNote`), [:634-635](../../lib/gemini.js#L634-L635) (`generateDailyNudge`), [:687-688](../../lib/gemini.js#L687-L688) (`generateMealFact`).
- `tryModelChain` ([lib/gemini.js:317-329](../../lib/gemini.js#L317-L329)) loops `models`, calling `buildUrl(model)` once per model — no key dimension today.
- `parseModelList` ([lib/gemini.js:283-285](../../lib/gemini.js#L283-L285)) is a generic comma-list parser, named model-specifically but reusable as-is for a key list.

## Proposed change
1. **`getApiKeyChain()`** (new) → `[GEMINI_API_KEY, ...parseCommaList(GEMINI_API_KEY_FALLBACKS)].filter(Boolean)` — `parseModelList` renamed to `parseCommaList` (used for models *and* keys now, no behavior change to its two existing call sites).
2. **`tryModelChain`** gains a nested loop: for each model, for each API key (both 0-indexed, computing `isLastAttempt = isLastModel && isLastKey`), call `fetchGeminiWithRetries(buildUrl(model, apiKey), ...)`. Same "advance on any `GeminiHttpError`, propagate a raw non-HTTP exception immediately, throw once truly exhausted" rule as today, just with one more dimension to exhaust before throwing. `console.warn` differentiates "trying the next API key on the same model" vs "every key failed for this model, moving to the next model" — **never logs the key value itself**, only its position (`API key #2`), since keys are secrets. Throws the `"GEMINI_API_KEY belum diisi..."` error up front if the whole chain is empty (moves this check out of all 4 call sites into this one shared place).
3. **`buildUrl` signature** changes from `(model) => url` to `(model, apiKey) => url` at all 4 call sites — each site drops its own `const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) throw ...;` lines (now handled once, inside `tryModelChain`) and interpolates the passed-in `apiKey` param instead of a closed-over outer variable.
4. **`fetchGeminiForChat`/`fetchGeminiForLowTier`** — unchanged internally; they already just forward `buildUrl` to `tryModelChain`, so the key dimension is fully contained there. The cross-tier drop to the low tier (chat calls) gets key fallback "for free" — it's the same `tryModelChain` doing the work.
5. **`README.md`** — new `GEMINI_API_KEY_FALLBACKS` env var documented next to `GEMINI_API_KEY`.
6. **`.env.local`** (gitignored, not committed) — add the new var alongside the existing model-tier ones, matching the pattern from the two prior runs' local-file updates.

## Scope
### In scope
- `lib/gemini.js` — `parseModelList` → `parseCommaList` rename, `getApiKeyChain`, `tryModelChain`'s nested loop, all 4 call sites' `buildUrl` signature + dropped early `apiKey` check.
- `lib/gemini.test.js` — new tests (see Test plan); no rewrite needed for existing tests (they only ever set `GEMINI_API_KEY`, never `GEMINI_API_KEY_FALLBACKS`, so `getApiKeyChain()` naturally resolves to a 1-element list for all of them — behavior unchanged).
- `README.md` — env var doc.
- `.env.local` — local-only addition.

### Out of scope / non-goals
- No per-tier API keys (one shared key chain for all 4 call sites) — API keys are account-level, not tied to which feature is calling, unlike model choice.
- No change to which statuses trigger fallback (still "any `GeminiHttpError`, not a raw exception") — same rule, just one more dimension it applies to.
- Never logging the actual key value — only its 1-based position in the chain.

## Data / schema impact
None.

## Risks & mitigations
- **Risk:** a genuinely dead first key now gets retried once per model in a tier's chain (e.g. 3 models × exhausting that key first each time) before ever reaching key #2 for the *last* model — same latency-multiplication shape as the already-accepted [[gemini-fallback-any-error]] tradeoff, just one more dimension.
  **Mitigation:** identical reasoning already accepted there — the alternative (key-outer) was explicitly not chosen; documented in the `tryModelChain` comment.
- **Risk:** a key value accidentally logged.
  **Mitigation:** `console.warn` only ever prints the 1-based position (`API key #2`), never `process.env.GEMINI_API_KEY_FALLBACKS` or any parsed key string — verified in the diff before commit.

## Test plan
`lib/gemini.test.js`, same fixture style as the two prior runs (mock `global.fetch`, key behavior off the URL — now differentiated by both model name *and* the `key=` query param):
1. **Falls back to the next API key on the same model, and succeeds there** (low tier, via `generateDailyNudge`) — `GEMINI_API_KEY=key-a`, `GEMINI_API_KEY_FALLBACKS=key-b`; `key-a` fails (any status), `key-b` succeeds on the *same* model; 2 fetch calls.
2. **Key-inner nesting order (the core of this design)** — `GEMINI_MODEL=model-a`, `GEMINI_FALLBACK_MODELS=model-b`, `GEMINI_API_KEY=key-a`, `GEMINI_API_KEY_FALLBACKS=key-b`; model-a fails under *both* keys, model-b succeeds under key-a (the chain resets to key-a for the new model) — exactly 3 calls in that order: (model-a,key-a), (model-a,key-b), (model-b,key-a).
3. **Chat tier + key fallback composes with the cross-tier drop** (via `streamNutritionChatTurn`) — chat tier's only model fails under every key, low tier's primary model succeeds under key-a — proves the key dimension works inside both `tryModelChain` invocations `fetchGeminiForChat` makes (chat tier attempt, then low-tier attempt), and the reply still carries `GEMINI_LOWER_TIER_NOTICE` + the correct model caption.
4. **No fallback keys configured behaves exactly as before** — none of the existing tests set `GEMINI_API_KEY_FALLBACKS`, so re-running the full existing suite unmodified is itself the regression guard; called out explicitly, not a new test.
5. **Raw network exception still skips every dimension** — reuse the existing pattern (`mockRejectedValue(new TypeError(...))`), asserting exactly 1 fetch call (neither key nor model fallback attempted).

## Standards notes
No kredivo-docs areas touched (no auth/SSO, GCP/WIF, Terraform, or Docker changes) — reads one more app-level env var the same direct `process.env.*` way the file already reads the others. Note: this *is* API-key handling, but for the Gemini consumer API (a query-param key, not GCP service-account/WIF auth), so `wif-integration/` doesn't apply.
