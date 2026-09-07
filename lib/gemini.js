import "server-only";
import { NUTRIENT_ORDER, NUTRIENT_META } from "@/lib/nutrition";

// One Gemini call per chat turn (text and/or a photo), used only by
// app/api/nutrition-chat/route.js. Plain fetch, no SDK. Gemini decides for
// itself whether the turn is "log this food" (→ structured nutrition data +
// the chat's "Simpan ke Dashboard" button) or just conversation (→ a normal
// reply) — the chat doesn't gate that client-side, so talking to Bloom feels
// like a normal chat, not a form that only accepts photos.

// Schema is built from NUTRIENT_ORDER (lib/nutrition.js) instead of listing
// the nutrient keys again here, so the meals table's nutrient columns and
// what Gemini is asked to return can't quietly drift apart.
function buildResponseSchema() {
  const properties = { is_log: { type: "BOOLEAN" }, meal: { type: "STRING" } };
  NUTRIENT_ORDER.forEach((n) => { properties[n] = { type: "NUMBER" }; });
  properties.reply = { type: "STRING" };
  return { type: "OBJECT", properties, required: ["is_log", "meal", ...NUTRIENT_ORDER, "reply"] };
}

// e.g. "calories (kkal), protein_g (g), ..." — built from NUTRIENT_META so
// the prompt can't drift from the schema (and from every other nutrient list
// in the app) whenever a nutrient is added or removed.
const NUTRIENT_LIST_FOR_PROMPT = NUTRIENT_ORDER
  .map((n) => `${n} (${NUTRIENT_META[n].unit}, "${NUTRIENT_META[n].label}")`)
  .join(", ");

const SYSTEM_PROMPT = `Kamu adalah Bloom — teman ngobrol seputar kehamilan & gizi untuk ibu hamil, ramah
dan santai seperti chat biasa, bukan formulir.

Setiap pesan dari user termasuk salah satu dari dua situasi ini:

1) User cerita atau menunjukkan foto tentang makanan/minuman yang dia makan/minum (lewat kata-kata
   dan/atau foto terlampir) — ini permintaan MENCATAT ke Bloom:
   - is_log = true
   - meal = nama menunya, dalam Bahasa Indonesia (mis. "Nasi goreng dengan telur")
   - isi field gizi berikut untuk porsi yang disebutkan/terlihat (nama field, satuan, nama gizinya):
     ${NUTRIENT_LIST_FOR_PROMPT}. Isi 0 untuk yang jelas tidak relevan. Gunakan angka realistis
     berdasarkan porsi lazim, jangan mengarang angka ekstrem.
   - reply = balasan singkat hangat (1-2 kalimat) + satu insight gizi soal menu ini, dan sebutkan
     kalau ini sudah bisa disimpan ke Dashboard lewat tombol di bawah balasanmu.

2) Selain itu — sapaan, curhat, tanya-tanya soal gizi/kehamilan secara umum, obrolan apa pun yang BUKAN
   cerita soal makanan/minuman spesifik yang sedang/baru dikonsumsi — ini obrolan biasa:
   - is_log = false, "meal" kosong, semua field gizi 0
   - reply = balasan chat yang wajar, hangat, dan membantu. Boleh menjawab pertanyaan gizi/kehamilan
     secara umum di sini, tapi untuk hal yang butuh penanganan medis, sarankan konsultasi ke
     dokter/bidan alih-alih memberi kepastian.

Riwayat percakapan sebelumnya (kalau ada) disertakan sebagai konteks — sambungkan obrolan dengan wajar
dan jangan mengulang sapaan pembuka kalau sudah pernah menyapa sebelumnya.

Jawab HANYA dalam JSON sesuai skema yang diberikan.`;

function toSafeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// `history`: [{ role: "user" | "assistant", text }] — prior turns only, most
// recent last. Text-only: past photos are never resent (or stored at all,
// see chat_messages in supabase/schema.sql), so a prior image turn is
// represented as a placeholder string instead of its actual bytes.
export async function nutritionChatTurn({ message, image, history }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  const model = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  const contents = (history || []).map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.text || "" }],
  }));

  const currentParts = [];
  if (message) currentParts.push({ text: message });
  if (image) currentParts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  contents.push({ role: "user", parts: currentParts });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { responseMimeType: "application/json", responseSchema: buildResponseSchema() },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini tidak mengembalikan hasil apa pun.");

  const parsed = JSON.parse(text); // let a malformed response throw — caller replies gracefully
  const safe = { is_log: !!parsed.is_log, meal: String(parsed.meal || "").slice(0, 200), reply: String(parsed.reply || "").slice(0, 800) };
  NUTRIENT_ORDER.forEach((n) => { safe[n] = toSafeNumber(parsed[n]); });
  return safe;
}
