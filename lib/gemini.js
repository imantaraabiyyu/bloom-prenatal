import "server-only";
import { NUTRIENT_ORDER, NUTRIENT_META } from "@/lib/nutrition";

// Food-photo → nutrition-estimate call to the Gemini API (free tier), used
// only by app/api/nutrition-chat/route.js. Plain fetch, no SDK.

// Schema is built from NUTRIENT_ORDER (lib/nutrition.js) instead of listing
// the nutrient keys again here, so the meals table's nutrient columns and
// what Gemini is asked to return can't quietly drift apart.
function buildResponseSchema() {
  const properties = { is_food: { type: "BOOLEAN" }, meal: { type: "STRING" } };
  NUTRIENT_ORDER.forEach((n) => { properties[n] = { type: "NUMBER" }; });
  properties.note = { type: "STRING" };
  return { type: "OBJECT", properties, required: ["is_food", "meal", ...NUTRIENT_ORDER, "note"] };
}

// e.g. "calories (kkal), protein_g (g), ..." — built from NUTRIENT_META so
// the prompt can't drift from the schema (and from every other nutrient list
// in the app) whenever a nutrient is added or removed.
const NUTRIENT_LIST_FOR_PROMPT = NUTRIENT_ORDER
  .map((n) => `${n} (${NUTRIENT_META[n].unit}, "${NUTRIENT_META[n].label}")`)
  .join(", ");

const PROMPT = `Kamu adalah asisten gizi kehamilan yang membantu ibu hamil mencatat menu makan lewat foto.

Lihat foto ini. Kalau ini foto makanan atau minuman:
- Set is_food = true.
- Isi "meal" dengan nama menunya dalam Bahasa Indonesia (mis. "Nasi goreng dengan telur").
- Perkirakan kandungan gizi untuk PORSI YANG TERLIHAT di foto, untuk tiap field berikut (nama field, satuan,
  nama gizinya): ${NUTRIENT_LIST_FOR_PROMPT}. Isi 0 untuk yang jelas tidak relevan (mis. water_ml untuk
  makanan padat tanpa kuah). Gunakan angka realistis berdasarkan porsi lazim, jangan mengarang angka ekstrem.
- Isi "note" dengan SATU-DUA kalimat insight gizi singkat untuk ibu hamil terkait menu ini (mis. kandungan
  yang menonjol, atau saran pelengkap sederhana), dalam Bahasa Indonesia, nada hangat dan tidak menggurui.

Kalau foto ini BUKAN makanan/minuman (mis. orang, pemandangan, dokumen, dll): set is_food = false, "meal"
kosong, semua angka gizi 0, dan "note" berisi permintaan maaf singkat kalau tidak bisa mengenali menu ini.

Jawab HANYA dalam JSON sesuai skema yang diberikan.`;

function toSafeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function analyzeFoodImage(base64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: buildResponseSchema() },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini tidak mengembalikan hasil apa pun.");

  const parsed = JSON.parse(text); // let a malformed response throw — caller replies gracefully
  const safe = { is_food: !!parsed.is_food, meal: String(parsed.meal || "").slice(0, 200), note: String(parsed.note || "").slice(0, 500) };
  NUTRIENT_ORDER.forEach((n) => { safe[n] = toSafeNumber(parsed[n]); });
  return safe;
}
