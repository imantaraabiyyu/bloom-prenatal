// Shared nutrition constants + tiny CSV parser used by the dashboard.

// dha_mg/vitamin_k_mcg targets follow general prenatal guidance (~200mg/day
// DHA per WHO/international recommendations; 90mcg/day vitamin K per the US
// NIH ODS adult-female adequate intake) — flat across trimesters, same as
// every other nutrient here except calories.
export const TARGETS = {
  t1: { calories: 1800, protein_g: 71, iron_mg: 27, calcium_mg: 1000, folate_mcg: 600, vitamin_d_mcg: 15, fiber_g: 28, water_ml: 2300, dha_mg: 200, vitamin_k_mcg: 90 },
  t2: { calories: 2200, protein_g: 71, iron_mg: 27, calcium_mg: 1000, folate_mcg: 600, vitamin_d_mcg: 15, fiber_g: 28, water_ml: 2300, dha_mg: 200, vitamin_k_mcg: 90 },
  t3: { calories: 2400, protein_g: 71, iron_mg: 27, calcium_mg: 1000, folate_mcg: 600, vitamin_d_mcg: 15, fiber_g: 28, water_ml: 2300, dha_mg: 200, vitamin_k_mcg: 90 },
};

export const NUTRIENT_META = {
  calories: { label: "Kalori", unit: "kkal", color: "#E3B65E" },
  protein_g: { label: "Protein", unit: "g", color: "#C97B63" },
  iron_mg: { label: "Zat besi", unit: "mg", color: "#9C6ADE" },
  calcium_mg: { label: "Kalsium", unit: "mg", color: "#7FA9C7" },
  folate_mcg: { label: "Folat", unit: "mcg", color: "#8FAE8B" },
  vitamin_d_mcg: { label: "Vitamin D", unit: "mcg", color: "#E0956B" },
  fiber_g: { label: "Serat", unit: "g", color: "#B98BC9" },
  water_ml: { label: "Cairan", unit: "ml", color: "#6FB8C4" },
  dha_mg: { label: "DHA", unit: "mg", color: "#C48B6B" },
  vitamin_k_mcg: { label: "Vitamin K", unit: "mcg", color: "#5C8A6E" },
};

export const NUTRIENT_ORDER = [
  "calories", "protein_g", "iron_mg", "calcium_mg",
  "folate_mcg", "vitamin_d_mcg", "fiber_g", "water_ml",
  "dha_mg", "vitamin_k_mcg",
];

// Shared 3-tier status vocabulary ("Tercukupi/Hampir/Kurang") — used for the
// daily average pill, the history table, and each nutrient ring, so the same
// color always means the same thing everywhere in the app.
export const STATUS_TIERS = [
  { min: 85, key: "good", label: "Tercukupi", color: "#8FAE8B" },
  { min: 60, key: "mid", label: "Hampir", color: "#E3B65E" },
  { min: 0, key: "low", label: "Kurang", color: "#C77B7B" },
];

export function statusForPct(pct) {
  return STATUS_TIERS.find((t) => pct >= t.min) || STATUS_TIERS[STATUS_TIERS.length - 1];
}

// ---------------- "batas harian" (daily-limit / ceiling-type) nutrients ----------------
// Everything above (NUTRIENT_ORDER/TARGETS/STATUS_TIERS) is floor-type: more is
// better, up to 100% of a per-trimester target. Sugar/sodium/cholesterol/
// saturated fat/caffeine are the opposite shape — a daily UPPER limit you do
// NOT want to exceed — so they get their own parallel list/targets/status
// vocabulary rather than being folded into NUTRIENT_ORDER, which would make
// "120% of your sugar limit" look like a *good* ring/trend value the way
// "120% of your protein target" already does. Kept deliberately out of
// computeActiveNutrients/TARGETS-based rings/trend/history-average — see
// ALL_TRACKED_NUTRIENTS below for the one place these two lists *do* combine.
export const LIMIT_ORDER = ["sugar_g", "sodium_mg", "cholesterol_mg", "saturated_fat_g", "caffeine_mg"];

