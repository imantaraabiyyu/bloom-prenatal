# Implementation Log — Graceful Gemini 429 (quota exceeded) handling

Branch: `main` (user chose to stay on main, carrying pre-existing uncommitted changes as-is).

## Steps

1. **`lib/gemini.js` — stop retrying 429** ([lib/gemini.js:192-205](../../lib/gemini.js#L192-L205))
   - `RETRYABLE_STATUS` narrowed from `{429, 500, 502, 503, 504}` to `{500, 502, 503, 504}`.
   - Comment above it rewritten to explain why: the free tier's quota is a per-day counter, retrying within one request can't succeed once it's spent, and every retry burns another request against that same exhausted budget; Gemini's own `RetryInfo.retryDelay` (tens of seconds) was always longer than the fixed 600/1200ms backoff anyway.
   - No change to the still-retryable 500/502/503/504 path, `MAX_ATTEMPTS`, or `RETRY_BASE_DELAY_MS`.

2. **`lib/gemini.js` — centralize the "busy" classification + copy** ([lib/gemini.js:188-201](../../lib/gemini.js#L188-L201))
   - Added `export const GEMINI_BUSY_MESSAGE = "Gemini API lagi dibatasi kuotanya, belum bisa diproses sekarang. Coba lagi beberapa saat lagi ya."`
   - Added `export function isGeminiBusyError(e) { return e instanceof GeminiHttpError && (e.status === 503 || e.status === 429); }`
   - Placed directly after `GeminiHttpError`'s definition, with a comment explaining why one generic message covers both 429 and 503 rather than parsing the error body for the daily-quota-specific `quotaId`.

3. **`app/api/nutrition-chat/route.js`** ([app/api/nutrition-chat/route.js:3](../../app/api/nutrition-chat/route.js#L3), [:69-76](../../app/api/nutrition-chat/route.js#L69-L76))
   - Import swapped from `GeminiHttpError` to `isGeminiBusyError, GEMINI_BUSY_MESSAGE`.
   - Inline `busy = ...` ternary replaced with `isGeminiBusyError(e) ? GEMINI_BUSY_MESSAGE : "Ada gangguan pas memproses pesannya. Coba lagi sebentar lagi."`.
   - Comment above it updated to reflect that 429 no longer retries at all (previously said "already survived a couple of retries" for both statuses).

4. **`app/api/journal/transcribe/route.js`** ([app/api/journal/transcribe/route.js:3](../../app/api/journal/transcribe/route.js#L3), [:57-61](../../app/api/journal/transcribe/route.js#L57-L61))
   - Same import + ternary replacement as nutrition-chat, for consistency (per the answered "both routes" question).

5. **Tests — `lib/gemini.test.js`**
   - Import line extended to also pull `isGeminiBusyError, GeminiHttpError, generateDailyNudge`.
   - New `describe("isGeminiBusyError", ...)`: 429 → true, 503 → true, 500/400 → false, non-`GeminiHttpError`/`null` → false.
   - New `describe("fetchGeminiWithRetries status policy (via generateDailyNudge)", ...)`, using `generateDailyNudge` (simplest exported call site) as the vehicle since `fetchGeminiWithRetries` itself isn't exported:
     - 429 → mocked `fetch` resolving once with `{ok:false, status:429}`; asserts the call rejects with `status: 429` and `fetch` was called **exactly once** (regression guard for the reported bug — no more wasted retries against an exhausted daily quota).
     - 503 twice then success → asserts `generateDailyNudge` still resolves and `fetch` was called **exactly 3 times** (proves the still-retryable 5xx path is unaffected).
   - No fake timers needed: `RETRY_BASE_DELAY_MS` backoff (600ms + 1200ms in the 503 case) runs with real timers; test suite duration stayed at ~3.3s total, no meaningful slowdown.

## Test run (Bash, real output)

```
$ npx vitest run lib/gemini.test.js
 Test Files  1 passed (1)
      Tests  17 passed (17)
   Duration  3.29s

$ npx vitest run   (full suite)
 Test Files  3 passed (3)
      Tests  49 passed (49)
   Duration  2.64s
```

No lint script exists in this repo (`package.json` has no `lint` entry) — skipped, nothing to run.

## Deviations from plan
None — implemented exactly as written in `gemini-429-quota-handling-improvement-plan.md`.

## Follow-ups (not in scope, noted per plan's Out-of-scope section)
- No quotaId parsing / no distinct daily-quota-vs-transient-overload copy — deliberately deferred per the answered question, not a gap.
- The underlying free-tier daily cap (20 requests/day for `gemini-3.6-flash`) is a Google Cloud/API-project billing limit; this change makes failures fail fast and read honestly, it does not raise the cap itself — that's an account/billing decision outside this codebase.
