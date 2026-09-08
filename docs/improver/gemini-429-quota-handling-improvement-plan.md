# Improvement Plan — Graceful Gemini 429 (quota exceeded) handling

## Goal
Stop the shared Gemini retry layer from retrying 429 responses (they can only be transient-quota bugs
away from guaranteed failure and, on the free tier's *daily* quota, retrying just burns further
requests against the same exhausted counter), and reword the user-facing "busy" message so it no
longer implies a short wait will fix what might be a day-long quota exhaustion. Apply consistently to
both routes that share this pattern (nutrition-chat, journal/transcribe).

## Current behavior
- [lib/gemini.js:192](../../lib/gemini.js#L192) `RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])` — 429 retried like a transient 5xx, with a fixed 600ms/1200ms backoff that ignores Gemini's own `RetryInfo.retryDelay` hint.
- [app/api/nutrition-chat/route.js:74-79](../../app/api/nutrition-chat/route.js#L74-L79) and [app/api/journal/transcribe/route.js:59-64](../../app/api/journal/transcribe/route.js#L59-L64) each inline the same `busy = e instanceof GeminiHttpError && (e.status === 503 || e.status === 429)` check and a near-duplicate "lagi ramai dipakai, coba lagi sebentar lagi" message.

## Proposed change
1. **Stop retrying 429** in `fetchGeminiWithRetries` — remove it from `RETRYABLE_STATUS` (keep 500/502/503/504 retryable, unchanged). A 429 now throws `GeminiHttpError(429, body)` on the first attempt, matching the answered question: fail fast rather than wait on a delay that can't be known to be short.
2. **Centralize the "busy" classification + copy** in `lib/gemini.js` as two small exports — `isGeminiBusyError(e)` and `GEMINI_BUSY_MESSAGE` — reused by both routes instead of each duplicating the ternary and the string. This is also what makes the fix unit-testable (mirrors why `sanitizeChatTurnResult` was pulled out of the route for its own tests).
3. **Reword the shared message** to not overpromise a quick recovery, per the "one improved generic message" answer — no quotaId parsing, same message for 429 and 503:
   `"Gemini API lagi dibatasi kuotanya, belum bisa diproses sekarang. Coba lagi beberapa saat lagi ya."`

## Scope
### In scope
- `lib/gemini.js` — drop 429 from `RETRYABLE_STATUS` (+ update the comment above it explaining why); add `export function isGeminiBusyError(e)`; add `export const GEMINI_BUSY_MESSAGE`.
- `app/api/nutrition-chat/route.js` — replace the inline `busy` check + message with `isGeminiBusyError`/`GEMINI_BUSY_MESSAGE`.
- `app/api/journal/transcribe/route.js` — same replacement.

### Out of scope / non-goals
- No quotaId parsing / no distinct "daily quota" vs "transient overload" copy (per answered question).
- No change to `generateDailyNudge`/`generateMealFact` call sites or the cron route's fallback logic — they already swallow any error unconditionally ([app/api/cron/reminders/route.js:108-119](../../app/api/cron/reminders/route.js#L108-L119)); dropping 429 from the retryable set only makes that fallback trigger slightly faster, no behavior change needed there.
- No change to `MAX_ATTEMPTS`/`RETRY_BASE_DELAY_MS` for the still-retryable 5xx statuses.
- No `GEMINI_API_KEY`/quota configuration change — that's an account/billing decision outside this codebase.

## Steps
1. `lib/gemini.js`: edit `RETRYABLE_STATUS` to `new Set([500, 502, 503, 504])`; update the comment above it to explain 429 is excluded because the free tier's quota is a per-day counter — retrying within one request's lifetime cannot succeed and only spends more of that same daily budget.
2. `lib/gemini.js`: add, near `GeminiHttpError`, the two new exports:
   ```js
   export const GEMINI_BUSY_MESSAGE = "Gemini API lagi dibatasi kuotanya, belum bisa diproses sekarang. Coba lagi beberapa saat lagi ya.";
   export function isGeminiBusyError(e) {
     return e instanceof GeminiHttpError && (e.status === 503 || e.status === 429);
   }
   ```
3. `app/api/nutrition-chat/route.js`: import `isGeminiBusyError, GEMINI_BUSY_MESSAGE` alongside the existing `streamNutritionChatTurn, GeminiHttpError` import (drop `GeminiHttpError` from the import if it becomes unused there); replace the `const busy = ...` line + ternary with the shared helpers.
4. `app/api/journal/transcribe/route.js`: same replacement.
5. Add tests (see Test plan) to `lib/gemini.test.js`.

## Data / schema impact
None.

## Risks & mitigations
- **Risk:** a 429 that was actually a short-lived per-minute burst (not the daily cap) will now fail on the first attempt instead of succeeding on retry 2/3.
  **Mitigation:** explicitly accepted in the answered question — the fixed 600/1200ms backoff was already far shorter than Gemini's own suggested `retryDelay` (33s in the reported case), so those retries were already ineffective in practice for a real rate-limit wait; failing fast is a straight improvement (no wasted latency/quota) with no realistic regression.
- **Risk:** message copy change is user-visible; wrong tone could read oddly in the Bahasa Indonesia chat UI.
  **Mitigation:** kept short, same casual register as the rest of the app's copy (`Kamu perlu login dulu.`, `Foto terlalu besar...`), reviewed against existing strings in both route files before landing.

## Test plan
`lib/gemini.test.js` (Vitest, mocking `global.fetch` — same style already used for pure-function testing in this file, extended here since `generateDailyNudge`/`isGeminiBusyError` are now exported and network-mockable):
1. **`isGeminiBusyError`** — pure, sync: 429 → true, 503 → true, 404/500 → false, a plain `Error` (not `GeminiHttpError`) → false.
2. **429 fails fast (regression guard for the actual bug reported)** — mock `fetch` to resolve once with `{ ok: false, status: 429, text: async () => "...RESOURCE_EXHAUSTED..." }`; call `generateDailyNudge({})`; assert it rejects with `GeminiHttpError` whose `status === 429`, and that `fetch` was called **exactly once** (no retries).
3. **503 still retries (unaffected legacy behavior)** — mock `fetch` to resolve `503` twice then a valid success body; call `generateDailyNudge({})`; assert it resolves successfully and `fetch` was called exactly 3 times — proves the retry path for genuinely transient 5xx errors is untouched.

Uses `generateDailyNudge` (already exported, non-streaming, simplest call site) as the vehicle for exercising `fetchGeminiWithRetries` rather than exporting that internal function itself — consistent with this file's existing "export only what needs to be independently tested" convention.

## Standards notes
No kredivo-docs areas touched (no auth/SSO, GCP/WIF, Terraform, or Docker changes).