export const LIMIT_META = {
  sugar_g: { label: "Gula", unit: "g", color: "#C77B7B" },
  sodium_mg: { label: "Natrium", unit: "mg", color: "#9C6ADE" },
  cholesterol_mg: { label: "Kolesterol", unit: "mg", color: "#E0956B" },
  saturated_fat_g: { label: "Lemak jenuh", unit: "g", color: "#B98BC9" },
  caffeine_mg: { label: "Kafein", unit: "mg", color: "#7FA9C7" },
};

// General adult/pregnancy guidance, flat (no per-trimester split, same as
// every TARGETS entry except calories) — general guidance, not personal
// medical advice, same caveat as the app's existing nutrition disclaimer:
// - sugar_g: 25g/day added sugar (AHA recommendation for women)
// - sodium_mg: 2300mg/day (US/WHO general adult upper limit)
// - cholesterol_mg: 300mg/day (older, still commonly-cited general-population
//   advisory ceiling — modern US/WHO guidance dropped a strict numeric cap, so
//   this is a soft advisory number, not a hard medical limit)
// - saturated_fat_g: 20g/day (UK NHS general guidance for women)
// - caffeine_mg: 200mg/day (ACOG/WHO pregnancy-specific guidance)
export const LIMITS = {
  sugar_g: 25,
  sodium_mg: 2300,
  cholesterol_mg: 300,
  saturated_fat_g: 20,
  caffeine_mg: 200,
};

// Ceiling-type mirror of STATUS_TIERS/statusForPct above — "less is safer",
// so the tiers read the opposite direction (low % = good).
export const LIMIT_STATUS_TIERS = [
  { max: 70, key: "safe", label: "Aman", color: "#8FAE8B" },
  { max: 100, key: "near", label: "Mendekati batas", color: "#E3B65E" },
  { max: Infinity, key: "over", label: "Melebihi batas", color: "#C77B7B" },
];

export function limitStatusForPct(pct) {
  return LIMIT_STATUS_TIERS.find((t) => pct <= t.max) || LIMIT_STATUS_TIERS[LIMIT_STATUS_TIERS.length - 1];
}

// Picks the right status-tier direction for a nutrient's CURRENT goal type
// (see resolveEffectiveGoals below) — "max" (a limit, less is safer) reads
// limitStatusForPct, anything else ("min", the floor-type default) reads
// statusForPct. Needed once a nutrient's direction is per-user/editable
// (e.g. a user flipping protein_g to a max-type goal) rather than fixed by
// NUTRIENT_ORDER/LIMIT_ORDER membership — every render site that used to
// pick statusForPct vs limitStatusForPct by "which hardcoded list is this
// key in" now asks the user's own current goal_type instead.
export function statusForGoal(pct, goalType) {
  return goalType === "max" ? limitStatusForPct(pct) : statusForPct(pct);
}

// Given a `{ [key]: number }` totals object (same shape dayLimitTotals/
// groupLimitTotalsByUser below produce) and an `effectiveGoals` map (see
// resolveEffectiveGoals below), returns the display label of every
// max-type goal strictly exceeded — single source of truth shared by the
// dashboard's warning banner (app/dashboard/page.js) and the dinner-reminder
// trigger/message (lib/reminderLogic.js, app/api/cron/reminders/route.js) so
// "what counts as exceeded" can't drift between the two.
//
// Replaces the old exceededLimitLabels(totals), which hardcoded LIMIT_ORDER/
// LIMITS directly -- now that a nutrient's min/max direction (and its target
// value) is per-user (see resolveEffectiveGoals), "which keys count as a
// limit at all" can no longer be a fixed list either.
export function exceededGoalLabels(totals, effectiveGoals) {
  return Object.entries(effectiveGoals || {})
    .filter(([key, goal]) => goal.goalType === "max" && (totals?.[key] || 0) > goal.targetValue)
    .map(([, goal]) => goal.label);
}

