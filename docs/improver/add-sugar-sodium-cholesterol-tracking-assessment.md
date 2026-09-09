# Assessment — Add sugar/sodium/cholesterol tracking + limit warnings + Gemini safety verdict

## Current behavior

### Nutrient model (single source of truth: `lib/nutrition.js`)
- `NUTRIENT_ORDER` (`lib/nutrition.js:26-30`) is the fixed list of tracked nutrients: `calories,
  protein_g, iron_mg, calcium_mg, folate_mcg, vitamin_d_mcg, fiber_g, water_ml, dha_mg,
  vitamin_k_mcg`. `NUTRIENT_META` (`lib/nutrition.js:13-24`) carries label/unit/color per nutrient.
  `TARGETS` (`lib/nutrition.js:7-11`) is a per-trimester **floor** (recommended daily minimum) —
  the whole app's status vocabulary (`STATUS_TIERS`/`statusForPct`, `lib/nutrition.js:35-43`) is
  "Tercukupi/Hampir/Kurang" (sufficient/almost/lacking), i.e. more-is-better up to 100%. There is
  **no upper-limit ("don't exceed") concept anywhere in the codebase** — the only "over 100%"
  handling is a cosmetic marker (a small dot on the ring, an `.over` CSS class with a subtle
  end-cap on the bar) meaning "you've exceeded your (floor) target", which reads as a *good* thing,
  the opposite of what an upper-limit-nutrient warning needs to mean.
- Every nutrient in `NUTRIENT_ORDER` is a real column on both `meals` and `vitamins`
  (`supabase/schema.sql:32-58, 61-76`) — added historically via `alter table add column if not
  exists` migrations (e.g. `dha_mg`/`vitamin_k_mcg`). `extra_nutrients` (jsonb) exists for
  ad-hoc/one-off nutrients a vitamin label has (Zinc, B6, …) but is deliberately **informational
  only** — no target, no ring, no status (`lib/nutrition.js:140-146`) — so it's not a fit for
  sugar/sodium/cholesterol, which the request wants full tracking + limit warnings for.
- `dayTotals(date)` (`app/dashboard/page.js:203-212`) sums `NUTRIENT_ORDER` fields across that
  day's `meals` rows + every checked `vitamins` row. `groupMealsByDay` (`lib/nutrition.js:222-230`)
  does the same for the whole meals array (used by the trend chart).
- CSV import/export (`MEAL_ALIASES`/`VIT_ALIASES`, `lib/nutrition.js:45-64`, and
  `SAMPLE_MEAL_CSV`/`SAMPLE_VIT_CSV`) is keyed off the same nutrient list and would need the new
  fields added to stay consistent (aliases, sample CSVs, the "format kolom CSV" help text in
  `app/dashboard/page.js:516-521`).

### Gemini food analysis (`lib/gemini.js`)
- `buildResponseSchema()` (`lib/gemini.js:50-63`) and `buildVitaminItemSchema()`
  (`lib/gemini.js:21-33`) both derive their nutrient fields from `NUTRIENT_ORDER` — adding a new
  entry there automatically flows into both Gemini response schemas and the prompt's
  `NUTRIENT_LIST_FOR_PROMPT` (`lib/gemini.js:68-70`), with no schema hand-editing needed.
- `sanitizeChatTurnResult`/`sanitizeVitaminItem` (`lib/gemini.js:131-176`) also iterate
  `NUTRIENT_ORDER` generically via `toSafeNumber` — no per-nutrient special-casing exists today
  that would need duplicating.
