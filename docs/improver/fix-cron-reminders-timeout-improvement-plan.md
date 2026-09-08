# Improvement Plan — Fix Vercel timeout on /api/cron/reminders (SIMPLE)

## Goal

Stop `/api/cron/reminders` from hitting Vercel's 60s function timeout, by
bounding per-call latency (Gemini + push send) and running independent
per-user/per-subscription work concurrently instead of summing it
sequentially.

## Current behavior

See `fix-cron-reminders-timeout-assessment.md` — sequential `for` loops in
`route.js` ([route.js:85-124](../../app/api/cron/reminders/route.js#L85-L124)), no timeout on Gemini fetches
(`gemini.js`'s `fetchGeminiWithRetries`, [gemini.js:90-105](../../lib/gemini.js#L90-L105)), no timeout on
`web-push` sends (`pushSender.js`, [pushSender.js:33-53](../../lib/pushSender.js#L33-L53)).

## Proposed change

1. **`lib/gemini.js`** — add an opt-in `timeoutMs` option to
   `fetchGeminiWithRetries` (`AbortController`, aborts and retries like any
   other transient failure, same `MAX_ATTEMPTS`/backoff). Apply a fixed
   8s-per-attempt timeout only inside `generateDailyNudge`/
   `generateMealFact` (their sole callers are the two cron reminder slots
   that need this fix) — `streamNutritionChatTurn`/transcribe keep calling
   without it, unchanged.
2. **`lib/pushSender.js`** — pass `timeout: 8000` alongside the existing
   `TTL` to `webpush.sendNotification` (the package already supports this
   option natively).
3. **`app/api/cron/reminders/route.js`** — replace the sequential per-user
   `for` loop (and its nested per-subscription `for` loop) with
   `Promise.all`, each user task returning `{ sent, pruned, skipped }`
   which are summed after all tasks settle, instead of mutating shared
   counters mid-loop. CRON_SECRET check, `kind` validation, and the
   response JSON shape stay exactly the same.

Net effect: total wall-clock becomes roughly "slowest single user's Gemini
call + push sends" instead of "sum across every user", and no single Gemini
call can silently hang past ~8s × 3 attempts.

## Scope

- `lib/gemini.js` — `fetchGeminiWithRetries` gets `timeoutMs` support;
  `generateDailyNudge`/`generateMealFact` pass a fixed timeout.
- `lib/pushSender.js` — `sendPush` passes `timeout` to `sendNotification`.
- `app/api/cron/reminders/route.js` — per-user/per-subscription loop
  becomes `Promise.all`-based; counters aggregated from returned results.

## Steps

1. `lib/gemini.js`: extend `fetchGeminiWithRetries`'s options with
   `timeoutMs`; on abort, treat like a retryable failure (same backoff),
   throwing `GeminiHttpError` once attempts are exhausted. Add a
   `CRON_GEMINI_TIMEOUT_MS` constant; pass it from `generateDailyNudge` and
   `generateMealFact` only.
2. `lib/pushSender.js`: add `timeout: PUSH_TIMEOUT_MS` to the
   `sendNotification` options object.
3. `app/api/cron/reminders/route.js`: rewrite the loop body as an async
   per-user function returning `{ sent, pruned, skipped }`, run all of them
   via `Promise.all(userIds.map(...))`, and sum the three counters from the
   results array for the final `NextResponse.json(...)`.

## Test plan

- New test in `lib/reminderLogic.test.js`'s neighborhood isn't applicable
  (that file is pure-logic and untouched) — instead, since `gemini.js` and
  `route.js` do real network/DB I/O with no existing test harness for that
  (per `README.md`'s own "Testing" section: network calls are verified
  manually, not unit-tested), add a **new** lightweight unit test file for
  the one pure, extractable piece of this change: the counter-aggregation
  logic (summing `{ sent, pruned, skipped }` across settled per-user
  results) — factored out as a small pure helper so it's actually testable
  without mocking Gemini/Supabase/web-push.
- Regression guard: run the full existing suite (`npm test`) to confirm
  `lib/reminderLogic.test.js` and `lib/nutrition.test.js` still pass
  unchanged.
- Manual verification (documented, not automated — consistent with this
  repo's existing testing philosophy): `npm run build` to confirm the
  route still compiles/type-checks under Next's build.

## Triage

SIMPLE — 3 files, no schema/migration, no `$KDOCS`-mandatory area, no open
ambiguity, low blast radius (grep-confirmed single-caller functions).
