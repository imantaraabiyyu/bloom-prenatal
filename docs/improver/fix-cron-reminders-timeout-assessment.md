# Assessment — Fix Vercel timeout on /api/cron/reminders

## Reported problem

`Vercel Runtime Timeout Error: Task timed out after 60 seconds` on
`app/api/cron/reminders/route.js` (its `maxDuration` is already set to `60`,
so there's no headroom left to just raise the limit further).

## Current behavior (entry points, data flow, where the change lands)

`app/api/cron/reminders/route.js` (`GET`, [route.js:33-127](../../app/api/cron/reminders/route.js#L33-L127)):

1. Auth check (`CRON_SECRET`) + `kind` validation.
2. Fetches all `push_subscriptions` rows and (for `kind=dinner` only) which
   users already logged a meal/vitamin today — these are batched Supabase
   queries, not the bottleneck.
3. **The loop that is the bottleneck** ([route.js:85-124](../../app/api/cron/reminders/route.js#L85-L124)):
   a strictly sequential `for (const userId of userIds)`, and inside it a
   second sequential `for (const row of subscriptionsByUser.get(userId))`.
   Every iteration `await`s:
   - `generateDailyNudge`/`generateMealFact` (`lib/gemini.js`) — one Gemini
     HTTP call per user (skipped only if the try/catch's fallback path is
     taken, which happens *after* the call already failed/threw).
   - `sendPush` (`lib/pushSender.js`) — one `web-push` HTTP call per
     subscription row.

   Total wall-clock = **sum** across every user and every subscription, not
   the slowest one.

`lib/gemini.js`:
- `fetchGeminiWithRetries` ([gemini.js:90-105](../../lib/gemini.js#L90-L105)) — shared by every Gemini
  call in the file (chat turns, transcription, *and* the two reminder
  functions). Retries `429/500/502/503/504` up to `MAX_ATTEMPTS=3` with
  `600ms → 1.2s` backoff. **No `AbortController`/timeout at all** — a slow
  or hanging Gemini response has no upper bound per attempt.
- `generateDailyNudge` ([gemini.js:353-378](../../lib/gemini.js#L353-L378)) and `generateMealFact`
  ([gemini.js:404-429](../../lib/gemini.js#L404-L429)) are the **only two callers used by the cron
  route** — confirmed via `grep`, nothing else in the codebase calls either
  one. Both call `fetchGeminiWithRetries` with no options besides the
  request body.
- `streamNutritionChatTurn` (chat) and the journal transcribe function also
  call `fetchGeminiWithRetries`, but are invoked once per interactive user
  request (not batched across all users), so they don't have the
  "compounds with user count" failure mode this fix targets — out of scope,
  not touched.

`lib/pushSender.js` (`sendPush`, [pushSender.js:33-53](../../lib/pushSender.js#L33-L53)):
- Wraps `webpush.sendNotification(subscription, payload, { TTL })` in
  try/catch, returns `{ ok, isDead }` — already fully caught, never throws
  up to the route. **No `timeout` option passed**, even though the
  underlying `web-push` package supports one natively (confirmed in
  `node_modules/web-push/src/web-push-lib.js`: `options.timeout` is read
  and applied to the underlying `https.request`/`http.request` call).
- `sendPush` is the **only** thing in the codebase that imports
  `lib/pushSender.js` (confirmed via grep + the file's own doc comment) —
  changing its call to `sendNotification` has no other consumer.

`lib/reminderLogic.js` / `lib/reminderLogic.test.js` — pure logic (message
building, fallback bank picks), no I/O, not touched by this fix. Confirmed
by reading both in full: nothing here calls into `gemini.js`/`pushSender.js`
or the route's loop shape, so parallelizing the route/timing out Gemini
calls doesn't change any of the inputs/outputs these tests assert on.

## Files/functions in scope

- `app/api/cron/reminders/route.js` — replace the two sequential `for`
  loops (per-user, per-subscription) with `Promise.all`-based concurrent
  processing, aggregating `sent`/`pruned`/`skipped` from each task's
  returned result instead of mutating shared counters mid-loop.
- `lib/gemini.js` — give `fetchGeminiWithRetries` an opt-in `timeoutMs`
  option (via `AbortController`), and apply a fixed short timeout only
  inside `generateDailyNudge`/`generateMealFact` (their only callers are
  the cron route). `streamNutritionChatTurn` and the transcribe function
  keep calling without `timeoutMs` — completely unchanged.
- `lib/pushSender.js` — pass a `timeout` option through to
  `webpush.sendNotification` alongside the existing `TTL`.

## Ambiguities

None material — the reported problem, the diagnosed cause, and the
constraints to preserve (auth/validation, response shape, dead-subscription
pruning, existing fallback keying, existing pure-logic tests) were already
stated in the improvement request. Remaining choices (the exact timeout
value, parallelizing per-subscription sends too) are ordinary implementation
judgment within that already-agreed direction, not open questions that
change scope.

## Triage

**Triage: SIMPLE** — 3 files (`route.js`, `gemini.js`, `pushSender.js`), no
schema/migration, no `$KDOCS`-mandatory area (not auth/SSO/WIF/Terraform/
Docker), no open ambiguity, and grep confirms `generateDailyNudge`/
`generateMealFact`/`sendPush` have no other callers beyond the cron route —
low blast radius.
