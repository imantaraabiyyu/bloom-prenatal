# Improvement Plan — Web Push meal/vitamin reminders

## Goal
Add self-hosted Web Push (PWA) notifications to Bloom: once daily at 19:00 WIB, remind a
subscribed user if they haven't logged today's meal and/or vitamin check yet, with a short
Gemini-generated affirmation or pregnancy fact appended (falling back to a static curated line if
Gemini is unavailable) so the reminder doesn't feel repetitive day after day.

## Current behavior
- No PWA/push infra exists (see assessment.md) — no manifest, no service worker, no `web-push`
  dependency, no cron, no service-role Supabase client anywhere in the codebase.
- `meals` and `vitamin_checks` already record what's logged per `(user_id, date)`
  (`supabase/schema.sql:28-88`); "logged vitamin today" must mean *at least one `checked = true`
  row for today* per the answered question — an all-unchecked day still counts as not-logged.
- `lib/nutrition.js:210` already has `todayISOInTimeZone(tz = "Asia/Jakarta")` — a leftover-but-
  correct helper for "what's today in WIB" from a UTC serverless host clock. **Reused as-is**, not
  reinvented.
- `lib/gemini.js` has an established plain-`fetch` + retry pattern (`fetchGeminiWithRetries`,
  `GeminiHttpError`) for structured-JSON Gemini calls, used non-streaming-safe (the transcribe/chat
  callers use `streamGenerateContent`, but the same retry helper works against plain
  `generateContent` too since it only checks `res.ok`).
- `app/dashboard/profile/page.js` is the existing home for personal/device settings (HPHT, baby
  names) — the agreed spot for the new opt-in panel.
- No test framework installed at all (`package.json` has no `devDependencies`, no test script).

## Proposed change
1. **Schema**: new `push_subscriptions` table, RLS owner-scoped like every other table.
2. **PWA shell**: `manifest.json` + `sw.js` + 3 generated placeholder icons + registration wired
   into `app/layout.js`, so the browser can hold a push subscription (and so iOS users can add
   Bloom to their Home Screen, the only way iOS 16.4+ delivers web push at all).
3. **Subscribe/unsubscribe**: a client helper (`lib/push.js`) + an authenticated API route
   (`app/api/push/subscribe/route.js`, mirrors the existing cookie-session pattern) + a new
   "Notifikasi" panel in the Profile page.
4. **Pure decision logic** (`lib/reminderLogic.js`, new — same "computed, not stored" philosophy as
   `lib/nutrition.js`/`lib/pregnancy.js`): who's missing what, the reminder body copy, and the
   static-fallback nudge picker — all as small, independently-testable functions with no I/O.
5. **Gemini nudge**: one new exported function in `lib/gemini.js`, non-streaming, same
   retry/error-class conventions as the rest of the file.
6. **Sender**: `lib/supabaseAdmin.js` (first-ever service-role client in this codebase, server-only,
   used *only* by the cron route to see across all users — RLS still protects every other path in
   the app) + `lib/pushSender.js` (thin `web-push` wrapper) + `app/api/cron/reminders/route.js`
   (the actual scheduled job, protected by `CRON_SECRET`) + `vercel.json` (`crons` entry, `0 12 * *
   *` = 19:00 WIB daily — Indonesia has no DST, so this stays correct year-round).
7. **Tests**: introduce `vitest` (lightest fit for this repo — zero existing test infra to match,
   no framework preference expressed anywhere) with a minimal alias-aware config, and unit-test the
   new pure functions in `lib/reminderLogic.js` **plus** a regression test for the pre-existing
   `todayISOInTimeZone` — justified because the new cron route's send-or-skip decision now
   critically depends on that function's correctness at day boundaries, not because it's a drive-by
   cleanup.

## Scope

### In scope
- `supabase/schema.sql` — append `push_subscriptions` table + 3 RLS policies (select/insert/delete;
  no update needed — resubscribe is delete+insert).
