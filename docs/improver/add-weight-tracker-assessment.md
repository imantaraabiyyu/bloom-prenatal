# Assessment — Add weight tracker

## Current behavior

**No weight tracking exists at all today** (`grep -rniE "weight|berat badan"` across the codebase
only turns up one mention: the dashboard's disclaimer text lists "berat badan sebelum hamil"
(pre-pregnancy weight) as a factor nutrition needs vary by — `app/dashboard/page.js:1151` — it is
not stored or read anywhere).

### Profile (`app/dashboard/profile/page.js`, `profiles` table)
- `profiles` (`supabase/schema.sql`): `user_id`, `hpht` (date), `name` (text). A legacy `trimester`
  column still exists from before HPHT-derived trimester was introduced but is no longer read
  anywhere in app code (dead column, out of scope to touch here).
- The Profile page is framed explicitly as "data pribadi yang jarang berubah" (personal data that
  rarely changes) — HPHT (set once, occasionally corrected), name, and the baby-names list.
  Nothing per-day lives here today.
- `computeGestationalAge`/`trimesterForDate`/`gestationalProgressPct` (`lib/pregnancy.js`) derive
  everything from `hpht` + a target date — nothing else is stored (deliberate "computed, not
  stored" philosophy, stated in that file's own header comment).

### Per-day metrics on the Dashboard (`app/dashboard/page.js`)
Two existing patterns for "log something for a specific day", neither of which fits weight as-is:
1. **Cumulative-per-day (water, `meals` rows)** — `addWater(amount)` inserts a new `meals` row
   `{ meal: "Air minum", water_ml: amount }` for `currentDate`; `dayTotals(date)` sums every row's
   `water_ml` for that date. Right pattern for "how much did I drink today" (many small adds sum
   up), wrong shape for weight — a body weight reading is a single point-in-time value, not
   something to sum across multiple entries the same day.
2. **Boolean checklist-per-day (`vitamin_checks`)** — one row per `(user_id, date, vitamin_id)`
   with a `checked` boolean, upserted on toggle. Closer in spirit (one row per day) but still the
   wrong value shape (boolean, not a number).

Neither existing table is a fit — a weight log needs its own table: one row per
`(user_id, date)` carrying a numeric value, upsertable (a same-day re-weigh overwrites, doesn't
sum), most similar in *shape* to `journal_entries` (one row per user+date-ish, freely editable) but
without the mood/note/attachments machinery.

### Trend chart precedent (`app/dashboard/page.js`, from the prior sugar/sodium work)
Two parallel trend blocks already exist: a floor-type trend (`trendData`/`tw`/`th`/`padL`.../
`xPos`/`yPos`/`gridTicks`, plotting `% of a per-trimester TARGETS value` per nutrient) and a
ceiling-type trend (`limitTrendData`/`ltw`.../ plotting `% of a fixed LIMITS value`). Both are
literal geometry blocks (not a shared component) computed from `datesWithMeals`, each returning an
SVG polyline per tracked key. A weight trend is a different shape again — a single series (not
"one line per nutrient key"), and the meaningful unit is the raw weight value (or cumulative gain
from a baseline), not a percentage of a target — so it doesn't slot into either existing block
as-is; it would be its own third geometry block, following the same hand-rolled-SVG house style
(inline `<svg>`, no charting library — none is installed, confirmed via `package.json`).

### Reminder notifications (`lib/reminderLogic.js`, `app/api/cron/reminders/route.js`)
4 daily push slots (morning/lunch/dinner/night). The dinner slot already conditionally fires based
on per-day database state (missing meal/vitamin logging, and — after the prior session's work —
exceeded nutrient limits). Weight is customarily checked weekly by OB-GYNs, not daily, so wiring it
into any of the 4 *daily* slots as written would nudge far more often than clinically sensible —
open question for the user rather than an assumed design.

### Existing "range/target" precedent
`TARGETS` (`lib/nutrition.js`) is a flat, code-constant, per-trimester **floor** number (protein,
iron, etc.) with no personalization beyond trimester. `LIMITS` (added in the prior session) is a
flat ceiling, same shape. A clinically real "healthy weight gain" guidance (IOM 2009) is
**BMI-category-dependent** (total recommended gain differs for underweight/normal/overweight/obese
pre-pregnancy BMI) — computing it needs a pre-pregnancy weight AND a height, **neither of which
this app collects anywhere today**. Whether to add that (and the BMI-lookup table) or ship a
simpler "just log + trend, no target range" version is a real scope fork, not something the code
already implies an answer to.

## Files/functions likely in scope (pending clarifying answers)
- `supabase/schema.sql` — new `weight_logs` table (or a `weight_kg` addition elsewhere, depending
  on answers), possibly new `profiles` columns (pre-pregnancy weight/height) if range guidance is
  wanted.
- `lib/pregnancy.js` or a new `lib/weight.js` — BMI/IOM range helpers if wanted; unit
  conversion helpers if lbs support is wanted.
- `app/dashboard/page.js` (most likely home, given the "per-day metric" precedent) or
  `app/dashboard/profile/page.js` — new panel + possibly a new trend block.
- `lib/reminderLogic.js`/`app/api/cron/reminders/route.js` — only if reminder integration is
  wanted.
- Tests: a new `lib/weight.test.js` (or additions to `lib/nutrition.test.js`/`lib/pregnancy.test.js`
  if the logic lands there instead) for any new pure helper (BMI category, IOM range lookup, unit
  conversion).

## Ambiguities the description doesn't resolve
1. **Where it lives** — Dashboard (matches the existing per-day-metric precedent: water, meals,
   vitamin checks) or Profile (matches "pregnancy info" grouping — HPHT/HPL/trimester already live
   there, and weight-for-BMI is arguably closer to "personal info" than "today's log")?
2. **Healthy gain range/guidance** — full IOM-2009 BMI-category-based range (needs new
   pre-pregnancy-weight + height inputs, a BMI calculator, and a lookup table), or a simpler
   "log + trend only, no target/range" version (no new profile fields, smaller scope)?
3. **Unit(s)** — kg only (matches this app's Indonesia-first framing — no lbs/imperial anywhere
   else in the app), or a kg/lbs toggle?
4. **Log granularity** — one entry per calendar date (upsert — a same-day re-weigh overwrites, like
   `vitamin_checks`), or a free-form list allowing multiple timestamped entries per day (closer to
   `meals`/`journal_entries`, more flexible but a different "today's value" derivation: latest? first?)?
5. **Trend chart** — own SVG trend block (matches the nutrient/limit trend precedent) — assumed
   yes per the task description, confirming rather than assuming outright given it's a real
   scope item (a third hand-rolled SVG geometry block).
6. **Reminder integration** — none of the 4 existing daily push slots, given weight is customarily
   a weekly check, not daily (as reasoned above) — or a specific cadence/slot the user wants wired
   in regardless?

Triage: COMPLEX — no existing table/column fits weight's shape (schema impact: at minimum one new
table), the dashboard/profile placement and range-guidance scope are both genuine forks the
description doesn't resolve, and depending on answers the blast radius could include
`lib/reminderLogic.js`/the cron route. Every SIMPLE criterion is at risk; defaulting to COMPLEX.