// LIMIT_ORDER mirror of computeActiveNutrients below — only nutrients with a
// nonzero value in at least one row are worth showing.
export function computeActiveLimitNutrients(rows) {
  const present = {};
  rows.forEach((r) => LIMIT_ORDER.forEach((n) => { if (r[n] != null) present[n] = true; }));
  return LIMIT_ORDER.filter((n) => present[n]);
}

// Sums `keys` fields across arbitrary rows (already filtered to one target
// date), grouped by user_id -- multi-user variant used server-side by
// app/api/cron/reminders/route.js's dinner slot (meals rows + the vitamins
// rows of every checked vitamin_check that day both get summed this way,
// then combined with mergeUserTotals below), since that route processes
// every subscriber in one batch rather than one signed-in user at a time
// like the dashboard's own dayLimitTotals does.
//
// `keys` defaults to LIMIT_ORDER (this function's original, only key list,
// from before per-user goal direction existed) so every existing 2-arg call
// site keeps its exact current behavior unchanged. Callers that now need to
// know about every ALL_TRACKED_NUTRIENTS column (since which of them count
// as a "limit" is per-user, see resolveEffectiveGoals) pass that explicitly.
export function groupLimitTotalsByUser(rows, keys = LIMIT_ORDER) {
  const byUser = {};
  (rows || []).forEach((r) => {
    const uid = r.user_id;
    if (!uid) return;
    if (!byUser[uid]) { byUser[uid] = {}; keys.forEach((k) => { byUser[uid][k] = 0; }); }
    keys.forEach((k) => { if (r[k] != null) byUser[uid][k] += Number(r[k]) || 0; });
  });
  return byUser;
}

// Adds two `{ [userId]: { [key]: number } }` maps together per-user, per-
// nutrient — e.g. combining groupLimitTotalsByUser's meals-rows result with
// its checked-vitamins-rows result into one running total per user. Same
// `keys` default/override as groupLimitTotalsByUser above -- pass the same
// `keys` to both when overriding, so every key initializes to 0 in each map
// being merged.
export function mergeUserTotals(a, b, keys = LIMIT_ORDER) {
  const out = {};
  [a, b].forEach((totals) => {
    Object.entries(totals || {}).forEach(([uid, vals]) => {
      if (!out[uid]) { out[uid] = {}; keys.forEach((k) => { out[uid][k] = 0; }); }
      keys.forEach((k) => { out[uid][k] += vals?.[k] || 0; });
    });
  });
  return out;
}

// The full set of DB-persisted nutrient columns (floor + ceiling type) —
// used ONLY at "build/persist a full meals/vitamins row" call sites (the
// Gemini schema, vitaminItemToRow, manual add-meal/add-vitamin forms, CSV
// upload, chat-page save-to-dashboard) so the 5 LIMIT_ORDER fields don't get
// silently dropped there. Every floor-type-only call site (rings, the
// existing trend chart, history-table average, TARGETS-based %) stays keyed
// to NUTRIENT_ORDER alone, unchanged — mixing a floor-% and a ceiling-% into
// the same average/ring would be misleading (see LIMIT_ORDER's own comment).
export const ALL_TRACKED_NUTRIENTS = [...NUTRIENT_ORDER, ...LIMIT_ORDER];

// Combined label/unit/color lookup for ALL_TRACKED_NUTRIENTS — NUTRIENT_ORDER
// and LIMIT_ORDER keys never overlap, so this is a safe merge. Lets a detail-
// text builder that now iterates both lists (e.g. a meal/vitamin's "Kalori
// 380kkal · Gula 12g" line) look up any of them the same way, without an
// if/else between NUTRIENT_META and LIMIT_META at every call site.
export const ALL_TRACKED_META = { ...NUTRIENT_META, ...LIMIT_META };

// ---------------- per-user nutrient goals (targets/limits) ----------------
// TARGETS/LIMITS above are the app's global DEFAULTS, same for every user.
// `nutrient_goals` (supabase/schema.sql) lets a user override, per nutrient,
// BOTH the goal direction ("min" = reach at least, "max" = avoid exceeding)
// and the target value itself — for any of the 15 ALL_TRACKED_NUTRIENTS keys
// AND for any custom slug they've logged via extra_nutrients (e.g. a food
// label's "Laktosa"). resolveEffectiveGoals below is the one seam every
// consumer (Dashboard, the Gemini chat route, the cron reminder route) reads
// through instead of TARGETS/LIMITS directly, so "does this user have an
// override" only has to be answered in one place.