- `package.json` — add `web-push` (runtime dep) and `vitest` (dev dep) + a `"test": "vitest run"`
  script.
- `vitest.config.js` (new) — minimal, just resolves the `@/*` alias `jsconfig.json` already defines,
  so `lib/reminderLogic.test.js` can `import ... from "@/lib/nutrition"` the same way app code does.
- `public/manifest.json` (new) — name "Bloom", `start_url: "/dashboard"`, `display: "standalone"`,
  theme/background colors matching `--bg2`/`--accent` from `app/globals.css`, 3 icon entries.
- `public/icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (new) — generated with a
  throwaway pure-Node script (no new dependency, no image tool available on this machine): flat
  `--bg2` background + centered `--accent` circle. Explicitly a placeholder, easy to swap later.
- `public/sw.js` (new) — `push` handler → `showNotification` from the JSON payload; `notificationclick`
  handler → focus an existing Bloom tab or open `/dashboard`.
- `components/ServiceWorkerRegister.js` (new, `"use client"`) — registers `/sw.js` on mount, guarded
  by `"serviceWorker" in navigator`.
- `app/layout.js` — add `<link rel="manifest">`, `<meta name="theme-color">`,
  `<link rel="apple-touch-icon">`, render `<ServiceWorkerRegister />`.
- `lib/push.js` (new) — `isPushSupported()`, `getSubscriptionState()`, `subscribeToPush(supabase)`,
  `unsubscribeFromPush(supabase)`. Talks to `/api/push/subscribe`.
- `app/api/push/subscribe/route.js` (new) — `POST` (upsert the caller's own subscription row via
  the normal cookie-session Supabase client, RLS-scoped — **no service-role needed here**, this is
  the user writing their own row) and `DELETE` (remove the caller's own row by endpoint).
- `lib/reminderLogic.js` (new) — `pickMissing(mealUserIds, vitaminUserIds, userId)`,
  `buildReminderBody({ missingMeal, missingVitamin, nudge })`, `FALLBACK_NUDGES` (curated array),
  `pickFallbackNudge(seed)`.
- `lib/reminderLogic.test.js` (new) — unit tests for the above.
- `lib/nutrition.test.js` (new, narrow) — one regression test for `todayISOInTimeZone` at a WIB
  day-boundary instant, justified above.
- `lib/gemini.js` — add `generateDailyNudge({ trimester, weeks })`, reusing
  `fetchGeminiWithRetries`/`GeminiHttpError`; throws on failure (existing file's convention),
  caller decides the fallback.
- `lib/supabaseAdmin.js` (new) — `import "server-only"`, service-role client, throws a clear error
  if `SUPABASE_SERVICE_ROLE_KEY` is missing (same style as the existing "belum dikonfigurasi" checks).
- `lib/pushSender.js` (new) — `sendPush(subscriptionRow, payload)` wrapping `web-push`, throws
  `WebPushError`-shaped info the caller uses to decide "prune this subscription" (404/410) vs.
  "log and move on" (anything else).
- `app/api/cron/reminders/route.js` (new) — `GET`, checks `Authorization: Bearer $CRON_SECRET`,
  queries subscriptions/meals/vitamin_checks/profiles via the admin client, computes today (WIB) via
  the reused `todayISOInTimeZone`, decides per user via `reminderLogic.js`, gets the nudge line
  (Gemini → fallback on any failure), sends via `pushSender.js`, prunes dead subscriptions, returns
  a `{ sent, pruned, skipped }` summary.
- `vercel.json` (new) — one cron entry, `"0 12 * * *"`.
- `app/dashboard/profile/page.js` — new "Notifikasi" panel: supported/unsupported message,
  current permission/subscription state, enable/disable buttons, the 19:00 WIB + "kalau belum
  catat menu/vitamin" explanation, and the iOS "tambahkan ke Layar Utama dulu" caveat.
- `app/globals.css` — a handful of new classes for the panel (reusing existing tokens/patterns,
  not inventing a new visual language).
- `README.md` — new setup section: generating/pasting VAPID keys (I generate them during
  implementation and hand them over), where to find `SUPABASE_SERVICE_ROLE_KEY` in the Supabase
  dashboard, what `CRON_SECRET` is for (I generate one), the Vercel Hobby-plan constraint (cron
  jobs are allowed but capped at once/day — this fits exactly), and the iOS caveat.

### Out of scope / non-goals
- No per-user configurable reminder time (fixed 19:00 WIB for everyone, per the answered question).
- No native app / app-store wrapper.
- No third-party push service (OneSignal etc.) — self-hosted VAPID only, per the original ask.
- No retry/backoff queue for failed sends beyond what `web-push` itself does for a single attempt —
  a failed send is logged and skipped, not queued for redelivery same day.
- No admin UI to see subscriber counts — the cron's JSON summary in Vercel's function logs is enough
  for a personal/family-scale app.
- Not migrating the rest of the repo onto a test framework beyond what this feature needs — vitest is
  added and configured, but no tests are added for pre-existing unrelated code beyond the one
  justified `todayISOInTimeZone` case above.

## Steps
1. `supabase/schema.sql` — append `push_subscriptions` table + RLS policies.
2. `npm install web-push` + `npm install -D vitest`; add `vitest.config.js`; add `"test"` script to
   `package.json`.
3. Generate the 3 placeholder icons (throwaway script, not committed) → commit the resulting PNGs
   under `public/icons/`.
4. `public/manifest.json`, `public/sw.js`.
5. `components/ServiceWorkerRegister.js`; wire into `app/layout.js` along with manifest/meta tags.
6. `lib/reminderLogic.js` + `lib/reminderLogic.test.js`; `lib/nutrition.test.js`. Run tests.
7. `lib/gemini.js` — add `generateDailyNudge`.
8. `lib/supabaseAdmin.js`, `lib/pushSender.js`.
9. `lib/push.js` (client helper) + `app/api/push/subscribe/route.js`.
10. `app/api/cron/reminders/route.js` + `vercel.json`.
11. `app/dashboard/profile/page.js` new panel + `app/globals.css` additions.
12. Generate VAPID keys + a `CRON_SECRET`; add all new env vars (with generated values where
    applicable, placeholders where the user must supply them) to `.env.local`; document in README.
13. Final test run + local commit.

## Data / schema impact
New table `push_subscriptions`:
```sql
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
```
Additive only (`if not exists`), safe to re-run, no backfill needed (empty table until users opt in).
RLS: owner select/insert/delete (auth.uid() = user_id), same pattern as every other table. The cron
route reads this table via the service-role client (bypasses RLS by design, since it must see every
user's subscriptions — never used for anything else, and never imported into client code).

## Risks & mitigations
- **Service-role key misuse** (first time this codebase has one) → isolated to
  `lib/supabaseAdmin.js`, `import "server-only"`, imported only by the cron route; never returned
  to any client response.
- **Cron route hit by anyone** (it's a public URL) → `CRON_SECRET` bearer-token check, 401 otherwise;
  Vercel sets this header automatically for its own scheduled invocations once the env var exists.
- **Dead push subscriptions accumulating** (user uninstalls, clears data, endpoint expires) →
  cron prunes any subscription whose send comes back 404/410.
- **Gemini flakiness/missing key blocking reminders** → `generateDailyNudge` failures are caught in
  the cron route and fall back to `pickFallbackNudge`, so a Gemini outage never stops the actual
  reminder from sending.
- **WIB day-boundary correctness** → reusing the already-written `todayISOInTimeZone` instead of a
  new implementation, plus a dedicated regression test for it.
- **iOS limitation is a platform fact, not a bug** → surfaced explicitly in the Profile panel copy
  and README, so it isn't mistaken for a broken feature later.
- **Icon files are a rough placeholder** → explicitly called out in this plan and the final summary
  so it isn't mistaken for finished visual design.

## Test plan
`lib/reminderLogic.test.js`:
- `pickMissing`: user id present in neither set → both missing true; present in meal set only →
  `missingMeal:false, missingVitamin:true`; present in both → both false.
- `buildReminderBody`: both missing → combined phrasing mentioning both; meal-only; vitamin-only —
  each asserted to contain the right substrings and the appended nudge text.
- `pickFallbackNudge`: same seed → same result (determinism, so a retried cron run or two devices
  for one user don't feel randomly inconsistent); returns a non-empty string that's actually a
  member of `FALLBACK_NUDGES`.

`lib/nutrition.test.js`:
- `todayISOInTimeZone("Asia/Jakarta")` against a mocked `Date` at `2026-09-08T23:30:00Z` (06:30 WIB
  *the next day*) resolves to `"2026-09-09"`, not `"2026-09-08"` — the exact boundary case the new
  cron route's correctness depends on.

Run via `npm test` (`vitest run`), captured output attached to the implementation log.

## Standards notes
No `kredivo-docs` areas touched (no WIF/GCP auth, no JumpCloud SSO, no Terraform/IaC, no
Dockerfile/compose) — degraded gracefully per the assessment (not located, and not needed here).

## Addendum — 4 daily slots + mom's name (requested mid-implementation, after the schema/PWA-shell/
reminderLogic/gemini-nudge/supabaseAdmin steps above were already committed)

Confirmed with the user via follow-up questions:
- **4 scheduled slots, not 1**: 07:00 morning (unconditional: greeting + affirmation-or-fact),
  12:00 lunch (unconditional: lunch nudge + a nutrition-specific fun fact — NOT gated on whether a
  meal's already logged), 19:00 dinner (**exactly** the meal/vitamin-missing logic already built —
  unchanged, just its own cron entry instead of the only one), 21:30 night (unconditional: sleep
  reminder + affirmation).
- **profiles.name** (new column): a "mom's name" field, editable on the Profile page, used to
  personalize the greeting in all 4 slots (falls back to a name-less generic greeting when unset).

### Revised scope (additions on top of everything already built)
- `supabase/schema.sql` — `alter table public.profiles add column if not exists name text;`
  (additive, same pattern as the existing `hpht` column addition).
- `app/dashboard/profile/page.js` — new "Nama" field near the top of the page (same
  edit/save-button pattern as the HPHT form).
- `lib/reminderLogic.js` — `greet(name, timeOfDayLabel)` helper; `buildReminderBody` gains an
  optional `name` param (prefixes the lead line); new `MEAL_FACT_FALLBACKS` bank +
  `pickMealFactFallback(seed)` (lunch-specific, since that content is nutrition-domain, distinct
  from the general affirmation/fact bank reused for morning/dinner/night).
- `lib/gemini.js` — new `generateMealFact({ trimester, weeks })` (lunch only, dedicated prompt).
  `generateDailyNudge` is **reused as-is** for morning, dinner, and night — no new Gemini function
  needed for those three.
- `lib/pushSender.js`, `app/api/cron/reminders/route.js` — one shared route, dispatched by a
  `?kind=morning|lunch|dinner|night` query param (avoids 4 near-duplicate route files; only the
  "build this slot's content" branch differs — subscription fetch/send/prune is shared).
- `vercel.json` — 4 cron entries (`00:00`/`05:00`/`12:00`/`14:30` UTC = `07:00`/`12:00`/`19:00`/
  `21:30` WIB — all same-UTC-day conversions, no rollover math needed).
- **Caveat to surface in README, not silently assumed**: Vercel's Hobby (free) plan has historically
  capped both the number of cron jobs per project and enforced at-most-once-per-day execution
  regardless of schedule string — the exact current numbers aren't something to assert from memory
  here, so the README tells the user to check their plan's current cron limits before deploying 4
  separate entries, with "collapse to fewer slots" or "upgrade to Pro" as the two fallbacks if 4
  doesn't fit.
