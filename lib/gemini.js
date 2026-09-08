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

// One vitamin/supplement item extracted from a label or doctor's note — see
// buildResponseSchema's "vitamin" category below. extra_nutrients mirrors the
// {label, unit, value} shape the manual "Tambah vitamin" form already uses
// (app/dashboard/page.js), converted to the same jsonb map via
// buildExtraNutrientsMap (lib/nutrition.js) once a saved row is built.
function buildVitaminItemSchema() {
  const properties = { name: { type: "STRING" } };
  NUTRIENT_ORDER.forEach((n) => { properties[n] = { type: "NUMBER" }; });
  properties.extra_nutrients = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: { label: { type: "STRING" }, unit: { type: "STRING" }, value: { type: "NUMBER" } },
      required: ["label", "unit", "value"],
    },
  };
  return { type: "OBJECT", properties, required: ["name", ...NUTRIENT_ORDER, "extra_nutrients"] };
}

// Schema is built from NUTRIENT_ORDER (lib/nutrition.js) instead of listing
// the nutrient keys again here, so the meals table's nutrient columns and
// what Gemini is asked to return can't quietly drift apart. `reply` is last
// so the model "decides" category/meal/vitamins/nutrients before composing
// it — those are short atomic values, so this doesn't meaningfully delay
// when streaming of the reply text itself starts.
//
// `category` replaces what used to be a binary `is_log`: "food" (a meal/
// drink being eaten now, or a packaged item's own printed Nutrition Facts
// label — uses `meal` + the top-level nutrient fields, same shape as
// before), "vitamin" (a vitamin/supplement label or doctor's note — can name
// more than one product, see `vitamins` below), or "chat" (plain
// conversation, nothing to log). Only the branch matching `category` is
// ever populated by the model; the other branches stay at their empty/zero
// default (enforced again defensively in sanitizeChatTurnResult below).
function buildResponseSchema() {
  const properties = {
    category: { type: "STRING", enum: ["food", "vitamin", "chat"] },
    meal: { type: "STRING" },
  };
  NUTRIENT_ORDER.forEach((n) => { properties[n] = { type: "NUMBER" }; });
  properties.vitamins = { type: "ARRAY", items: buildVitaminItemSchema() };
  properties.reply = { type: "STRING" };
  return {
    type: "OBJECT",
    properties,
    required: ["category", "meal", ...NUTRIENT_ORDER, "vitamins", "reply"],
  };
}

// e.g. "calories (kkal), protein_g (g), ..." — built from NUTRIENT_META so
// the prompt can't drift from the schema (and from every other nutrient list
// in the app) whenever a nutrient is added or removed.
const NUTRIENT_LIST_FOR_PROMPT = NUTRIENT_ORDER
  .map((n) => `${n} (${NUTRIENT_META[n].unit}, "${NUTRIENT_META[n].label}")`)
  .join(", ");