// Turns a user's raw `nutrient_goals` rows (possibly none at all) into a
// `{ [key]: { label, unit, goalType, targetValue, isCustom } }` map covering
// every ALL_TRACKED_NUTRIENTS key (falling back to today's global default +
// its historical direction when no override row exists for that key) PLUS
// any row whose key isn't one of the 15 fixed ones (a custom nutrient,
// `isCustom: true`). `trimester`: "t1"|"t2"|"t3" — only used for the
// fallback TARGETS lookup on an unconfigured floor-type key; an already-
// configured row's own stored value is used as-is regardless of trimester
// (see the seeding trade-off note in docs/improver/
// custom-nutrient-targets-improvement-plan.md's Risks section).
export function resolveEffectiveGoals(goalRows, trimester) {
  const byKey = new Map((goalRows || []).map((g) => [g.nutrient_key, g]));
  const effective = {};
  ALL_TRACKED_NUTRIENTS.forEach((key) => {
    const row = byKey.get(key);
    if (row) {
      effective[key] = {
        label: row.label, unit: row.unit, goalType: row.goal_type,
        targetValue: Number(row.target_value), isCustom: false,
      };
    } else {
      const isLimit = LIMIT_ORDER.includes(key);
      effective[key] = {
        label: ALL_TRACKED_META[key].label,
        unit: ALL_TRACKED_META[key].unit,
        goalType: isLimit ? "max" : "min",
        targetValue: isLimit ? LIMITS[key] : TARGETS[trimester]?.[key],
        isCustom: false,
      };
    }
  });
  (goalRows || []).forEach((row) => {
    if (!ALL_TRACKED_NUTRIENTS.includes(row.nutrient_key)) {
      effective[row.nutrient_key] = {
        label: row.label, unit: row.unit, goalType: row.goal_type,
        targetValue: Number(row.target_value), isCustom: true,
      };
    }
  });
  return effective;
}

// Presence check spanning ALL_TRACKED_NUTRIENTS (both floor- and ceiling-
// type keys together) — replaces the Dashboard's old separate calls to
// computeActiveNutrients (NUTRIENT_ORDER only) + computeActiveLimitNutrients
// (LIMIT_ORDER only), since which of the 15 keys render as a ring vs a
// "batas harian" bar is now decided per-user by resolveEffectiveGoals'
// goalType, not by which of the two fixed lists a key originally belonged
// to. computeActiveNutrients/computeActiveLimitNutrients are left as-is
// (still exported/tested) for anything else that still wants the old,
// direction-fixed split.
export function computeActiveTrackedNutrients(rows) {
  const present = {};
  rows.forEach((r) => ALL_TRACKED_NUTRIENTS.forEach((n) => { if (r[n] != null) present[n] = true; }));
  return ALL_TRACKED_NUTRIENTS.filter((n) => present[n]);
}

