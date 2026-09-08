# Implementation Log — Fall back across multiple Gemini API keys (key-inner)

Branch: `main` (clean tree aside from one unrelated untracked file from a different in-progress improver run, `docs/improver/push-send-fallback-assessment.md` — left untouched).

## Steps

1. **`lib/gemini.js` — renamed `parseModelList` → `parseCommaList`** ([lib/gemini.js:283-285](../../lib/gemini.js#L283-L285)) — no behavior change, just generalizing the name since it's now used for API keys too, not only models. Both existing call sites (`getChatModelChain`, `getLowModelChain`) updated to the new name.

2. **`getApiKeyChain()`** (new, [lib/gemini.js:296-301](../../lib/gemini.js#L296-L301)) — `[GEMINI_API_KEY, ...parseCommaList(GEMINI_API_KEY_FALLBACKS)].filter(Boolean)`. One shared chain for all 4 call sites (not tier-specific — an API key is an account-level credential, unlike model choice).

3. **`tryModelChain`** ([lib/gemini.js:303-357](../../lib/gemini.js#L303-L357)) — gained a nested loop: for each model, for each API key, calls `fetchGeminiWithRetries(buildUrl(model, apiKey), ...)`. Key-inner per the approved design: every key is tried for a model before moving to the next model, and the key index resets to the first key for each new model. Throws once `isLastModel && isLastKey`. Moved the shared `"GEMINI_API_KEY belum diisi..."` check here (`keys.length === 0`), replacing the 4 separate per-call-site checks. `console.warn` differentiates "next API key, same model" vs "every key failed, next model" — logs only the key's 1-based position, never its value.

4. **All 4 call sites** ([lib/gemini.js:463-731](../../lib/gemini.js#L463-L731)) — dropped their own `const apiKey = process.env.GEMINI_API_KEY; if (!apiKey) throw ...;` lines (now handled once inside `tryModelChain`); `buildUrl` closures changed from `(model) => ...&key=${apiKey}` (closing over the removed outer `apiKey`) to `(model, apiKey) => ...&key=${apiKey}` (using the per-attempt key `tryModelChain` now passes in). `fetchGeminiForChat`/`fetchGeminiForLowTier` needed no changes — they already just forward `buildUrl` through to `tryModelChain`, so the key dimension is fully contained there, including the cross-tier drop (chat calls) getting key fallback "for free".

5. **`README.md`** — documented `GEMINI_API_KEY_FALLBACKS` next to `GEMINI_API_KEY`, plus a short paragraph explaining the key-inner nesting order in plain language (tries every key per model before moving to the next model).

6. **`.env.local`** (gitignored, not committed) — added `GEMINI_API_KEY_FALLBACKS=` (empty — no second key to fill in) alongside `GEMINI_API_KEY`. Left the model-tier values as the user's own already-updated state (`GEMINI_CHAT_MODEL` had been switched to `gemini-3.6-flash` since the last run, presumably in response to the `gemini-2.5-pro` 404 — not reverted, treated as the current deliberate state per the file's own changed-on-disk convention).

7. **Tests — `lib/gemini.test.js`** — new `describe("API key fallback (GEMINI_API_KEY / GEMINI_API_KEY_FALLBACKS)", ...)`:
   - Falls back to the next key on the same model, succeeds (2 fetch calls, via `generateDailyNudge`).
   - **Core test**: key-inner nesting order — model-a fails under both keys (2 calls), model-b succeeds on the *first* key (3rd call, `key=key-a` again, proving the reset).
   - Composes with the chat tier + cross-tier drop — chat-model-a fails under both keys, low-model-a succeeds on the first key (3 calls total); reply carries both `GEMINI_LOWER_TIER_NOTICE` and the correct model caption.
   - Raw network exception still skips every dimension (1 fetch call).
   - No API key configured at all → throws `"GEMINI_API_KEY belum diisi..."` immediately, `fetch` never called.
   - No dedicated "no fallback keys configured" test — every pre-existing test already covers this implicitly (none of them set `GEMINI_API_KEY_FALLBACKS`), per the plan.

   One bug caught during the first test run: the "composes with chat tier + cross-tier" test originally used status 500 (retryable) for chat-model-a's failure, which meant `fetchGeminiWithRetries`'s own internal 3-attempt retry policy ran per key, inflating the expected call count from 3 to 7. Fixed by switching that mock to 429 (non-retryable), which is what the test actually needed to isolate (the key/model/tier composition, not the already-covered 5xx-retry-exhaustion behavior).

## Test run (Bash, real output)

```
$ npx vitest run lib/gemini.test.js
 Test Files  1 passed (1)
      Tests  33 passed (33)
   Duration  5.74s

$ npx vitest run   (full suite)
 Test Files  3 passed (3)
      Tests  66 passed (66)
   Duration  5.70s
```

No lint script exists in this repo — skipped, consistent with the three prior runs this session.

## Deviations from plan
None — implemented exactly as written in `gemini-api-key-fallback-improvement-plan.md` (key-inner nesting, as the user chose over key-outer). The one mid-implementation fix (500 → 429 in one test's mock) was a test-authoring correction, not a design deviation — caught by actually running the tests per Step 9, not claimed green without real output.

## Follow-ups (not in scope, noted per plan)
- Same operational tradeoff already flagged in [[gemini-fallback-any-error]] — now one dimension bigger (models × keys) for the low-tier cron path's worst-case latency. Still accepted for the same reason (the cron route already degrades per-user regardless of how long a Gemini call took to eventually fail).
- `.env.local`'s `GEMINI_API_KEY_FALLBACKS` is left empty — the user would need to generate a second free API key at https://aistudio.google.com/apikey themselves to actually use this feature locally.