const SYSTEM_PROMPT = `Kamu adalah Bloom — teman ngobrol seputar kehamilan & gizi untuk ibu hamil, ramah
dan santai seperti chat biasa, bukan formulir.

Setiap pesan dari user termasuk salah satu dari TIGA situasi ini — tentukan "category"-nya lebih dulu:

1) category = "food" — user cerita atau menunjukkan foto tentang makanan/minuman yang sedang/baru dia
   makan/minum (lewat kata-kata dan/atau foto terlampir), ATAU foto label Nutrisi/Nutrition Facts yang
   tercetak pada kemasan makanan/minuman kemasan:
   - meal = nama menu/produknya, dalam Bahasa Indonesia (mis. "Nasi goreng dengan telur", atau nama
     produk kalau dari foto kemasan)
   - isi field gizi berikut (nama field, satuan, nama gizinya): ${NUTRIENT_LIST_FOR_PROMPT}. Kalau
     fotonya adalah label kemasan dengan angka gizi tercetak, BACA LANGSUNG angka-angka itu dari label
     — jangan menaksir. Kalau fotonya makanan/minuman biasa (bukan label), taksir berdasarkan porsi
     lazim yang terlihat/disebutkan. Isi 0 untuk yang jelas tidak relevan, jangan mengarang angka
     ekstrem.
   - vitamins = array kosong.
   - reply = balasan singkat hangat (1-2 kalimat) + satu insight gizi soal menu ini, dan sebutkan
     kalau ini sudah bisa disimpan ke Dashboard lewat tombol di bawah balasanmu.

2) category = "vitamin" — foto atau cerita tentang vitamin/suplemen: label botol vitamin/suplemen,
   ATAU foto/daftar resep dokter yang menyebut satu atau lebih nama vitamin/suplemen:
   - vitamins = array berisi SATU OBJEK PER vitamin/suplemen yang terdeteksi (boleh lebih dari satu
     kalau memang ada beberapa nama disebut/terlihat dalam satu foto/pesan, mis. resep dokter yang
     berisi 2-3 nama produk). Untuk tiap objek:
     - name = nama produknya (mis. "Folamil Genio")
     - isi field gizi berikut untuk produk itu (${NUTRIENT_LIST_FOR_PROMPT}) SESUAI ANGKA DI LABEL/
       KEMASAN kalau terlihat/diketahui, isi 0 kalau tidak ada info gizinya (mis. resep dokter yang
       cuma menyebut nama produk tanpa kandungan gizi tercetak) — JANGAN mengarang angka pasti untuk
       produk yang kandungan gizinya tidak kamu ketahui persis.
     - extra_nutrients = daftar nutrisi tambahan di luar daftar utama di atas kalau terlihat di label
       (mis. Zinc, Vitamin B6, Iodium — masing-masing {label, unit, value}), array kosong kalau tidak
       ada nutrisi tambahan yang terlihat.
   - meal dikosongkan, semua field gizi di level atas 0 (tidak dipakai untuk kategori ini).
   - reply = balasan singkat hangat yang menyebutkan vitamin/suplemen apa saja yang terdeteksi, dan
     sebutkan kalau masing-masing sudah bisa disimpan ke Dashboard lewat tombol di bawah balasanmu.

3) category = "chat" — selain dua di atas: sapaan, curhat, tanya-tanya soal gizi/kehamilan secara
   umum, obrolan apa pun yang BUKAN cerita/foto soal makanan/minuman/vitamin/suplemen spesifik:
   - meal kosong, semua field gizi 0, vitamins = array kosong
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

const MAX_VITAMIN_ITEMS = 10; // defensive cap, same spirit as the string-length caps below
const MAX_EXTRA_NUTRIENTS_PER_ITEM = 20;

// One raw `vitamins[]` item from Gemini -> a sanitized item, or null if it has
// no usable name (dropped from the array entirely rather than kept as a blank
// card with a "Simpan ke Dashboard" button pointing at nothing).
function sanitizeVitaminItem(item) {
  const name = String(item?.name || "").trim().slice(0, 200);
  if (!name) return null;
  const safeItem = { name };
  NUTRIENT_ORDER.forEach((n) => { safeItem[n] = toSafeNumber(item?.[n]); });
  const extra = Array.isArray(item?.extra_nutrients) ? item.extra_nutrients : [];
  safeItem.extra_nutrients = extra
    .map((e) => ({
      label: String(e?.label || "").trim().slice(0, 60),
      unit: String(e?.unit || "").trim().slice(0, 20),
      value: toSafeNumber(e?.value),
    }))
    .filter((e) => e.label)
    .slice(0, MAX_EXTRA_NUTRIENTS_PER_ITEM);
  return safeItem;
}

// Turns Gemini's raw parsed JSON into the shape the rest of the app relies on.
// Exported (and kept free of any network/DOM dependency) so it's directly
// unit-testable. `category` is only trusted when it's one of the three known
// values AND that branch actually has something worth acting on (a named
// `meal` for "food", at least one named item for "vitamin") — otherwise it's
// downgraded to "chat" rather than surfacing an empty/broken "Simpan ke
// Dashboard" card for nothing.
export function sanitizeChatTurnResult(parsed) {
  const reply = String(parsed?.reply || "").slice(0, 800);
  const safe = { category: "chat", meal: "", vitamins: [], reply };
  NUTRIENT_ORDER.forEach((n) => { safe[n] = 0; });

  if (parsed?.category === "food") {
    const meal = String(parsed?.meal || "").trim().slice(0, 200);
    if (meal) {
      safe.category = "food";
      safe.meal = meal;
      NUTRIENT_ORDER.forEach((n) => { safe[n] = toSafeNumber(parsed?.[n]); });
    }
  } else if (parsed?.category === "vitamin") {
    const items = Array.isArray(parsed?.vitamins) ? parsed.vitamins : [];
    const safeItems = items.map(sanitizeVitaminItem).filter(Boolean).slice(0, MAX_VITAMIN_ITEMS);
    if (safeItems.length > 0) {
      safe.category = "vitamin";
      safe.vitamins = safeItems;
    }
  }
  return safe;
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

// Shared by both nutrition-chat and journal/transcribe routes' stream catch
// blocks — they present the same "Gemini is rate-limited/out of quota, try
// again" case the same way, so the classification + copy live here once
// instead of duplicated (and able to drift) across two route files. Deliberately
// one generic message for both 429 (quota) and 503 (overload) rather than
// parsing the error body to tell "daily quota spent" apart from "momentarily
// busy" — worded so it doesn't promise a quick retry will definitely work,
// since a spent daily quota won't recover in "a few seconds" the way a 503 might.
export const GEMINI_BUSY_MESSAGE =
  "Gemini API lagi dibatasi kuotanya, belum bisa diproses sekarang. Coba lagi beberapa saat lagi ya.";

export function isGeminiBusyError(e) {
  return e instanceof GeminiHttpError && (e.status === 503 || e.status === 429);
}

// Gemini returns 503 ("high demand... usually temporary", per Google's own
// message) often enough that retrying a couple of times before giving up is
// worth it — these are the two calls in a typical chat turn's error budget,
// not a general-purpose retry policy.
//
// 429 (rate limit) is deliberately NOT in this set. The free tier's quota is
// a *per-day* counter (e.g. "GenerateRequestsPerDayPerProjectPerModel-
// FreeTier", limit 20/day) — once that's exhausted, no amount of retrying
// within one request's lifetime can succeed, and every retry attempt is
// itself another request counted against that same exhausted daily budget.
// Failing fast on 429 also isn't a real loss for a genuinely short-lived
// rate limit: Gemini's own error body suggests waiting tens of seconds
// (RetryInfo.retryDelay) before a 429 retry has a real chance, far longer
// than the fixed backoff below was ever using anyway. A 429 is instead
// handled one level up, by trying a *different* model — see
// tryModelChain/fetchGeminiForChat/fetchGeminiForLowTier below.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
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

// ---------------- model tiers + fallback-on-429 ----------------
// Two independent tiers, each an ordered list of model names tried in turn:
//
// - "chat" tier (streamNutritionChatTurn, streamTranscribeVoiceNote) — both
//   real-time and user-facing, and both need to read an attached photo/audio
//   clip, so this always tries the most capable model(s) first.
// - "low" tier (generateDailyNudge, generateMealFact) — a cron job nobody is
//   watching, text-only, so the cheapest model that answers reliably is fine.
//
// GEMINI_MODEL is this file's original, single model env var, from before
// tiers existed — it's repurposed here to mean the low tier specifically,
// same as GEMINI_FALLBACK_MODELS. See README.md for the full env var list;
// if you already had GEMINI_MODEL set, it now only affects the two cron
// calls, not chat — that repurposing is called out there too.
function parseModelList(envValue) {
  return (envValue || "").split(",").map((m) => m.trim()).filter(Boolean);
}

function getChatModelChain() {
  const primary = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-pro";
  return [primary, ...parseModelList(process.env.GEMINI_CHAT_FALLBACK_MODELS)];
}

function getLowModelChain() {
  const primary = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  return [primary, ...parseModelList(process.env.GEMINI_FALLBACK_MODELS)];
}

// Tries each model in `models` in order — `buildUrl(model)` builds that
// model's request URL, otherwise identical to a single fetchGeminiWithRetries
// call (same per-model retry policy for 500/502/503/504). Moves to the next
// model only when the current one throws a 429 GeminiHttpError (quota/rate
// limit — each model has its own separate quota, so a fresh model is worth
// trying); any other error (a 5xx that outlasted its own retries, a network
// failure, a bad request, ...) propagates immediately without trying further
// models, since falling back only ever helps a rate-limit/quota problem.
// Returns { res, model } for whichever model actually served the request.
async function tryModelChain(models, buildUrl, requestBody, opts) {
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      const res = await fetchGeminiWithRetries(buildUrl(model), requestBody, opts);
      return { res, model };
    } catch (e) {
      const isLastModel = i === models.length - 1;
      if (!(e instanceof GeminiHttpError) || e.status !== 429 || isLastModel) throw e;
      console.warn(`Gemini model "${model}" hit 429 (quota/rate limit), falling back to "${models[i + 1]}"`);
    }
  }
}

// Shown to the user only when a chat-tier call had to fall all the way
// through to the low tier because every chat-tier model was 429'd — the low
// tier is a much smaller/cheaper model never meant to carry this workload, so
// its structured output (nutrients, transcript, vitamins) may be less
// reliable and is worth a second look before being trusted or saved.
export const GEMINI_LOWER_TIER_NOTICE =
  "Balasan ini dari model cadangan yang lebih sederhana karena model utama lagi penuh kuotanya — cek ulang dulu ya sebelum disimpan, siapa tahu ada detail yang kurang pas.";

// Small caption appended to every chat/transcribe reply (not just a
// fallback one) so it's always visible which model actually answered —
// folded straight into reply/tidiedNote rather than a separate UI element,
// same reasoning as GEMINI_LOWER_TIER_NOTICE: no frontend/schema changes
// needed, and it persists automatically since that's what's already saved.
export function formatGeminiModelCaption(model) {
  return `(model: ${model})`;
}

// Chat-tier calls always try the chat-tier chain first; only if every model
// in it 429s do they fall through to the low tier as an absolute last
// resort — some answer (even from a weaker model) beats none. Callers use
// the returned `usedLowerTier` flag to attach GEMINI_LOWER_TIER_NOTICE.
async function fetchGeminiForChat(buildUrl, requestBody, opts) {
  try {
    const { res, model } = await tryModelChain(getChatModelChain(), buildUrl, requestBody, opts);
    return { res, model, usedLowerTier: false };
  } catch (e) {
    if (!(e instanceof GeminiHttpError) || e.status !== 429) throw e;
    console.warn("Every chat-tier Gemini model hit 429, falling back to the low tier");
    const { res, model } = await tryModelChain(getLowModelChain(), buildUrl, requestBody, opts);
    return { res, model, usedLowerTier: true };
  }
}

// Low-tier calls only ever use the low tier chain — there's nothing lower to
// fall to, and a total failure here is already handled by the cron route's
// own fallback copy (see the comment above generateDailyNudge below).
async function fetchGeminiForLowTier(buildUrl, requestBody, opts) {
  const { res } = await tryModelChain(getLowModelChain(), buildUrl, requestBody, opts);
  return res;
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
// category/meal/vitamins/nutrients, `onDelta` is purely a progressive preview of it.
export async function streamNutritionChatTurn({ message, image, history }, onDelta) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");

  // Chat tier: best-model-first, with a last-resort drop to the low tier if
  // every chat-tier model is 429'd (see fetchGeminiForChat above) — override
  // the default model via GEMINI_CHAT_MODEL/GEMINI_CHAT_FALLBACK_MODELS in
  // .env.local/Vercel without a code change (see README).
  const { res, model, usedLowerTier } = await fetchGeminiForChat(
    (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
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
  const safe = sanitizeChatTurnResult(parsed);
  if (usedLowerTier) safe.reply = `${safe.reply}\n\n${GEMINI_LOWER_TIER_NOTICE}`;
  safe.reply = `${safe.reply}\n\n${formatGeminiModelCaption(model)}`;
  if (safe.reply.length > emittedLen) onDelta?.(safe.reply.slice(emittedLen)); // any tail we hadn't emitted yet (the notice + model caption above included)
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

  // Chat tier, same as streamNutritionChatTurn — this reads an attached audio
  // clip, so it stays on the best-model tier too (see fetchGeminiForChat).
  const { res, model, usedLowerTier } = await fetchGeminiForChat(
    (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
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
  // Appended to tidiedNote, not transcript — transcript stays a verbatim
  // transcript; tidiedNote is the "ready to paste into your journal" draft,
  // which is exactly where a "double-check this" caveat belongs.
  if (usedLowerTier) safe.tidiedNote = `${safe.tidiedNote}\n\n${GEMINI_LOWER_TIER_NOTICE}`;
  safe.tidiedNote = `${safe.tidiedNote}\n\n${formatGeminiModelCaption(model)}`;
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

  const contextLine = trimester && weeks != null
    ? `Konteks: pengguna sedang trimester ${trimester.slice(1)}, usia kehamilan minggu ke-${weeks}.`
    : "Konteks: usia kehamilan pengguna belum diketahui — tulis kalimat yang umum berlaku di semua trimester.";

  // Low tier — no user watching, text-only, cheapest model that answers
  // reliably is fine (see fetchGeminiForLowTier above).
  const res = await fetchGeminiForLowTier(
    (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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

  const contextLine = trimester && weeks != null
    ? `Konteks: pengguna sedang trimester ${trimester.slice(1)}, usia kehamilan minggu ke-${weeks}.`
    : "Konteks: usia kehamilan pengguna belum diketahui — tulis fakta yang umum berlaku di semua trimester.";

  // Low tier, same as generateDailyNudge above.
  const res = await fetchGeminiForLowTier(
    (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
