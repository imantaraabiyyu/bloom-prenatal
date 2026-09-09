# Improvement Plan — Track sugar/sodium/cholesterol/saturated fat/caffeine, warn on daily-limit overage, and add a Gemini safety verdict

## Goal
Extend Gemini's food/vitamin analysis to also extract sugar, sodium (natrium), cholesterol,
saturated fat, and caffeine per item; track these as a new "daily limit" nutrient category
(ceiling, not floor) with their own trend + today's-totals UI, separate from the existing
floor-type nutrients (protein, iron, …); warn wherever a daily limit is exceeded — on the
dashboard and in the 19:00 WIB dinner push/email reminder; and add a Gemini-produced `verdict`
(aman/waspada/sebaiknya_dihindari) + short reason on every food-category chat analysis, reasoned
over the item's own composition plus today's already-saved cumulative meals+vitamins totals.

## Current behavior
See `docs/improver/add-sugar-sodium-cholesterol-tracking-assessment.md` for the full file-by-file
read. Summary: `NUTRIENT_ORDER`/`TARGETS` (`lib/nutrition.js`) is a fixed, floor-type
("more-is-better up to 100%") nutrient list shared by the Gemini schema (`lib/gemini.js`), the
`meals`/`vitamins` tables (`supabase/schema.sql`), the dashboard rings/trend/history
(`app/dashboard/page.js`), and the chat bubble renderer (`app/dashboard/chat/page.js`). There is no
ceiling-type ("don't exceed") concept anywhere. The dinner cron slot (`app/api/cron/reminders/
route.js`, `lib/reminderLogic.js`) only checks whether today's meal/vitamin *rows exist*, never
their nutrient values, and skips sending entirely once both exist. The nutrition-chat route
(`app/api/nutrition-chat/route.js`) never queries the database — it's a stateless proxy to Gemini.

## Decisions from clarifying questions
1. **New nutrients**: `sugar_g`, `sodium_mg`, `cholesterol_mg`, `saturated_fat_g`, `caffeine_mg`.
2. **Daily limits** (flat across trimesters, general adult/pregnancy guidance — same "general
   guidance, not personal medical advice" framing as the existing disclaimer):
   - Sugar (added sugar): **25 g/day** (AHA recommendation for women)
   - Sodium: **2300 mg/day** (US/WHO general adult upper limit)
   - Cholesterol: **300 mg/day** (older, still commonly-cited general-population advisory ceiling —
     framed softly since modern US/WHO guidance dropped a strict numeric cap; the disclaimer will
     say so)
   - Saturated fat: **20 g/day** (UK NHS general guidance for women)
   - Caffeine: **200 mg/day** (ACOG/WHO pregnancy-specific guidance — the one number here that's
     specifically about pregnancy, not general adult health)
3. **Verdict computation**: Gemini reasons over it. The nutrition-chat route fetches today's
   already-saved meals+checked-vitamins totals for the 5 limit nutrients (server-side, RLS-scoped)
   and passes them into the Gemini call as context; Gemini's schema gets `verdict` (enum:
   `aman`/`waspada`/`kurangi_dulu`) + `verdict_reason` (short string), populated only for
   `category: "food"` turns.
7. **Soft tone for a not-safe verdict** (added mid-plan, from the user): a "this isn't great right
   now" verdict must never read as alarming/scary — same warm, non-judgmental register as the rest
   of Bloom's replies, not a medical warning label. Concretely: the third verdict value is named
   `kurangi_dulu` ("cut back for now"), not "avoid"/"dangerous"-flavored wording, and the prompt
   explicitly bans alarming words (`jangan`, `berbahaya`, `dilarang`, `bahaya`) and requires every
   non-`aman` `verdict_reason` to pair the caution with a gentle, constructive suggestion (e.g.
   "porsinya boleh dikurangi sedikit besok" rather than "makanan ini berbahaya") — see the
   `SYSTEM_PROMPT` addition in section 3 below.
4. **Verdict context scope**: already-saved totals only (what the Dashboard already shows) — not
   items analyzed-but-unsaved earlier in the same chat session.
