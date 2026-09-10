import "server-only";
import { NUTRIENT_ORDER, NUTRIENT_META, LIMIT_ORDER, LIMIT_META, LIMITS, ALL_TRACKED_NUTRIENTS } from "@/lib/nutrition";

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
// Shared {label, unit, value} shape for "nutrients outside the fixed list"
// -- one free-form entry per extra composition fact Gemini spots (e.g. Zinc,
// Omega-3, Vitamin B6) that isn't one of NUTRIENT_ORDER/LIMIT_ORDER. Used by
// both a vitamin item's extra_nutrients (below) and, since meals gained the
// same extra_nutrients jsonb column as vitamins, the top-level food-category
// extra_nutrients in buildResponseSchema.
function buildExtraNutrientItemSchema() {
  return {
    type: "OBJECT",
    properties: { label: { type: "STRING" }, unit: { type: "STRING" }, value: { type: "NUMBER" } },
    required: ["label", "unit", "value"],
  };
}

function buildVitaminItemSchema() {
  const properties = { name: { type: "STRING" } };
  ALL_TRACKED_NUTRIENTS.forEach((n) => { properties[n] = { type: "NUMBER" }; });
  properties.extra_nutrients = { type: "ARRAY", items: buildExtraNutrientItemSchema() };
  return { type: "OBJECT", properties, required: ["name", ...ALL_TRACKED_NUTRIENTS, "extra_nutrients"] };
}

// The 3 possible verdict values on a category="food" turn -- see VERDICT_LIST_FOR_PROMPT
// and the SYSTEM_PROMPT paragraph below for what each means and the required
// soft tone. Deliberately not "avoid"/"danger"-flavored wording (`kurangi_dulu`,
// not e.g. "sebaiknya_dihindari") -- a caution here should never read as an
// alarming medical warning, see the soft-tone requirement in the prompt.
const VERDICT_VALUES = ["aman", "waspada", "kurangi_dulu"];

// Schema is built from NUTRIENT_ORDER/LIMIT_ORDER (lib/nutrition.js, combined
// as ALL_TRACKED_NUTRIENTS) instead of listing the nutrient keys again here,
// so the meals/vitamins tables' nutrient columns and what Gemini is asked to
// return can't quietly drift apart. `reply` is last so the model "decides"
// category/meal/vitamins/nutrients/verdict before composing it — those are
// short atomic values, so this doesn't meaningfully delay when streaming of
// the reply text itself starts (see extractPartialStringValue, which keys
// off "reply" specifically -- any new field MUST be inserted before it).
//
// `category` replaces what used to be a binary `is_log`: "food" (a meal/
// drink being eaten now, or a packaged item's own printed Nutrition Facts
// label — uses `meal` + the top-level nutrient fields, same shape as
// before), "vitamin" (a vitamin/supplement label or doctor's note — can name
// more than one product, see `vitamins` below), or "chat" (plain
// conversation, nothing to log). Only the branch matching `category` is
// ever populated by the model; the other branches stay at their empty/zero
// default (enforced again defensively in sanitizeChatTurnResult below).
// `verdict`/`verdict_reason` are food-specific (see the SYSTEM_PROMPT
// paragraph) -- sanitizeChatTurnResult blanks them out for any other category.
function buildResponseSchema() {
  const properties = {
    category: { type: "STRING", enum: ["food", "vitamin", "chat"] },
    meal: { type: "STRING" },
  };
  ALL_TRACKED_NUTRIENTS.forEach((n) => { properties[n] = { type: "NUMBER" }; });
  properties.vitamins = { type: "ARRAY", items: buildVitaminItemSchema() };
  // Food-category-only, like verdict/verdict_reason below -- extra composition
  // facts (e.g. Zinc, Omega-3) that don't fit NUTRIENT_ORDER/LIMIT_ORDER,
  // stored in meals.extra_nutrients the same way a vitamin item's own
  // extra_nutrients already is (see buildExtraNutrientItemSchema above).
  properties.extra_nutrients = { type: "ARRAY", items: buildExtraNutrientItemSchema() };
  properties.verdict = { type: "STRING", enum: VERDICT_VALUES };
  properties.verdict_reason = { type: "STRING" };
  properties.reply = { type: "STRING" };
  return {
    type: "OBJECT",
    properties,
    required: ["category", "meal", ...ALL_TRACKED_NUTRIENTS, "vitamins", "extra_nutrients", "verdict", "verdict_reason", "reply"],
  };
}

