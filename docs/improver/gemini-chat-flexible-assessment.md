# Assessment — Make Gemini chat more flexible

## Request (as given)
1. Gemini should read/extract *anything* present in a food/vitamin label or composition, even
   fields not modeled in this DB/schema — and put those into "extra nutrients" for both meals
   and vitamins.
2. Users should be able to ask Gemini anything, not just meal/pregnancy topics.
3. Add chat session history (multiple revisitable sessions, not just one endless log).
4. Fix the chat box on mobile so it's scrollable.

User also supplied a concrete repro for (1): a photo of canned milk ("susu kaleng") whose label
prints Karbohidrat (carbs) and Laktosa (lactose). Gemini extracted only the fixed tracked fields
(calories/protein/calcium/water/sugar/sodium/cholesterol/saturated fat) and, when asked directly
why carbs weren't shown, replied that Bloom "currently only tracks calories, protein, micronutrients
and sugar, so carbs aren't shown separately" — i.e. it silently dropped label data instead of using
the existing `extra_nutrients` mechanism, and then rationalized the omission to the user.

## Current behavior

### Backend / Gemini call
- `lib/gemini.js` — single Gemini integration point, backend-only (`import "server-only"`), plain
  `fetch` (no SDK), used only by `app/api/nutrition-chat/route.js`.
- Chat model chain: `gemini-2.5-pro` by default (`GEMINI_CHAT_MODEL` + `GEMINI_CHAT_FALLBACK_MODELS`
  env vars), streamed via `v1beta/models/{model}:streamGenerateContent` with
  `responseMimeType: application/json` + a `responseSchema` (structured/controlled output, not
  function-calling). Retry/fallback chain for 500/502/503/504 across API keys then models
  (`fetchGeminiWithRetries`, `tryModelChain`, `lib/gemini.js:310-465`).
- `app/api/nutrition-chat/route.js` — thin authenticated proxy: validates input, best-effort fetches
  today's cumulative sugar/sodium/etc. totals for verdict context, calls `streamNutritionChatTurn`,
  streams NDJSON (`delta`/`done`/`error`) back. Never writes to the DB itself — the client inserts
  into `meals`/`vitamins` only after the user taps "Simpan ke Dashboard".

### System prompt (`lib/gemini.js:102-178`, `SYSTEM_PROMPT`)
- Opens by framing Bloom as "teman ngobrol seputar kehamilan & gizi" (a companion for pregnancy &
  nutrition chat) — line 102-103.
- Routes every turn into one of three `category` values:
  - `"food"` (lines 107-126): fills `NUTRIENT_ORDER`/`LIMIT_ORDER` fields (the fixed tracked set,
    `lib/nutrition.js`), plus `extra_nutrients` "kalau ada info gizinya (mis. ... Omega-3, Zinc,
    Vitamin B6, dll)" — phrased as extra/bonus micronutrients, not as "capture everything printed on
    the label". This is the root cause of the carb/lactose repro: the model treats anything outside
    its fixed list as optional bonus data rather than mandatory-if-printed, and the fixed list itself
    doesn't include macro fields like total carbohydrate, so a common label value falls through.
  - `"vitamin"` (lines 128-147): same fixed-list-plus-optional-extras pattern per detected item.
  - `"chat"` (lines 149-155): *already* permits general pregnancy/nutrition talk and does **not**
    contain a hard refuse/redirect instruction for off-topic messages — but the opening framing line
    (102-103) plus the category-3 wording ("...tanya-tanya soal gizi/kehamilan secara umum...") bias
    the model toward pregnancy/nutrition-flavored replies and toward declining or redirecting fully
    unrelated questions (general knowledge, coding help, etc.), matching request #2.
- No safety-setting or server-side topic filter anywhere in `route.js` — everything is prompt-driven.

### "Extra nutrients" mechanism (already exists end-to-end — not a new concept)
- Schema level: `buildExtraNutrientItemSchema()` (`lib/gemini.js:27-33`) → `{label, unit, value}`,
  used both as a per-vitamin-item field and a top-level food-category field
  (`buildResponseSchema`, lines 68-88).
- Sanitization: `sanitizeExtraNutrientsList()` (`lib/gemini.js:192-202`) — caps at
  `MAX_EXTRA_NUTRIENTS_PER_ITEM = 20` entries, label ≤60 chars, unit ≤20 chars, value clamped ≥0.
  20 is already generous for a nutrition label; not a bottleneck for the repro case.
- Storage: `buildExtraNutrientsMap()` (`lib/nutrition.js:297-308`) turns the array into a slug-keyed
  jsonb map, stored in the **already-existing** `extra_nutrients jsonb not null default '{}'::jsonb`
  column on **both** `public.meals` and `public.vitamins` (`supabase/schema.sql:38-80, 83-108`). No
  migration needed for request #1 — the column, schema field, and UI rendering
  (`formatAnalysisText`/`formatVitaminAnalysisText`, `app/dashboard/chat/page.js:52-74`) all already
  exist and work generically for any `{label, unit, value}` triple.
- **Conclusion for #1**: this is a prompt-instruction fix, not a schema/pipeline gap. The system
  prompt needs to explicitly instruct exhaustive label transcription into `extra_nutrients` for
  anything not in the fixed list, and to never rationalize/omit a printed value in `reply`.

