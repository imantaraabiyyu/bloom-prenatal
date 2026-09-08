"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import ConfirmButton from "@/components/ConfirmButton";
import HelpTip from "@/components/HelpTip";
import {
  Home, NotebookText, MessageCircle, User, ImagePlus, Video, Mic, Square,
  FileText, X, Check, Sprout, Pencil, AlertTriangle,
} from "lucide-react";
import { todayISO } from "@/lib/nutrition";
import { computeGestationalAge, trimesterForWeeks } from "@/lib/pregnancy";
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

// Same t1/t2/t3 -> "Trimester N" labels app/dashboard/page.js already uses.
const TRIMESTER_LABEL = { t1: "Trimester 1", t2: "Trimester 2", t3: "Trimester 3" };

// null (not a fallback like "Trimester 1") when HPHT isn't set yet or the
// entry predates it -- computeGestationalAge already returns null for
// both cases, so there's nothing to invent here; the caller just doesn't
// render a label rather than guessing.
function weekTrimesterLabel(hpht, entryDate) {
  const ga = computeGestationalAge(hpht, entryDate);
  if (!ga) return null;
  return `Minggu ke-${ga.weeks} · ${TRIMESTER_LABEL[trimesterForWeeks(ga.weeks)]}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Gagal membaca rekaman."));
    reader.readAsDataURL(blob);
  });
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
  const [confirmingAttachmentId, setConfirmingAttachmentId] = useState(null); // click-again-to-confirm delete
  const [hpht, setHpht] = useState(null); // for the history list's week/trimester label only -- read-only here, set in Profil

  // editing an existing entry — date/mood/note, and (like the composer)
  // new attachments too now; existing attachments keep their own
  // delete-only management (handleDeleteAttachment), unrelated to this
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [editDate, setEditDate] = useState("");
  const [editMood, setEditMood] = useState(null);
  const [editNote, setEditNote] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

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

  // Same shape, for whichever entry is currently being edited -- kept
  // separate from the composer's own pending state above rather than
  // shared, since the composer (always on-screen) and an edit session
  // (opened inline within one history entry) can both be "open" in the UI
  // at once; editingEntryId is singular (only one entry editable at a
  // time), so one set of these is enough -- no per-entry-id map needed.
  const [editPendingPhotos, setEditPendingPhotos] = useState([]);
  const [editPendingVideos, setEditPendingVideos] = useState([]);
  const [editPendingVoiceNotes, setEditPendingVoiceNotes] = useState([]);
  const [editAttachError, setEditAttachError] = useState("");

  // Only one microphone recording can physically happen at a time, so
  // isRecording/recordSeconds/the refs below stay shared between compose
  // and edit -- recordingTarget just remembers which one asked for it, so
  // onstop delivers the finished blob to the right pending list, and the
  // *other* target's record button can disable itself meanwhile instead
  // of offering a confusing second simultaneous recording.
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordingTarget, setRecordingTarget] = useState(null); // "compose" | "edit" | null
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

      // Read-only here (unlike the Dashboard, which creates a profile row
      // if none exists yet) -- this page only needs hpht for the history
      // list's week/trimester label, and a missing profile/hpht just
      // means that label stays hidden (see weekTrimesterLabel).
      const { data: profile } = await supabase.from("profiles").select("hpht").eq("user_id", u.id).maybeSingle();
      setHpht(profile?.hpht || null);

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
      const setAttachErr = recordingTarget === "edit" ? setEditAttachError : setAttachError;
      stopRecording();
      setAttachErr(`Rekaman dihentikan otomatis di batas ${Math.round(MAX_RECORDING_SECONDS / 60)} menit.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordSeconds, isRecording]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // ---------------- attachments: pick files ----------------
  // `target`: "compose" (the always-visible new-entry form) or "edit"
  // (whichever entry is currently open via startEditEntry) -- picks which
  // parallel set of state below a call operates on. Edit mode's count
  // also includes that entry's *existing* attachments, so the combined
  // total still respects MAX_ATTACHMENTS_PER_ENTRY (a per-entry cap, not
  // per add-session).
  function pendingCount(target) {
    if (target === "edit") {
      const entry = entries.find((e) => e.id === editingEntryId);
      const existing = entry?.attachments?.length || 0;
      return existing + editPendingPhotos.length + editPendingVideos.length + editPendingVoiceNotes.length;
    }
    return pendingPhotos.length + pendingVideos.length + pendingVoiceNotes.length;
  }

  function addPendingFiles(target, kind, fileList) {
    const setAttachErr = target === "edit" ? setEditAttachError : setAttachError;
    setAttachErr("");
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    // cap first so type/size checks below only run on files that have room
    const room = Math.max(MAX_ATTACHMENTS_PER_ENTRY - pendingCount(target), 0);
    const withinCap = files.slice(0, room);
    const overCap = files.length - withinCap.length;

    const wrongType = withinCap.filter((f) => !isAcceptedMime(kind, f.type));
    const rightType = withinCap.filter((f) => isAcceptedMime(kind, f.type));
    const oversized = rightType.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
    const ok = rightType.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);

    const withUrls = ok.map((file) => ({ file, url: URL.createObjectURL(file) }));
    const setPhotos = target === "edit" ? setEditPendingPhotos : setPendingPhotos;
    const setVideos = target === "edit" ? setEditPendingVideos : setPendingVideos;
    if (kind === "photo") setPhotos((prev) => [...prev, ...withUrls]);
    else setVideos((prev) => [...prev, ...withUrls]);

    const problems = [];
    if (wrongType.length > 0) problems.push(`${wrongType.length} file bukan ${ATTACHMENT_KINDS[kind].label.toLowerCase()} yang valid`);
    if (oversized.length > 0) problems.push(`${oversized.length} file lebih besar dari ${MAX_ATTACHMENT_MB}MB`);
    if (overCap > 0) problems.push(`${overCap} file dilewati (maks ${MAX_ATTACHMENTS_PER_ENTRY} lampiran per catatan)`);
    if (problems.length > 0) setAttachErr(`${problems.join(" · ")}.`);
  }

  function removePending(target, kind, idx) {
    const setter = target === "edit"
      ? (kind === "photo" ? setEditPendingPhotos : kind === "video" ? setEditPendingVideos : setEditPendingVoiceNotes)
      : (kind === "photo" ? setPendingPhotos : kind === "video" ? setPendingVideos : setPendingVoiceNotes);
    setter((prev) => {
      const item = prev[idx];
      if (item?.url) URL.revokeObjectURL(item.url);
      return prev.filter((_, i) => i !== idx);
    });
  }

  // ---------------- attachments: record voice note ----------------
  // Only one microphone recording can physically happen at a time, so
  // this stays a single MediaRecorder implementation shared by both
  // targets -- `target` (captured in onstop's own closure, not read back
  // from state, so it can't go stale) just decides which pending list the
  // finished blob lands in.
  async function startRecording(target) {
    const setAttachErr = target === "edit" ? setEditAttachError : setAttachError;
    setAttachErr("");
    if (isRecording) {
      setAttachErr("Sedang merekam di catatan lain — selesaikan/hentikan dulu.");
      return;
    }
    if (pendingCount(target) >= MAX_ATTACHMENTS_PER_ENTRY) {
      setAttachErr(`Maksimal ${MAX_ATTACHMENTS_PER_ENTRY} lampiran per catatan.`);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setAttachErr("Browser ini tidak mendukung rekam suara.");
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
          setAttachErr(`Rekaman terlalu besar (lebih dari ${MAX_ATTACHMENT_MB}MB) — coba rekam lebih singkat.`);
          return;
        }
        const url = URL.createObjectURL(blob);
        const setVoice = target === "edit" ? setEditPendingVoiceNotes : setPendingVoiceNotes;
        setVoice((prev) => [...prev, { blob, url, mimeType }]);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecordSeconds(0);
      setIsRecording(true);
      setRecordingTarget(target);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch (e) {
      setAttachErr("Tidak bisa akses microphone. Izinkan akses mic dulu di pengaturan browser.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    clearInterval(recordTimerRef.current);
    setIsRecording(false);
    setRecordingTarget(null);
  }

  // ---------------- voice note transcription ----------------
  // Right after a recording stops, `promptDismissed` is unset — the pending
  // item shows a "transkrip ini?" prompt rather than a passive button, so
  // it's impossible to miss. Runs before the entry is saved — lets you
  // review/edit the tidied text (or just the raw transcript) and drop it
  // into the note field yourself, rather than silently rewriting your typing.
  function dismissTranscribePrompt(target, idx) {
    const setVoice = target === "edit" ? setEditPendingVoiceNotes : setPendingVoiceNotes;
    setVoice((prev) => prev.map((v, i) => (i === idx ? { ...v, promptDismissed: true } : v)));
  }

  async function transcribePendingVoice(target, idx) {
    const voiceList = target === "edit" ? editPendingVoiceNotes : pendingVoiceNotes;
    const setVoice = target === "edit" ? setEditPendingVoiceNotes : setPendingVoiceNotes;
    const voice = voiceList[idx];
    if (!voice) return;
    setVoice((prev) => prev.map((v, i) => (
      i === idx ? { ...v, promptDismissed: true, transcribing: true, transcribeError: "", transcript: "", tidiedNote: "" } : v
    )));

    function applyProgress(patch) {
      setVoice((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
    }

    try {
      const base64 = await blobToBase64(voice.blob);
      const res = await fetch("/api/journal/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: { base64, mimeType: voice.mimeType } }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Gagal mentranskrip.");
      }

      // Newline-delimited JSON events, same protocol as /api/nutrition-chat:
      // {type:"progress", transcript, tidiedNote} as text fills in, then one
      // {type:"done", result} or {type:"error", error}.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      let streamError = null;

      function handleLine(line) {
        if (!line.trim()) return;
        let evt;
        try { evt = JSON.parse(line); } catch { return; }
        if (evt.type === "progress") applyProgress({ transcript: evt.transcript, tidiedNote: evt.tidiedNote });
        else if (evt.type === "done") finalResult = evt.result;
        else if (evt.type === "error") streamError = evt.error;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        lines.forEach(handleLine);
      }
      if (buffer.trim()) handleLine(buffer);

      if (streamError) throw new Error(streamError);
      if (!finalResult) throw new Error("Gagal mentranskrip.");
      applyProgress({ transcribing: false, transcript: finalResult.transcript, tidiedNote: finalResult.tidiedNote });
    } catch (e) {
      applyProgress({ transcribing: false, transcribeError: e.message || "Gagal mentranskrip." });
    }
  }

  // Appends rather than replaces — you might already be typing your own note
  // alongside the voice note, or combining transcripts from more than one.
  function useTidiedNote(target, idx) {
    const voiceList = target === "edit" ? editPendingVoiceNotes : pendingVoiceNotes;
    const tidied = voiceList[idx]?.tidiedNote;
    if (!tidied) return;
    const setTargetNote = target === "edit" ? setEditNote : setNote;
    setTargetNote((prev) => (prev.trim() ? `${prev.trim()}\n\n${tidied}` : tidied));
  }

  // ---------------- save ----------------
  // Shared by handleSave (new entry, just-inserted id) and saveEditEntry
  // (existing entry, no insert needed) -- upload to storage then insert
  // the journal_attachments row; returns the row on success or null on
  // either failure, caller decides how to count/report failures.
  async function uploadAttachment(entryId, kind, fileOrBlob, fallbackName, mimeType) {
    const path = attachmentPath(user.id, entryId, fileOrBlob.name || fallbackName);
    const contentType = mimeType || fileOrBlob.type;
    const { error: upErr } = await supabase.storage.from(JOURNAL_BUCKET).upload(path, fileOrBlob, { contentType });
    if (upErr) return null;
    const { data: attRow, error: attErr } = await supabase
      .from("journal_attachments")
      .insert({ user_id: user.id, entry_id: entryId, kind, storage_path: path, mime_type: contentType, size_bytes: fileOrBlob.size })
      .select()
      .maybeSingle();
    if (attErr) return null;
    return attRow;
  }

  async function handleSave() {
    setError("");
    const trimmed = note.trim();
    const hasAttachments = pendingPhotos.length > 0 || pendingVideos.length > 0 || pendingVoiceNotes.length > 0;
    if (!trimmed && !hasAttachments) { setError("Tulis catatan atau lampirkan foto/video/voice note dulu."); return; }
    if (!entryDate) { setError("Pilih tanggal untuk catatan ini."); return; }

    setSaving(true);
    const { data: entry, error: entryErr } = await supabase
      .from("journal_entries")
      .insert({ user_id: user.id, entry_date: entryDate, mood, note: trimmed })
      .select()
      .maybeSingle();

    if (entryErr) { setSaving(false); setError(entryErr.message); return; }

    const savedAttachments = [];
    let failedCount = 0;

    async function uploadAndCollect(kind, fileOrBlob, fallbackName, mimeType) {
      const row = await uploadAttachment(entry.id, kind, fileOrBlob, fallbackName, mimeType);
      if (row) savedAttachments.push(row); else failedCount++;
    }

    for (const p of pendingPhotos) await uploadAndCollect("photo", p.file, "photo.jpg");
    for (const v of pendingVideos) await uploadAndCollect("video", v.file, "video.mp4");
    for (const v of pendingVoiceNotes) await uploadAndCollect("voice", v.blob, "voice-note.webm", v.mimeType);

    setSaving(false);
    const withUrls = await withSignedUrls(savedAttachments);
    setEntries((prev) => [{ ...entry, attachments: withUrls }, ...prev].sort(sortEntries));

    setNote("");
    setMood(null);
    [...pendingPhotos, ...pendingVideos, ...pendingVoiceNotes].forEach((p) => p.url && URL.revokeObjectURL(p.url));
    setPendingPhotos([]);
    setPendingVideos([]);
    setPendingVoiceNotes([]);

    if (failedCount > 0) setError(`Catatan tersimpan, tapi ${failedCount} lampiran gagal diunggah.`);
  }

  async function handleDelete(entry) {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    const paths = (entry.attachments || []).map((a) => a.storage_path);
    if (paths.length > 0) await supabase.storage.from(JOURNAL_BUCKET).remove(paths);
    await supabase.from("journal_entries").delete().eq("id", entry.id);
  }

  // ---------------- edit an existing entry ----------------
  function clearEditPendingAttachments() {
    [...editPendingPhotos, ...editPendingVideos, ...editPendingVoiceNotes].forEach((p) => p.url && URL.revokeObjectURL(p.url));
    setEditPendingPhotos([]);
    setEditPendingVideos([]);
    setEditPendingVoiceNotes([]);
    setEditAttachError("");
  }

  function startEditEntry(entry) {
    setEditingEntryId(entry.id);
    setEditDate(entry.entry_date);
    setEditMood(entry.mood);
    setEditNote(entry.note || "");
    setEditError("");
    clearEditPendingAttachments(); // defensive -- should already be empty by now, see cancel/save below
  }

  function cancelEditEntry() {
    clearEditPendingAttachments();
    setEditingEntryId(null);
    setEditError("");
  }

  async function saveEditEntry(entry) {
    setEditError("");
    const trimmed = editNote.trim();
    const hasAttachments = (entry.attachments || []).length > 0
      || editPendingPhotos.length > 0 || editPendingVideos.length > 0 || editPendingVoiceNotes.length > 0;
    if (!trimmed && !hasAttachments) { setEditError("Tulis catatan dulu."); return; }
    if (!editDate) { setEditError("Pilih tanggal untuk catatan ini."); return; }

    setEditSaving(true);
    const { data, error: updateErr } = await supabase
      .from("journal_entries")
      .update({ entry_date: editDate, mood: editMood, note: trimmed, updated_at: new Date().toISOString() })
      .eq("id", entry.id)
      .select()
      .maybeSingle();
    if (updateErr) { setEditSaving(false); setEditError(updateErr.message); return; }

    // Same upload-then-collect shape as handleSave, just against the
    // entry's already-existing id instead of a fresh insert.
    const savedAttachments = [];
    let failedCount = 0;
    async function uploadAndCollect(kind, fileOrBlob, fallbackName, mimeType) {
      const row = await uploadAttachment(entry.id, kind, fileOrBlob, fallbackName, mimeType);
      if (row) savedAttachments.push(row); else failedCount++;
    }
    for (const p of editPendingPhotos) await uploadAndCollect("photo", p.file, "photo.jpg");
    for (const v of editPendingVideos) await uploadAndCollect("video", v.file, "video.mp4");
    for (const v of editPendingVoiceNotes) await uploadAndCollect("voice", v.blob, "voice-note.webm", v.mimeType);
    setEditSaving(false);

    // Merge into the existing entry rather than replacing it outright — the
    // update+select above only returns journal_entries columns, not the
    // attachments array this list item also carries. New attachments (if
    // any) get appended the same way handleSave appends them for a fresh entry.
    const withUrls = await withSignedUrls(savedAttachments);
    setEntries((prev) => prev
      .map((e) => (e.id === entry.id
        ? { ...e, entry_date: data.entry_date, mood: data.mood, note: data.note, attachments: [...(e.attachments || []), ...withUrls] }
        : e))
      .sort(sortEntries));

    clearEditPendingAttachments();
    // A partial attachment failure keeps the edit form open (same
    // entry/note already saved either way) so the warning stays visible —
    // editError renders inside that form, which unmounts once
    // editingEntryId clears.
    if (failedCount > 0) setEditError(`Perubahan tersimpan, tapi ${failedCount} lampiran gagal diunggah.`);
    else setEditingEntryId(null);
  }

  async function handleDeleteAttachment(entryId, attachment) {
    setEntries((prev) => prev.map((e) => (
      e.id === entryId ? { ...e, attachments: e.attachments.filter((a) => a.id !== attachment.id) } : e
    )));
    await supabase.storage.from(JOURNAL_BUCKET).remove([attachment.storage_path]);
    await supabase.from("journal_attachments").delete().eq("id", attachment.id);
  }

  // This remove button sits absolutely-positioned over the thumbnail, so it
  // can't swap to ConfirmButton's inline "[Ya, hapus] [Batal]" pair the way
  // every other delete button does (there's no room, and it'd fight the
  // overlay positioning) — same click-again-to-confirm intent, just done as
  // an in-place icon swap with an auto-revert instead.
  function handleAttachmentRemoveClick(entryId, attachment) {
    if (confirmingAttachmentId === attachment.id) {
      setConfirmingAttachmentId(null);
      handleDeleteAttachment(entryId, attachment);
    } else {
      setConfirmingAttachmentId(attachment.id);
      setTimeout(() => {
        setConfirmingAttachmentId((cur) => (cur === attachment.id ? null : cur));
      }, 3000);
    }
  }

  // Shared by the new-entry composer and the edit form -- same attach
  // row (photo/video/record), pending-attachment previews, and voice-note
  // transcription UI, just pointed at whichever target's state via the
  // parameterized handlers above. Defined once so the two call sites
  // (below) can't drift out of sync with each other.
  function renderAttachSection(target) {
    const attachErr = target === "edit" ? editAttachError : attachError;
    const photos = target === "edit" ? editPendingPhotos : pendingPhotos;
    const videos = target === "edit" ? editPendingVideos : pendingVideos;
    const voiceNotes = target === "edit" ? editPendingVoiceNotes : pendingVoiceNotes;
    return (
      <>
        <div className="attach-row">
          <label className="attach-btn">
            <ImagePlus size={15} /> Foto
            <input
              type="file" accept="image/*" multiple
              onChange={(e) => { addPendingFiles(target, "photo", e.target.files); e.target.value = ""; }}
            />
          </label>
          <label className="attach-btn">
            <Video size={15} /> Video
            <input
              type="file" accept="video/*" multiple
              onChange={(e) => { addPendingFiles(target, "video", e.target.files); e.target.value = ""; }}
            />
          </label>
          {!isRecording ? (
            <button type="button" className="attach-btn" onClick={() => startRecording(target)}><Mic size={15} /> Rekam voice note</button>
          ) : recordingTarget === target ? (
            <button type="button" className="attach-btn recording" onClick={stopRecording}>
              <Square size={13} /> Berhenti · {formatSeconds(recordSeconds)}
            </button>
          ) : (
            <button type="button" className="attach-btn" disabled title="Sedang merekam di catatan lain"><Mic size={15} /> Rekam voice note</button>
          )}
        </div>
        <div className="attach-hint">
          Batas lampiran
          <HelpTip label="Batas lampiran">
            Foto/video maks {MAX_ATTACHMENT_MB}MB per file, maks {MAX_ATTACHMENTS_PER_ENTRY} lampiran per catatan.
            Voice note butuh izin akses mic browser dan otomatis berhenti di {Math.round(MAX_RECORDING_SECONDS / 60)} menit.
          </HelpTip>
        </div>

        {attachErr && <div className="error-box"><AlertTriangle size={13} /> {attachErr}</div>}

        {(photos.length > 0 || videos.length > 0 || voiceNotes.length > 0) && (
          <div className="pending-attachments">
            {photos.map((p, i) => (
              <div className="pending-item" key={`${target}-p${i}`}>
                <img src={p.url} alt="" />
                <button type="button" className="pending-remove-btn" onClick={() => removePending(target, "photo", i)}><X size={11} /></button>
              </div>
            ))}
            {videos.map((v, i) => (
              <div className="pending-item" key={`${target}-v${i}`}>
                <video src={v.url} muted />
                <button type="button" className="pending-remove-btn" onClick={() => removePending(target, "video", i)}><X size={11} /></button>
              </div>
            ))}
            {voiceNotes.map((v, i) => (
              <div className="pending-item pending-voice" key={`${target}-a${i}`}>
                <div className="pending-voice-row">
                  <audio controls src={v.url} />
                  <button type="button" className="pending-remove-btn" onClick={() => removePending(target, "voice", i)}><X size={11} /></button>
                </div>

                {/* Right after recording stops: an unmissable prompt, not a
                    button sitting quietly among the others. */}
                {!v.promptDismissed && !v.transcribing && !v.tidiedNote && (
                  <div className="transcribe-prompt">
                    <p>Mau ditranskrip jadi draf jurnal?</p>
                    <div className="transcribe-prompt-actions">
                      <button type="button" className="transcribe-use-btn" onClick={() => transcribePendingVoice(target, i)}>
                        Ya, transkrip
                      </button>
                      <button type="button" className="manual-form-cancel" onClick={() => dismissTranscribePrompt(target, i)}>
                        Tidak, nanti saja
                      </button>
                    </div>
                  </div>
                )}

                {/* Declined earlier, changed your mind — the button stays available. */}
                {v.promptDismissed && !v.transcribing && !v.tidiedNote && !v.transcribeError && (
                  <button type="button" className="transcribe-btn" onClick={() => transcribePendingVoice(target, i)}>
                    <FileText size={13} /> Transkrip & rapikan jadi jurnal
                  </button>
                )}

                {/* Streams in live — transcript fills in first, then the
                    tidied draft right after (see streamTranscribeVoiceNote). */}
                {v.transcribing && (
                  <div className="transcript-preview streaming">
                    <p className="transcript-preview-label">Mentranskrip…</p>
                    {v.tidiedNote ? (
                      <p className="transcript-preview-text">{v.tidiedNote}<span className="chat-cursor" /></p>
                    ) : (
                      <p className="transcript-preview-text muted">{v.transcript}<span className="chat-cursor" /></p>
                    )}
                  </div>
                )}

                {v.transcribeError && (
                  <div className="error-box">
                    <AlertTriangle size={13} />
                    <span>
                      {v.transcribeError}{" "}
                      <button type="button" className="retry-inline-btn" onClick={() => transcribePendingVoice(target, i)}>Coba lagi</button>
                    </span>
                  </div>
                )}

                {!v.transcribing && v.tidiedNote && (
                  <div className="transcript-preview">
                    <p className="transcript-preview-label">Draf jurnal dari voice note ini:</p>
                    <p className="transcript-preview-text">{v.tidiedNote}</p>
                    <details className="transcript-raw">
                      <summary>Lihat transkrip apa adanya</summary>
                      <p>{v.transcript || "(tidak ada ucapan yang dikenali)"}</p>
                    </details>
                    <button type="button" className="transcribe-use-btn" onClick={() => useTidiedNote(target, i)}>
                      Gunakan sebagai catatan
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </>
    );
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
          <Link href="/dashboard" className="nav-link"><Home size={19} /><span>Dashboard</span></Link>
          <Link href="/dashboard/journal" className="nav-link active"><NotebookText size={19} /><span>Jurnal</span></Link>
          <Link href="/dashboard/chat" className="nav-link"><MessageCircle size={19} /><span>Chat</span></Link>
          <Link href="/dashboard/profile" className="nav-link"><User size={19} /><span>Profil</span></Link>
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

            {renderAttachSection("compose")}

            {error && <div className="error-box"><AlertTriangle size={13} /> {error}</div>}

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
              const weekTrimester = weekTrimesterLabel(hpht, e.entry_date);
              return (
                <div className="journal-entry" key={e.id}>
                  <div className="journal-entry-header">
                    <span className="journal-entry-date">{e.entry_date}</span>
                    {weekTrimester && <span className="journal-entry-week">{weekTrimester}</span>}
                    {m && <span className="journal-entry-mood">{m.emoji} {m.label}</span>}
                    <div className="journal-entry-actions">
                      {editingEntryId !== e.id && (
                        <button type="button" className="journal-entry-edit" title="Ubah catatan ini" onClick={() => startEditEntry(e)}><Pencil size={13} /></button>
                      )}
                      <ConfirmButton className="journal-entry-remove" title="Hapus catatan ini" onConfirm={() => handleDelete(e)}><X size={15} /></ConfirmButton>
                    </div>
                  </div>

                  {editingEntryId === e.id ? (
                    <div className="journal-edit-form">
                      <div className="journal-date-row">
                        <label htmlFor={`edit-date-${e.id}`}>Tanggal</label>
                        <input
                          id={`edit-date-${e.id}`} type="date" className="journal-date-input"
                          value={editDate} onChange={(ev) => setEditDate(ev.target.value)}
                        />
                      </div>
                      <div className="mood-picker">
                        {MOODS.map((mm) => (
                          <button
                            key={mm.key} type="button" className={`mood-btn ${editMood === mm.key ? "active" : ""}`}
                            onClick={() => setEditMood((prev) => (prev === mm.key ? null : mm.key))} title={mm.label}
                          >
                            <span>{mm.emoji}</span> {mm.label}
                          </button>
                        ))}
                      </div>
                      <textarea
                        className="journal-textarea" rows={4}
                        value={editNote} onChange={(ev) => setEditNote(ev.target.value)}
                      />
                      {renderAttachSection("edit")}
                      {editError && <div className="error-box"><AlertTriangle size={13} /> {editError}</div>}
                      <div className="manual-form-actions">
                        <button className="manual-form-save" onClick={() => saveEditEntry(e)} disabled={editSaving}>
                          {editSaving ? "Menyimpan…" : "Simpan perubahan"}
                        </button>
                        <button className="manual-form-cancel" onClick={cancelEditEntry}>Batal</button>
                      </div>
                    </div>
                  ) : (
                    e.note && <p className="journal-entry-note">{e.note}</p>
                  )}
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
                            <div className="entry-attachment-broken"><AlertTriangle size={13} /> tidak bisa dimuat</div>
                          )}
                          <button
                            className={`entry-attachment-remove ${confirmingAttachmentId === a.id ? "confirming" : ""}`}
                            title={confirmingAttachmentId === a.id ? "Klik sekali lagi untuk menghapus" : "Hapus lampiran ini"}
                            onClick={() => handleAttachmentRemoveClick(e.id, a)}
                          >{confirmingAttachmentId === a.id ? <Check size={11} /> : <X size={11} />}</button>
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