// Scans a user's own `meals`/`vitamins` rows (their full history, not just
// one day — unlike mergeExtraNutrients below, which is a per-day total) and
// returns every distinct custom extra_nutrients slug they've ever logged, as
// `[{slug, label, unit}]` sorted by label. Used by the Profile page's
// "Konfigurasi nutrisi" section to offer previously-logged custom nutrients
// (e.g. "Laktosa") as goal add-candidates. Last-seen label/unit wins per
// slug — same precedent as buildExtraNutrientsMap's own "duplicate labels
// collapse to the last one" behavior.
export function collectKnownExtraNutrientSlugs(rows) {
  const bySlug = new Map();
  (rows || []).forEach((row) => {
    Object.entries(row?.extra_nutrients || {}).forEach(([slug, info]) => {
      if (!info?.label) return;
      bySlug.set(slug, { slug, label: info.label, unit: info.unit || "" });
    });
  });
  return [...bySlug.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// Shared by both alias maps below — the 5 LIMIT_ORDER ("batas harian")
// columns, English + Indonesian spellings, same convention as the
// floor-type aliases above them.
const LIMIT_ALIASES = {
  sugar: "sugar_g", sugar_g: "sugar_g", gula: "sugar_g",
  sodium: "sodium_mg", sodium_mg: "sodium_mg", natrium: "sodium_mg",
  cholesterol: "cholesterol_mg", cholesterol_mg: "cholesterol_mg", kolesterol: "cholesterol_mg",
  saturated_fat: "saturated_fat_g", saturated_fat_g: "saturated_fat_g", lemak_jenuh: "saturated_fat_g",
  caffeine: "caffeine_mg", caffeine_mg: "caffeine_mg", kafein: "caffeine_mg",
};

const MEAL_ALIASES = {
  date: "date", day: "date", meal: "meal", food: "meal", item: "meal", food_item: "meal",
  calories: "calories", kcal: "calories", energy_kcal: "calories", energy: "calories",
  protein: "protein_g", protein_g: "protein_g", iron: "iron_mg", iron_mg: "iron_mg",
  calcium: "calcium_mg", calcium_mg: "calcium_mg", folate: "folate_mcg", folic_acid: "folate_mcg",
  folate_mcg: "folate_mcg", folic_acid_mcg: "folate_mcg", vitamin_d: "vitamin_d_mcg",
  vitamin_d_mcg: "vitamin_d_mcg", vitamind: "vitamin_d_mcg", fiber: "fiber_g", fibre: "fiber_g",
  fiber_g: "fiber_g", water: "water_ml", water_ml: "water_ml", fluid_ml: "water_ml", fluids_ml: "water_ml",
  dha: "dha_mg", dha_mg: "dha_mg", vitamin_k: "vitamin_k_mcg", vitamin_k_mcg: "vitamin_k_mcg", vitk: "vitamin_k_mcg", vit_k: "vitamin_k_mcg",
  ...LIMIT_ALIASES,
};

const VIT_ALIASES = {
  name: "name", vitamin: "name", supplement: "name", product: "name",
  calories: "calories", kcal: "calories", protein: "protein_g", protein_g: "protein_g",
  iron: "iron_mg", iron_mg: "iron_mg", calcium: "calcium_mg", calcium_mg: "calcium_mg",
  folate: "folate_mcg", folic_acid: "folate_mcg", folate_mcg: "folate_mcg", folic_acid_mcg: "folate_mcg",
  vitamin_d: "vitamin_d_mcg", vitamin_d_mcg: "vitamin_d_mcg", vitamind: "vitamin_d_mcg",
  fiber: "fiber_g", fibre: "fiber_g", fiber_g: "fiber_g", water: "water_ml", water_ml: "water_ml",
  dha: "dha_mg", dha_mg: "dha_mg", vitamin_k: "vitamin_k_mcg", vitamin_k_mcg: "vitamin_k_mcg", vitk: "vitamin_k_mcg", vit_k: "vitamin_k_mcg",
  ...LIMIT_ALIASES,
};

export const SAMPLE_MEAL_CSV =
  "date,meal,calories,protein_g,iron_mg,calcium_mg,folate_mcg,vitamin_d_mcg,fiber_g,water_ml,dha_mg,vitamin_k_mcg,sugar_g,sodium_mg,cholesterol_mg,saturated_fat_g,caffeine_mg\n" +
  "2026-08-14,Bubur ayam dan telur rebus,380,18,2.0,90,60,1.0,3,300,50,5,2,620,180,3,0\n" +
  "2026-08-14,Ikan bakar dengan nasi dan bayam,610,34,3.1,220,110,2.5,5,350,600,140,1,540,70,2,0\n" +
  "2026-08-14,Susu dan buah pisang,260,9,0.4,220,15,1.0,2,250,0,3,18,90,10,2,0\n" +
  "2026-08-15,Nasi uduk dengan tempe orek,480,16,2.4,80,70,0.2,4,300,0,8,3,710,20,4,0\n" +
  "2026-08-15,Sup ayam dan sayur,420,26,2.8,90,90,0.3,5,400,15,35,4,580,60,1.5,0\n" +
  "2026-08-15,Yogurt dan kacang almond,240,12,0.6,200,20,0.2,2,150,0,2,15,60,5,1,0\n";

export const SAMPLE_VIT_CSV =
  "name,folate_mcg,iron_mg,calcium_mg,vitamin_d_mcg,dha_mg,vitamin_k_mcg,sugar_g,sodium_mg,cholesterol_mg,saturated_fat_g,caffeine_mg\n" +
  "Folamil Genio,1000,30,40,10,200,0,0,0,0,0,0\n" +
  "Cavit D3,0,0,500,3.3,0,0,0,60,0,0,0\n";

// Default catalog seeded for a brand-new account. DHA/vitamin K values are
// approximate label figures (same caveat as the rest of this catalog — see
// README) — Folamil Genio is widely labeled as containing ~200mg DHA per
// serving; Cavit D3 is a plain calcium+D3 supplement with neither. The 5
// LIMIT_ORDER fields default to 0 for both — neither is an effervescent/
// chewable formulation with meaningful sugar/sodium, and no attempt is made
// to backfill real historical composition for the other floor-type fields
// either (same precedent as when dha_mg/vitamin_k_mcg were added).
export const DEFAULT_VITAMINS = [
  { name: "Folamil Genio", calories: 0, protein_g: 0, iron_mg: 30, calcium_mg: 40, folate_mcg: 1000, vitamin_d_mcg: 10, fiber_g: 0, water_ml: 0, dha_mg: 200, vitamin_k_mcg: 0, sugar_g: 0, sodium_mg: 0, cholesterol_mg: 0, saturated_fat_g: 0, caffeine_mg: 0 },
  { name: "Cavit D3", calories: 0, protein_g: 0, iron_mg: 0, calcium_mg: 500, folate_mcg: 0, vitamin_d_mcg: 3.3, fiber_g: 0, water_ml: 0, dha_mg: 0, vitamin_k_mcg: 0, sugar_g: 0, sodium_mg: 0, cholesterol_mg: 0, saturated_fat_g: 0, caffeine_mg: 0 },
];

function splitCsvLine(line) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseGenericCsv(text, aliasMap, requiredKey) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const out = {};
    for (let j = 0; j < headers.length; j++) {
      const canon = aliasMap[headers[j]];
      if (!canon) continue;
      const raw = (cells[j] || "").trim();
      if (canon === "date" || canon === "meal" || canon === "name") {
        if (raw) out[canon] = raw;
      } else {
        const v = parseFloat(raw);
        if (!isNaN(v)) out[canon] = (out[canon] || 0) + v;
      }
    }
    if (out[requiredKey]) rows.push(out);
  }
  return rows;
}