- The chat turn (`streamNutritionChatTurn`, `lib/gemini.js:463-516`) receives only `{ message,
  image, history }` — **no per-user daily context (today's cumulative meals/vitamins) is ever sent
  to Gemini today.** A "verdict: safe to consume right now given today's cumulative intake" needs
  that context threaded in from the caller (`app/dashboard/chat/page.js` → `app/api/nutrition-chat/
  route.js` → `lib/gemini.js`), which today's flow has no path for — the chat page never fetches
  the dashboard's meals/vitamins data at all.
- `generateDailyNudge`/`generateMealFact` (`lib/gemini.js:656-729`, used only by the cron reminder
  route) are separate, structurally simple (one string field) Gemini calls unrelated to the food
  analysis schema.

### Daily trend + warnings display (`app/dashboard/page.js`)
- The rings (`activeNutrients.slice(0,3)`), the nutrient detail list (`visibleNutrients`,
  `app/dashboard/page.js:828-850`), and the day-over-day trend chart (`trendData`,
  `app/dashboard/page.js:438-451`, rendered `app/dashboard/page.js:852-891`) all iterate
  `activeNutrients` (`computeActiveNutrients`, `lib/nutrition.js:134-138` — any nutrient with a
  nonzero value in at least one meal row). Adding sugar/sodium/cholesterol to `NUTRIENT_ORDER`
  makes them show up in all three automatically **once they have a numeric target** — but
  `targets[n]` is used as a percent-of-target denominator everywhere (`pct = value/target*100`),
  and a limit-type nutrient's "target" is a ceiling, not a floor, so every one of these call sites
  (ring frac, trend `%`, history table average, bar width) would need to know whether a nutrient
  is floor-type or ceiling-type to render meaningfully (else e.g. "120% of your sodium limit"
  would look like a bar 20% *over the edge* of a 100%-max bar with nowhere to go, and the overall
  "avg % tercapai / metCount" summary would count "exceeded your sugar limit" as a *good*
  contributor to the daily score, which is backwards).
- No existing UI element reads as "you are over budget, this is bad" — the closest is the
  cosmetic `.over` marker described above, which is celebratory, not a warning.

### Reminders / notifications (`lib/reminderLogic.js`, `app/api/cron/reminders/route.js`,
`lib/emailSender.js`)
- 4 daily slots (morning/lunch/dinner/night, `app/api/cron/reminders/route.js:23`), one shared
  route dispatched by `?kind=`. Only the **dinner** slot (19:00 WIB) is conditional — it only
  fires when `missingMeal || missingVitamin` is true (`pickMissing`, `lib/reminderLogic.js:11-16`,
  checked against `meals`/`vitamin_checks` rows for today, `app/api/cron/reminders/route.js:80-87`).
  `buildReminderBody` (`lib/reminderLogic.js:32-45`) composes the dinner body from
  `missingMeal`/`missingVitamin` + a Gemini-generated or fallback `nudge` string — it has no
  awareness of nutrient totals at all today.
- The route never queries nutrient totals for the dinner slot (only *whether a meals/vitamin_check
  row exists* for today, not their values) — adding an "you exceeded your sugar/sodium limit
  today" line means the dinner branch needs to additionally fetch+sum today's meals/vitamins
  nutrient columns (same shape as `dayTotals` in the dashboard, but server-side/admin-client) and
  compare against a limit table.
- Push delivery (`lib/pushSender.js`, not read in full — used via `sendPush`) and the Resend email
  fallback (`lib/emailSender.js`) both just take a prebuilt `{title, body}`/`(to, subject, text)` —
  no schema change needed there; the warning is just additional text folded into the existing
  `body` string, same pattern as the existing `nudge` append.

### Chat page (`app/dashboard/chat/page.js`)
- `formatAnalysisText`/`formatVitaminAnalysisText` (`app/dashboard/chat/page.js:46-68`) render
  `NUTRIENT_ORDER` fields generically — a new nutrient appears in the "Simpan ke Dashboard" bubble
  text automatically. There is no verdict/safety field rendered anywhere in the bubble UI today —
  a new one would need explicit UI (e.g. a colored badge/line under the analysis).
- The chat page has no access to the dashboard's meals/vitamins data (it only loads
  `chat_messages`) — sending Gemini "today's cumulative intake" for the verdict requires either (a)
  the chat page fetching today's meals/vitamin-checks the same way the dashboard does before
  calling `/api/nutrition-chat`, or (b) the API route querying them server-side once it knows the
  user. Both are viable; needs a decision.

## Files/functions in scope (expected, pending clarifying answers)
- `supabase/schema.sql` — new columns on `meals` + `vitamins` (`sugar_g`, `sodium_mg`,
  `cholesterol_mg`, possibly more), migration-style `alter table add column if not exists`.
- `lib/nutrition.js` — extend `NUTRIENT_ORDER`/`NUTRIENT_META`, add a ceiling-type limits table
  (parallel to `TARGETS` but "don't exceed"), alias maps, sample CSVs, a `computeDailyWarnings`-
  style helper.
