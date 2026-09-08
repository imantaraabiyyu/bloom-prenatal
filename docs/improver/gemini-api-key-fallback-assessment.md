# Assessment — Fall back across multiple Gemini API keys

## Requested improvement
"apakah kita bisa buat api key fallback?" — extend the existing two-tier model-fallback system
([[gemini-model-fallback]], [[gemini-fallback-any-error]]) so that if the current `GEMINI_API_KEY`
is quota-exhausted, invalid, or otherwise failing, the same request is retried under a different
API key instead of failing outright.

## Current behavior
- Each of the 4 Gemini call sites reads `process.env.GEMINI_API_KEY` once and closes over it in
  the URL-building callback passed to `fetchGeminiForChat`/`fetchGeminiForLowTier`:
  - [lib/gemini.js:436-437](../../lib/gemini.js#L436-L437) `streamNutritionChatTurn`
  - [lib/gemini.js:529-530](../../lib/gemini.js#L529-L530) `streamTranscribeVoiceNote`
  - [lib/gemini.js:634-635](../../lib/gemini.js#L634-L635) `generateDailyNudge`
  - [lib/gemini.js:687-688](../../lib/gemini.js#L687-L688) `generateMealFact`
  - All 4 throw `"GEMINI_API_KEY belum diisi..."` up front if it's unset — there's currently no
    concept of more than one key anywhere in this file.
- The API key is embedded directly in the request URL as a query param (`?key=${apiKey}`, Gemini's
  own auth scheme) — not a header, so any key-fallback wrapper needs to vary the URL per attempt,
  same shape as how `getChatModelChain`/`getLowModelChain` already vary the URL per model.
- `parseModelList(envValue)` ([lib/gemini.js:283-285](../../lib/gemini.js#L283-L285)) — the
  existing comma-separated-list parser, currently named model-specifically but generic in
  implementation (trim + filter empty) — directly reusable for a key list too.
- `tryModelChain` ([lib/gemini.js:317-329](../../lib/gemini.js#L317-L329)) and `fetchGeminiForChat`
  ([lib/gemini.js:353-363](../../lib/gemini.js#L353-L363)) both already establish the "advance on
  any `GeminiHttpError`, propagate a raw non-HTTP exception immediately, throw once the last
  candidate is exhausted" pattern this feature would extend to a new dimension (API key) rather
  than reinvent.

## Files/functions in scope
- [lib/gemini.js](../../lib/gemini.js) — a new key-chain helper + fallback wrapper, applied at all 4 call sites' URL-building closures.
- [lib/gemini.test.js](../../lib/gemini.test.js) — new tests.
- [README.md](../../README.md) — document the new env var.
- `.env.local` (gitignored, local-only, not committed) — add the new var alongside the existing model-tier ones, same as the two prior runs' `.env.local` updates.

## Open ambiguity (the description doesn't resolve this)
**Nesting order between key fallback and the existing model-tier fallback.** Two real designs:
1. **Key-outer** — for a given API key, run the *entire* existing tier logic (every model in
   the chat tier, the cross-tier drop to the low tier for chat calls) before ever trying the next
   key. Simple: wraps `fetchGeminiForChat`/`fetchGeminiForLowTier` as a black box, no change to
   either of those functions' internals.
2. **Key-inner** — for each individual model attempt, cycle through every API key before moving to
   the next model. More fine-grained (reaches a working key sooner if only the *first* model+key
   combo is broken), but threads the key chain through `tryModelChain`'s per-model loop instead of
   wrapping it, more invasive change.

No indication in the request of which is wanted — this is a real architectural fork with different
tradeoffs (key-outer is simpler and matches "retry the whole request under a different key"; key-inner
reaches a working combination faster but is more complex and slower to fail over when a whole key is
genuinely dead). Asking rather than guessing.

Triage: COMPLEX — the nesting-order question is a genuine, consequential design fork the
description/code don't resolve on their own (fails the "no open ambiguity" SIMPLE criterion), even
though file scope (3 tracked files) and blast radius are otherwise small and well-bounded by the
existing tier-fallback pattern.
