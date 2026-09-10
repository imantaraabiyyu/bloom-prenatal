# Improvement Plan — Make the Gemini chat more flexible

## Goal
1. Gemini must exhaustively extract every nutrient/composition value it can read from a photo or
   description — including ones not in Bloom's fixed tracked list (e.g. carbohydrate, lactose) —
   into `extra_nutrients` on both meals and vitamins, and must never tell the user a value "isn't
   tracked/supported" instead of capturing it.
2. Users must be able to ask Gemini about anything, not just meals/pregnancy — no topic-based
   refusal or redirect for category="chat" turns.
3. Add real chat session history: an explicit "New chat" action, a list of past sessions the user
   can revisit, per-session delete, auto-titled from each session's first message, with existing
   flat history migrated into one "Riwayat lama" (legacy) session per user so nothing is lost.
4. Fix the mobile chat box so the message thread scrolls internally within the viewport instead of
   the whole page growing past it.

## Current behavior (see `docs/improver/gemini-chat-flexible-assessment.md` for full detail)
- `lib/gemini.js:102-178` (`SYSTEM_PROMPT`) frames Bloom as pregnancy/nutrition-only and describes
  `extra_nutrients` as optional bonus micronutrients (Omega-3/Zinc/B6 examples) rather than
  "capture everything printed" — root cause of the user-reported repro (canned milk label's
  carbohydrate/lactose silently dropped, then rationalized away in the reply).
- `extra_nutrients` storage/schema/UI pipeline already exists end-to-end (`lib/gemini.js:27-40,
  192-202`, `lib/nutrition.js:297-333`, `supabase/schema.sql` `extra_nutrients jsonb` column on both
  `meals` and `vitamins`, `app/dashboard/chat/page.js:52-74`) — this is a prompt fix, not a new
  pipeline.
- `chat_messages` (`supabase/schema.sql:161-177`) has no session grouping — one flat per-user log,
  loaded/cleared in full (`app/dashboard/chat/page.js:129-140, 378-381`).
- `.chat-page` mobile CSS (`app/globals.css:584-594`) uses `min-height: 100vh; min-height: 100dvh;`
  on the outer flex column — a floor, not a cap, so the flex-fill/`overflow-y:auto` chain never
  actually height-constrains and the whole page grows instead of the thread scrolling internally.
- `app/api/nutrition-chat/route.js` never touches `chat_messages`/`chat_sessions` — it only proxies
  to Gemini and streams the result back; the client does every DB read/write directly via Supabase
  (RLS-scoped). Confirmed the only file touching `chat_messages` anywhere in the repo is
  `app/dashboard/chat/page.js` (7 call sites) — contained blast radius for #3.

## Proposed change

### 1) Exhaustive extra_nutrients (prompt-only, `lib/gemini.js`)
Rewrite `SYSTEM_PROMPT`'s `extra_nutrients` instructions (food category, lines 120-122; vitamin
category, lines 139-141) from example-only/optional wording to mandatory-and-exhaustive: capture
**every** printed/mentioned value outside the fixed list, explicitly naming common macros
(Karbohidrat, Lemak total, Laktosa, etc.) as required, not just micronutrient examples. Add one new
paragraph addressing the observed failure mode directly: if the user asks why a value is missing,
Gemini must never claim it's unsupported — it must acknowledge the gap and ask for the label again,
not defend the omission. No schema/sanitization change needed — `MAX_EXTRA_NUTRIENTS_PER_ITEM = 20`
(`lib/gemini.js:186`) already comfortably covers a full nutrition label.

### 2) Open-topic chat (prompt-only, `lib/gemini.js`)
Rewrite the opening framing (lines 102-103) and the `category = "chat"` branch (lines 149-155) to
explicitly allow any topic — general knowledge, coding help, casual conversation, anything — while
keeping the existing "suggest a doctor for pregnancy-specific medical certainty" carve-out scoped to
pregnancy/nutrition questions only, not as a blanket disclaimer on every reply.

### 3) Chat session history (schema + `page.js` + CSS)
- New `chat_sessions` table (`id, user_id, title, created_at, updated_at`), same RLS-owner-policy
  pattern as every other table in `supabase/schema.sql`. `chat_messages` gains a nullable
  `session_id uuid references chat_sessions(id) on delete cascade` column + index — deleting a
  session cascades its messages in one call.
- One-time idempotent backfill in the same `schema.sql` (matching its existing hand-run,
  additive style): every user with pre-existing `session_id is null` messages gets one
  `"Riwayat lama"` session spanning their existing message timestamps, and those messages are
  attached to it. Safe to leave in the file permanently per this repo's existing convention (old
  `add column if not exists` statements are never deleted either); a no-op once every message has a
  session.
