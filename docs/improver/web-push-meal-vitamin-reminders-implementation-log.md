# Implementation Log — Web Push meal/vitamin reminders

Branch: `feat/web-push-reminders` (new, agent-proposed name, created off `feat/initial`).

## Steps (in commit order)

1. **`push_subscriptions` table + RLS** — `supabase/schema.sql` (commit `6d4713a`).
2. **`web-push` + `vitest` installed, `test` script added** — `package.json`, `package-lock.json`,
   `vitest.config.mjs` (commits `89a0046`, then renamed `.js`→`.mjs` to silence a Vite config-loader
   warning — same commit).
3. **PWA shell** — `public/manifest.json`, `public/sw.js`, `public/icons/*` (generated locally, no
   image tool available — placeholder flat `--bg2`/`--accent` circle), `components/ServiceWorkerRegister.js`,
   `app/layout.js` wiring (commit `583865a`).
4. **Pure reminder logic + tests** — `lib/reminderLogic.js`, `lib/reminderLogic.test.js`,
   `lib/nutrition.test.js` (regression test for the pre-existing `todayISOInTimeZone`) (commit `1234eef`).
5. **`generateDailyNudge`** added to `lib/gemini.js` (commit `d714974`).
6. **Mid-implementation scope change** (user requested after step 5, via the `web-push-meal-
   vitamin-reminders-improvement-plan.md` addendum): 1 combined daily reminder → 4 slots
   (morning/lunch/dinner/night) + a `profiles.name` field for personalized greetings. Re-confirmed
   via `AskUserQuestion` (times, lunch/dinner/morning-night conditionality) before continuing.
7. **`profiles.name` column** — `supabase/schema.sql` (commit `4b88e49`).
8. **Reminder logic extended for 4 slots** — `greet`, `buildMorningBody`, `buildLunchBody`,
   `buildNightBody`, name-aware `buildReminderBody`, `MEAL_FACT_FALLBACKS`/`pickMealFactFallback`
   in `lib/reminderLogic.js` + tests (commit `a2901c9`).
9. **Assessment doc committed** (was missed at step 1's commit) (commit `0cb24d9`).
10. **`lib/supabaseAdmin.js`** — first-ever service-role client, `import "server-only"`, cron-only
    (commit `c1ac03a`).
11. **`lib/pushSender.js`** (web-push wrapper) + **`generateMealFact`** in `lib/gemini.js`
    (commit `b2ecd8d`).
12. **`lib/push.js`** (client subscribe/unsubscribe) + **`app/api/push/subscribe/route.js`**
    (POST/DELETE, cookie-session auth, no service-role) (commit `49281e9`).
13. **`app/api/cron/reminders/route.js`** (one shared route, `?kind=` dispatch) + **`vercel.json`**
    (4 cron entries, UTC times converted from WIB) (commit `0d42a4e`).
14. **Profile page**: `Nama` field + `Notifikasi` panel — `app/dashboard/profile/page.js`. Reused
    existing form/panel CSS classes, so `app/globals.css` needed no changes (a plan-scoped item
    that turned out unnecessary once written). Verified via `npm run build` (clean compile, all
    13 routes render) (commit `78a90f4`).
15. **README** — new section 6 (env vars, 4 slots, iOS + Vercel-cron-limit caveats), updated
    "Struktur project" and a new "Testing" section (commit `7e8d1c1`).
16. **VAPID keys + `CRON_SECRET` generated** locally (`web-push.generateVAPIDKeys()` +
    `crypto.randomBytes`) and written to `.env.local` (gitignored, never committed) —
    `SUPABASE_SERVICE_ROLE_KEY` left blank for the user to paste from their Supabase dashboard.
17. **CLAUDE.md** — added per user's opt-in (this commit, see below).

## Tests

`npm test` (`vitest run`) — final result: **19/19 passing**, 2 test files
(`lib/reminderLogic.test.js`, `lib/nutrition.test.js`). Covers:
- `pickMissing` (all 3 combinations of meal/vitamin logged-or-not).
- `buildReminderBody` (both/meal-only/vitamin-only/no-nudge/name-prefixed).
- `greet`, `buildMorningBody`, `buildLunchBody`, `buildNightBody`.
- `pickFallbackNudge` / `pickMealFactFallback` (determinism + real bank membership).
- `todayISOInTimeZone` at a WIB day-boundary instant (regression guard, pre-existing function).

Not unit-tested (network I/O, would need heavy mocking for little signal at this app's scale):
`generateDailyNudge`/`generateMealFact` (Gemini calls), `sendPush` (web-push), the Supabase
admin/anon queries in the cron route and subscribe API route. These were verified via `npm run
build` (clean compile) and code review against the existing codebase's own patterns
(`fetchGeminiWithRetries`, cookie-session auth, RLS policies).

## Pre-existing issues noticed, not fixed (out of scope)
- `npm audit`: 6 vulnerabilities (4 low, 2 high) in `next`, `@supabase/ssr`, `@supabase/auth-js`,
  `postcss` — all pre-existing (not introduced by `web-push`/`vitest`), fixes require breaking
  major-version bumps. Not addressed here — flagging for a separate improvement run if desired.

## Deferred / follow-ups for the user
- Paste `SUPABASE_SERVICE_ROLE_KEY` into `.env.local` and Vercel (from Supabase dashboard →
  Project Settings → API → service_role secret) — the only credential this session couldn't
  generate itself.
- Copy the generated `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `CRON_SECRET` from
  `.env.local` into Vercel's Environment Variables before deploying.
- Set `VAPID_SUBJECT` to the app's actual deployed URL once known (currently a placeholder).
- Check the current Vercel plan's cron-job limits before deploying (4 separate daily crons) —
  README section 6 flags this rather than asserting a specific number.
- Placeholder PWA icons (`public/icons/*.png`) are a flat single-color circle — swap for real
  branding whenever convenient, no code changes needed elsewhere.

Triage: **COMPLEX** — new table + RLS (schema impact), new service worker/manifest, first-ever
service-role client + scheduled job (blast radius), multiple ambiguities resolved via
`AskUserQuestion` before and during implementation (including a genuine mid-implementation scope
change from 1 reminder to 4 slots + a name field, re-confirmed with the user rather than assumed).
