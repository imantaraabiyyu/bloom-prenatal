# Improvement Plan — Weight tracker with IOM-based healthy gain range

## Goal
Add a weight tracker to the Dashboard: log one weight (kg) per calendar date, see it as a trend
over time, and — using pre-pregnancy weight + height captured on the Profile page — show an
IOM-2009 BMI-category-based healthy total-gain range and an "on track so far" read against the
current gestational week. A weekly nudge is added to the morning push notification when no weigh-in
has been logged in the last 7 days.

## Current behavior
See `docs/improver/add-weight-tracker-assessment.md` for the full file-by-file read. Summary: no
weight tracking exists anywhere in the codebase today. `profiles` (`supabase/schema.sql`) has only
`user_id`/`hpht`/`name` (+ a dead legacy `trimester` column, untouched). No existing table fits a
"one point-in-time value per day" shape — water is cumulative-summed (`meals.water_ml`),
`vitamin_checks` is boolean. Trend charts are hand-rolled inline `<svg>` blocks (no charting
library is installed) — two parallel examples already exist (floor-type nutrient trend, ceiling-type
limit trend, both in `app/dashboard/page.js`), each computed from its own geometry block; a weight
trend needs a third such block (single series, absolute kg, not a %-of-target line).

## Decisions from clarifying questions
1. **Placement**: Dashboard (matches the existing per-day-metric precedent — water, meals,
   vitamin checklist — not Profile's "rarely changes" framing).
2. **Gain guidance**: full IOM-2009 BMI-category-based range, not just a bare log+trend. Requires
   capturing pre-pregnancy weight + height (on the **Profile** page, alongside HPHT — the natural
   "set once, rarely changes" home for these two new fields).
3. **Unit**: kg only.
4. **Log granularity**: one entry per calendar date, upsert (re-logging the same day overwrites —
   same shape as `vitamin_checks`).
5. **Reminder**: yes — a weekly nudge (no weigh-in logged in the last 7 days) added to the
   **morning** push slot.

## Proposed change

### 1. `supabase/schema.sql` — new table + 2 new profile columns
```sql
alter table public.profiles add column if not exists pre_pregnancy_weight_kg numeric;
alter table public.profiles add column if not exists height_cm numeric;

create table if not exists public.weight_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date date not null,
  weight_kg numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists weight_logs_user_date_idx on public.weight_logs (user_id, date);
alter table public.weight_logs enable row level security;
create policy "weight_logs: owner select" on public.weight_logs for select using (auth.uid() = user_id);
create policy "weight_logs: owner insert" on public.weight_logs for insert with check (auth.uid() = user_id);
create policy "weight_logs: owner update" on public.weight_logs for update using (auth.uid() = user_id);
create policy "weight_logs: owner delete" on public.weight_logs for delete using (auth.uid() = user_id);
```
Both new profile columns are nullable — the range/BMI feature simply doesn't render until both are
filled in (graceful degradation, no forced onboarding step). `unique (user_id, date)` is what makes
"log again today" an upsert (`onConflict: "user_id,date"`) rather than a second row, mirroring
`vitamin_checks`' own `unique (user_id, date, vitamin_id)`. Index mirrors `meals_user_date_idx`
(same `(user_id, date)` shape, same query pattern: single-user all-dates on the Dashboard,
multi-user date-range on the cron route).

### 2. `lib/weight.js` (new file) — pure BMI/IOM-range helpers
Same "computed, not stored" convention as `lib/pregnancy.js`/`lib/nutrition.js`. No component or
network code — fully unit-testable.
- `computeBMI(weightKg, heightCm)` → `weightKg / (heightCm/100)²`, or `null` if either is
  missing/non-positive.
- `BMI_CATEGORIES` (ordered thresholds) + `bmiCategory(bmi)` → `"underweight"` (`<18.5`) |
  `"normal"` (`18.5–24.9`) | `"overweight"` (`25–29.9`) | `"obese"` (`≥30`) | `null`.
- `BMI_CATEGORY_META` — Indonesian label + color per category (`Kurus`, `Normal`, `Gemuk`,
  `Obesitas`), same `{label, color}` shape `NUTRIENT_META`/`LIMIT_META` already use.
- `TOTAL_GAIN_RANGE_KG` (IOM 2009, singleton pregnancy) — `{ underweight: [12.5,18], normal:
  [11.5,16], overweight: [7,11.5], obese: [5,9] }`.
- `WEEKLY_GAIN_RATE_KG_T2T3` (IOM 2009, per-week rate for weeks 14–40) — `{ underweight:
  [0.44,0.58], normal: [0.35,0.5], overweight: [0.23,0.33], obese: [0.17,0.27] }`. Trimester 1 uses
  one flat category-independent allowance, `T1_GAIN_RANGE_KG = [0.5, 2]`, reached by week 13.
- `expectedGainRangeAtWeek(category, weeks)` → `{ minKg, maxKg }` or `null` (unknown category):
  - `weeks <= 13`: linear interpolation from `[0,0]` at week 0 to `T1_GAIN_RANGE_KG` at week 13
    (`min/max × weeks/13`).
  - `weeks > 13`: `T1_GAIN_RANGE_KG` (full) + `(weeks-13) × WEEKLY_GAIN_RATE_KG_T2T3[category]`.
- `gainStatusForWeek(actualGainKg, expectedRange)` → `"below"` | `"within"` | `"above"` | `null`
  (`expectedRange` null → null). Own 3-way status (not reusing `STATUS_TIERS`/`LIMIT_STATUS_TIERS`
  — neither's "single threshold from one direction" shape fits a two-sided band).
- `GAIN_STATUS_META` — `within` → sage/green ("Sesuai target"), `below` → accent/amber ("Di bawah
  target"), `above` → rose/red ("Di atas target") — cosmetic 3-way color map for the badge.

### 3. `app/dashboard/profile/page.js` — pre-pregnancy weight + height inputs
New panel (same structural style as the existing "Usia kehamilan" panel): two number inputs
(kg, cm), a save button upserting `profiles.pre_pregnancy_weight_kg`/`height_cm` (same
`supabase.from("profiles").upsert({user_id, ...}, {onConflict:"user_id"})` pattern `saveHpht`/
`saveName` already use). Once both are set, shows the computed BMI + category inline as immediate
feedback (`computeBMI`/`bmiCategory`/`BMI_CATEGORY_META` from `lib/weight.js`) — no page reload
needed to see it take effect elsewhere.

### 4. `app/dashboard/page.js` — the weight-tracker panel(s)
- Bootstrap: fetch `weight_logs` for the signed-in user alongside `meals`/`vitamins` (same
  `useEffect`, same `.eq("user_id", u.id)` pattern); `profiles` already `select("*")`s, so the two
  new columns arrive for free.
- New derived state: `weightByDate` (map keyed by date, one row each — no summing needed, unlike
  `groupMealsByDay`), `datesWithWeight`, `todaysWeight = weightByDate[currentDate]`,
  `bmi`/`bmiCat` (from profile fields), `gestationalWeekForDate(date)` (via
  `computeGestationalAge`/`hpht`, already imported), `expectedRangeToday`/`gainStatusToday` (via
  `lib/weight.js`, only computed when `hpht` + both profile fields are set).
- New panel "Berat badan — {currentDate}": a single kg number input + save button (upsert on
  `(user_id, date)`) — no quick-add buttons (unlike water; a weight entry is an absolute value, not
  additive). Shows today's value if already logged, a "Hapus" (`ConfirmButton`, same as other rows)
  to delete it, and — when computable — the BMI category, target total-gain range, and a
  `gainStatusToday` badge ("Sesuai/Di bawah/Di atas target" + the actual vs. expected-so-far
  numbers). When pre-pregnancy weight/height aren't set yet, a `format-hint`-style prompt links to
  `/dashboard/profile` instead of silently omitting the feature.
- Small manual date-entry row (mirrors the meal form's date input) so a past day can be
  backfilled/corrected, not just today.
- New "Tren berat badan" panel: a third hand-rolled SVG trend block (own geometry, following the
  existing two blocks' exact style — inline `<svg>`, `padL/padR/padT/padB`, `xPos`/`yPos` closures)
  plotting raw kg (not a %) per `datesWithWeight` entry as one polyline, plus — when a BMI category
  is known — a shaded/dashed expected-range band (`prePregWeight + expectedGainRangeAtWeek(...)`
  per date's own gestational week) rendered as two additional dashed polylines (min/max), so
  "am I on track" is answerable at a glance, not just for today.
- Small addition to the page's existing bottom disclaimer paragraph: the gain range is general IOM
  guidance, not personalized medical advice (same framing already used for nutrient targets/limits).

### 5. `lib/reminderLogic.js` + `app/api/cron/reminders/route.js` — weekly nudge
- `buildMorningBody({ name, nudge, weightNudge })` — new optional param, space-appended after the
  existing nudge (same pattern as the prior session's `limitWarning` on `buildReminderBody`).
  `weightNudge` is a fixed friendly line built by a new `WEIGHT_NUDGE_TEXT` constant (not a Gemini
  call — this is a static, deterministic check, not a generative fact/affirmation): "📏 Belum catat
  berat badan 7 hari terakhir — yuk timbang & catat di Dashboard."
- `app/api/cron/reminders/route.js`: only inside `kind === "morning"`, fetch `weight_logs.user_id`
  for `date >= addDays(today, -6)` (7-day inclusive window, `addDays` from `lib/pregnancy.js`,
  already used elsewhere in this file's trimester/weeks computation) across `userIds`; a user NOT
  in that result set gets `weightNudge: WEIGHT_NUDGE_TEXT` passed into `buildMorningBody`. Scoped to
  the morning branch only — the other 3 slots pay nothing extra, same "only query what a slot's
  content needs" discipline already used for the dinner slot's meal/vitamin/limit queries.

## Scope
### In scope
- `supabase/schema.sql` — `weight_logs` table + 2 new `profiles` columns.
- `lib/weight.js` (new) — BMI/IOM-range pure helpers.
- `app/dashboard/profile/page.js` — pre-pregnancy weight/height inputs + BMI feedback.
- `app/dashboard/page.js` — weight-log panel, manual date-entry, trend panel, disclaimer update.
- `lib/reminderLogic.js` — `buildMorningBody`'s new `weightNudge` param + `WEIGHT_NUDGE_TEXT`.
- `app/api/cron/reminders/route.js` — morning-slot 7-day weigh-in check.
- New `lib/weight.test.js`; extended `lib/reminderLogic.test.js`.

### Out of scope / non-goals
- CSV import/export for weight (no existing precedent argues for it — water has none either).
- Editing the legacy unused `profiles.trimester` column.
- Any change to the lunch/dinner/night push slots.
- A day-of-week-specific ("every Monday") nudge — the 7-day-lookback check is date-window-based
  and self-corrects regardless of which day a user actually logs on.
- Non-singleton-pregnancy IOM guidance (twins/multiples have different gain ranges) — this app has
  no multiples flag anywhere; the singleton table is used unconditionally, same "general guidance"
  caveat as elsewhere.

## Steps
1. `supabase/schema.sql` — add the table + 2 columns.
2. `lib/weight.js` — BMI/category/range/status helpers.
3. `app/dashboard/profile/page.js` — pre-pregnancy weight/height panel.
4. `app/dashboard/page.js` — weight panel + manual entry + trend panel + disclaimer line.
5. `lib/reminderLogic.js` — `buildMorningBody`'s `weightNudge` param.
6. `app/api/cron/reminders/route.js` — morning-slot weigh-in-window query + trigger.
7. Tests (see below), run, fix, commit per finished step.

## Data / schema impact
One new table (`weight_logs`, RLS-enabled, owner-only policies, `unique(user_id,date)` + a
`(user_id,date)` index) + 2 new nullable `profiles` columns — additive, non-breaking, no backfill
(brand-new data, nothing to migrate).

## Risks & mitigations
- **BMI/range feature silently missing for users without pre-pregnancy weight/height** — mitigated
  by an explicit `format-hint`-style prompt linking to Profile, rather than just hiding the section
  with no explanation.
- **A third hand-rolled SVG trend block growing this file further** — mitigated by following the
  exact existing geometry-block pattern (already proven twice), not inventing a new charting
  approach; still a deliberate non-goal to refactor the three into one shared component (separate,
  larger risk not worth taking in this run).
- **7-day-window query added to the morning slot** — bounded to `kind === "morning"` only (mirrors
  the dinner slot's own scoping discipline), so the other 3 slots' cost is unchanged.
- **IOM ranges are singleton-pregnancy-only** — explicitly called out as a non-goal/disclaimer
  rather than silently wrong for a twin pregnancy.

## Test plan
- `lib/weight.test.js`:
  - `computeBMI`: normal case; `null` for missing/zero/negative weight or height.
  - `bmiCategory`: boundary values at 18.5, 25, 30 (each boundary belongs to the *higher* category,
    matching the `<`/`≤` convention used by `lib/nutrition.js`'s `STATUS_TIERS`); `null` for a null
    BMI.
  - `expectedGainRangeAtWeek`: week 0 → `[0,0]`; week 13 → exactly `T1_GAIN_RANGE_KG`; a T2/T3 week
    (e.g. 20) → `T1_GAIN_RANGE_KG + 7×rate`; `null` category → `null`.
  - `gainStatusForWeek`: below/within/above at the range's own boundaries; `null` range → `null`.
- `lib/reminderLogic.test.js`:
  - `buildMorningBody` with `weightNudge` set → appended after the nudge; omitted/empty → unchanged
    from current behavior (regression guard).
- Run via `npx vitest run` (this repo's existing script), capture real output, fix any failures
  within this plan's scope before considering the run done.

## Standards notes
No `kredivo-docs` areas touched — app-level feature work (Next.js/Supabase, no GCP/WIF, no SSO, no
Terraform/IaC, no Dockerfile/compose).