- `page.js` loads the user's sessions (newest-`updated_at`-first), defaults to the most recent one
  (creating a fresh empty session for a brand-new user with none), and loads only that session's
  messages. "New chat" starts a fresh session and switches to it. Clicking a past session switches
  the loaded thread. Each session auto-titles itself from its first message (truncated text, or
  "Chat dari foto" for an image-only first message) the first time a message is saved into it, and
  bumps `updated_at` once per turn so the most recently active session sorts first.
- "Hapus riwayat chat" changes scope to **the open session only** (per your answer); a new "Hapus
  semua riwayat" action clears every session for the user. Both use the existing `ConfirmButton`
  component, same as today.
- UI: a session-list panel reuses `bloom-grid`'s already-unused 340px left column on desktop
  (≥820px, `app/globals.css:92-93`) — the chat panel drops its `full` class so it now sits in the
  right column instead of spanning both. Below 820px (matching that same existing grid breakpoint,
  not a new one) the session panel becomes a slide-in drawer with a backdrop, toggled by a new
  "Riwayat" button in `.chat-toolbar`, using the same CSS-class-toggle + outside-click-to-close
  pattern the existing `.attach-menu` already uses (`page.js:114, 146-159`) rather than inventing a
  new interaction model.

### 4) Mobile scroll fix (`app/globals.css`, `.chat-page` block only)
Change `.chat-page`'s mobile rule (inside the existing `@media (max-width: 560px)` block) from
`min-height: 100vh; min-height: 100dvh;` to `height: 100vh; height: 100dvh;`. A `min-height` is a
floor the container can grow past; `height` caps it to the viewport so the existing
`flex: 1; min-height: 0` chain down to `.chat-thread` actually engages and the thread scrolls
internally with the input pinned at the bottom, matching the intent already documented in the
comment above that block. One-line-value change, no other rule in that block needs to move.

## Scope

### In scope
- `lib/gemini.js` — `SYSTEM_PROMPT` text only (extra_nutrients exhaustiveness ×2 branches, open-topic
  chat framing, new "don't rationalize a missing value" paragraph). No schema/function-signature
  changes.
- `supabase/schema.sql` — new `chat_sessions` table + RLS policies, `chat_messages.session_id`
  column + index, one-time backfill insert/update.
- `app/dashboard/chat/page.js` — session state (`sessions`, `activeSessionId`, `sessionDrawerOpen`),
  `loadSessions`, `loadMessagesForSession`, `startNewSession`, `switchSession`, `deleteSession`,
  `deleteAllHistory`, `touchSession` (title-on-first-message + `updated_at` bump), session-list JSX,
  drawer toggle button, `saveMessage`/`handleSend` updated to stamp `session_id`.
- `app/globals.css` — `.chat-page` mobile height fix; new `.chat-session-panel`,
  `.chat-session-header`, `.chat-session-list`, `.chat-session-item` (+ `.active` state),
  `.chat-session-backdrop`, `.chat-session-toggle` rules; add the new per-session delete button to
  the existing mobile touch-target bump list (`app/globals.css:611-614`).
- `lib/gemini.test.js` — new assertions on `streamNutritionChatTurn`'s request body
  (`systemInstruction.parts[0].text`) proving the exhaustive-extraction and open-topic wording
  actually shipped, alongside the existing schema-shape tests in that same describe block.

### Out of scope / non-goals
- `app/api/nutrition-chat/route.js` — untouched; it's session-agnostic (never queries
  `chat_messages`/`chat_sessions`), so no plumbing needed there for #3.
- No change to `MAX_EXTRA_NUTRIENTS_PER_ITEM`/`MAX_VITAMIN_ITEMS` caps — already generous enough.
- No AI-generated session titles (no extra Gemini call for titling) — plain truncation, per your
  "auto-title from first message" answer, keeps this free of added latency/cost.
- No automated Postgres migration runner — `schema.sql` stays the one hand-run file, consistent
  with this repo's existing (no-migrations-tool) setup; the new DDL still needs a human to run it in
  the Supabase SQL editor (called out again under Risks below).
- No component/integration test harness introduced for `page.js` (none exists in this repo today,
  and adding one is a much bigger change than this improvement) — covered instead by the automated
  prompt-content tests plus a production build + manual verification, see Test plan.

## Steps
1. **`lib/gemini.js`** — rewrite the four `SYSTEM_PROMPT` sections described above (opening framing,
   food-category extra_nutrients, vitamin-category extra_nutrients, chat-category topic scope) plus
   add the new "don't rationalize a missing value" paragraph. No other function touched.
2. **`supabase/schema.sql`** — append the new `chat_sessions` table + RLS policies + `session_id`
   column/index + backfill statements, following the file's existing numbered-comment-header
   convention.