// e.g. "calories (kkal), protein_g (g), ..." — built from NUTRIENT_META/
// LIMIT_META so the prompt can't drift from the schema (and from every other
// nutrient list in the app) whenever a nutrient is added or removed. Kept as
// two separate clauses (not one merged list) so the prompt can explain the
// floor-vs-ceiling distinction between them.
//
// These are the STATIC fallback (today's global NUTRIENT_ORDER=min/
// LIMIT_ORDER=max split) -- used only when a caller doesn't pass
// `effectiveGoals` to buildSystemPrompt below (defensive default, same
// "never block the chat turn" spirit as buildDailyContextHint returning
// null for missing context). The real, per-user-aware lists are built by
// buildMinMaxListsForPrompt from the caller's resolveEffectiveGoals result,
// since a nutrient's direction is no longer fixed to these two arrays.
const NUTRIENT_LIST_FOR_PROMPT = NUTRIENT_ORDER
  .map((n) => `${n} (${NUTRIENT_META[n].unit}, "${NUTRIENT_META[n].label}")`)
  .join(", ");
const LIMIT_LIST_FOR_PROMPT = LIMIT_ORDER
  .map((n) => `${n} (${LIMIT_META[n].unit}, "${LIMIT_META[n].label}")`)
  .join(", ");
const LIMIT_LABELS_PROSE = LIMIT_ORDER.map((n) => LIMIT_META[n].label).join("/");

// Splits ALL_TRACKED_NUTRIENTS into "target minimum" vs "batas maksimum
// harian" prompt clauses using THIS user's own effectiveGoals (see
// lib/nutrition.js's resolveEffectiveGoals) instead of the fixed
// NUTRIENT_ORDER/LIMIT_ORDER split -- a user can flip any nutrient's
// direction, so which of the 15 keys is a "reach at least" vs "avoid
// exceeding" field varies per user/request, not per deploy.
function buildMinMaxListsForPrompt(effectiveGoals) {
  if (!effectiveGoals) {
    return { minListForPrompt: NUTRIENT_LIST_FOR_PROMPT, maxListForPrompt: LIMIT_LIST_FOR_PROMPT, maxLabelsProse: LIMIT_LABELS_PROSE };
  }
  const minKeys = ALL_TRACKED_NUTRIENTS.filter((k) => effectiveGoals[k]?.goalType !== "max");
  const maxKeys = ALL_TRACKED_NUTRIENTS.filter((k) => effectiveGoals[k]?.goalType === "max");
  const listFor = (keys) => keys.map((k) => `${k} (${effectiveGoals[k].unit}, "${effectiveGoals[k].label}")`).join(", ");
  return {
    minListForPrompt: listFor(minKeys),
    maxListForPrompt: listFor(maxKeys),
    maxLabelsProse: maxKeys.map((k) => effectiveGoals[k].label).join("/"),
  };
}