- `lib/gemini.js` — schema/prompt already flows from `NUTRIENT_ORDER` (no schema change needed
  for the composition fields themselves); needs a new `verdict`-type field in the schema/prompt,
  and a new parameter path for "today's cumulative totals" into `streamNutritionChatTurn`.
- `app/api/nutrition-chat/route.js` — thread cumulative-totals context (server-fetched or
  client-sent) into `streamNutritionChatTurn`.
- `app/dashboard/chat/page.js` — send/fetch today's cumulative context; render the new verdict.
- `app/dashboard/page.js` — daily trend + nutrient list + a new warning banner for
  ceiling-type nutrients that exceed their limit; likely a distinct visual treatment from the
  existing floor-type nutrients (can't reuse `pct >= 100 = good` for these).
- `lib/reminderLogic.js` + `app/api/cron/reminders/route.js` — dinner-slot warning text, needs a
  new nutrient-totals fetch server-side.
- `README.md` — CSV column docs, env var docs if any new config surfaces (e.g. whether
  limits are hardcoded constants or configurable).

## Ambiguities the description doesn't resolve
1. **Exact nutrient list + limit values.** "Sugar, sodium, and other composition fields such as
   cholesterol (e.g. from coffee)" — which fields exactly (sugar_g, sodium_mg, cholesterol_mg —
   anything else, e.g. saturated fat, caffeine)? What are the actual daily limit numbers per
   trimester (flat across trimesters like the rest of `TARGETS`, or does sodium/sugar guidance
   differ by trimester)?
2. **Where the "verdict" is computed.** Should Gemini itself produce the safe/not-safe verdict
   (as a schema field, reasoning over composition + a cumulative-context string given to it), or
   should the app compute it deterministically (composition vs. remaining daily budget) and only
   use Gemini for the composition extraction? The request says "in Gemini add verdict... based on
   current food and vitamin intake" — implies Gemini should reason over it, which requires
   threading daily cumulative totals (and vitamin/supplement totals) into every chat turn as
   context, not just when the user's message happens to be about food.
3. **What "current cumulative intake" means for a not-yet-saved analysis.** The verdict is
   requested "based on current food and vitamin intake" — is that only what's already saved to
   `meals`/`vitamins` for today (i.e. `dayTotals` before this new item), or does it also include
   items sitting unsaved in the chat thread (analyzed but not yet clicked "Simpan ke Dashboard")?
4. **How ceiling-type nutrients render in the existing trend/ring UI.** Given today's
   floor-type-only status vocabulary (Tercukupi/Hampir/Kurang, more-is-better), do
   sugar/sodium/cholesterol get a mirrored ceiling-type status (e.g. "Aman/Mendekati batas/
   Melebihi batas") with their own color scale, excluded from rings/summary "rata-rata tercapai"
   average (since averaging a floor-% with a ceiling-% is meaningless), and shown as their own
   trend lines / warning banner section?
5. **Scope of "give warning in notification in dinner"** — only the dinner slot (already
   conditional on missing meal/vitamin), or should the warning fire independently of whether
   meal/vitamin logging is complete (i.e. even a user who logged everything still gets a "you're
   over your sugar limit today" warning)? Today's dinner slot skips sending entirely when nothing
   is missing (`app/api/cron/reminders/route.js:107`) — a limit-exceeded warning needs its own
   trigger condition layered on top of (or instead of) that early return.
6. **Backfill / existing rows.** New nutrient columns default to 0 for every historical
   meal/vitamin row (same as when `dha_mg`/`vitamin_k_mcg` were added) — confirm this is
   acceptable (no attempt to backfill real historical sugar/sodium/cholesterol values).

Triage: COMPLEX — fails "no schema/data impact" (new `meals`/`vitamins` columns + a parallel
limits table), fails "bounded scope" (touches 8+ files across schema, nutrition lib, Gemini
integration, 2 dashboard/chat pages, reminder logic + cron route, README), and fails "no open
ambiguity" (6 unresolved design questions above, several of which change the shape of the
implementation, e.g. where the verdict is computed and what "cumulative intake" scope means).