3. **`app/dashboard/chat/page.js`**:
   a. Add `sessions`/`activeSessionId`/`sessionDrawerOpen` state.
   b. Replace the mount effect's single "load all messages" query with: load sessions → pick/create
      active → load that session's messages.
   c. Add `startNewSession`, `switchSession`, `deleteSession`, `deleteAllHistory`, `touchSession`.
   d. Wire `saveMessage` to stamp `session_id: activeSessionId`; call `touchSession` once per
      `handleSend` turn (after the user message saves).
   e. Add the session-list panel JSX (left column) + mobile drawer toggle button in `.chat-toolbar`;
      repoint "Hapus riwayat chat" at `deleteSession(activeSessionId)`, add "Hapus semua riwayat".
   f. Drop `full` from the chat panel's className.
4. **`app/globals.css`** — the one-line `.chat-page` height fix, plus the new session-panel/drawer
   CSS block(s) (scoped under the existing 820px `bloom-grid` breakpoint for sidebar-vs-drawer, and
   inside the existing 560px block only for the height fix).
5. **`lib/gemini.test.js`** — add the new request-body content assertions.

## Data / schema impact
- New table `public.chat_sessions` (id, user_id, title, created_at, updated_at) + 4 RLS policies
  (owner select/insert/update/delete), mirroring every existing table in this file exactly.
- New nullable column `public.chat_messages.session_id` (FK → `chat_sessions.id`,
  `on delete cascade`) + a `(session_id, created_at)` index.
- One-time backfill (insert + update, both idempotent/no-op once applied) grouping each user's
  pre-existing messages into a `"Riwayat lama"` session.
- **Manual deploy step required**: since this repo has no migration runner, you'll need to run the
  updated `supabase/schema.sql` in the Supabase Dashboard SQL editor before the session-history
  feature works against your live database (same deploy process this repo already uses for every
  past schema change).

## Risks & mitigations
- **Schema not yet applied in production** → the new session queries would fail against a DB
  missing `chat_sessions`/`session_id` until the SQL is run. Mitigation: called out explicitly here
  and in the final summary; this is a pre-existing characteristic of this repo's schema workflow; I'll
  provide clear ready to run SQL and this is a documented, expected manual step.
- **Backfill matching by `title = 'Riwayat lama'`** could, in a rare edge case (a stray
  `session_id is null` message appearing after the first backfill run — e.g. a bug in some future
  code path), land in a second freshly-created "Riwayat lama" session rather than merging with an
  existing one. Accepted as best-effort, consistent with the rest of this hand-maintained,
  non-transactional schema file (no other migration here guards against re-run edge cases more
  strictly either).
- **Prompt changes are behavioral, not type-checked** — a wrong wording either under- or
  over-extracts. Mitigated by the new request-body content tests (fails loudly if the wording
  regresses) plus manual verification against the exact canned-milk repro case before commit.
- **General-topic chat could drift the persona** (verbose disclaimers, or Bloom losing its
  pregnancy/nutrition character) — mitigated by keeping the "Bloom" identity/warmth instructions
  unchanged and only removing the *topic gate*, not the tone rules.
- **No component tests for `page.js`** (repo has none for any page) — mitigated by a
  production build (`npm run build` or repo equivalent) as a syntax/type smoke check, plus manual
  click-through in the dev server (new chat → switch → delete → mobile-width scroll check) recorded
  in the implementation log.

## Test plan
- `lib/gemini.test.js` (automated, run via the repo's existing Vitest setup):
  - New test(s) in the "response schema shape + daily-limit context" describe block (or a new
    adjacent one) asserting `JSON.parse(fetchMock.mock.calls[0][1].body).systemInstruction.parts[0].text`
    contains the new mandatory-extraction wording (proving carbs/macros are no longer
    example-only) and the new open-topic wording (proving the chat category is no longer
    pregnancy/nutrition-scoped).
  - All existing `sanitizeChatTurnResult`/`extra_nutrients` tests must keep passing unchanged — this
    is a regression guard proving the sanitization pipeline (already correct) wasn't touched.
- Manual verification (no component-test harness exists in this repo, see Risks):
  - Re-run the exact canned-milk repro conversationally (or an equivalent label photo) and confirm
    carbohydrate/lactose now appear under "extra nutrients" instead of being omitted/rationalized.
  - Ask an off-topic question (e.g. general knowledge) and confirm Gemini answers directly instead
    of redirecting to pregnancy/nutrition.
  - New chat → send a message → appears in the session list with an auto-title; switch to the old
    session → old messages reload correctly; delete a session → it disappears and cascade-deletes
    its messages (verified via a follow-up read); "Hapus semua riwayat" clears every session.
  - Resize the browser to a mobile width (or real device) → send enough messages to overflow the
    viewport → confirm the thread scrolls internally with the input box still reachable, and the
    session drawer opens/closes via the toolbar button without affecting the desktop sidebar layout
    at ≥820px.
  - `npm run build` (or this repo's equivalent) passes with no errors after all `page.js`/CSS changes.

## Standards notes
No `$KDOCS` areas touched (no auth/SSO, no WIF/GCP, no Terraform/IaC, no Dockerfile/compose changes)
— `kredivo-docs` located at `~/.claude/kredivo-docs` but not applicable to this improvement.
