// Shared nutrition constants + tiny CSV parser used by the dashboard.

export const TARGETS = {
  t1: { calories: 1800, protein_g: 71, iron_mg: 27, calcium_mg: 1000, folate_mcg: 600, vitamin_d_mcg: 15, fiber_g: 28, water_ml: 2300 },
  t2: { calories: 2200, protein_g: 71, iron_mg: 27, calcium_mg: 1000, folate_mcg: 600, vitamin_d_mcg: 15, fiber_g: 28, water_ml: 2300 },
  t3: { calories: 2400, protein_g: 71, iron_mg: 27, calcium_mg: 1000, folate_mcg: 600, vitamin_d_mcg: 15, fiber_g: 28, water_ml: 2300 },
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
};

export const NUTRIENT_ORDER = [
  "calories", "protein_g", "iron_mg", "calcium_mg",
  "folate_mcg", "vitamin_d_mcg", "fiber_g", "water_ml",
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

const MEAL_ALIASES = {
  date: "date", day: "date", meal: "meal", food: "meal", item: "meal", food_item: "meal",
  calories: "calories", kcal: "calories", energy_kcal: "calories", energy: "calories",
  protein: "protein_g", protein_g: "protein_g", iron: "iron_mg", iron_mg: "iron_mg",
  calcium: "calcium_mg", calcium_mg: "calcium_mg", folate: "folate_mcg", folic_acid: "folate_mcg",
  folate_mcg: "folate_mcg", folic_acid_mcg: "folate_mcg", vitamin_d: "vitamin_d_mcg",
  vitamin_d_mcg: "vitamin_d_mcg", vitamind: "vitamin_d_mcg", fiber: "fiber_g", fibre: "fiber_g",
  fiber_g: "fiber_g", water: "water_ml", water_ml: "water_ml", fluid_ml: "water_ml", fluids_ml: "water_ml",
};

const VIT_ALIASES = {
  name: "name", vitamin: "name", supplement: "name", product: "name",
  calories: "calories", kcal: "calories", protein: "protein_g", protein_g: "protein_g",
  iron: "iron_mg", iron_mg: "iron_mg", calcium: "calcium_mg", calcium_mg: "calcium_mg",
  folate: "folate_mcg", folic_acid: "folate_mcg", folate_mcg: "folate_mcg", folic_acid_mcg: "folate_mcg",
  vitamin_d: "vitamin_d_mcg", vitamin_d_mcg: "vitamin_d_mcg", vitamind: "vitamin_d_mcg",
  fiber: "fiber_g", fibre: "fiber_g", fiber_g: "fiber_g", water: "water_ml", water_ml: "water_ml",
};

export const SAMPLE_MEAL_CSV =
  "date,meal,calories,protein_g,iron_mg,calcium_mg,folate_mcg,vitamin_d_mcg,fiber_g,water_ml\n" +
  "2026-08-14,Bubur ayam dan telur rebus,380,18,2.0,90,60,1.0,3,300\n" +
  "2026-08-14,Ikan bakar dengan nasi dan bayam,610,34,3.1,220,110,2.5,5,350\n" +
  "2026-08-14,Susu dan buah pisang,260,9,0.4,220,15,1.0,2,250\n" +
  "2026-08-15,Nasi uduk dengan tempe orek,480,16,2.4,80,70,0.2,4,300\n" +
  "2026-08-15,Sup ayam dan sayur,420,26,2.8,90,90,0.3,5,400\n" +
  "2026-08-15,Yogurt dan kacang almond,240,12,0.6,200,20,0.2,2,150\n";

export const SAMPLE_VIT_CSV =
  "name,folate_mcg,iron_mg,calcium_mg,vitamin_d_mcg\n" +
  "Folamil Genio,1000,30,40,10\n" +
  "Cavit D3,0,0,500,3.3\n";

// Default catalog seeded for a brand-new account.
export const DEFAULT_VITAMINS = [
  { name: "Folamil Genio", calories: 0, protein_g: 0, iron_mg: 30, calcium_mg: 40, folate_mcg: 1000, vitamin_d_mcg: 10, fiber_g: 0, water_ml: 0 },
  { name: "Cavit D3", calories: 0, protein_g: 0, iron_mg: 0, calcium_mg: 500, folate_mcg: 0, vitamin_d_mcg: 3.3, fiber_g: 0, water_ml: 0 },
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

export function groupMealsByDay(rows) {
  const byDay = {};
  rows.forEach((r) => {
    const key = r.date;
    if (!byDay[key]) byDay[key] = { date: key };
    NUTRIENT_ORDER.forEach((n) => { if (r[n] != null) byDay[key][n] = (byDay[key][n] || 0) + Number(r[n]); });
  });
  return byDay;
}

export function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
