import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { streamNutritionChatTurn } from "@/lib/gemini";

// This app's only backend route: a thin, authenticated proxy in front of the
// Gemini API for the in-app nutrition chat (app/dashboard/chat/page.js). It
// never touches the database — the client inserts the resulting meal itself
// via its own already-authenticated Supabase client (same RLS-backed path as
// every other write in this app). Existing purely so the Gemini API key
// never reaches the browser.
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await streamNutritionChatTurn({ message, image, history }, (delta) => {
          send({ type: "delta", text: delta });
        });
        send({ type: "done", result });
      } catch (e) {
        console.error("nutrition-chat stream error:", e);
        send({ type: "error", error: "Ada gangguan pas memproses pesannya. Coba lagi sebentar lagi." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