### Chat history / persistence (current: one continuous log per user, no sessions)
- `chat_messages` table (`supabase/schema.sql:167-177`): `id, user_id, role, text, had_image,
  analysis jsonb, saved_meal_id, created_at`. No session/conversation grouping column at all —
  every row for a user is one flat, ever-growing timeline, loaded in full on every page mount
  (`app/dashboard/chat/page.js:129-140`, `order("created_at", {ascending: true})` with no limit).
- "Hapus riwayat chat" (`clearHistory`, `page.js:378-381`) deletes **all** of a user's
  `chat_messages` rows — there's no concept of "sessions" to browse or delete individually.
- Gemini's own conversation context is separately capped to the last 12 turns
  (`toHistoryEntry`/`MAX_HISTORY_TURNS`, `page.js:217`, `route.js:32,85-90`) — unrelated to what's
  persisted/displayed, which is unbounded.
- **Conclusion for #3**: genuinely new feature. Needs a `chat_sessions` table (or equivalent),
  a `session_id` FK on `chat_messages`, a migration/backfill for existing rows (today's flat history
  has no session boundary), and new UI (session list, "new chat", switch-session, likely
  per-session delete alongside/instead of today's delete-everything button). `bloom-grid` already
  supports an unused left sidebar column (`340px minmax(0,1fr)` at ≥820px,
  `app/globals.css:92-93`) that the chat page currently ignores via `.panel.full`
  (`grid-column: 1 / -1`) — a natural place for a session list on desktop, but mobile has no
  equivalent slot yet.

### Mobile chat box CSS (`app/globals.css`)
- Base (non-mobile) rule: `.chat-thread { ...; max-height: 60vh; overflow-y: auto; ... }` (line 414).
- `≤560px` override (lines 584-594) redesigns `.chat-page` as a full-height flex column meant to let
  `.chat-thread` fill remaining space and scroll internally while `.chat-input-area` stays reachable:
  ```css
  .chat-page { display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh; }
  .chat-page .bloom-grid { flex: 1; min-height: 0; margin-bottom: 14px; display: flex; flex-direction: column; }
  .chat-page .panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .chat-page .chat-thread { flex: 1; min-height: 0; max-height: none; }
  .chat-page .chat-input-area { flex-shrink: 0; }
  ```
- **Root cause of the mobile scroll bug**: `.chat-page` is sized with `min-height: 100dvh`, not
  `height`/`max-height`. A `min-height` is a floor, not a cap — once the thread's content (many
  messages) needs more room than the viewport, the flex column simply grows past the viewport
  instead of staying pinned to it, so the `flex: 1; min-height: 0` chain down to `.chat-thread`
  never actually gets height-constrained and `overflow-y: auto` never engages. The effect: the whole
  page grows/scrolls instead of just the thread scrolling internally, and the input box can end up
  pushed far below the fold — the opposite of the "input always reachable" intent stated in the
  comment right above this block (line 579-583). Fix is to bound `.chat-page` to the viewport height
  (`height`, or `max-height`, at `100dvh`/`100vh`) instead of only giving it a minimum.

## Files / functions in scope
- `lib/gemini.js` — `SYSTEM_PROMPT` (extra-nutrients exhaustiveness + general-Q&A framing),
  possibly `sanitizeExtraNutrientsList`/`MAX_EXTRA_NUTRIENTS_PER_ITEM` if the cap needs raising.
- `app/api/nutrition-chat/route.js` — likely touched for session_id plumbing (#3).
- `app/dashboard/chat/page.js` — session list/switcher UI (#3), history load scoped to a session.
- `supabase/schema.sql` — new `chat_sessions` table + `chat_messages.session_id` column (#3).
- `app/globals.css` — mobile `.chat-page` height fix (#4), plus new session-list styling (#3).
- `lib/gemini.test.js` — extend for the strengthened extra-nutrients/general-chat prompt behavior
  (prompt-text assertions only; can't unit-test live model behavior).

## Ambiguities the description doesn't resolve
1. **Session boundaries**: how/when does a new session start — an explicit "New chat" action, or
   automatic (e.g. one per calendar day)? What happens to a user's existing flat history on
   migration (single "legacy" session vs. split retroactively by day)?
2. **Session list placement**: reuse the currently-unused `bloom-grid` left sidebar column on
   desktop (≥820px) — and what should mobile use, given there's no equivalent slot there today (a
   toggleable drawer/sheet, a separate list screen, etc.)?
3. **Session deletion**: does "Hapus riwayat chat" change to delete just the open session, with a
   separate action for "delete all sessions" — or stay as delete-everything and gain a new
   per-session delete alongside it?
4. **Session titling**: auto-title from the first message's text (simple truncation) vs. a
   generic "Chat — <date>" label vs. an extra Gemini call to summarize (cost/latency trade-off).

## Triage
**Triage: COMPLEX** — items 1, 2, and 4 are individually bounded, schema-free, low-blast-radius
prompt/CSS text fixes (would qualify SIMPLE on their own), but item 3 (chat session history) fails
multiple SIMPLE criteria at once: it requires a new table + a new FK column (schema/data impact),
touches 4+ files including new UI surface (bounded-scope criterion fails), and leaves open,
material ambiguity about session boundaries/placement/deletion/titling (open-ambiguity criterion
fails). Per the triage rule, one failing criterion is enough to route the whole run through the
COMPLEX flow — proceeding to clarifying questions before any plan is written.
