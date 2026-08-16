"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { todayISO } from "@/lib/nutrition";
import { MOODS, moodMeta } from "@/lib/journal";

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

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      setUser(sessionData.session.user);

      const { data: rows } = await supabase
        .from("journal_entries")
        .select("*")
        .eq("user_id", sessionData.session.user.id)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false });
      setEntries(rows || []);
      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  async function handleSave() {
    setError("");
    const trimmed = note.trim();
    if (!trimmed) { setError("⚠ Tulis dulu catatannya sebelum disimpan."); return; }
    if (!entryDate) { setError("⚠ Pilih tanggal untuk catatan ini."); return; }
    setSaving(true);
    const { data, error: err } = await supabase
      .from("journal_entries")
      .insert({ user_id: user.id, entry_date: entryDate, mood, note: trimmed })
      .select()
      .maybeSingle();
    setSaving(false);
    if (err) { setError("⚠ " + err.message); return; }
    setEntries((prev) => [data, ...prev].sort((a, b) => {
      if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1;
      return a.created_at < b.created_at ? 1 : -1;
    }));
    setNote("");
    setMood(null);
  }

  async function handleDelete(id) {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    await supabase.from("journal_entries").delete().eq("id", id);
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
          Catat perasaan, gejala, atau momen kecil hari ini. Catatan ini cuma teks — belum ada
          lampiran foto/video.
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
                    <button className="journal-entry-remove" title="Hapus catatan ini" onClick={() => handleDelete(e.id)}>✕</button>
                  </div>
                  <p className="journal-entry-note">{e.note}</p>
                </div>
              );
            })
          )}
        </div>
      </div>

      <p className="disclaimer">
        Jurnal ini bersifat pribadi dan hanya bisa diakses lewat akunmu. Kalau ada gejala yang
        mengkhawatirkan, tetap hubungi dokter/bidan — catatan di sini bukan pengganti konsultasi medis.
      </p>
    </div>
  );
}
