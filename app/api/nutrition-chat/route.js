import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { nutritionChatTurn } from "@/lib/gemini";

// This app's only backend route: a thin, authenticated proxy in front of the
// Gemini API for the in-app nutrition chat (app/dashboard/chat/page.js). It
// never touches the database — the client inserts the resulting meal itself
// via its own already-authenticated Supabase client (same RLS-backed path as
// every other write in this app). Existing purely so the Gemini API key
// never reaches the browser.
export const runtime = "nodejs";
export const maxDuration = 60; // Gemini's vision call can take a few seconds

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

  // Defense-in-depth same as MAX_BASE64_LENGTH above — the client only ever
  // sends its own recent messages, but don't trust that blindly server-side.
  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-MAX_HISTORY_TURNS)
        .filter((h) => h && (h.role === "user" || h.role === "assistant"))
        .map((h) => ({ role: h.role, text: String(h.text || "").slice(0, MAX_MESSAGE_LENGTH) }))
    : [];

  try {
    const result = await nutritionChatTurn({ message, image, history });
    return NextResponse.json({ result });
  } catch (e) {
    console.error("nutrition-chat turn error:", e);
    return NextResponse.json({ error: "Ada gangguan pas memproses pesannya. Coba lagi sebentar lagi." }, { status: 502 });
  }
}
