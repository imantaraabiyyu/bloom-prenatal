"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { todayISO } from "@/lib/nutrition";
import {
  MOODS, moodMeta, ATTACHMENT_KINDS,
  JOURNAL_BUCKET, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_MB, MAX_ATTACHMENTS_PER_ENTRY, MAX_RECORDING_SECONDS,
  attachmentPath, isAcceptedMime,
} from "@/lib/journal";

function formatSeconds(s) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function sortEntries(a, b) {
  if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1;
  return a.created_at < b.created_at ? 1 : -1;
}

export default function JournalPage() {
  const router = useRouter();
  const supabase = useMemo(() => {
    try { return getSupabaseClient(); } catch (e) { return null; }
  }, []);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState([]);

  const [entryDate, setEntryDate] = useState(todayISO());
  const [mood, setMood] = useState(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // pending attachments for the entry currently being composed
  const [pendingPhotos, setPendingPhotos] = useState([]); // [{ file, url }]
  const [pendingVideos, setPendingVideos] = useState([]); // [{ file, url }]
  const [pendingVoiceNotes, setPendingVoiceNotes] = useState([]); // [{ blob, url, mimeType }]
  const [attachError, setAttachError] = useState("");

  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const streamRef = useRef(null);

  // builds signed URLs for private-bucket attachments (~1h validity)
  async function withSignedUrls(attachmentRows) {
    if (!attachmentRows || attachmentRows.length === 0) return [];
    const paths = attachmentRows.map((a) => a.storage_path);
    const { data } = await supabase.storage.from(JOURNAL_BUCKET).createSignedUrls(paths, 3600);
    const urlByPath = {};
    (data || []).forEach((d) => { if (d?.signedUrl) urlByPath[d.path] = d.signedUrl; });
    return attachmentRows.map((a) => ({ ...a, url: urlByPath[a.storage_path] || null }));
  }

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      const u = sessionData.session.user;
      setUser(u);

      const { data: rows } = await supabase
        .from("journal_entries")
        .select("*")
        .eq("user_id", u.id)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });

      const { data: attRows } = await supabase
        .from("journal_attachments")
        .select("*")
        .eq("user_id", u.id)
        .order("created_at", { ascending: true });

      const byEntry = {};
      (attRows || []).forEach((a) => { (byEntry[a.entry_id] ||= []).push(a); });

      const withAttachments = await Promise.all((rows || []).map(async (e) => ({
        ...e, attachments: await withSignedUrls(byEntry[e.id] || []),
      })));

      setEntries(withAttachments);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, router]);

  // stop any in-progress recording / timer if the user navigates away
  useEffect(() => {
    return () => {
      clearInterval(recordTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // safety net: auto-stop a forgotten recording instead of letting it grow
  // past the file-size limit
  useEffect(() => {
    if (isRecording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
      setAttachError(`⚠ Rekaman dihentikan otomatis di batas ${Math.round(MAX_RECORDING_SECONDS / 60)} menit.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordSeconds, isRecording]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // ---------------- attachments: pick files ----------------
  function pendingCount() {
    return pendingPhotos.length + pendingVideos.length + pendingVoiceNotes.length;
  }

  function addPendingFiles(kind, fileList) {
    setAttachError("");
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    // cap first so type/size checks below only run on files that have room
    const room = Math.max(MAX_ATTACHMENTS_PER_ENTRY - pendingCount(), 0);
    const withinCap = files.slice(0, room);
    const overCap = files.length - withinCap.length;

    const wrongType = withinCap.filter((f) => !isAcceptedMime(kind, f.type));
    const rightType = withinCap.filter((f) => isAcceptedMime(kind, f.type));
    const oversized = rightType.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const ok = rightType.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);

    const withUrls = ok.map((file) => ({ file, url: URL.createObjectURL(file) }));
    if (kind === "photo") setPendingPhotos((prev) => [...prev, ...withUrls]);
    else setPendingVideos((prev) => [...prev, ...withUrls]);

    const problems = [];
    if (wrongType.length > 0) problems.push(`${wrongType.length} file bukan ${ATTACHMENT_KINDS[kind].label.toLowerCase()} yang valid`);
    if (oversized.length > 0) problems.push(`${oversized.length} file lebih besar dari ${MAX_ATTACHMENT_MB}MB`);
    if (overCap > 0) problems.push(`${overCap} file dilewati (maks ${MAX_ATTACHMENTS_PER_ENTRY} lampiran per catatan)`);
    if (problems.length > 0) setAttachError(`⚠ ${problems.join(" · ")}.`);
  }

  function removePending(kind, idx) {
    const setter = kind === "photo" ? setPendingPhotos : kind === "video" ? setPendingVideos : setPendingVoiceNotes;
    setter((prev) => {
      const item = prev[idx];
      if (item?.url) URL.revokeObjectURL(item.url);
      return prev.filter((_, i) => i !== idx);
    });
  }

  // ---------------- attachments: record voice note ----------------
  async function startRecording() {
    setAttachError("");
    if (pendingCount() >= MAX_ATTACHMENTS_PER_ENTRY) {
      setAttachError(`⚠ Maksimal ${MAX_ATTACHMENTS_PER_ENTRY} lampiran per catatan.`);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setAttachError("⚠ Browser ini tidak mendukung rekam suara.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm" : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (blob.size > MAX_ATTACHMENT_BYTES) {
          setAttachError(`⚠ Rekaman terlalu besar (lebih dari ${MAX_ATTACHMENT_MB}MB) — coba rekam lebih singkat.`);
          return;
        }
        const url = URL.createObjectURL(blob);
        setPendingVoiceNotes((prev) => [...prev, { blob, url, mimeType }]);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecordSeconds(0);
      setIsRecording(true);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch (e) {
      setAttachError("⚠ Tidak bisa akses microphone. Izinkan akses mic dulu di pengaturan browser.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
  }

  // ---------------- save ----------------
  async function handleSave() {
    setError("");
    const trimmed = note.trim();
    const hasAttachments = pendingPhotos.length > 0 || pendingVideos.length > 0 || pendingVoiceNotes.length > 0;
    if (!trimmed && !hasAttachments) { setError("⚠ Tulis catatan atau lampirkan foto/video/voice note dulu."); return; }
    if (!entryDate) { setError("⚠ Pilih tanggal untuk catatan ini."); return; }

    setSaving(true);
    const { data: entry, error: entryErr } = await supabase
      .from("journal_entries")
      .insert({ user_id: user.id, entry_date: entryDate, mood, note: trimmed })
      .select()
      .maybeSingle();

    if (entryErr) { setSaving(false); setError("⚠ " + entryErr.message); return; }

    const savedAttachments = [];
    let failedCount = 0;

    async function uploadOne(kind, fileOrBlob, fallbackName, mimeType) {
      const path = attachmentPath(user.id, entry.id, fileOrBlob.name || fallbackName);
      const contentType = mimeType || fileOrBlob.type;
      const { error: upErr } = await supabase.storage.from(JOURNAL_BUCKET).upload(path, fileOrBlob, { contentType });
      if (upErr) { failedCount++; return; }
      const { data: attRow, error: attErr } = await supabase
        .from("journal_attachments")
        .insert({ user_id: user.id, entry_id: entry.id, kind, storage_path: path, mime_type: contentType, size_bytes: fileOrBlob.size })
        .select()
        .maybeSingle();
      if (attErr) { failedCount++; return; }
      savedAttachments.push(attRow);
    }

    for (const p of pendingPhotos) await uploadOne("photo", p.file, "photo.jpg");
    for (const v of pendingVideos) await uploadOne("video", v.file, "video.mp4");
    for (const v of pendingVoiceNotes) await uploadOne("voice", v.blob, "voice-note.webm", v.mimeType);

    setSaving(false);
    const withUrls = await withSignedUrls(savedAttachments);
    setEntries((prev) => [{ ...entry, attachments: withUrls }, ...prev].sort(sortEntries));

    setNote("");
    setMood(null);
    [...pendingPhotos, ...pendingVideos, ...pendingVoiceNotes].forEach((p) => p.url && URL.revokeObjectURL(p.url));
    setPendingPhotos([]);
    setPendingVideos([]);
    setPendingVoiceNotes([]);

    if (failedCount > 0) setError(`⚠ Catatan tersimpan, tapi ${failedCount} lampiran gagal diunggah.`);
  }

  async function handleDelete(entry) {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    const paths = (entry.attachments || []).map((a) => a.storage_path);
    if (paths.length > 0) await supabase.storage.from(JOURNAL_BUCKET).remove(paths);
    await supabase.from("journal_entries").delete().eq("id", entry.id);
  }

  async function handleDeleteAttachment(entryId, attachment) {
    setEntries((prev) => prev.map((e) => (
      e.id === entryId ? { ...e, attachments: e.attachments.filter((a) => a.id !== attachment.id) } : e
    )));
    await supabase.storage.from(JOURNAL_BUCKET).remove([attachment.storage_path]);
    await supabase.from("journal_attachments").delete().eq("id", attachment.id);
  }

  if (loading) return <div className="center-loading">Memuat data…</div>;

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="topbar-left">
          <div className="avatar">{(user?.email || "?").charAt(0).toUpperCase()}</div>
          <span className="user-name">{user?.email}</span>
        </div>
        <div className="topbar-nav">
          <Link href="/dashboard" className="nav-link">Dashboard</Link>
          <Link href="/dashboard/journal" className="nav-link active">Jurnal</Link>
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Jurnal · kehamilan</p>
        <h1 className="bloom-title">Jurnal</h1>
        <p className="bloom-sub">
          Catat perasaan, gejala, atau momen kecil hari ini — bisa lewat teks, foto, video, atau
          voice note.
        </p>
      </div>

      <div className="bloom-grid">
        <div className="panel full">
          <h2>Catatan baru</h2>
          <div className="journal-composer">
            <div className="journal-date-row">
              <label htmlFor="journal-date">Tanggal</label>
              <input
                id="journal-date"
                type="date"
                className="journal-date-input"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>

            <div className="mood-picker">
              {MOODS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`mood-btn ${mood === m.key ? "active" : ""}`}
                  onClick={() => setMood((prev) => (prev === m.key ? null : m.key))}
                  title={m.label}
                >
                  <span>{m.emoji}</span> {m.label}
                </button>
              ))}
            </div>

            <textarea
              className="journal-textarea"
              placeholder="Apa yang kamu rasakan atau alami hari ini?"
              rows={4}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            <div className="attach-row">
              <label className="attach-btn">
                🖼️ Foto
                <input
                  type="file" accept="image/*" multiple
                  onChange={(e) => { addPendingFiles("photo", e.target.files); e.target.value = ""; }}
                />
              </label>
              <label className="attach-btn">
                🎬 Video
                <input
                  type="file" accept="video/*" multiple
                  onChange={(e) => { addPendingFiles("video", e.target.files); e.target.value = ""; }}
                />
              </label>
              {!isRecording ? (
                <button type="button" className="attach-btn" onClick={startRecording}>🎙️ Rekam voice note</button>
              ) : (
                <button type="button" className="attach-btn recording" onClick={stopRecording}>
                  ⏹ Berhenti · {formatSeconds(recordSeconds)}
                </button>
              )}
            </div>
            <div className="attach-hint">
              Foto/video maks {MAX_ATTACHMENT_MB}MB per file, maks {MAX_ATTACHMENTS_PER_ENTRY} lampiran per catatan.
              Voice note butuh izin akses mic browser dan otomatis berhenti di {Math.round(MAX_RECORDING_SECONDS / 60)} menit.
            </div>

            {attachError && <div className="error-box">{attachError}</div>}

            {(pendingPhotos.length > 0 || pendingVideos.length > 0 || pendingVoiceNotes.length > 0) && (
              <div className="pending-attachments">
                {pendingPhotos.map((p, i) => (
                  <div className="pending-item" key={`p${i}`}>
                    <img src={p.url} alt="" />
                    <button type="button" onClick={() => removePending("photo", i)}>✕</button>
                  </div>
                ))}
                {pendingVideos.map((v, i) => (
                  <div className="pending-item" key={`v${i}`}>
                    <video src={v.url} muted />
                    <button type="button" onClick={() => removePending("video", i)}>✕</button>
                  </div>
                ))}
                {pendingVoiceNotes.map((v, i) => (
                  <div className="pending-item pending-voice" key={`a${i}`}>
                    <audio controls src={v.url} />
                    <button type="button" onClick={() => removePending("voice", i)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {error && <div className="error-box">{error}</div>}

            <button className="journal-save-btn" onClick={handleSave} disabled={saving}>
              {saving ? "Menyimpan…" : "Simpan catatan"}
            </button>
          </div>
        </div>

        <div className="panel full">
          <h2>Riwayat catatan</h2>
          {entries.length === 0 ? (
            <div className="journal-empty">Belum ada catatan. Tulis yang pertama di atas 🌱</div>
          ) : (
            entries.map((e) => {
              const m = moodMeta(e.mood);
              return (
                <div className="journal-entry" key={e.id}>
                  <div className="journal-entry-header">
                    <span className="journal-entry-date">{e.entry_date}</span>
                    {m && <span className="journal-entry-mood">{m.emoji} {m.label}</span>}
                    <button className="journal-entry-remove" title="Hapus catatan ini" onClick={() => handleDelete(e)}>✕</button>
                  </div>
                  {e.note && <p className="journal-entry-note">{e.note}</p>}
                  {e.attachments && e.attachments.length > 0 && (
                    <div className="entry-attachments">
                      {e.attachments.map((a) => (
                        <div className="entry-attachment" key={a.id}>
                          {a.url ? (
                            <>
                              {a.kind === "photo" && <img src={a.url} alt="" />}
                              {a.kind === "video" && <video src={a.url} controls />}
                              {a.kind === "voice" && <audio src={a.url} controls />}
                            </>
                          ) : (
                            <div className="entry-attachment-broken">⚠ tidak bisa dimuat</div>
                          )}
                          <button
                            className="entry-attachment-remove" title="Hapus lampiran ini"
                            onClick={() => handleDeleteAttachment(e.id, a)}
                          >✕</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <p className="disclaimer">
        Jurnal ini bersifat pribadi dan hanya bisa diakses lewat akunmu — foto/video/voice note
        disimpan di bucket privat, bukan tautan publik. Kalau ada gejala yang mengkhawatirkan, tetap
        hubungi dokter/bidan — catatan di sini bukan pengganti konsultasi medis.
      </p>
    </div>
  );
}