5. **UI placement**: a new, separate "Batas harian" (daily limits) section — its own today-totals
   list + its own trend chart + its own warning banner — kept out of the existing rings/summary
   average/history-table average (mixing floor-% and ceiling-% there would be misleading).
6. **Dinner notification trigger**: warn independently of the missing-meal/vitamin check — the
   dinner slot now sends if `missingMeal || missingVitamin || anyLimitExceeded`, not just the first
   two.

## Proposed change

### 1. `lib/nutrition.js` — new ceiling-type nutrient model (parallel to the existing floor-type one)
- `LIMIT_ORDER = ["sugar_g", "sodium_mg", "cholesterol_mg", "saturated_fat_g", "caffeine_mg"]`,
  `LIMIT_META` (label/unit/color per nutrient, Indonesian labels: Gula, Natrium, Kolesterol, Lemak
  jenuh, Kafein), `LIMITS` (the 5 numbers above, flat — no per-trimester variation, mirroring
  `TARGETS`'s shape but as a plain `{ [key]: number }` map since there's no trimester split).
- `LIMIT_STATUS_TIERS` + `limitStatusForPct(pct)` — ceiling-type mirror of `STATUS_TIERS`/
  `statusForPct`: `<=70% = "Aman"` (green), `<=100% = "Mendekati batas"` (amber), `>100% =
  "Melebihi batas"` (red).
- `exceededLimitLabels(totals)` — pure function: given a `{ [limitKey]: number }` totals object,
  returns the display labels of every limit nutrient over its number in `LIMITS`. Shared by the
  dashboard warning banner and the dinner-reminder trigger/message (single source of truth for
  "what counts as exceeded").
- `computeActiveLimitNutrients(rows)` — `LIMIT_ORDER` mirror of `computeActiveNutrients` (only
  nutrients with a nonzero value in at least one row).
- Extend `groupMealsByDay` to sum **both** `NUTRIENT_ORDER` and `LIMIT_ORDER` fields (currently
  only the former) — the dashboard's per-day totals cache (`mealsByDay`) then carries both, so the
  new `dayLimitTotals(date)` (added in `app/dashboard/page.js`, mirroring the existing
  `dayTotals(date)`/`extraTotals(date)` pair) can read limit sums straight off it plus checked
  vitamins, with no separate re-scan of `meals`.
- `groupLimitTotalsByUser(rows)` + `mergeUserTotals(a, b)` — multi-user variants (grouped by
  `user_id` instead of by date) used server-side by the cron route to sum meals rows + checked
  vitamins' rows into one `{ [userId]: { [limitKey]: number } }` map for the dinner slot.
- `ALL_TRACKED_NUTRIENTS = [...NUTRIENT_ORDER, ...LIMIT_ORDER]` — used only at "build/read a full
  DB row" call sites (Gemini schema, `vitaminItemToRow`, manual add-meal/add-vitamin, CSV
  upload, chat-page save-to-dashboard) so those don't silently drop the 5 new fields. Every
  *existing* floor-type-only call site (`computeActiveNutrients`, rings, existing trend, history
  average, `TARGETS`-based `%`) is left exactly as-is, still keyed to `NUTRIENT_ORDER` alone.
- `MEAL_ALIASES`/`VIT_ALIASES` — add CSV column aliases for the 5 new fields (English + Indonesian
  spellings, e.g. `sugar`/`gula` → `sugar_g`, `sodium`/`natrium` → `sodium_mg`, `cholesterol`/
  `kolesterol` → `cholesterol_mg`, `saturated_fat`/`lemak_jenuh` → `saturated_fat_g`,
  `caffeine`/`kafein` → `caffeine_mg`).
- `SAMPLE_MEAL_CSV`/`SAMPLE_VIT_CSV`/`DEFAULT_VITAMINS` — extend headers/sample rows/seed data
  with the 5 new columns (defaulted to 0 or a plausible sample value).