// Was a static module-level constant -- now built fresh per chat turn since
// its "target minimum"/"batas maksimum harian" field lists (and the VERDICT
// section's prose naming which nutrients count as a daily limit) depend on
// THIS user's own effectiveGoals, not a fixed deploy-wide split. Not
// exported (only streamNutritionChatTurn below reads it), so this is a
// safe, contained conversion -- confirmed no other file imports SYSTEM_PROMPT.
function buildSystemPrompt(effectiveGoals) {
  const { minListForPrompt, maxListForPrompt, maxLabelsProse } = buildMinMaxListsForPrompt(effectiveGoals);
  return `Kamu adalah Bloom — teman ngobrol yang ramah dan santai untuk ibu hamil, seperti
chat biasa, bukan formulir. Kamu paham betul soal kehamilan & gizi, TAPI juga siap diajak ngobrol
soal topik apa pun lainnya (pengetahuan umum, bantuan menulis/coding, hiburan, curhat, dll) —
persis seperti asisten AI pada umumnya, bukan cuma soal kehamilan/gizi.

Setiap pesan dari user termasuk salah satu dari TIGA situasi ini — tentukan "category"-nya lebih dulu:

1) category = "food" — user cerita atau menunjukkan foto tentang makanan/minuman yang sedang/baru dia
   makan/minum (lewat kata-kata dan/atau foto terlampir), ATAU foto label Nutrisi/Nutrition Facts yang
   tercetak pada kemasan makanan/minuman kemasan:
   - meal = nama menu/produknya, dalam Bahasa Indonesia (mis. "Nasi goreng dengan telur", atau nama
     produk kalau dari foto kemasan)
   - isi field gizi "target minimum" berikut (nama field, satuan, nama gizinya):
     ${minListForPrompt}. Isi juga field gizi "batas maksimum harian" berikut (jangan sampai
     terlewat, terutama untuk kopi/teh/makanan kemasan/gorengan/makanan asin/manis):
     ${maxListForPrompt}. Kalau fotonya adalah label kemasan dengan angka gizi tercetak, BACA
     LANGSUNG angka-angka itu dari label — jangan menaksir. Kalau fotonya makanan/minuman biasa (bukan
     label), taksir berdasarkan porsi lazim yang terlihat/disebutkan. Isi 0 untuk yang jelas tidak
     relevan, jangan mengarang angka ekstrem.
   - vitamins = array kosong.
   - extra_nutrients = SEMUA nilai gizi lain yang tercetak/disebutkan selain daftar wajib di atas —
     WAJIB disalin satu per satu kalau ada di label/komposisinya, TERMASUK yang termasuk umum
     sekalipun (mis. Karbohidrat total, Lemak total, Laktosa, Vitamin A, Vitamin C, Fosfor, Kalium,
     Zinc, Omega-3, dll — masing-masing {label, unit, value}). Ini BUKAN cuma daftar contoh
     mikronutrien di atas — salin SEMUA baris gizi yang terlihat/disebut dan belum masuk daftar
     wajib, jangan pilih-pilih. Array kosong HANYA kalau memang tidak ada info gizi tambahan apa pun
     di luar daftar wajib yang terlihat/disebutkan.
   - verdict + verdict_reason — WAJIB diisi untuk kategori ini (lihat aturan lengkap di bagian
     "VERDICT" di bawah).
   - reply = balasan singkat hangat (1-2 kalimat) + satu insight gizi soal menu ini, dan sebutkan
     kalau ini sudah bisa disimpan ke Dashboard lewat tombol di bawah balasanmu.

2) category = "vitamin" — foto atau cerita tentang vitamin/suplemen: label botol vitamin/suplemen,
   ATAU foto/daftar resep dokter yang menyebut satu atau lebih nama vitamin/suplemen:
   - vitamins = array berisi SATU OBJEK PER vitamin/suplemen yang terdeteksi (boleh lebih dari satu
     kalau memang ada beberapa nama disebut/terlihat dalam satu foto/pesan, mis. resep dokter yang
     berisi 2-3 nama produk). Untuk tiap objek:
     - name = nama produknya (mis. "Folamil Genio")
     - isi field gizi berikut untuk produk itu (${minListForPrompt}, ${maxListForPrompt})
       SESUAI ANGKA DI LABEL/KEMASAN kalau terlihat/diketahui (mis. vitamin C effervescent sering
       mencantumkan kandungan natrium/gula di labelnya), isi 0 kalau tidak ada info gizinya (mis. resep
       dokter yang cuma menyebut nama produk tanpa kandungan gizi tercetak) — JANGAN mengarang angka
       pasti untuk produk yang kandungan gizinya tidak kamu ketahui persis.
     - extra_nutrients = SEMUA nilai gizi lain di label selain daftar utama di atas — WAJIB disalin
       satu per satu kalau terlihat, TERMASUK yang umum sekalipun (mis. Karbohidrat, Zinc, Vitamin
       B6, Iodium, dll — masing-masing {label, unit, value}). SEMUA baris gizi di label yang belum
       masuk daftar utama, jangan pilih-pilih. Array kosong HANYA kalau memang tidak ada nutrisi
       tambahan yang terlihat.
   - meal dikosongkan, semua field gizi di level atas 0, extra_nutrients di level atas array kosong
     (tidak dipakai untuk kategori ini — extra_nutrients yang relevan ada DI DALAM tiap objek
     vitamins di atas, bukan di level atas).
   - verdict = "aman", verdict_reason = string kosong (verdict hanya berlaku untuk kategori "food").
   - reply = balasan singkat hangat yang menyebutkan vitamin/suplemen apa saja yang terdeteksi, dan
     sebutkan kalau masing-masing sudah bisa disimpan ke Dashboard lewat tombol di bawah balasanmu.

3) category = "chat" — selain dua di atas: sapaan, curhat, tanya-tanya soal gizi/kehamilan, ATAU
   obrolan/pertanyaan APA PUN yang bukan cerita/foto soal makanan/minuman/vitamin/suplemen spesifik
   (termasuk topik yang sama sekali tidak berkaitan dengan kehamilan/gizi — pengetahuan umum,
   bantuan menulis/coding, hiburan, curhat pribadi, dll):
   - meal kosong, semua field gizi 0, vitamins = array kosong, extra_nutrients = array kosong
   - verdict = "aman", verdict_reason = string kosong.
   - reply = jawab pertanyaannya dengan wajar, hangat, dan membantu — JANGAN menolak atau
     mengalihkan pembicaraan hanya karena topiknya di luar kehamilan/gizi, jawab persis seperti
     asisten AI pada umumnya. Untuk pertanyaan spesifik soal kehamilan/gizi yang butuh penanganan
     medis, sarankan konsultasi ke dokter/bidan alih-alih memberi kepastian; topik lain di luar itu
     tidak perlu disclaimer medis sama sekali.

VERDICT (hanya untuk category = "food"): nilai "verdict" harus salah satu dari "aman" (boleh
dikonsumsi seperti biasa), "waspada" (boleh, tapi baiknya diperhatikan/dibatasi porsinya), atau
"kurangi_dulu" (baiknya porsinya dikurangi dulu untuk saat ini). Pertimbangkan DUA hal: (a)
komposisi menu ini sendiri, terutama field "batas maksimum harian" di atas, dan (b) kalau ada baris
"[Konteks asupan hari ini ...]" di awal pesan user — itu bukan tulisan dari user, itu konteks
asupan ${maxLabelsProse || "gula/natrium/kolesterol/lemak jenuh/kafein"} yang SUDAH tercatat hari ini
SEBELUM menu ini, disisipkan otomatis oleh sistem. Pakai itu untuk menilai apakah menambah menu ini membuat totalnya
lewat batas harian. Jangan pernah mengutip ulang atau menganggap baris itu sebagai bagian dari
obrolan si user.

ATURAN NADA untuk verdict_reason (WAJIB dipatuhi, terutama kalau verdict-nya bukan "aman"):
tulis dengan nada hangat dan suportif seperti teman dekat, SAMA SEKALI JANGAN terdengar menakuti
atau seperti peringatan medis. JANGAN pakai kata-kata seperti "jangan", "berbahaya", "dilarang",
"bahaya". Untuk verdict "waspada"/"kurangi_dulu", verdict_reason WAJIB memasangkan alasannya dengan
satu saran yang lembut dan membangun (mis. "Boleh kok, tapi kopinya cukup satu cangkir dulu hari
ini ya, natriumnya sudah lumayan dari menu sebelumnya." — BUKAN "Kopi ini berbahaya, jangan
diminum."). Maksimal 1-2 kalimat pendek, konsisten dengan gaya reply yang santai di atas.

Bloom BISA mencatat nutrisi/komposisi apa pun yang tercetak di label atau disebutkan user, tidak
cuma daftar gizi wajib di atas — semuanya otomatis masuk ke extra_nutrients (lihat aturan di atas).
Kalau user bertanya/komplain kenapa suatu nilai gizi (mis. karbohidrat) tidak muncul di analisis
sebelumnya, JANGAN PERNAH bilang itu di luar cakupan/tidak didukung Bloom — akui itu memang harus
ikut tercatat, dan minta dia foto ulang/kirim ulang labelnya kalau nilainya belum sempat masuk.

Riwayat percakapan sebelumnya (kalau ada) disertakan sebagai konteks — sambungkan obrolan dengan wajar
dan jangan mengulang sapaan pembuka kalau sudah pernah menyapa sebelumnya.

Jawab HANYA dalam JSON sesuai skema yang diberikan.`;
}

function toSafeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const MAX_VITAMIN_ITEMS = 10; // defensive cap, same spirit as the string-length caps below
const MAX_EXTRA_NUTRIENTS_PER_ITEM = 20;

// Shared by sanitizeVitaminItem's per-item extra_nutrients AND
// sanitizeChatTurnResult's top-level (food-category) extra_nutrients below —
// same {label, unit, value} shape either way (see buildExtraNutrientItemSchema
// above). Incomplete entries (no label) are dropped, not kept as a blank row.
function sanitizeExtraNutrientsList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((e) => ({
      label: String(e?.label || "").trim().slice(0, 60),
      unit: String(e?.unit || "").trim().slice(0, 20),
      value: toSafeNumber(e?.value),
    }))
    .filter((e) => e.label)
    .slice(0, MAX_EXTRA_NUTRIENTS_PER_ITEM);
}

// One raw `vitamins[]` item from Gemini -> a sanitized item, or null if it has
// no usable name (dropped from the array entirely rather than kept as a blank
// card with a "Simpan ke Dashboard" button pointing at nothing).
function sanitizeVitaminItem(item) {
  const name = String(item?.name || "").trim().slice(0, 200);
  if (!name) return null;
  const safeItem = { name };
  ALL_TRACKED_NUTRIENTS.forEach((n) => { safeItem[n] = toSafeNumber(item?.[n]); });
  safeItem.extra_nutrients = sanitizeExtraNutrientsList(item?.extra_nutrients);
  return safeItem;
}

