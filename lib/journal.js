// Shared constants for the pregnancy journal (notes + mood + media attachments).

export const MOODS = [
  { key: "senang", emoji: "😊", label: "Senang" },
  { key: "tenang", emoji: "😌", label: "Tenang" },
  { key: "biasa", emoji: "😐", label: "Biasa" },
  { key: "cemas", emoji: "😟", label: "Cemas" },
  { key: "lelah", emoji: "😴", label: "Lelah" },
  { key: "mual", emoji: "🤢", label: "Mual" },
  { key: "sedih", emoji: "😢", label: "Sedih" },
];

export function moodMeta(key) {
  return MOODS.find((m) => m.key === key) || null;
}

// ---------------- media attachments ----------------

export const JOURNAL_BUCKET = "journal-media";

// Supabase free tier caps uploads around 50MB/file — stay safely under that so
// the error is a friendly one from us, not a raw storage 413. This is checked
// client-side here AND server-side (storage.buckets.file_size_limit in
// supabase/schema.sql) — keep the two numbers in sync if either changes.
export const MAX_ATTACHMENT_MB = 45;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

// Per-entry cap so a misclick (selecting hundreds of photos) can't blow
// through the free tier's 1GB total storage in one save.
export const MAX_ATTACHMENTS_PER_ENTRY = 10;

// Auto-stop a voice note recording at 10 minutes so a forgotten mic can't
// quietly grow past the file-size limit before the user notices.
export const MAX_RECORDING_SECONDS = 600;

export const ATTACHMENT_KINDS = {
  photo: { label: "Foto", accept: "image/*", mimePrefix: "image/", icon: "🖼️" },
  video: { label: "Video", accept: "video/*", mimePrefix: "video/", icon: "🎬" },
  voice: { label: "Voice note", accept: "audio/*", mimePrefix: "audio/", icon: "🎙️" },
};

// Client-side mirror of the bucket's allowed_mime_types check — lets us
// reject an obviously-wrong file (mislabeled extension aside) before ever
// starting the upload.
export function isAcceptedMime(kind, mimeType) {
  const prefix = ATTACHMENT_KINDS[kind]?.mimePrefix;
  return !!prefix && typeof mimeType === "string" && mimeType.startsWith(prefix);
}

// Storage path convention: {user_id}/{entry_id}/{timestamp}-{filename}. The
// leading user_id segment is what the storage.objects RLS policies check, so
// don't change this shape without updating supabase/schema.sql to match.
export function attachmentPath(userId, entryId, filename) {
  const safeName = (filename || "file").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `${userId}/${entryId}/${Date.now()}-${safeName}`;
}
