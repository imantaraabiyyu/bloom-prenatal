import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { analyzeFoodImage } from "@/lib/gemini";

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

  const image = body?.image;
  if (!image?.base64 || !image?.mimeType) {
    return NextResponse.json({ error: "Lampirkan foto makanan dulu." }, { status: 400 });
  }
  if (image.base64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "Foto terlalu besar. Coba foto lain atau perkecil dulu." }, { status: 413 });
  }

  try {
    const result = await analyzeFoodImage(image.base64, image.mimeType);
    return NextResponse.json({ result });
  } catch (e) {
    console.error("nutrition-chat analyze error:", e);
    return NextResponse.json({ error: "Ada gangguan pas menganalisis fotonya. Coba lagi sebentar lagi." }, { status: 502 });
  }
}
