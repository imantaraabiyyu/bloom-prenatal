import "server-only";
import { NUTRIENT_ORDER, NUTRIENT_META } from "@/lib/nutrition";

// One Gemini call per chat turn (text and/or a photo), used only by
// app/api/nutrition-chat/route.js. Plain fetch, no SDK. Gemini decides for
// itself whether the turn is "log this food" (→ structured nutrition data +
// the chat's "Simpan ke Dashboard" button) or just conversation (→ a normal
// reply) — the chat doesn't gate that client-side, so talking to Bloom feels
// like a normal chat, not a form that only accepts photos.
//
// Streamed: Gemini's structured JSON output arrives token-by-token same as
// plain text would, so `reply` (the field the chat bubble actually shows)
// can be surfaced to the user as it's written instead of waiting for the
// nutrient fields around it to finish too. See extractPartialStringValue.

// Schema is built from NUTRIENT_ORDER (lib/nutrition.js) instead of listing
// the nutrient keys again here, so the meals table's nutrient columns and
// what Gemini is asked to return can't quietly drift apart. `reply` is last
// so the model "decides" is_log/meal/nutrients before composing it — those
// are short atomic values, so this doesn't meaningfully delay when
// streaming of the reply text itself starts.
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

function buildContents({ message, image, history }) {
  const contents = (history || []).map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.text || "" }],
  }));
  const currentParts = [];
  if (message) currentParts.push({ text: message });
  if (image) currentParts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  contents.push({ role: "user", parts: currentParts });
  return contents;
}

// Scans the JSON text accumulated so far for `"<key>":"<value so far>"` and
// returns its (unescaped) string value even before the closing quote has
// arrived — that's the whole point, so the caller can stream it out as more
// of the value comes in. Returns null if the key hasn't appeared yet (or
// hasn't reached its value yet). Good enough for our one controlled key
// (Gemini's own schema-generated field name, never user input) — not a
// general JSON streaming parser.
function extractPartialStringValue(buffer, key) {
  const marker = `"${key}"`;
  const keyIdx = buffer.indexOf(marker);
  if (keyIdx === -1) return null;
  let i = keyIdx + marker.length;
  const skipWs = () => { while (i < buffer.length && /\s/.test(buffer[i])) i++; };
  skipWs();
  if (buffer[i] !== ":") return null;
  i++;
  skipWs();
  if (buffer[i] !== '"') return null;
  i++;
  let out = "";
  for (; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === "\\") {
      if (i + 1 >= buffer.length) break; // escape split across chunks — wait for more
      const next = buffer[i + 1];
      if (next === "u") {
        if (i + 6 > buffer.length) break; // \uXXXX split across chunks — wait for more
        out += String.fromCharCode(parseInt(buffer.slice(i + 2, i + 6), 16));
        i += 5;
      } else {
        out += ({ '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" })[next] ?? next;
        i += 1;
      }
      continue;
    }
    if (ch === '"') return { text: out, closed: true };
    out += ch;
  }
  return { text: out, closed: false };
}

// `history`: [{ role: "user" | "assistant", text }] — prior turns only, most
// recent last. Text-only: past photos are never resent (or stored at all,
// see chat_messages in supabase/schema.sql), so a prior image turn is
// represented as a placeholder string instead of its actual bytes.
//
// `onDelta(text)` fires with each new chunk of the `reply` field as it
// streams in. Returns the final sanitized result once the whole response
// (not just `reply`) has arrived — that full object is what actually decides
// is_log/meal/nutrients, `onDelta` is purely a progressive preview of it.
export async function streamNutritionChatTurn({ message, image, history }, onDelta) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  // Google retires model aliases over time (gemini-2.0-flash was retired in
  // favor of this one) — override via GEMINI_MODEL in .env.local/Vercel
  // without a code change if this default goes stale again.
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: buildContents({ message, image, history }),
        generationConfig: { responseMimeType: "application/json", responseSchema: buildResponseSchema() },
      }),
    }
  );
  if (!res.ok || !res.body) throw new Error(`Gemini API error: ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let jsonBuffer = "";
  let emittedLen = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop(); // keep the trailing partial line for the next read
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; } // ignore any stray non-JSON keepalive lines
      const chunkText = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof chunkText !== "string") continue;
      jsonBuffer += chunkText;
      const partial = extractPartialStringValue(jsonBuffer, "reply");
      if (partial && partial.text.length > emittedLen) {
        onDelta?.(partial.text.slice(emittedLen));
        emittedLen = partial.text.length;
      }
    }
  }

  if (!jsonBuffer) throw new Error("Gemini tidak mengembalikan hasil apa pun.");
  const parsed = JSON.parse(jsonBuffer); // let a malformed response throw — caller replies gracefully
  const safe = { is_log: !!parsed.is_log, meal: String(parsed.meal || "").slice(0, 200), reply: String(parsed.reply || "").slice(0, 800) };
  NUTRIENT_ORDER.forEach((n) => { safe[n] = toSafeNumber(parsed[n]); });
  if (safe.reply.length > emittedLen) onDelta?.(safe.reply.slice(emittedLen)); // any tail we hadn't emitted yet
  return safe;
}
