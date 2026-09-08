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

// Thrown for a non-ok Gemini response — carries the HTTP status so callers
// (the API route) can tell "Gemini is overloaded, try again" apart from a
// real bug without parsing the error message text.
export class GeminiHttpError extends Error {
  constructor(status, body) {
    super(`Gemini API error: ${status} ${body}`);
    this.status = status;
  }
}

// Gemini returns 503 ("high demand... usually temporary", per Google's own
// message) and 429 (rate limit) often enough that retrying a couple of times
// before giving up is worth it — these are the two calls in a typical chat
// turn's error budget, not a general-purpose retry policy.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const RETRY_BASE_DELAY_MS = 600;

// Shared by every Gemini call in this file (chat turns, transcription): POSTs
// JSON, retries transient failures, throws GeminiHttpError once exhausted.
// `requireBody` also demands a readable stream body (streamGenerateContent) —
// a plain generateContent call just needs res.ok.
//
// `timeoutMs` is opt-in (undefined by default, same as before this option
// existed) — only the cron reminder calls (generateDailyNudge/
// generateMealFact below) pass one, since those run inside a batch job with
// a hard 60s ceiling. The interactive chat/transcribe calls keep waiting
// indefinitely, unchanged, since a real user is watching a single request.
// A timeout is treated as just another retryable failure (same backoff),
// and reported as GeminiHttpError("timeout", ...) once attempts run out —
// callers only ever check "did this throw", not the exact status value.
async function fetchGeminiWithRetries(url, requestBody, { requireBody = false, timeoutMs } = {}) {
  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    const controller = timeoutMs ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (e) {
      if (e?.name !== "AbortError" || isLastAttempt) {
        throw e?.name === "AbortError"
          ? new GeminiHttpError("timeout", `Gemini request timed out after ${timeoutMs}ms`)
          : e;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.ok && (!requireBody || res.body)) return res;
    const bodyText = await res.text();
    if (!RETRYABLE_STATUS.has(res.status) || isLastAttempt) {
      throw new GeminiHttpError(res.status, bodyText);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
  }
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

  const res = await fetchGeminiWithRetries(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: buildContents({ message, image, history }),
      generationConfig: { responseMimeType: "application/json", responseSchema: buildResponseSchema() },
    },
    { requireBody: true }
  );

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

// ---------------- voice note transcription (Jurnal) ----------------
// Used only by app/api/journal/transcribe/route.js. Streamed the same way
// streamNutritionChatTurn is — the schema has two string fields in order
// (transcript, then tidied_note), so both fill in live as Gemini writes
// them: the raw transcript first, then the tidied draft right after.

function buildTranscribeSchema() {
  return {
    type: "OBJECT",
    properties: { transcript: { type: "STRING" }, tidied_note: { type: "STRING" } },
    required: ["transcript", "tidied_note"],
  };
}

const TRANSCRIBE_SYSTEM_PROMPT = `Kamu membantu mentranskrip voice note untuk jurnal kehamilan pribadi.

Dengarkan audio ini dan hasilkan dua hal:
- transcript: transkrip apa adanya (verbatim) dari yang diucapkan, dalam bahasa yang sama dengan yang
  diucapkan (jangan diterjemahkan ke bahasa lain). Boleh membuang bunyi pengisi murni yang berulang
  (mis. "eee", "emm"), tapi jangan mengubah kata-kata atau makna aslinya.
- tidied_note: versi rapi dari transkrip itu, siap ditempel langsung ke jurnal — susun jadi
  kalimat/paragraf yang mengalir enak dibaca, perbaiki kalimat yang terpotong-potong atau berulang,
  TAPI tetap orang pertama ("aku"/"saya", ikuti gaya bicara aslinya), tetap dalam bahasa yang sama
  dengan ucapannya, dan jangan menambah informasi/detail yang tidak benar-benar diucapkan.

Kalau audio tidak berisi ucapan yang bisa dipahami (mis. hening, suara berisik, musik): isi transcript
dengan string kosong, dan tidied_note dengan permintaan maaf singkat kalau ucapannya tidak bisa dikenali.

Jawab HANYA dalam JSON sesuai skema yang diberikan.`;

// `onProgress({ transcript, tidiedNote })` fires with the current best-known
// full value of each field every time either grows — not deltas, since the
// caller here just wants to set state to "here's what we have so far" (same
// idea as streamNutritionChatTurn's onDelta, just simpler for two fields
// instead of one). Returns the final sanitized result once both fields —
// and the whole response — have actually finished arriving.
export async function streamTranscribeVoiceNote({ base64, mimeType }, onProgress) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const res = await fetchGeminiWithRetries(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      systemInstruction: { parts: [{ text: TRANSCRIBE_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mimeType, data: base64 } }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: buildTranscribeSchema() },
    },
    { requireBody: true }
  );

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let jsonBuffer = "";
  let lastTranscript = "";
  let lastTidied = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const chunkText = obj?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof chunkText !== "string") continue;
      jsonBuffer += chunkText;
      const t = extractPartialStringValue(jsonBuffer, "transcript");
      const n = extractPartialStringValue(jsonBuffer, "tidied_note");
      const nextTranscript = t ? t.text : lastTranscript;
      const nextTidied = n ? n.text : lastTidied;
      if (nextTranscript !== lastTranscript || nextTidied !== lastTidied) {
        lastTranscript = nextTranscript;
        lastTidied = nextTidied;
        onProgress?.({ transcript: lastTranscript, tidiedNote: lastTidied });
      }
    }
  }

  if (!jsonBuffer) throw new Error("Gemini tidak mengembalikan hasil apa pun.");
  const parsed = JSON.parse(jsonBuffer); // let a malformed response throw — caller replies gracefully
  const safe = {
    transcript: String(parsed.transcript || "").slice(0, 8000),
    tidiedNote: String(parsed.tidied_note || "").slice(0, 4000),
  };
  onProgress?.(safe); // any tail we hadn't caught yet
  return safe;
}

