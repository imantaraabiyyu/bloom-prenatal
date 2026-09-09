# Implementation Log — Email fallback when push notification delivery fails

Branch: `main` (per the user's choice; working tree was clean at Step 0).

## Step 1 — `npm install resend`

Installed cleanly (`resend@6.26.0`). Before writing `lib/emailSender.js`,
inspected the installed package's own `.d.ts` (`node_modules/resend/dist/
index.d.mts`) rather than relying on memory — confirmed `new
Resend(apiKey)`, `client.emails.send({ from, to, subject, text })`
returning `{ data, error }`, and that `text` alone (without `html`)
satisfies `CreateEmailOptions`'s "at least one of html/text/react"
requirement. `npm audit`'s 6 pre-existing vulnerabilities (Supabase/Next
internals, confirmed in an earlier run this session) are unchanged by
this install.

## Step 2 — `lib/emailSender.js` (new)

`sendReminderEmail(to, subject, text)` — mirrors `lib/pushSender.js`'s
shape: no-ops (`return false`) when `RESEND_API_KEY` is unset (same
"optional, absent = gracefully skipped" pattern as `GEMINI_API_KEY`),
never throws (last-resort fallback — nothing left to fall back to
further), logs via `console.error` on failure same as `pushSender.js`
does. `EMAIL_FROM` defaults to Resend's own `onboarding@resend.dev`
sandbox sender.

## Step 3 — `sumReminderResults` gains `emailed`

`lib/reminderLogic.js`: added `emailed` as a 4th summed field, defaulting
to 0. Updated the 4 existing test cases in `lib/reminderLogic.test.js` to
include `emailed: 0` in their expected output (their behavior otherwise
unchanged), and added a new case covering a nonzero `emailed` mixed with
the other 3 fields.

**Commit hiccup, noted for the record**: the first commit attempt for
this step (via `git commit -F <message-file>`, written with a heredoc)
produced no output and no commit — the files stayed staged. Re-ran with
a plain `git commit -m "..."` immediately after and it succeeded cleanly
on the first try; switched to plain `-m` for the rest of this run's
commits rather than investigate the heredoc/-F path further (out of
scope, and the fix was immediate).

## Step 4 — `app/api/cron/reminders/route.js`

After a user's per-subscription `Promise.all` resolves, if the resulting
`sentCount === 0`, fetches that user's email via
`supabase.auth.admin.getUserById(userId)` (the service-role client
already in use there — no new credentials) and calls
`sendReminderEmail(email, TITLES[kind], body)` with the exact same
title/body already built for the push payload. Confirmed this can't
fire for the dinner slot's early-return "skip" path (`return { sent: 0,
pruned: 0, skipped: 1 }` happens before `subResults` is ever computed,
so the `sentCount === 0` check is structurally unreachable from there).
`emailed` threaded through the response JSON and the existing outcome
`console.log` line (added in an earlier concurrent-session commit,
specifically because Vercel Logs don't show response bodies) alongside
`sent`/`pruned`/`skipped`.

## Step 5 — `README.md`

New "## 7. (Opsional) Aktifkan fallback email kalau push gagal terkirim"
section, matching the style of the existing Gemini/Push setup sections
(numbered steps, an env var code block, a closing "tanpa X diisi, tetap
jalan tanpa Y" note). Also added `lib/emailSender.js` to the `Struktur
project` file listing, next to `pushSender.js`.

## Tests

```
$ npm run build
✓ Compiled successfully
✓ Generating static pages (13/13)

$ npm test
 Test Files  3 passed (3)
      Tests  66 passed (66)
```

Both green after every step along the way, not just once at the end.

## CLAUDE.md (Step 10)

Marker `<!-- beehive:improver-skill-auto-invoke -->` already present —
already enabled, no question asked, no edit made.

## Deferred / follow-ups (not in scope for this run)

- End-to-end verification of an actual email arriving — this machine's
  `.env.local` has no real Resend/Supabase credentials to exercise it;
  left to the user post-deploy, per the approved plan's Verification
  section.
- No opt-out preference, no retry of the email send itself, no
  differentiated content for dead-vs-transient causes — all explicitly
  out of scope per the approved plan's Non-goals.
- Whether Resend's `onboarding@resend.dev` sandbox sender's
  send-to-any-recipient behavior holds as documented is worth the user
  double-checking on their own account after signup, since sandbox
  policies can vary/change by provider.
