import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { streamNutritionChatTurn, isGeminiBusyError, GEMINI_BUSY_MESSAGE } from "@/lib/gemini";
import { LIMIT_ORDER, groupLimitTotalsByUser, mergeUserTotals } from "@/lib/nutrition";

// This app's only backend route: a thin, authenticated proxy in front of the
// Gemini API for the in-app nutrition chat (app/dashboard/chat/page.js). It
// never *writes* to the database — the client inserts the resulting meal
// itself via its own already-authenticated Supabase client (same RLS-backed
// path as every other write in this app). It does now do one read-only
// fetch (fetchDailyLimitTotals below) — today's already-saved cumulative
// sugar/sodium/etc. totals, so Gemini's food-category verdict can reason
// about the whole day, not just the item in front of it. Existing purely so
// the Gemini API key never reaches the browser.
//
// Streams its response as newline-delimited JSON so the reply can appear
// progressively instead of all at once after the whole turn finishes:
//   {"type":"delta","text":"..."}   — zero or more, as Gemini generates the reply
//   {"type":"done","result":{...}}  — once, the full sanitized turn result
//   {"type":"error","error":"..."}  — instead of "done", if something failed
// Auth/validation failures happen before any of that, as a normal JSON
// response with a real status code — only once streaming has actually
// started are errors reported this way (HTTP headers are already sent by then).
export const runtime = "nodejs";
export const maxDuration = 60;

// Client already downsizes photos before sending (see resizeImageForChat in
// the chat page) — this is just a server-side backstop against a modified
// client or a direct API call.
const MAX_BASE64_LENGTH = 8_000_000; // ~6MB decoded
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_TURNS = 12;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// `date`: client-supplied browser-local todayISO() (lib/nutrition.js) — same
// "today" the Dashboard already uses, not a server-side timezone guess.
// Missing/malformed → null, and the caller just skips the daily-context hint
// entirely (never blocks the chat turn over this). Uses the same
// already-authenticated `supabase` (RLS auto-scopes every query to `userId`,
// same as every other read in this app) — no admin client, no new privilege.
// Sums today's meals + every checked vitamin's LIMIT_ORDER columns via the
// same groupLimitTotalsByUser/mergeUserTotals helpers the cron route's
// multi-user dinner-slot check uses (lib/nutrition.js), just for one user.
async function fetchDailyLimitTotals(supabase, userId, date) {
  if (!date || !DATE_RE.test(date)) return null;
  const limitCols = LIMIT_ORDER.join(",");
  const [{ data: mealRows }, { data: checkRows }] = await Promise.all([
    supabase.from("meals").select(`user_id, ${limitCols}`).eq("user_id", userId).eq("date", date),
    supabase.from("vitamin_checks").select("vitamin_id").eq("user_id", userId).eq("date", date).eq("checked", true),
  ]);
  const vitaminIds = (checkRows || []).map((c) => c.vitamin_id);
  let vitaminRows = [];
  if (vitaminIds.length > 0) {
    const { data } = await supabase.from("vitamins").select(`id, ${limitCols}`).in("id", vitaminIds);
    vitaminRows = (data || []).map((v) => ({ ...v, user_id: userId }));
  }
  const totalsByUser = mergeUserTotals(groupLimitTotalsByUser(mealRows || []), groupLimitTotalsByUser(vitaminRows));
  return totalsByUser[userId] || null;
}

export async function POST(request) {
  const supabase = getSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Kamu perlu login dulu." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid." }, { status: 400 });
  }

  const message = typeof body?.message === "string" ? body.message.trim().slice(0, MAX_MESSAGE_LENGTH) : "";
  const image = body?.image?.base64 && body?.image?.mimeType ? body.image : null;
  if (!message && !image) {
    return NextResponse.json({ error: "Tulis sesuatu atau lampirkan foto dulu." }, { status: 400 });
  }
  if (image && image.base64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "Foto terlalu besar. Coba foto lain atau perkecil dulu." }, { status: 413 });
  }

  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-MAX_HISTORY_TURNS)
        .filter((h) => h && (h.role === "user" || h.role === "assistant"))
        .map((h) => ({ role: h.role, text: String(h.text || "").slice(0, MAX_MESSAGE_LENGTH) }))
    : [];

  // Best-effort — a failure here (bad date, transient DB hiccup) just means
  // Gemini's verdict reasons without today's-intake context, same as any
  // caller that hasn't wired `today` up at all; it never blocks the chat turn.
  let dailyLimitTotals = null;
  try {
    dailyLimitTotals = await fetchDailyLimitTotals(supabase, user.id, typeof body?.today === "string" ? body.today : null);
  } catch (e) {
    console.error("nutrition-chat daily-context fetch error:", e);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await streamNutritionChatTurn({ message, image, history, dailyLimitTotals }, (delta) => {
          send({ type: "delta", text: delta });
        });
        send({ type: "done", result });
      } catch (e) {
        console.error("nutrition-chat stream error:", e);
        // A retryable GeminiHttpError (503) already survived a couple of
        // retries (see fetchGeminiWithRetries in lib/gemini.js) by the time
        // it gets here; a 429 never retries at all (see the comment on
        // RETRYABLE_STATUS there) — either way, this is what's shown once
        // Gemini itself won't cooperate.
        send({
          type: "error",
          error: isGeminiBusyError(e) ? GEMINI_BUSY_MESSAGE : "Ada gangguan pas memproses pesannya. Coba lagi sebentar lagi.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
