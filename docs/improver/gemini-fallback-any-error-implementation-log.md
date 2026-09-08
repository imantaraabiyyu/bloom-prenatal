# Implementation Log — Broaden model fallback trigger from 429-only to any GeminiHttpError

Branch: `main` (clean tree, user chose to stay).

## Steps

1. **`lib/gemini.js` `tryModelChain`** ([lib/gemini.js:306-329](../../lib/gemini.js#L306-L329)) — dropped the `e.status !== 429` check from the per-model advance condition, now `if (!(e instanceof GeminiHttpError) || isLastModel) throw e;`. Rewrote the surrounding comment to explain the "fallback everything" reasoning, the 404-in-production trigger for this change, and the operational tradeoff for the low-tier cron path. Updated `console.warn` to report the actual status instead of a hardcoded "429".

2. **`lib/gemini.js` `fetchGeminiForChat`** ([lib/gemini.js:345-360](../../lib/gemini.js#L345-L360)) — same broadening on the cross-tier drop condition: `if (!(e instanceof GeminiHttpError)) throw e;` before trying the low tier. `console.warn` updated similarly.

3. **`README.md`** — one-line rewording in the fallback-chain explanation: "kena limit kuota (429)" → "kena limit kuota/429, atau model-nya sudah dipensiunkan Google/404, atau error lain", and "kena limit kuota di SEMUA modelnya" → "gagal di SEMUA modelnya" (no longer 429-specific).

4. **Tests — `lib/gemini.test.js`**
   - Low-tier describe block: added a 404 regression test (mirrors the exact reported bug), rewrote the old "does not fall back on non-429" test into "falls back... even on an already-retry-exhausted 5xx" (now asserts 4 fetch calls instead of 3, and success), added a mixed-status (404 → 429 → 403) whole-chain-exhaustion test proving no status is special-cased, and added a new "raw network exception" test proving that boundary (non-`GeminiHttpError` errors never trigger any fallback) is unchanged.
   - Chat-tier describe block: replaced "does not fall through to the low tier on a non-429 chat-tier failure" with two tests — "falls back within the chat tier on a 404" (the literal production bug, using the exact 404 error body Google returned) and "falls through to the low tier even on a non-429 status once the whole chat tier is exhausted" (500, not 429) — plus a matching "raw network exception" boundary test for the chat tier.
   - Existing 429-based tests (low-tier fallback, chat-tier cross-tier fallback via 429, whole-low-tier-chain-429-exhaustion) left untouched — 429 is still one of the covered statuses, just no longer the only one.

## Test run (Bash, real output)

```
$ npx vitest run lib/gemini.test.js
 Test Files  1 passed (1)
      Tests  28 passed (28)
   Duration  5.98s

$ npx vitest run   (full suite)
 Test Files  3 passed (3)
      Tests  60 passed (60)
   Duration  5.75s
```

No lint script exists in this repo — skipped, consistent with the two prior runs this session.

## Deviations from plan
None — implemented exactly as written in `gemini-fallback-any-error-improvement-plan.md`. The plan's test-plan bullets (mixed-status whole-chain exhaustion, literal 404 regression, raw-exception boundary) were all included, plus one extra test (chat-tier 500-broadened-cross-tier) for symmetry with the low-tier equivalent — a natural completion of the planned test matrix, not a scope expansion.

## Follow-ups (not in scope, noted per plan)
- The operational tradeoff for the low-tier cron path (a long `GEMINI_FALLBACK_MODELS` chain multiplying an exhausted-5xx's ~26s cost per model) is flagged in code comments and this log, not mitigated — `app/api/cron/reminders/route.js`'s own 60s function budget and per-user `catch{...fallback...}` already degrade gracefully regardless, but if this becomes a real problem in practice (long fallback chains + frequent 5xx), a per-model or total time budget for the fallback loop would be the next improvement.
- `.env.local` (gitignored, not committed) was already updated by the user directly in a prior turn — not touched by this run.
