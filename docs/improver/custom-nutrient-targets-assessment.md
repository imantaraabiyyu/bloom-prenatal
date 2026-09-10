# Assessment — Per-user configurable nutrient targets/limits (incl. custom extras)

## Request (as given)
Build a Profile-page section where the user can configure which nutrients they want monitored,
including editing/adding targets and limits — for both the app's fixed nutrient set AND any custom
"extra nutrient" that has appeared in their own logged meals/vitamins (e.g. "Laktosa"). For each
nutrient, the user picks the goal *direction* themselves: "reach at least X" (minimum) or "avoid
exceeding X" (maximum) — not hardcoded per nutrient like today.

## Current behavior

### Fixed targets/limits are global constants, not per-user (`lib/nutrition.js`)
- `TARGETS` (`:7-11`) — floor-type ("reach at least") goals, keyed by trimester (`t1`/`t2`/`t3`), same
  for every user: `{ calories, protein_g, iron_mg, calcium_mg, folate_mcg, vitamin_d_mcg, fiber_g,
  water_ml, dha_mg, vitamin_k_mcg }`.
- `LIMITS` (`:75-81`) — ceiling-type ("don't exceed") thresholds, flat (no trimester variation), same
  for every user: `{ sugar_g: 25, sodium_mg: 2300, cholesterol_mg: 300, saturated_fat_g: 20,
  caffeine_mg: 200 }`.
- `NUTRIENT_ORDER`/`LIMIT_ORDER`/`NUTRIENT_META`/`LIMIT_META` — display order + label/unit/color for
  each. `ALL_TRACKED_NUTRIENTS` = the union (15 keys), the exact field set persisted on every
  `meals`/`vitamins` row and the exact schema Gemini's structured output must fill
  (`lib/gemini.js:68-88`).
- **No per-user override of any of this exists anywhere** — no table, no `profiles` column, no env
  var. `profiles.trimester` exists in the schema but is vestigial/dead (Dashboard derives trimester
  live from `hpht`, per `app/dashboard/page.js:39-40`; nothing in the Profile page reads/writes it).

### Where these constants are read (would all need a "does this user have a custom value?" check if
consumption is in scope — see Ambiguity #1)
- `app/dashboard/page.js` — rings (`:811-814`), nutrient detail bars (`:980-981`), trend chart
  (`:488`), history-table averages (`:1126`), water widget (`:259`) all divide a logged value by
  `TARGETS[trimester][key]`; the "batas harian" section (`:1052-1057`, `:507-521`, `:1074-1114`) and
  warning banner (`exceededLimitLabels`, `:254`) divide by/compare against `LIMITS[key]`.
- `lib/gemini.js` — `SYSTEM_PROMPT` embeds `NUTRIENT_LIST_FOR_PROMPT`/`LIMIT_LIST_FOR_PROMPT`
  (stringified `NUTRIENT_ORDER`/`LIMIT_ORDER` + meta) so Gemini knows what counts as a "target
  minimum" vs "batas maksimum harian" field at all; `buildDailyContextHint` (`:517-526`) reads the
  module-level `LIMITS[k]` constant directly to build the "...dari batas 2300mg" text fed to Gemini
  for the food verdict.
- `app/api/cron/reminders/route.js` — the dinner slot's `exceededLimitLabels(limitTotalsByUser[userId])`
  call (`:215`) checks every subscriber against the same global `LIMITS`, in one batched pass.
- `exceededLimitLabels` (`lib/nutrition.js:102-104`) is the explicit single source of truth shared by
  the Dashboard warning banner and the cron dinner-reminder trigger — "so 'what counts as exceeded'
  can't drift between the two."

### `extra_nutrients` — informational only today, no target concept, no cross-history query
- Storage shape: `{ [slug]: { label, unit, value } }` jsonb, on both `meals.extra_nutrients` and
  `vitamins.extra_nutrients` (`supabase/schema.sql:80,108`), built via `buildExtraNutrientsMap`
  (`lib/nutrition.js:297-308`), slug via `slugifyNutrientLabel` (`:285-287`).
- Explicit design comment (`lib/nutrition.js:280`): "no AKG/target reference for arbitrary entries...
  informational only — no ring, no % complete." Adding user-set targets for these is a genuine
  expansion of that stated intent, not completing something half-built.
- The **only** existing aggregation is per-day (`app/dashboard/page.js`'s `extraTotals(date)`,
  `:241-247`, merging one day's checked vitamins + meals). **Nothing scans a user's entire history**
  to discover which distinct extra-nutrient slugs they've ever logged (e.g. "Laktosa" from
  yesterday) — this is new capability the feature needs to build from scratch.

### `profiles` table + RLS
Full effective columns today: `user_id (pk)`, `trimester` (vestigial), `created_at`, `hpht`, `name`,
`pre_pregnancy_weight_kg`, `height_cm`. Standard owner-RLS (`auth.uid() = user_id`, select/insert/
update, no delete policy) — identical pattern to every other table in `supabase/schema.sql`.