export function parseMealCsv(text) { return parseGenericCsv(text, MEAL_ALIASES, "date"); }
export function parseVitaminCsv(text) { return parseGenericCsv(text, VIT_ALIASES, "name"); }

export function computeActiveNutrients(rows) {
  const present = {};
  rows.forEach((r) => NUTRIENT_ORDER.forEach((n) => { if (r[n] != null) present[n] = true; }));
  return NUTRIENT_ORDER.filter((n) => present[n]);
}

// ---------------- custom ("additional") nutrients ----------------
// For a nutrient a vitamin/supplement label has that isn't in NUTRIENT_ORDER
// (e.g. Zinc, Vitamin B6, Iodium) — stored per-row as a free-form
// `extra_nutrients` jsonb column: { [slug]: { label, unit, value } }. There's
// no AKG/target reference for arbitrary entries, so these are informational
// only — no ring, no % complete, just a running daily total.

// Normalizes a user-typed label into a stable key so "Zinc" and "zinc" (or
// re-entering the same nutrient on a different vitamin) aggregate together,
// while the original label is kept for display.
export function slugifyNutrientLabel(label) {
  return (label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Converts a list of free-form {label, unit, value} rows (the shape both the
// manual "Tambah vitamin" form's "nutrisi lain" rows and a Gemini-detected
// vitamin item's extra_nutrients share) into the `{ [slug]: {label, unit,
// value} }` jsonb map the `vitamins` table stores. `value` may arrive as a
// raw form-input string or an already-numeric value — parseFloat handles
// both. Incomplete rows (no label, or a value that isn't a number) are
// silently dropped, not saved as zero. Duplicate labels (same slug) collapse
// to the last one — same behavior as before this was extracted.
export function buildExtraNutrientsMap(rows) {
  const map = {};
  (rows || []).forEach((r) => {
    const label = (r?.label || "").trim();
    const value = parseFloat(r?.value);
    if (!label || isNaN(value)) return;
    const slug = slugifyNutrientLabel(label);
    if (!slug) return;
    map[slug] = { label, unit: (r?.unit || "").trim(), value };
  });
  return map;
}

// A Gemini-detected vitamin/supplement item (see lib/gemini.js's "vitamin"
// category) -> a row ready for `supabase.from("vitamins").insert(...)`,
// mirroring the row app/dashboard/page.js's manual "Tambah vitamin" form
// (handleAddVitamin) already builds by hand.
export function vitaminItemToRow(item, userId) {
  const row = { user_id: userId, name: (item?.name || "").trim() || "Vitamin" };
  ALL_TRACKED_NUTRIENTS.forEach((n) => { row[n] = Number(item?.[n]) || 0; });
  row.extra_nutrients = buildExtraNutrientsMap(item?.extra_nutrients);
  return row;
}

// Merges one row's extra_nutrients into a running `{ [slug]: {label, unit, value} }`
// total — used to sum custom nutrients across every checked vitamin for a day.
export function mergeExtraNutrients(totals, extra) {
  Object.values(extra || {}).forEach((entry) => {
    if (!entry?.label) return;
    const slug = slugifyNutrientLabel(entry.label);
    if (!slug) return;
    const value = Number(entry.value) || 0;
    if (!totals[slug]) totals[slug] = { label: entry.label, unit: entry.unit || "", value: 0 };
    totals[slug].value += value;
  });
  return totals;
}

// Builds a stable dedupe key for a meal row: same date + same meal name
// (trimmed, case-insensitive) counts as a duplicate.
function mealDedupeKey(r) {
  return `${(r.date || "").trim()}::${(r.meal || "").trim().toLowerCase()}`;
}

// Splits parsed meal rows into ones that are genuinely new vs. duplicates of
// rows already in `existingRows` (or of each other, within the same batch).
// Only the new rows should be inserted — duplicates are reported, not added.
export function dedupeMeals(existingRows, newRows) {
  const seen = new Set(existingRows.map(mealDedupeKey));
  const unique = [];
  let duplicateCount = 0;
  for (const r of newRows) {
    const key = mealDedupeKey(r);
    if (seen.has(key)) { duplicateCount++; continue; }
    seen.add(key);
    unique.push(r);
  }
  return { unique, duplicateCount };
}

// Sums both floor-type (NUTRIENT_ORDER) and ceiling-type (LIMIT_ORDER) fields
// per day -- dayTotals (app/dashboard/page.js) reads the former off this,
// dayLimitTotals reads the latter, both off the same cache instead of
// scanning `meals` twice.
export function groupMealsByDay(rows) {
  const byDay = {};
  rows.forEach((r) => {
    const key = r.date;
    if (!byDay[key]) byDay[key] = { date: key };
    ALL_TRACKED_NUTRIENTS.forEach((n) => { if (r[n] != null) byDay[key][n] = (byDay[key][n] || 0) + Number(r[n]); });
  });
  return byDay;
}

export function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Server-side equivalent of todayISO() — a serverless function has no
// "browser local timezone" to rely on (its host clock is UTC), so the
// WhatsApp webhook needs to ask explicitly for "today" in the user's
// timezone (defaults to WIB, since the app's copy/targets are Indonesia-
// focused) rather than getting UTC's date near the WIB midnight boundary.
export function todayISOInTimeZone(tz = "Asia/Jakarta") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