// ---------------- daily nudge line (push reminders) ----------------
// Used only by app/api/cron/reminders/route.js, appended to the "belum
// catat menu/vitamin" reminder body so it doesn't read the same every single
// day. Non-streaming (a cron job has no UI to progressively render into) —
// one plain generateContent call, same retry/error handling as the rest of
// this file. Throws on failure like every other function here; the caller
// decides the fallback (lib/reminderLogic.js's pickFallbackNudge), this file
// stays consistent with its own "let the caller handle graceful degradation"
// convention rather than swallowing errors itself.

function buildNudgeSchema() {
  return { type: "OBJECT", properties: { nudge: { type: "STRING" } }, required: ["nudge"] };
}

const NUDGE_SYSTEM_PROMPT = `Kamu menulis SATU kalimat pendek (maksimal sekitar 110 karakter) untuk
ditambahkan di akhir notifikasi pengingat harian aplikasi Bloom (pelacak gizi kehamilan), dalam
Bahasa Indonesia, hangat dan santai seperti dari teman dekat, bukan formal.

Pilih SALAH SATU secara acak dari dua jenis kalimat ini setiap kali diminta (variasikan, jangan
selalu jenis yang sama):
1) Kalimat afirmasi/penyemangat untuk ibu hamil, ATAU
2) Fakta ringan seputar kehamilan yang sudah umum diketahui dan aman (tidak kontroversial, tidak
   berupa anjuran medis spesifik), idealnya relevan dengan trimester/usia kehamilan yang diberikan
   kalau ada datanya.

Jangan menjanjikan atau memastikan hal medis apa pun, jangan menyebut nama produk/merek, dan jangan
mengulang kalimat "belum catat menu/vitamin" itu sendiri (itu sudah ada di bagian lain notifikasi) —
tulis HANYA kalimat tambahannya. Jawab HANYA dalam JSON sesuai skema yang diberikan.`;

