# Assessment — Graceful Gemini 429 (quota exceeded) handling

## Reported problem
User-reported error (nutrition-chat, but the same client/pattern is shared by journal transcribe):

```
nutrition-chat stream error: Gemini API error: 429 {
  "error": { "code": 429, "status": "RESOURCE_EXHAUSTED",
    "message": "...Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
                limit: 20, model: gemini-3.6-flash. Please retry in 33.026263417s.",
    "details": [
      { "@type": "...QuotaFailure", "violations": [{ "quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier", ... }] },
      { "@type": "...RetryInfo", "retryDelay": "33s" }
    ]
  }
}
```
`gemini selalu ...` ("gemini always ...") — implies this is not a one-off blip but every chat turn failing right now, consistent with the free tier's **daily** quota (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, limit 20/day) being fully exhausted for the day.

## Current behavior

### Retry layer — [lib/gemini.js:192-240](../../lib/gemini.js#L192-L240)
- `RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])` — 429 is retried exactly like a transient 5xx.
- `MAX_ATTEMPTS = 3` (1 try + 2 retries), backoff `RETRY_BASE_DELAY_MS * 2**attempt` = **600ms, then 1200ms**.
- Gemini's own error body includes `RetryInfo.retryDelay` (here: `33s`) — **never read**; the fixed 600/1200ms backoff is used regardless of what Gemini says to actually wait.
- This function is shared by all 4 Gemini call sites: `streamNutritionChatTurn`, `streamTranscribeVoiceNote`, `generateDailyNudge`, `generateMealFact` ([lib/gemini.js:304](../../lib/gemini.js#L304), [:395](../../lib/gemini.js#L395), [:494](../../lib/gemini.js#L494), [:546](../../lib/gemini.js#L546)).
- Consequence when the **daily** quota is the thing exhausted: each retry is itself another counted request against that same exhausted daily quota, guaranteed to 429 again — so a single user chat turn burns 3 requests instead of 1 while accomplishing nothing, and still takes ~1.8s longer to fail than it needs to.

### User-facing error — [app/api/nutrition-chat/route.js:74-79](../../app/api/nutrition-chat/route.js#L74-L79) and identically [app/api/journal/transcribe/route.js:59-64](../../app/api/journal/transcribe/route.js#L59-L64)
```js
const busy = e instanceof GeminiHttpError && (e.status === 503 || e.status === 429);
send({ type: "error", error: busy
  ? "Gemini lagi ramai dipakai. Coba kirim lagi dalam beberapa saat ya."
  : "Ada gangguan pas memproses pesannya. Coba lagi sebentar lagi." });
```
- Already distinguishes "busy" (429/503) from a hard failure — this part isn't crashing raw to the user, it does send a friendly ndjson `error` event, and `console.error` logs the full `GeminiHttpError` server-side (which is the log line the user pasted).
- The "busy, try again in a moment" wording is accurate for a transient 503/short-lived rate limit, but **misleading for a daily-quota exhaustion** — retrying "in a few seconds" cannot succeed until the daily counter resets, so the user is told to do something that won't work.
- No distinction currently exists between "transient overload, retry soon" (503, or a short-window 429) and "daily quota fully spent" (429 specifically with the `PerDay` quotaId) — both collapse to the same "ramai, coba lagi sebentar" message.

### Cron call sites — [app/api/cron/reminders/route.js:108-119](../../app/api/cron/reminders/route.js#L108-L119)
`generateDailyNudge`/`generateMealFact` failures are already swallowed unconditionally (`catch { ...fallback... }`, no status check) — not affected by the message-wording question, only incidentally sped up if 429 retries are removed (less wasted time per user in the 60s batch job).

## Files/functions in scope
- [lib/gemini.js](../../lib/gemini.js) — `fetchGeminiWithRetries`, `RETRYABLE_STATUS`, `GeminiHttpError` (retry policy for 429; optionally surface quota/retry-delay info to callers)
- [app/api/nutrition-chat/route.js](../../app/api/nutrition-chat/route.js) — user-facing error message branch
- [app/api/journal/transcribe/route.js](../../app/api/journal/transcribe/route.js) — same message branch (identical pattern, same root cause)

## Open ambiguities (the description doesn't resolve these)
1. **Retry policy for 429**: stop retrying 429 entirely (fail fast — cheapest fix, saves quota), or keep retrying but honor Gemini's own `retryDelay` hint instead of the fixed 600/1200ms backoff?
2. **Message differentiation**: is a single improved "busy" message enough for both 429 and 503, or does the daily-quota-exhausted case (429 + `PerDay` quotaId) need its own distinct copy (e.g. explicitly saying "quota harian habis, coba lagi besok" instead of implying a short wait will fix it)?
3. **Scope**: apply the same fix to journal/transcribe (identical pattern, same shared retry function) or leave it untouched and fix nutrition-chat only?

Triage: COMPLEX — open ambiguity on retry policy, message differentiation, and scope survives the assessment (fails the "no open ambiguity" SIMPLE criterion); routing through clarifying questions rather than guessing at intent.