// Turns Gemini's raw parsed JSON into the shape the rest of the app relies on.
// Exported (and kept free of any network/DOM dependency) so it's directly
// unit-testable. `category` is only trusted when it's one of the three known
// values AND that branch actually has something worth acting on (a named
// `meal` for "food", at least one named item for "vitamin") — otherwise it's
// downgraded to "chat" rather than surfacing an empty/broken "Simpan ke
// Dashboard" card for nothing. `verdict`/`verdict_reason` are food-specific
// (see the SYSTEM_PROMPT's VERDICT section) — blanked out for every other
// category regardless of what Gemini actually returned, same defensive
// "only the active branch's fields are trusted" rule as the nutrient fields.
export function sanitizeChatTurnResult(parsed) {
  const reply = String(parsed?.reply || "").slice(0, 800);
  const safe = { category: "chat", meal: "", vitamins: [], extra_nutrients: [], verdict: "", verdict_reason: "", reply };
  ALL_TRACKED_NUTRIENTS.forEach((n) => { safe[n] = 0; });

  if (parsed?.category === "food") {
    const meal = String(parsed?.meal || "").trim().slice(0, 200);
    if (meal) {
      safe.category = "food";
      safe.meal = meal;
      ALL_TRACKED_NUTRIENTS.forEach((n) => { safe[n] = toSafeNumber(parsed?.[n]); });
      safe.extra_nutrients = sanitizeExtraNutrientsList(parsed?.extra_nutrients);
      safe.verdict = VERDICT_VALUES.includes(parsed?.verdict) ? parsed.verdict : "";
      safe.verdict_reason = String(parsed?.verdict_reason || "").trim().slice(0, 400);
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
function parseCommaList(envValue) {
  return (envValue || "").split(",").map((m) => m.trim()).filter(Boolean);
}

function getChatModelChain() {
  const primary = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-pro";
  return [primary, ...parseCommaList(process.env.GEMINI_CHAT_FALLBACK_MODELS)];
}

function getLowModelChain() {
  const primary = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  return [primary, ...parseCommaList(process.env.GEMINI_FALLBACK_MODELS)];
}

// GEMINI_API_KEY_FALLBACKS: same idea, one dimension over — a comma list of
// further API keys to try if the primary one is exhausted/invalid.
//
// Tier-aware, same split as the model chains above, and fully opt-in/
// backward-compatible: GEMINI_CHAT_API_KEY is a NEW, optional env var — set
// it to give the chat tier (streamNutritionChatTurn, streamTranscribeVoiceNote)
// its own dedicated key/quota, separate from the low/utility tier's cron
// calls (generateDailyNudge, generateMealFact). Leave it unset and nothing
// changes: every call site keeps sharing GEMINI_API_KEY exactly like before
// this tiering existed. The low tier (and the chat tier's own last-resort
// drop to the low tier on total failure, see fetchGeminiForChat below)
// always uses GEMINI_API_KEY -- there's no "dedicated utility key" env var,
// since GEMINI_API_KEY already *is* that one, unconditionally.
function getApiKeyChain(tier) {
  if (tier === "chat" && process.env.GEMINI_CHAT_API_KEY) {
    const primary = process.env.GEMINI_CHAT_API_KEY;
    return [primary, ...parseCommaList(process.env.GEMINI_CHAT_API_KEY_FALLBACKS)].filter(Boolean);
  }
  const primary = process.env.GEMINI_API_KEY;
  return [primary, ...parseCommaList(process.env.GEMINI_API_KEY_FALLBACKS)].filter(Boolean);
}

// Tries each model in `models` in order, and — nested inside each model —
// every API key in getApiKeyChain() in order, before moving to the next
// model (key-inner: a dead key gets retried on the *next* model too, rather
// than exhausting every model on just that one key first — chosen since a
// genuinely broken model isn't fixed by cycling keys on it, but a genuinely
// broken key might still work fine on a different model). `buildUrl(model,
// apiKey)` builds that attempt's request URL, otherwise identical to a
// single fetchGeminiWithRetries call (same per-model retry policy for
// 500/502/503/504). Moves to the next (key, then model) on ANY
// GeminiHttpError from the current attempt — not just 429 (quota), also e.g.
// 404 (Google retired/renamed the model — happened in practice:
// gemini-2.5-pro started returning "no longer available to new users" one
// day with no code change here), 400/403 (a bad or revoked key), etc. A raw
// non-HTTP exception (network failure — fetchGeminiWithRetries never wraps
// those in GeminiHttpError, see its own comment) still isn't caught here, so
// it still propagates immediately without cycling anything for something no
// key or model in the chains could fix anyway. Never logs an actual key
// value, only its 1-based position — keys are secrets. Throws the "belum
// diisi" error up front if there isn't even one usable key (this used to be
// checked separately at each of the 4 call sites; now it's just here).
// Returns { res, model } for whichever model actually served the request.
//
// Tradeoff worth knowing: for the low tier (generateDailyNudge/
// generateMealFact, called inside app/api/cron/reminders/route.js's 60s
// batch budget), a 500/502/503/504 that survives all of *its own* retries
// already costs ~26s for one model (CRON_GEMINI_TIMEOUT_MS's own comment) —
// that exhausted failure now advances to the next key, then the next model,
// so a long GEMINI_FALLBACK_MODELS/GEMINI_API_KEY_FALLBACKS chain multiplies
// that cost per user (models × keys, worst case). Accepted since the cron
// route already degrades per-user on any failure regardless of how long it
// took to get there (see generateDailyNudge/generateMealFact below).
async function tryModelChain(models, buildUrl, requestBody, opts, keyTier) {
  const keys = getApiKeyChain(keyTier);
  if (keys.length === 0) throw new Error("GEMINI_API_KEY belum diisi di .env.local / Vercel (lihat README).");
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const isLastModel = i === models.length - 1;
    for (let j = 0; j < keys.length; j++) {
      const apiKey = keys[j];
      const isLastKey = j === keys.length - 1;
      try {
        const res = await fetchGeminiWithRetries(buildUrl(model, apiKey), requestBody, opts);
        return { res, model };
      } catch (e) {
        if (!(e instanceof GeminiHttpError) || (isLastModel && isLastKey)) throw e;
        const next = isLastKey ? `model "${models[i + 1]}" (API key #1)` : `API key #${j + 2}`;
        console.warn(`Gemini model "${model}" (API key #${j + 1}) failed (status ${e.status}), falling back to ${next}`);
      }
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
// in it fails (any GeminiHttpError — same "fall back on anything" reasoning
// as tryModelChain above) do they fall through to the low tier as an
// absolute last resort — some answer (even from a weaker model) beats none.
// Callers use the returned `usedLowerTier` flag to attach GEMINI_LOWER_TIER_NOTICE.
async function fetchGeminiForChat(buildUrl, requestBody, opts) {
  try {
    const { res, model } = await tryModelChain(getChatModelChain(), buildUrl, requestBody, opts, "chat");
    return { res, model, usedLowerTier: false };
  } catch (e) {
    if (!(e instanceof GeminiHttpError)) throw e;
    console.warn(`Every chat-tier Gemini model failed (last status ${e.status}), falling back to the low tier`);
    // "low" here too, not "chat" -- once you're already using the low tier's
    // *model* as a last resort, use its *key* too (GEMINI_API_KEY), so a
    // dedicated GEMINI_CHAT_API_KEY being exhausted/invalid doesn't also take
    // this fallback attempt down with it.
    const { res, model } = await tryModelChain(getLowModelChain(), buildUrl, requestBody, opts, "low");
    return { res, model, usedLowerTier: true };
  }
}

// Low-tier calls only ever use the low tier chain — there's nothing lower to
// fall to, and a total failure here is already handled by the cron route's
// own fallback copy (see the comment above generateDailyNudge below).
async function fetchGeminiForLowTier(buildUrl, requestBody, opts) {
  const { res } = await tryModelChain(getLowModelChain(), buildUrl, requestBody, opts, "low");
  return res;
}

// Builds the bracketed "[Konteks asupan hari ini ...]" line the SYSTEM_PROMPT's
// VERDICT section refers to — one clause per max-type nutrient (per THIS
// user's own effectiveGoals, not the fixed LIMIT_ORDER) already consumed
// today (already-saved meals + checked vitamins only, see
// app/api/nutrition-chat/route.js for where dailyLimitTotals/effectiveGoals
// come from) — so Gemini's verdict can reason about today's cumulative
// intake, not just this one item in isolation. Returns null when there's
// nothing to add (no `dailyLimitTotals` passed, e.g. a caller that hasn't
// wired it up, no max-type keys at all, or every value is exactly 0) so
// callers never prepend an empty/pointless line.
function buildDailyContextHint(dailyLimitTotals, effectiveGoals) {
  if (!dailyLimitTotals) return null;
  const maxKeys = effectiveGoals
    ? ALL_TRACKED_NUTRIENTS.filter((k) => effectiveGoals[k]?.goalType === "max")
    : LIMIT_ORDER; // no effectiveGoals passed -- fall back to today's fixed split, same as buildMinMaxListsForPrompt's own fallback
  const hasAny = maxKeys.some((k) => (Number(dailyLimitTotals[k]) || 0) > 0);
  if (!hasAny) return null;
  const parts = maxKeys.map((k) => {
    const used = Math.round((Number(dailyLimitTotals[k]) || 0) * 10) / 10;
    const goal = effectiveGoals?.[k];
    const label = goal?.label || LIMIT_META[k]?.label || k;
    const unit = goal?.unit ?? LIMIT_META[k]?.unit ?? "";
    const target = goal?.targetValue ?? LIMITS[k];
    return `${label} ${used}${unit} dari batas ${target}${unit}`;
  });
  return `[Konteks asupan hari ini sebelum menu ini: ${parts.join(", ")}.]`;
}

function buildContents({ message, image, history, contextHint }) {
  const contents = (history || []).map((h) => ({
    role: h.role === "assistant" ? "model" : "user",
    parts: [{ text: h.text || "" }],
  }));
  const currentParts = [];
  const textWithContext = contextHint ? `${contextHint}\n${message || ""}`.trim() : message;
  if (textWithContext) currentParts.push({ text: textWithContext });
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
//
// `dailyLimitTotals` (optional): today's already-saved cumulative totals for
// every ALL_TRACKED_NUTRIENTS column (see app/api/nutrition-chat/route.js,
// which fetches it server-side before calling this) — folded into the
// prompt via buildDailyContextHint so the food-category verdict can reason
// about today's intake so far, not just this one item.
//
// `effectiveGoals` (optional): this user's resolveEffectiveGoals result
// (lib/nutrition.js) — decides, per nutrient, whether it's currently a
// "target minimum" or "batas maksimum harian" field for THIS user (see
// buildSystemPrompt/buildDailyContextHint). Omitted → both fall back to
// today's fixed NUTRIENT_ORDER=min/LIMIT_ORDER=max split, same as before
// this parameter existed.
export async function streamNutritionChatTurn({ message, image, history, dailyLimitTotals, effectiveGoals }, onDelta) {
  // Chat tier: best-model-first, with a last-resort drop to the low tier if
  // every chat-tier model is exhausted (see fetchGeminiForChat above) —
  // override the default model via GEMINI_CHAT_MODEL/GEMINI_CHAT_FALLBACK_MODELS,
  // and/or add more API keys via GEMINI_API_KEY_FALLBACKS, in .env.local/Vercel
  // without a code change (see README).
  const { res, model, usedLowerTier } = await fetchGeminiForChat(
    (model, apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      systemInstruction: { parts: [{ text: buildSystemPrompt(effectiveGoals) }] },
      contents: buildContents({ message, image, history, contextHint: buildDailyContextHint(dailyLimitTotals, effectiveGoals) }),
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
  // Chat tier, same as streamNutritionChatTurn — this reads an attached audio
  // clip, so it stays on the best-model tier too (see fetchGeminiForChat).
  const { res, model, usedLowerTier } = await fetchGeminiForChat(
    (model, apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`,
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
  const contextLine = trimester && weeks != null
    ? `Konteks: pengguna sedang trimester ${trimester.slice(1)}, usia kehamilan minggu ke-${weeks}.`
    : "Konteks: usia kehamilan pengguna belum diketahui — tulis kalimat yang umum berlaku di semua trimester.";

  // Low tier — no user watching, text-only, cheapest model that answers
  // reliably is fine (see fetchGeminiForLowTier above).
  const res = await fetchGeminiForLowTier(
    (model, apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
//
// Called once per distinct trimester BUCKET present among that run's lunch
// subscribers (route.js), not once per user -- `trimester` here is the
// bucket's trimester ("t1"|"t2"|"t3"|null for the "unknown" bucket), not any
// one individual's exact gestational week (there's no single `weeks` value
// that represents a whole bucket, so that param is gone). `avoidFacts`: this
// same bucket's own fact history from the last 7 days
// (supabase/schema.sql's meal_fact_history, filtered by trimester) -- fed to
// Gemini as a "don't repeat these" instruction. Best-effort: if Gemini
// repeats one anyway, the caller uses it and just logs a warning, no retry.

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

Kalau ada daftar "fakta yang sudah dipakai" di konteks, JANGAN membuat fakta yang sama atau mirip
persis dengan salah satunya — buat fakta yang berbeda.

Jangan menyebut nama produk/merek, jangan mengulang ajakan "waktunya makan siang" (itu sudah ada di
bagian lain notifikasi) — tulis HANYA fakta gizinya. Jawab HANYA dalam JSON sesuai skema yang diberikan.`;

export async function generateMealFact({ trimester, avoidFacts } = {}) {
  const trimesterLine = trimester
    ? `Konteks: pengguna sedang trimester ${trimester.slice(1)}.`
    : "Konteks: usia kehamilan pengguna belum diketahui — tulis fakta yang umum berlaku di semua trimester.";
  const avoidLine = avoidFacts && avoidFacts.length > 0
    ? ` Fakta yang SUDAH dipakai 7 hari terakhir untuk konteks ini (JANGAN ulangi salah satu dari ini, buat yang beda): ${avoidFacts.map((f) => `"${f}"`).join("; ")}.`
    : "";
  const contextLine = `${trimesterLine}${avoidLine}`;

  // Low tier, same as generateDailyNudge above.
  const res = await fetchGeminiForLowTier(
    (model, apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
