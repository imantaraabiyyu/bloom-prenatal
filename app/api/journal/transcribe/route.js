import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { streamTranscribeVoiceNote, isGeminiBusyError, GEMINI_BUSY_MESSAGE } from "@/lib/gemini";

// Second (and only other) backend route in this app, alongside
// /api/nutrition-chat — same shape: a thin authenticated proxy to Gemini,
// no database access at all. Used by the journal composer (see
// transcribePendingVoice in app/dashboard/journal/page.js) to turn a
// just-recorded voice note into a verbatim transcript + a tidied version
// the user can drop straight into their journal note, before the entry is
// even saved.
//
// Streams its response as newline-delimited JSON, same protocol as
// nutrition-chat:
//   {"type":"progress","transcript":"...","tidiedNote":"..."} — as text fills in
//   {"type":"done","result":{...}}  — once, the final sanitized result
//   {"type":"error","error":"..."}  — instead of "done", if something failed
export const runtime = "nodejs";
export const maxDuration = 60;

// A 10-minute voice note (MAX_RECORDING_SECONDS in lib/journal.js) at
// typical browser voice-recording bitrates is a couple MB at most — this is
// a generous ceiling above that, not a real-world limit.
const MAX_AUDIO_BASE64_LENGTH = 15_000_000; // ~11MB decoded

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

  const audio = body?.audio;
  if (!audio?.base64 || !audio?.mimeType) {
    return NextResponse.json({ error: "Lampirkan audio voice note dulu." }, { status: 400 });
  }
  if (audio.base64.length > MAX_AUDIO_BASE64_LENGTH) {
    return NextResponse.json({ error: "Rekamannya terlalu besar untuk ditranskrip." }, { status: 413 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await streamTranscribeVoiceNote({ base64: audio.base64, mimeType: audio.mimeType }, (progress) => {
          send({ type: "progress", ...progress });
        });
        send({ type: "done", result });
      } catch (e) {
        console.error("journal transcribe stream error:", e);
        send({
          type: "error",
          error: isGeminiBusyError(e) ? GEMINI_BUSY_MESSAGE : "Gagal mentranskrip voice note ini. Coba lagi sebentar lagi.",
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
