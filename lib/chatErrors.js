// Client-safe (no server-only import) helpers for the chat page
// (app/dashboard/chat/page.js): turning whatever went wrong on a chat turn
// into one clear, actionable notice, and building the text a tapped bubble
// copies. Kept free of DOM/network dependencies so they're unit-testable.

// `code` values the route (app/api/nutrition-chat/route.js) puts on its JSON
// error responses and stream "error" events.
export const CHAT_ERROR_MESSAGES = {
  auth: "Sesi kamu sudah habis, silakan login ulang lalu kirim lagi pesannya.",
  network: "Koneksi internet terputus. Cek jaringanmu lalu kirim ulang ya.",
  busy: "Gemini API lagi dibatasi kuotanya, belum bisa diproses sekarang. Coba lagi beberapa saat lagi ya.",
  too_large: "Fotonya terlalu besar. Coba foto lain atau perkecil dulu.",
  invalid: "Pesannya belum bisa diproses. Tulis sesuatu atau lampirkan foto dulu.",
  generic: "Ada gangguan pas memproses pesannya. Coba kirim ulang sebentar lagi.",
};

// Input: { status?, code?, serverMessage?, networkFailure? }.
// `code` wins when present; otherwise falls back to the HTTP status so an
// older/unknown response shape still classifies sensibly. A server-provided
// message is kept for "invalid"/"too_large"/"generic" (it can be more
// specific than ours) but never for "auth"/"network"/"busy", whose wording
// is fixed here so the user always sees the same call to action.
export function classifyChatError({ status, code, serverMessage, networkFailure } = {}) {
  let kind = "generic";
  if (networkFailure) kind = "network";
  else if (code && CHAT_ERROR_MESSAGES[code]) kind = code;
  else if (status === 401 || status === 403) kind = "auth";
  else if (status === 413) kind = "too_large";
  else if (status === 400) kind = "invalid";
  else if (status === 429 || status === 503) kind = "busy";

  const useServerText = ["invalid", "too_large", "generic"].includes(kind) && serverMessage;
  return {
    kind,
    message: useServerText ? serverMessage : CHAT_ERROR_MESSAGES[kind],
    needsLogin: kind === "auth",
  };
}

// The text a tapped bubble copies: its plain message text, the formatted
// analysis (meal/vitamin detail + reply), and the verdict line if any — the
// same visible content, minus buttons/badges chrome. Empty for a streaming
// placeholder or an error notice (nothing worth copying).
export function buildBubbleCopyText({ text, analysisText, verdictLabel, verdictReason, streaming, isError } = {}) {
  if (streaming || isError) return "";
  const verdict = verdictLabel ? `${verdictLabel}${verdictReason ? ` — ${verdictReason}` : ""}` : "";
  return [text, analysisText, verdict].filter((p) => p && String(p).trim()).join("\n\n").trim();
}
