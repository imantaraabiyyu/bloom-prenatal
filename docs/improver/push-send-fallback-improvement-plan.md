# Improvement Plan — Email fallback when push notification delivery fails

## Goal

When every one of a user's push subscriptions fails to deliver in a given
cron run, send the same reminder content via email instead — a real
recovery path, not just logging, per the user's answers (Resend, and
triggered only when *all* of a user's devices failed, not just one).

## Current behavior

`app/api/cron/reminders/route.js:127-137`: per-subscription `sendPush()`
calls run concurrently; a dead (404/410) subscription is pruned, any
other failure is logged via `console.error` in `lib/pushSender.js:49-52`
and otherwise dropped — "no same-run retry," and no fallback of any
kind. `userIds` is derived from `push_subscriptions` rows that already
exist, so every user this route ever processes already has push set up
— there's no "user never enabled push" case to worry about here, only
"push was attempted and none of it landed."

## Proposed change

1. `npm install resend`.
2. New `lib/emailSender.js`, mirroring `lib/pushSender.js`'s shape:
   `sendReminderEmail(to, subject, text)` — no-ops (`return false`)
   if `RESEND_API_KEY` isn't set (optional feature, same philosophy as
   `GEMINI_API_KEY`), sends via Resend otherwise, catches and logs any
   failure rather than throwing (last-resort fallback — nothing left to
   fall back to further).
3. `route.js`: after `subResults` resolves for a user, if the resulting
   `sentCount === 0`, look up that user's email via
   `supabase.auth.admin.getUserById(userId)` (service-role client, no
   new credentials) and call `sendReminderEmail(email, TITLES[kind],
   body)` — same title/body already built for the push payload, no
   separate template. Track success as a new `emailed` count.
4. `lib/reminderLogic.js`'s `sumReminderResults` gains `emailed` as a
   4th summed field; `route.js`'s response JSON and its `console.log`
   outcome line both include it.
5. `README.md`: new "opsional" section documenting `RESEND_API_KEY`/
   `EMAIL_FROM`, matching the existing Gemini/Push setup sections.

## Scope

### In scope
- `package.json`/`package-lock.json`, `lib/emailSender.js` (new),
  `app/api/cron/reminders/route.js`, `lib/reminderLogic.js`,
  `lib/reminderLogic.test.js`, `README.md`.

### Out of scope / non-goals
- No opt-out preference/toggle — automatic backstop, not a separate
  user-managed feature.
- No retry of the email send itself on failure.
- No differentiated email content for dead-vs-transient causes in v1.

## Steps

1. `npm install resend`; confirm it resolves.
2. `lib/emailSender.js`: implement `sendReminderEmail`.
3. `lib/reminderLogic.js` + `lib/reminderLogic.test.js`: add `emailed` to
   `sumReminderResults` and its tests.
4. `app/api/cron/reminders/route.js`: the `sentCount === 0` →
   `getUserById` → `sendReminderEmail` → `emailed` count/logging change.
5. `README.md`: new setup section.
6. `npm run build` + `npm test` to confirm no regressions.

## Data / schema impact

None — no new table/column; reads the existing Supabase Auth user record
via the admin API, doesn't store anything new.

## Risks & mitigations

- **Resend's sandbox sender being restricted to the account owner's own
  email** (a common pattern for other providers' sandbox modes) — Resend
  specifically allows `onboarding@resend.dev` to send to any recipient
  without domain verification; flagged in the README so the user can
  swap in a verified custom domain via `EMAIL_FROM` later if this
  changes or if they want their own branding.
- **`getUserById` adding latency/another failure point per zero-push
  user** — only called for users who already had `sentCount === 0`
  (a small subset, not every user every run), and wrapped so a failure
  there just skips the email fallback (logged) rather than affecting the
  push-side counts already computed.
- **Regressing `sumReminderResults`'s existing tests** by changing its
  return shape — mitigated by updating those tests in the same step,
  `npm test` as the regression guard.

## Test plan

- `lib/reminderLogic.test.js`: existing `sumReminderResults` cases
  updated to include `emailed: 0` in their expected output; new cases
  covering a mix including nonzero `emailed`, and an empty/undefined
  input still defaulting `emailed` to 0.
- Regression guard: full `npm test` stays green, `npm run build`
  succeeds (validates the new `resend` import resolves).
- Manual (post-deploy, real credentials needed): confirmed by the user
  per the plan's Verification section — this machine has no real
  Supabase/Resend credentials to exercise an end-to-end send.

## Standards notes

No `kredivo-docs` areas touched — application-level feature addition
using a third-party SaaS API key, not cloud infra/auth/Terraform/Docker.
