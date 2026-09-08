# Assessment — Web Push meal/vitamin reminders

## Stack & current state
- Next.js 14.2.35 (App Router), React 18.3.1, Supabase (Postgres + Auth), deployed to Vercel.
- No PWA infra at all yet: no `public/` dir, no `manifest.json`, no service worker, no `next.config.mjs` PWA wiring.
- No push-related npm dependency (`web-push` not installed).
- No `vercel.json` — no existing cron jobs.
- Auth pattern:
  - Browser: `lib/supabaseClient.js` — singleton `createBrowserClient` (anon key).
  - Server routes: `lib/supabaseServer.js` — `createServerClient` (anon key, cookie-based session), used by `app/api/nutrition-chat/route.js` and `app/api/journal/transcribe/route.js` purely to confirm `auth.getUser()` before proxying to Gemini. **No service-role client exists anywhere in the codebase** — every existing write/read goes through RLS as the calling user.
- DB (`supabase/schema.sql`): 8 tables, all with `enable row level security` + 4 owner-scoped policies (`select/insert/update/delete` using `auth.uid() = user_id`) in a consistent, repeated pattern. Relevant tables for "did they log today":
  - `meals(id, user_id, date, meal, ...nutrients..., source, created_at)` — index `meals_user_date_idx (user_id, date)`.
  - `vitamin_checks(id, user_id, date, vitamin_id, checked, updated_at)` — unique `(user_id, date, vitamin_id)`, index `(user_id, date)`. A row can exist with `checked = false` (user toggled off), so "logged" must mean *at least one row for that date with `checked = true`*, not just row-existence.
- UI pattern: `app/dashboard/profile/page.js` is the existing home for personal/device-level settings (HPHT, baby names) — client component, `"use client"`, uses `getSupabaseClient()`, same topbar/panel/`bloom-grid` layout as `app/dashboard/page.js`. This is the natural place for a notification opt-in toggle by existing convention.
- Styling: `app/globals.css` — CSS custom properties (`--accent`, `--panel`, `--panel-border`, etc.), existing `.panel`, `.manual-form-save`, `.btn-ghost`, `.format-hint`, `.error-box` classes to reuse rather than inventing new visual language.
- `app/layout.js` — root layout, no `<meta>` tags beyond Next's `metadata` export; this is where `manifest` link + apple-touch-icon + service-worker registration script would be wired in.
- Env vars currently used (`.env.local`, mirrored in Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`.
- No image-conversion tool available locally (`convert`/`rsvg-convert`/`magick` all absent) — any manifest icon needs either a hand-rolled PNG (pure JS via `zlib`, no new dependency) or an SVG icon (weaker iOS support).

## Files/functions in scope (expected)
- `supabase/schema.sql` — new `push_subscriptions` table + RLS policies (append, following the exact existing pattern).
- `public/manifest.json` (new), `public/sw.js` (new, service worker: `push` + `notificationclick` handlers), `public/icons/*` (new, generated placeholder).
- `app/layout.js` — add manifest link, theme-color, apple-touch-icon meta, SW registration.
- `lib/push.js` (new) — client helper: register SW, subscribe/unsubscribe via `PushManager`, talk to the new API route.
- `app/api/push/subscribe/route.js` (new) — authenticated route (mirrors `lib/supabaseServer.js` pattern) to upsert/delete the caller's subscription row.
- `app/dashboard/profile/page.js` — new panel: notification opt-in toggle + permission-state messaging (blocked/unsupported/subscribed).
- `lib/supabaseAdmin.js` (new) — service-role client, server-only, used **only** by the cron route (first service-role usage in this codebase — needs care: never expose the key to the client, never import in a client component).
- `app/api/cron/reminders/route.js` (new) — the scheduled sender: service-role query for "subscribed users who haven't logged {meal, vitamin} today", build payload, send via `web-push`, prune dead (410/404) subscriptions.
- `vercel.json` (new) — `crons` entry.
- `package.json` — add `web-push` dependency.
- New env vars needed: `SUPABASE_SERVICE_ROLE_KEY` (secret, server-only — user must fetch from Supabase dashboard, I cannot generate this), `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (I can generate these via `web-push.generateVAPIDKeys()`), `CRON_SECRET` (protects the cron route from being hit by anyone — Vercel sends it automatically as `Authorization: Bearer $CRON_SECRET` when the env var is set).

## Ambiguities the description doesn't resolve
1. **UI placement** — confirm Profile page (fits existing "personal settings" convention) vs. Dashboard.
2. **Timing & timezone** — what wall-clock time should the daily check fire at, in WIB (UTC+7, app is Indonesian-language)? Vercel Cron schedules are UTC.
3. **One combined reminder vs. two separate ones** — a single push saying "belum minum vitamin dan/atau catat menu" vs. two independently-timed pushes.
4. **"Logged vitamin today" definition** — at least one `vitamin_checks` row with `checked = true` for today, given a user may have multiple vitamins and toggle some off.
5. **Exact notification copy** (title/body, Indonesian, matching the app's existing tone) and what clicking it does (deep-link to `/dashboard`, which defaults to today).
6. **Secrets generation** — I'll generate VAPID keys during implementation and hand them to the user to paste into `.env.local`/Vercel; `SUPABASE_SERVICE_ROLE_KEY` must come from their Supabase dashboard (Project Settings → API → service_role) since I have no access to it.

Triage: **COMPLEX** — new table + RLS policies (schema impact), new service worker + manifest (new modules), new scheduled job + first-ever service-role client in the codebase (blast radius: bypasses RLS, must be handled carefully), and multiple open ambiguities (timing, copy, UI placement, "logged" definition) not resolved by the description alone.