### Profile page (`app/dashboard/profile/page.js`, 899 lines) — patterns to reuse
- Per-field state triplet + `upsert({ user_id, ...field }, { onConflict: "user_id" })` pattern, e.g.
  `saveName`/`saveBio`/`saveHpht` (`:164,182-185,320`) — the house style for anything landing on
  `profiles` directly.
- **Id-based editable list w/ add + `ConfirmButton` delete** — "Daftar calon nama" (`baby_names`,
  `:816-886`): closest precedent for a genuinely persisted, individually-removable list of rows.
- **Index-based transient row editor** — the meal/vitamin form's "nutrisi lain" rows
  (`app/dashboard/page.js:324-332, 660-684`): `{label, unit, value}` rows added/edited/removed by
  array index, only converted to persisted jsonb on final save — closest precedent for the actual
  label+value+unit input shape, but not for persisting each row with its own id/lifecycle.

### Tests
`lib/nutrition.test.js` — one `describe` per exported function, header comment explaining the
cross-cutting contract it guards (e.g. `exceededLimitLabels`'s "single source of truth..." comment).
No component-level tests exist for any page (`profile/page.js` or `dashboard/page.js` included) —
confirmed absent in two separate prior improver runs earlier this session too.

## Files / functions likely in scope
- `supabase/schema.sql` — new storage for per-user nutrient goals (table vs. jsonb column — open,
  see ambiguities).
- `lib/nutrition.js` — a new function to discover a user's historical extra-nutrient slugs (scanning
  `meals`/`vitamins`), and (if consumption is in scope) helpers resolving "effective target/limit for
  key X" that check the user's override before falling back to `TARGETS`/`LIMITS`.
- `app/dashboard/profile/page.js` — new "Konfigurasi nutrisi" section: fixed nutrients (editable
  direction + value) + discovered custom extras (add/edit/remove goals).
- Possibly `app/dashboard/page.js`, `lib/gemini.js`, `app/api/cron/reminders/route.js` — **only if**
  the user wants this run to also wire consumption, not just capture the preference (Ambiguity #1).
- `lib/nutrition.test.js` — new tests for the new pure-logic pieces.

## Ambiguities the description doesn't resolve
1. **Scope: config-only, or also wire consumption?** The request is phrased as "build the
   configuration [UI]" — it's unclear whether this run should stop at storing the user's preference
   (Profile page lets them set it, it's persisted) or also make the Dashboard rings/warnings and
   Gemini's food-verdict context actually use the custom value instead of the global
   `TARGETS`/`LIMITS`. These are very different sizes of change (1 new UI + 1 table vs. that plus
   rewiring 3+ read call-sites across the Dashboard, chat prompt, and cron).
2. **Storage model** — a dedicated table (one row per user+nutrient-key, matching the `baby_names`
   precedent: individually addressable, deletable, natural fit for "add one, remove one") vs. a
   single jsonb column on `profiles` (matches `extra_nutrients`' own precedent, one blob per user).
3. **Fixed-nutrient default semantics** — does "no override row" simply mean "use the app's existing
   `TARGETS`/`LIMITS` default" (nothing pre-seeded, only deviations stored), or should every fixed
   nutrient get a row seeded with today's default value the first time a user opens this section (so
   the UI always shows *something* to edit, and the stored value becomes the actual source of truth
   going forward even before an edit)?
4. **Discovering a user's custom extras** — no aggregation exists today; building it means scanning
   the user's own `meals.extra_nutrients`/`vitamins.extra_nutrients` (client-side reduce, matching
   this app's "personal-app scale, do it in JS" convention elsewhere) — confirming this is
   acceptable, and confirming what happens when the same slug was logged with two different units
   over time (pick most-recent, most-frequent, or ask the user to confirm a unit?).
5. **Direction UI** — for a fixed nutrient that's *currently* always a floor (e.g. protein_g) or
   always a ceiling (e.g. sodium_mg), should the user still be free to flip its direction (e.g. treat
   protein as a ceiling instead), or should fixed nutrients keep their existing floor/ceiling
   identity and only *custom extras* get a user-chosen direction? The request says "the direction is
   user-configurable per nutrient, not hardcoded like today," which reads as applying to every
   nutrient, fixed or custom — worth confirming since flipping a fixed nutrient's direction has
   knock-on effects everywhere it's currently assumed to be one or the other (rings vs. limit bars
   render very differently today).

## Triage
**Triage: COMPLEX** — fails multiple SIMPLE criteria: (a) **schema/data impact** — new per-user
storage for nutrient goals, a table/schema the app has never had before; (b) **open ambiguity** —
five materially different unresolved decisions above, the biggest being whether consumption wiring
is even in scope, which changes the blast radius by 3-4x; (c) **blast radius** — if consumption
wiring is included, this touches the Dashboard's rings/warnings, the Gemini chat prompt, and the cron
reminder route, well beyond a bounded ≤3-file change. Proceeding to clarifying questions before any
plan is written.