// Both cron reminder calls (generateDailyNudge, generateMealFact below) pass
// this to fetchGeminiWithRetries -- app/api/cron/reminders/route.js processes
// every subscribed user inside one 60s function, so no single Gemini call
// here can be allowed to hang; 3 attempts x (8s + backoff) tops out around
// 26s worst case, well inside that budget even for one unlucky user.
const CRON_GEMINI_TIMEOUT_MS = 8000;

// `trimester`: "t1"|"t2"|"t3"|null, `weeks`: number|null (usia kehamilan
// dalam minggu, dari lib/pregnancy.js) — either/both may be unknown (user
// hasn't set HPHT yet), in which case the prompt just gets a generic ask.
export async function generateDailyNudge({ trimester, weeks } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const contextLine = trimester && weeks != null
    ? `Konteks: pengguna sedang trimester ${trimester.slice(1)}, usia kehamilan minggu ke-${weeks}.`
    : "Konteks: usia kehamilan pengguna belum diketahui — tulis kalimat yang umum berlaku di semua trimester.";

  const res = await fetchGeminiWithRetries(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      systemInstruction: { parts: [{ text: NUDGE_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: contextLine }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: buildNudgeSchema() },
    },
    { timeoutMs: CRON_GEMINI_TIMEOUT_MS }
  );

  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini tidak mengembalikan hasil apa pun.");
  const parsed = JSON.parse(text);
  const nudge = String(parsed.nudge || "").trim().slice(0, 200);
  if (!nudge) throw new Error("Gemini mengembalikan nudge kosong.");
  return nudge;
}

// ---------------- lunch-slot nutrition fact ----------------
// Used only by app/api/cron/reminders/route.js's lunch slot (12:00 WIB) —
// distinct from generateDailyNudge above: this is specifically a fun fact
// about *nutritional needs during pregnancy* (protein, iron, folate, etc.),
// not a general pregnancy fact or affirmation. Same non-streaming/retry
// shape as generateDailyNudge; throws on failure, caller falls back to
// lib/reminderLogic.js's pickMealFactFallback.

function buildMealFactSchema() {
  return { type: "OBJECT", properties: { fact: { type: "STRING" } }, required: ["fact"] };
}

const MEAL_FACT_SYSTEM_PROMPT = `Kamu menulis SATU kalimat pendek (maksimal sekitar 110 karakter) untuk
ditambahkan di akhir notifikasi pengingat makan siang aplikasi Bloom (pelacak gizi kehamilan), dalam
Bahasa Indonesia, hangat dan santai.

Kalimatnya HARUS berupa fakta ringan seputar KEBUTUHAN GIZI selama kehamilan (mis. protein, zat besi,
kalsium, folat, cairan, serat, DHA, vitamin D — bebas topiknya, boleh disesuaikan dengan
trimester/usia kehamilan kalau datanya ada), yang sudah umum diketahui dan aman (tidak kontroversial,
bukan anjuran dosis/medis spesifik).

Jangan menyebut nama produk/merek, jangan mengulang ajakan "waktunya makan siang" (itu sudah ada di
bagian lain notifikasi) — tulis HANYA fakta gizinya. Jawab HANYA dalam JSON sesuai skema yang diberikan.`;

export async function generateMealFact({ trimester, weeks } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

  const contextLine = trimester && weeks != null
    ? `Konteks: pengguna sedang trimester ${trimester.slice(1)}, usia kehamilan minggu ke-${weeks}.`
    : "Konteks: usia kehamilan pengguna belum diketahui — tulis fakta yang umum berlaku di semua trimester.";

  const res = await fetchGeminiWithRetries(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      systemInstruction: { parts: [{ text: MEAL_FACT_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: contextLine }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: buildMealFactSchema() },
    },
    { timeoutMs: CRON_GEMINI_TIMEOUT_MS }
  );

  const body = await res.json();
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini tidak mengembalikan hasil apa pun.");
  const parsed = JSON.parse(text);
  const fact = String(parsed.fact || "").trim().slice(0, 200);
  if (!fact) throw new Error("Gemini mengembalikan fact kosong.");
  return fact;
}
