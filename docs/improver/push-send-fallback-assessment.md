# Assessment — Fallback when a push notification fails to send

## Request (verbatim)

"if push up notif won't sent can we add fallback?" — prompted by the
Vercel log screenshot in this same conversation showing one subscription
returning HTTP 410 (dead, correctly pruned) — but the underlying question
is about the *other* failure case: what happens today when a send fails
for a reason that isn't "this subscription is permanently gone."

## Current behavior

`app/api/cron/reminders/route.js:127-137`: for each of a user's
`push_subscriptions` rows, `sendPush()` (`lib/pushSender.js:33-55`) is
called once, concurrently with every other row (no loop-level retry).
`sendPush` returns:
- `{ ok: true }` — delivered.
- `{ ok: false, isDead: true }` — HTTP 404/410 (push service says the
  subscription is permanently gone) → the route deletes that row from
  `push_subscriptions` (correct — retrying a dead subscription can never
  succeed).
- `{ ok: false, isDead: false }` — *any other* failure: a non-404/410
  HTTP status from the push service, a network error, or the 8s socket
  timeout added in an earlier run this session. **This is the actual gap
  the user is asking about** — per the route's own comment (line 134):
  "logged ... and just moved past -- no same-run retry." Nothing retries
  it, nothing tries again later, and nothing records that it happened
  beyond a `console.error` line in `sendPush` itself (`pushSender.js:49-52`)
  — invisible unless someone is watching Vercel Runtime Logs at that
  moment. The user simply doesn't get that one reminder slot on that
  device, with no visibility and no recovery.

Related, already-existing patterns worth reusing rather than inventing
something new:
- `lib/gemini.js`'s `fetchGeminiWithRetries` already retries transient
  HTTP failures (500/502/503/504) with exponential backoff, a proven
  pattern in this same codebase for "retry a flaky external call."
- The route's per-user/per-subscription work is already parallelized
  (`Promise.all`, from an earlier run this session fixing a Vercel 60s
  timeout) — any added retry logic must stay mindful of that budget: a
  retry that blocks for several seconds per failed subscription, times
  however many subscriptions fail in a given run, eats into the same 60s
  ceiling that was already a real incident once this session.
- `sumReminderResults`/the route's own `console.log` outcome line (this
  session's own recent work, prompted by the user's screenshot) already
  established the pattern of surfacing per-run outcomes in Vercel Logs
  since the response body itself isn't visible there.

## Files/functions likely in scope

- `lib/pushSender.js` — `sendPush`'s failure handling.
- `app/api/cron/reminders/route.js` — the per-subscription loop, and
  possibly the outcome-counting/logging (`sent`/`pruned`/`skipped`
  already tracked — a 4th category may be needed if failures are now
  tracked distinctly rather than silently dropped).

## Ambiguities (unresolved — block a SIMPLE classification)

1. **What kind of fallback**: an immediate retry (1-2 extra attempts with
   backoff, same call, same run — mirrors `fetchGeminiWithRetries`'s
   existing pattern) vs. a completely different delivery channel (e.g.
   email) when push fails vs. just visibility (log/track failures
   without auto-retrying) vs. a catch-up mechanism that tries again on a
   *later* cron run rather than immediately.
2. **If retrying**: how many attempts / how much backoff is acceptable
   given the existing 60s function-timeout budget (already a real
   incident once this session)?
3. **Scope**: all 4 daily slots, or just some?

## Triage

**Triage: COMPLEX** — genuinely open question about which kind of
fallback is wanted (retry vs. alternate channel vs. visibility-only vs.
deferred catch-up) with materially different scope/risk per option, plus
a real timeout-budget constraint from this session's own prior incident
that any retry design must respect.