### 2. `supabase/schema.sql` — new columns
Five `alter table ... add column if not exists ... numeric default 0` statements each on `meals`
and `vitamins` (same pattern as the existing `dha_mg`/`vitamin_k_mcg` additions) — no new table,
no backfill of historical values (existing rows default to 0, same precedent as those two
columns). `README.md`'s schema-run instructions already say "aman dijalankan ulang" (safe to
re-run), so no doc change needed there beyond the CSV column list (`app/dashboard/page.js`'s
"Format kolom CSV" help text).

### 3. `lib/gemini.js` — extend the schema/prompt, add the verdict, thread in daily context
- Every place that currently iterates `NUTRIENT_ORDER` to build the Gemini response schema
  (`buildResponseSchema`, `buildVitaminItemSchema`) or the prompt's nutrient list
  (`NUTRIENT_LIST_FOR_PROMPT`) switches to `ALL_TRACKED_NUTRIENTS` — this is the same
  "schema/prompt built from the shared list" pattern already in place, just widened.
  `sanitizeChatTurnResult`/`sanitizeVitaminItem` switch the same way (already nutrient-generic via
  `toSafeNumber`, no per-field special-casing to duplicate).
- Add `verdict`/`verdict_reason` to `buildResponseSchema` (placed before `reply`, which must stay
  the schema's last property — see the existing comment on why: streaming relies on it). Defaults
  applied in `sanitizeChatTurnResult`: `""` unless `category === "food"` with a non-empty `meal`
  (same "only populate the branch that's actually active" rule the rest of the sanitizer already
  follows).
- **Tone requirement (soft on a bad verdict)**: the enum is `aman` / `waspada` / `kurangi_dulu` —
  deliberately not "avoid"/"danger"-flavored wording. `SYSTEM_PROMPT` gets explicit instructions:
  never use alarming words (`jangan`, `berbahaya`, `dilarang`, `bahaya`) in `verdict_reason`; every
  `waspada`/`kurangi_dulu` reason must pair the caution with one gentle, constructive suggestion
  (e.g. "boleh kok, tapi coba kurangi porsi camilan manis lainnya hari ini" instead of an alarming
  warning) — same warm, non-judgmental register the rest of Bloom's replies already use. The UI
  labels in `app/dashboard/chat/page.js` follow the same softness: `aman` → "Aman dikonsumsi",
  `waspada` → "Boleh, tapi dibatasi", `kurangi_dulu` → "Porsinya dikurangi dulu ya" (not
  "sebaiknya dihindari").
- `streamNutritionChatTurn({ message, image, history, dailyLimitTotals })` — new optional 4th
  field. When present, a short bracketed context line is prepended to the current turn's message
  text: `[Konteks asupan hari ini sebelum ini: Gula 12g dari batas 25g, Natrium 900mg dari batas
  2300mg, ...]`, built by a new small helper (`buildDailyContextHint`, using `LIMIT_META`/`LIMITS`
  from `lib/nutrition.js`) — one line per `LIMIT_ORDER` nutrient, not the floor-type ones (those
  aren't what the safety verdict is about). `SYSTEM_PROMPT` gets a new paragraph explaining: (a)
  category="food" now also requires `verdict` + `verdict_reason`, reasoned from the item's own
  composition *and* the bracketed context line if present; (b) the bracketed line is
  app-injected context, never something the user wrote — don't quote it back or treat it as part
  of the conversation; (c) category="vitamin"/"chat" set `verdict: "aman"`,
  `verdict_reason: ""`.
- No change to the retry/model-fallback/streaming machinery — the new fields ride through the
  exact same JSON response, same as every existing nutrient field.

### 4. `app/api/nutrition-chat/route.js` — fetch today's cumulative limit totals (read-only)
- Accepts a new `today` field in the request body (client-supplied, browser-local `todayISO()` —
  same date semantics the Dashboard already uses for "today", not a server-side timezone
  assumption). Validated as a plain `YYYY-MM-DD` string; a missing/malformed value just skips the
  context fetch (falls back to no context, same as before this change — never blocks the chat).
- Before calling `streamNutritionChatTurn`, queries (via the same already-authenticated
  `getSupabaseServerClient()` used for `auth.getUser()`, so RLS scopes it to the caller
  automatically — no admin client, no new privilege): `meals` rows for that date + the 5 limit
  columns, `vitamin_checks` rows for that date where `checked = true`, and the corresponding
  `vitamins` rows' 5 limit columns. Sums them with the new `groupLimitTotalsByUser`/
  `mergeUserTotals` helpers (single-user case — reusing the multi-user shape from #1 above rather
  than writing a third variant) into one `dailyLimitTotals` object, passed to
  `streamNutritionChatTurn`.
- This is the one place the route's own top-of-file comment ("It never touches the database") stops
  being true — the comment gets updated to say it now does one read-only fetch for daily nutrient
  context, still never *writes* (every insert stays client-side via the browser's own
  already-authenticated Supabase client, unchanged).

### 5. `app/dashboard/chat/page.js` — send `today`, render the verdict, save the new fields
- `handleSend`'s POST body gains `today: todayISO()`.
- A new small badge/line renders under a `category: "food"` analysis bubble (above the existing
  "Simpan ke Dashboard" button): `analysis.verdict` maps to a label + color (`aman` → green
  "Aman dikonsumsi", `waspada` → amber "Boleh, tapi dibatasi", `kurangi_dulu` → a soft amber/rose
  (not alarm-red) "Porsinya dikurangi dulu ya"), followed by `analysis.verdict_reason` as
  supporting text. Nothing renders for `vitamin`/`chat` categories (verdict is food-specific, per
  the decisions above). Deliberately no red/alarm styling anywhere in this badge, per the
  soft-tone decision above — reserve red for the deterministic `exceededLimitLabels` warning
  banner (#6 below), which is exact math, not a qualitative judgment about one food.
- `formatAnalysisText`/`formatVitaminAnalysisText` extend their nutrient-detail line to include
  `LIMIT_ORDER` fields (via `LIMIT_META`) alongside the existing `NUTRIENT_ORDER` ones, so e.g.
  "Gula 12g · Natrium 400mg" shows up next to "Kalori 380kkal" the same way.
- `saveAnalysisToMeals` (building the `meals` insert row) and `vitaminItemToRow` (`lib/
  nutrition.js`, used by `saveVitaminItemToDashboard`) switch their `NUTRIENT_ORDER.forEach` to
  `ALL_TRACKED_NUTRIENTS.forEach` so the 5 new fields actually get persisted, not silently dropped.

### 6. `app/dashboard/page.js` — "Batas harian" section + warning banner + manual-entry fields
- New pure derived state: `activeLimitNutrients` (`computeActiveLimitNutrients(meals)`),
  `dayLimitTotals(date)` (mirrors `dayTotals`/`extraTotals`, reading `LIMIT_ORDER` off
  `mealsByDay[date]` + checked vitamins), `limitTotals` / `exceededToday` (via the shared
  `exceededLimitLabels`) for the currently-viewed date.
- A warning banner (`AlertTriangle` + red-tinted box, same visual language as the existing
  `.error-box`) renders right after `bloom-header` — the first thing visible on the page — whenever
  `exceededToday.length > 0`: "⚠️ Sudah melebihi batas harian hari ini: {labels}." Only shown for
  the date being viewed (so browsing to a past day shows that day's own warning state, consistent
  with how trimester/targets already follow the viewed date).
- New "Batas harian — {currentDate}" panel (same structural style as the existing "rincian per
  nutrisi" panel): one row per `activeLimitNutrients` entry — bar fill colored by
  `limitStatusForPct`, `{value}/{limit}{unit} · {pct}%` text, `over` marker past 100%.
- New "Tren batas harian" panel: a second trend `<svg>`, structurally mirroring the existing "Tren
  dari hari ke hari" block but computed from `dayLimitTotals`/`LIMITS` instead of
  `dayTotals`/`targets`, own legend, own 100%-dashed "batas" line. Built as a parallel block
  (deliberately not refactoring the existing trend into a shared generic component — smaller diff,
  zero risk to the existing floor-type trend).
- Manual "add menu"/"add vitamin" forms (`manual-form-grid`) gain a second, clearly-labeled
  sub-grid ("Batas harian (opsional)") of number inputs for the 5 `LIMIT_ORDER` fields, using
  `LIMIT_META` labels/units — same input styling as the existing grid. `handleAddMeal`/
  `handleAddVitamin`/`handleVitFile` extend their per-field loops to `ALL_TRACKED_NUTRIENTS` so
  these values actually get saved.
- Meal-list-item and vitamin-row detail lines extend their `NUTRIENT_ORDER.filter(...)`.map(...)`
  to also include `LIMIT_ORDER` (via `LIMIT_META`), same as the chat bubble change in #5.
- "Format kolom CSV" / vitamin-CSV help text updated to list the 5 new columns.

### 7. `lib/reminderLogic.js` — limit-warning clause + trigger condition
- `buildLimitWarningClause(exceededLabels)` — pure function, returns `""` for an empty list, else
  `"⚠️ Sudah melebihi batas harian {labels} hari ini — coba dikurangi dulu ya."`.
- `buildReminderBody` gains an optional `limitWarning` param, appended (space-joined, not
  newline-joined — push notification bodies don't reliably render multi-line text) after the
  existing `nudge`-appended text, regardless of which `lead` branch fired (including the
  "Semua sudah tercatat hari ini!" branch — that's exactly the new case this feature adds: fully
  logged, but over a limit).

### 8. `app/api/cron/reminders/route.js` — dinner slot: fetch limit totals, change the trigger
- Only inside the existing `kind === "dinner"` conditional block (unconditional slots pay nothing
  extra, unchanged): additionally fetches `meals` rows (5 limit columns) for `today`, and the
  `vitamins` rows (5 limit columns) for every checked `vitamin_checks` row that day — same
  `.in("user_id", userIds)` scoping already used for the existing queries. Builds
  `limitTotalsByUser` via `groupLimitTotalsByUser` + `mergeUserTotals` (`lib/nutrition.js`).
- Replaces the early-return skip condition:
  `if (!missingMeal && !missingVitamin) return {sent:0,pruned:0,skipped:1}` →
  `if (!missingMeal && !missingVitamin && exceededLabels.length === 0) return {...}`, where
  `exceededLabels = exceededLimitLabels(limitTotalsByUser[userId] || {})`.
- Passes `limitWarning: buildLimitWarningClause(exceededLabels)` into `buildReminderBody`.

### 9. `README.md`
- Update the CSV column list mention (the schema-setup section already says "aman dijalankan
  ulang", no change needed there) and add one line noting the 5 new tracked nutrients + that their
  daily limits are general adult/pregnancy guidance, not personal medical advice (mirroring the
  existing dashboard disclaimer's framing) — short doc touch, not a new setup step (no new env var,
  no new service to configure).

## Scope
### In scope
- `lib/nutrition.js` — new `LIMIT_ORDER`/`LIMIT_META`/`LIMITS`/`LIMIT_STATUS_TIERS`, new pure
  helpers (`limitStatusForPct`, `exceededLimitLabels`, `computeActiveLimitNutrients`,
  `groupLimitTotalsByUser`, `mergeUserTotals`, `ALL_TRACKED_NUTRIENTS`), extended
  `groupMealsByDay`/alias maps/sample CSVs/`DEFAULT_VITAMINS`/`vitaminItemToRow`.
- `supabase/schema.sql` — 10 new `alter table add column if not exists` statements (5 cols ×
  2 tables).
- `lib/gemini.js` — schema/prompt widened to `ALL_TRACKED_NUTRIENTS`, new `verdict`/
  `verdict_reason` fields + sanitize defaults, new `dailyLimitTotals` param + context-line builder
  on `streamNutritionChatTurn`.
- `app/api/nutrition-chat/route.js` — new `today`-scoped read-only Supabase query for daily limit
  context.
- `app/dashboard/chat/page.js` — send `today`, render verdict badge, extend detail-text +
  save-to-DB field lists.
- `app/dashboard/page.js` — new "Batas harian" today panel + trend panel + warning banner, new
  manual-form sub-grids, extended detail lines + CSV help text.
- `lib/reminderLogic.js` — `buildLimitWarningClause`, `buildReminderBody`'s new param.
- `app/api/cron/reminders/route.js` — dinner-slot limit-totals fetch + trigger condition change.
- `README.md` — short doc note.
- New/extended tests: `lib/nutrition.test.js`, `lib/gemini.test.js`, `lib/reminderLogic.test.js`
  (see Test plan).

### Out of scope / non-goals
- Per-trimester variation of the 5 new limits (kept flat, like the rest of `TARGETS`'s non-calorie
  entries are already flat in spirit — calories is the only field that varies by trimester today).
- Backfilling historical `meals`/`vitamins` rows with real sugar/sodium/etc. values — new columns
  default to 0, same precedent as `dha_mg`/`vitamin_k_mcg`.
- Configurable/admin-editable limit numbers — `LIMITS` is a code constant, not a per-user setting.
- Including unsaved, analyzed-but-not-yet-saved chat items in the verdict's "today's intake"
  context (decided: already-saved totals only).
- Changing the morning/lunch/night notification slots — only dinner's trigger condition changes.
- Refactoring the existing floor-type trend chart into a shared/generic component — the new
  ceiling-type trend is a parallel, structurally-similar block, not an abstraction over both.

## Steps
1. `lib/nutrition.js` — add `LIMIT_ORDER`/`LIMIT_META`/`LIMITS`/`LIMIT_STATUS_TIERS` +
   `limitStatusForPct`/`exceededLimitLabels`/`computeActiveLimitNutrients`/
   `groupLimitTotalsByUser`/`mergeUserTotals`/`ALL_TRACKED_NUTRIENTS`; extend `groupMealsByDay`,
   `MEAL_ALIASES`/`VIT_ALIASES`, `SAMPLE_MEAL_CSV`/`SAMPLE_VIT_CSV`, `DEFAULT_VITAMINS`,
   `vitaminItemToRow`.
2. `supabase/schema.sql` — add the 10 new columns.
3. `lib/gemini.js` — widen schema/prompt to `ALL_TRACKED_NUTRIENTS`, add `verdict`/
   `verdict_reason` + sanitize defaults, add `dailyLimitTotals` param + `buildDailyContextHint` +
   prompt paragraph.
4. `app/api/nutrition-chat/route.js` — accept `today`, fetch+sum daily limit context, pass through.
5. `app/dashboard/chat/page.js` — send `today`; render verdict badge; extend detail text + saved
   field lists.
6. `app/dashboard/page.js` — "Batas harian" today panel + trend panel + warning banner; manual-form
   sub-grids; extended detail lines + CSV help text.
7. `lib/reminderLogic.js` — `buildLimitWarningClause`; extend `buildReminderBody`.
8. `app/api/cron/reminders/route.js` — dinner-slot limit fetch + trigger condition change.
9. `README.md` — doc note.
10. Tests (see below), run, fix, commit per finished step per the skill's own per-step-commit rule.

## Data / schema impact
10 new nullable-with-default (`numeric default 0`) columns, 5 on `meals` + 5 on `vitamins`, via
`alter table ... add column if not exists` — additive, non-breaking, no backfill, matches the
existing `dha_mg`/`vitamin_k_mcg` precedent in `supabase/schema.sql`. No new tables, no RLS policy
changes needed (existing per-owner policies already cover all columns on those tables).

## Risks & mitigations
- **Prompt/schema regression on existing nutrient extraction** (widening `NUTRIENT_ORDER` →
  `ALL_TRACKED_NUTRIENTS` at every Gemini schema/prompt call site) — mitigated by keeping the
  widening mechanical (same iteration pattern, just a longer list) and re-running
  `lib/gemini.test.js`'s existing `sanitizeChatTurnResult`/schema-shape assertions unchanged first,
  before adding new ones, to catch any accidental behavior change to the existing 10 fields.
- **Streaming breaks if `reply` stops being the schema's last property** — mitigated by explicitly
  inserting `verdict`/`verdict_reason` before `reply` in `buildResponseSchema`, and adding a test
  asserting `reply` is still the final key.
- **Push notification body formatting** with the appended limit-warning clause — mitigated by
  space-joining (not newline-joining), consistent with how `nudge` is already appended today.
- **Dinner slot now queries more data** (meals + vitamins + vitamin_checks with extra columns) —
  bounded to the existing `kind === "dinner"`-only branch (already the pattern for the
  missing-meal/vitamin queries), so the 3 unconditional slots pay nothing extra; Vercel's existing
  60s budget/concurrency-per-user model is unchanged.
- **Verdict disagreeing with the deterministic `exceededLimitLabels` warning** (Gemini might say
  "aman" for a food while the day's totals are already over budget on paper, or vice versa) — this
  is by design (Gemini reasons qualitatively per-item; the dashboard/dinner warnings are exact
  math) and will be called out in the disclaimer text so it doesn't read as a bug.

## Test plan
- `lib/nutrition.test.js`:
  - `exceededLimitLabels`: empty totals → `[]`; one nutrient over its limit → returns just that
    label; multiple over → returns all, in `LIMIT_ORDER` order; exactly at the limit (not over) →
    excluded (strict `>`, not `>=`, matching the existing `.over` marker's `pct > 102` "clearly
    over" spirit but using the limit itself as the threshold since these are hard ceilings).
  - `computeActiveLimitNutrients`: only nutrients with a nonzero value in at least one row are
    returned; empty input → `[]`.
  - `groupLimitTotalsByUser` + `mergeUserTotals`: sums across multiple rows for the same user;
    keeps different users separate; merging two totals maps adds them per-user per-nutrient.
  - `vitaminItemToRow`: asserts the 5 new fields are present on the built row (regression guard —
    this is exactly the "silently dropped" bug the plan calls out).
- `lib/gemini.test.js`:
  - `sanitizeChatTurnResult`: existing floor-type-field assertions still pass unchanged (regression
    guard); new assertions — a `category: "food"` result's `verdict`/`verdict_reason` pass through
    sanitized/truncated; `category: "vitamin"`/`"chat"` results get `verdict: ""`,
    `verdict_reason: ""` regardless of what the raw payload contained (mirrors the existing
    "only the active branch's fields are trusted" test pattern already in the file); `verdict` only
    accepts the three known values (`aman`/`waspada`/`kurangi_dulu`), anything else downgrades to
    `""` same as an unrecognized `category` does today.
  - A schema-shape assertion: `reply` is still the last key in `buildResponseSchema()`'s
    `properties` (guards the streaming-relies-on-last-field invariant called out above).
  - `streamNutritionChatTurn` (mocking `fetch`, same style as the file's existing tests): when
    `dailyLimitTotals` is passed, the request body's `contents` includes the bracketed context
    line; when omitted, it doesn't (regression guard for calls that don't pass it).
- `lib/reminderLogic.test.js`:
  - `buildLimitWarningClause`: empty list → `""`; one/many labels → the expected sentence.
  - `buildReminderBody`: with `limitWarning` set, appended after the existing lead+nudge text,
    including in the "everything already logged" (`!missingMeal && !missingVitamin`) branch —
    covers the new "fully logged but over a limit" case the dinner trigger change unlocks.
- Run via `npm test` (this repo's existing `vitest run` script — no `uv`/Python here), capture real
  output, fix any failures within this plan's scope before considering the run done.

## Standards notes
No `kredivo-docs` areas touched — this is app-level feature work (Next.js/Supabase/Gemini, no
GCP/WIF, no SSO, no Terraform/IaC, no Dockerfile/compose). `kredivo-docs` was located at
`~/.claude/kredivo-docs` but nothing in it applies here.
