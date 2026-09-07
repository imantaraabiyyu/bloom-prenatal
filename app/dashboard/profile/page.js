"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import ConfirmButton from "@/components/ConfirmButton";
import { todayISO } from "@/lib/nutrition";
import {
  computeHPL, computeHPHTFromHPL, computeGestationalAge, formatGestationalAge, trimesterForWeeks,
  gestationalProgressPct, formatDateID, FULL_TERM_WEEKS,
} from "@/lib/pregnancy";

const GENDER_META = {
  boy: { label: "Laki-laki", color: "#7FA9C7" },
  girl: { label: "Perempuan", color: "#C97B63" },
  unisex: { label: "Unisex", color: "#8FAE8B" },
};

const FILTERS = [
  { key: "all", label: "Semua" },
  { key: "favorite", label: "★ Favorit" },
  { key: "boy", label: "Laki-laki" },
  { key: "girl", label: "Perempuan" },
  { key: "unisex", label: "Unisex" },
];

export default function ProfilePage() {
  const router = useRouter();
  const supabase = useMemo(() => {
    try { return getSupabaseClient(); } catch (e) { return null; }
  }, []);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trimester, setTrimester] = useState("t2");

  // HPHT (Hari Pertama Haid Terakhir) — usia kehamilan/HPL/progress semua dihitung darinya.
  // Bisa diisi langsung, atau lewat HPL (perkiraan lahir dari dokter/USG) yang
  // dibalik jadi HPHT — hphtInputMode cuma menentukan field mana yang diisi
  // user, hphtDraft selalu berisi nilai untuk mode itu.
  const [hpht, setHpht] = useState(null);
  const [hphtEditing, setHphtEditing] = useState(false);
  const [hphtInputMode, setHphtInputMode] = useState("hpht"); // "hpht" | "hpl"
  const [hphtDraft, setHphtDraft] = useState("");
  const [hphtSaving, setHphtSaving] = useState(false);
  const [hphtError, setHphtError] = useState("");

  // calon nama bayi
  const [names, setNames] = useState([]);
  const [filter, setFilter] = useState("all");
  const [formName, setFormName] = useState("");
  const [formGender, setFormGender] = useState("");
  const [formNote, setFormNote] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      const u = sessionData.session.user;
      setUser(u);

      let { data: profile } = await supabase.from("profiles").select("*").eq("user_id", u.id).maybeSingle();
      if (!profile) {
        const { data: created } = await supabase.from("profiles").insert({ user_id: u.id, trimester: "t2" }).select().maybeSingle();
        profile = created;
      }
      setTrimester(profile?.trimester || "t2");
      setHpht(profile?.hpht || null);

      const { data: nameRows } = await supabase
        .from("baby_names")
        .select("*")
        .eq("user_id", u.id)
        .order("is_favorite", { ascending: false })
        .order("name", { ascending: true });
      setNames(nameRows || []);

      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // ---------------- usia kehamilan ----------------
  const gestationalAge = useMemo(() => computeGestationalAge(hpht, todayISO()), [hpht]);
  const hpl = useMemo(() => computeHPL(hpht), [hpht]);
  const gaProgressPct = gestationalProgressPct(gestationalAge);
  const suggestedTrimester = gestationalAge ? trimesterForWeeks(gestationalAge.weeks) : null;

  function openHphtForm() {
    setHphtInputMode("hpht");
    setHphtDraft(hpht || "");
    setHphtError("");
    setHphtEditing(true);
  }

  // Toggling mode converts whatever's already typed to the other
  // representation, instead of just clearing the field.
  function switchHphtMode(mode) {
    if (mode === hphtInputMode) return;
    if (hphtDraft) {
      setHphtDraft((mode === "hpl" ? computeHPL(hphtDraft) : computeHPHTFromHPL(hphtDraft)) || "");
    }
    setHphtInputMode(mode);
  }

  async function saveHpht() {
    setHphtError("");
    if (!hphtDraft) {
      setHphtError(hphtInputMode === "hpl" ? "⚠ Pilih tanggal HPL dulu." : "⚠ Pilih tanggal HPHT dulu.");
      return;
    }
    const hphtToSave = hphtInputMode === "hpl" ? computeHPHTFromHPL(hphtDraft) : hphtDraft;
    const ga = computeGestationalAge(hphtToSave, todayISO());
    if (!ga) {
      setHphtError("⚠ Tanggal ini menghasilkan usia kehamilan yang tidak valid (di masa depan). Cek lagi tanggalnya.");
      return;
    }
    // Trimester syncs with the pregnancy tracker every time this is saved —
    // still manually overridable afterward from the trimester picker on
    // Dashboard, this just resets it to match whenever the date changes.
    const newTrimester = trimesterForWeeks(ga.weeks);
    setHphtSaving(true);
    const { error } = await supabase
      .from("profiles")
      .upsert({ user_id: user.id, hpht: hphtToSave, trimester: newTrimester }, { onConflict: "user_id" });
    setHphtSaving(false);
    if (error) { setHphtError("⚠ " + error.message); return; }
    setHpht(hphtToSave);
    setTrimester(newTrimester);
    setHphtEditing(false);
  }

  // ---------------- calon nama bayi ----------------
  async function handleAdd() {
    setFormError("");
    const name = formName.trim();
    if (!name) { setFormError("⚠ Isi dulu namanya."); return; }
    setFormSaving(true);
    const row = { user_id: user.id, name, gender: formGender || null, note: formNote.trim() || null };
    const { data, error } = await supabase.from("baby_names").insert(row).select().maybeSingle();
    setFormSaving(false);
    if (error) { setFormError("⚠ " + error.message); return; }
    setNames((prev) => [...prev, data].sort((a, b) => (b.is_favorite - a.is_favorite) || a.name.localeCompare(b.name)));
    setFormName("");
    setFormGender("");
    setFormNote("");
  }

  async function toggleFavorite(id, current) {
    setNames((prev) => [...prev].map((n) => (n.id === id ? { ...n, is_favorite: !current } : n))
      .sort((a, b) => (b.is_favorite - a.is_favorite) || a.name.localeCompare(b.name)));
    await supabase.from("baby_names").update({ is_favorite: !current }).eq("id", id);
  }

  async function handleDelete(id) {
    setNames((prev) => prev.filter((n) => n.id !== id));
    await supabase.from("baby_names").delete().eq("id", id);
  }

  if (loading) return <div className="center-loading">Memuat data…</div>;

  const filtered = names.filter((n) => {
    if (filter === "all") return true;
    if (filter === "favorite") return n.is_favorite;
    return n.gender === filter;
  });

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="topbar-left">
          <div className="avatar">{(user?.email || "?").charAt(0).toUpperCase()}</div>
          <span className="user-name">{user?.email}</span>
        </div>
        <div className="topbar-nav">
          <Link href="/dashboard" className="nav-link">Dashboard</Link>
          <Link href="/dashboard/journal" className="nav-link">Jurnal</Link>
          <Link href="/dashboard/chat" className="nav-link">Chat</Link>
          <Link href="/dashboard/profile" className="nav-link active">Profil</Link>
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Profil · kehamilan</p>
        <h1 className="bloom-title">Profil</h1>
        <p className="bloom-sub">
          Usia kehamilanmu dan daftar calon nama bayi — data pribadi yang jarang berubah, terpisah
          dari pencatatan harian di Dashboard.
        </p>
      </div>

      <div className="bloom-grid">
        {/* Usia kehamilan (dari HPHT) + progress tracker */}
        <div className="panel full">
          <h2>Usia kehamilan</h2>
          <p className="format-hint" style={{ marginTop: 0 }}>
            <strong>HPHT</strong> = Hari Pertama Haid Terakhir, yaitu tanggal mulai menstruasi
            terakhirmu sebelum hamil. Ini patokan standar dokter/bidan untuk menghitung usia
            kehamilan dan HPL (Hari Perkiraan Lahir) — Bloom memakai tanggal yang sama (aturan
            Naegele: HPL = HPHT + 280 hari).
          </p>
          {!hpht && !hphtEditing && (
            <button className="manual-form-save" onClick={openHphtForm}>+ Isi tanggal</button>
          )}
          {hphtEditing && (
            <div className="hpht-form">
              <div className="name-filter-row">
                <button
                  type="button" className={`name-filter-btn ${hphtInputMode === "hpht" ? "active" : ""}`}
                  onClick={() => switchHphtMode("hpht")}
                >
                  Saya tahu HPHT
                </button>
                <button
                  type="button" className={`name-filter-btn ${hphtInputMode === "hpl" ? "active" : ""}`}
                  onClick={() => switchHphtMode("hpl")}
                >
                  Saya tahu HPL (dari dokter)
                </button>
              </div>
              <label className="extra-nutrient-label">
                {hphtInputMode === "hpl"
                  ? "HPL — tanggal perkiraan lahir yang diberikan dokter/USG"
                  : "HPHT — tanggal hari pertama haid terakhirmu"}
              </label>
              <input type="date" value={hphtDraft} onChange={(e) => setHphtDraft(e.target.value)} />
              {hphtInputMode === "hpl" && hphtDraft && (
                <p className="format-hint">→ HPHT dihitung otomatis: {formatDateID(computeHPHTFromHPL(hphtDraft))}</p>
              )}
              {hphtError && <div className="error-box">{hphtError}</div>}
              <div className="manual-form-actions">
                <button className="manual-form-save" onClick={saveHpht} disabled={hphtSaving}>
                  {hphtSaving ? "Menyimpan…" : "Simpan"}
                </button>
                <button className="manual-form-cancel" onClick={() => setHphtEditing(false)}>Batal</button>
              </div>
            </div>
          )}
          {hpht && !hphtEditing && (
            <div className="pregnancy-info">
              <div className="pregnancy-stats">
                <div className="pregnancy-stat">
                  <span className="pregnancy-stat-value">{formatGestationalAge(gestationalAge)}</span>
                  <span className="pregnancy-stat-label">Usia kehamilan</span>
                </div>
                <div className="pregnancy-stat">
                  <span className="pregnancy-stat-value">{formatDateID(hpl)}</span>
                  <span className="pregnancy-stat-label">HPL (perkiraan lahir)</span>
                </div>
                <div className="pregnancy-stat">
                  <span className="pregnancy-stat-value">Trimester {trimester.slice(1)}</span>
                  <span className="pregnancy-stat-label">Tersinkron otomatis</span>
                </div>
              </div>
              <div className="water-bar-track">
                <div className="water-bar-fill" style={{ width: `${gaProgressPct}%`, background: "var(--lilac)" }} />
              </div>
              <div className="pregnancy-progress-label">
                <span>Minggu {gestationalAge?.weeks ?? 0} dari {FULL_TERM_WEEKS}</span>
                {suggestedTrimester && suggestedTrimester !== trimester && (
                  <span> · kalender menunjukkan Trimester {suggestedTrimester.slice(1)} (beda dari trimester yang dipilih manual di Dashboard)</span>
                )}
              </div>
              <button className="extra-nutrient-add" style={{ marginTop: 12 }} onClick={openHphtForm}>Ubah HPHT/HPL</button>
            </div>
          )}
        </div>

        {/* Calon nama bayi */}
        <div className="panel full">
          <h2>Tambah calon nama</h2>
          <div className="manual-form">
            <div className="manual-form-row">
              <input
                type="text" placeholder="Nama (mis. Kirana)"
                value={formName} onChange={(e) => setFormName(e.target.value)}
              />
              <select className="babyname-gender-select" value={formGender} onChange={(e) => setFormGender(e.target.value)}>
                <option value="">Tanpa gender</option>
                <option value="boy">Laki-laki</option>
                <option value="girl">Perempuan</option>
                <option value="unisex">Unisex</option>
              </select>
            </div>
            <textarea
              className="journal-textarea" rows={2} placeholder="Arti/catatan (opsional)"
              value={formNote} onChange={(e) => setFormNote(e.target.value)}
            />
            {formError && <div className="error-box">{formError}</div>}
            <div className="manual-form-actions">
              <button className="manual-form-save" onClick={handleAdd} disabled={formSaving}>
                {formSaving ? "Menyimpan…" : "Tambah nama"}
              </button>
            </div>
          </div>
        </div>

        <div className="panel full">
          <h3>Daftar calon nama</h3>
          <div className="name-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f.key} className={`name-filter-btn ${filter === f.key ? "active" : ""}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="babyname-empty">
              {names.length === 0 ? "Belum ada calon nama. Tambahkan yang pertama di atas 🌱" : "Tidak ada nama di kategori ini."}
            </div>
          ) : (
            filtered.map((n) => {
              const g = GENDER_META[n.gender];
              return (
                <div className="babyname-row" key={n.id}>
                  <button
                    className={`babyname-star ${n.is_favorite ? "active" : ""}`}
                    title={n.is_favorite ? "Hapus dari favorit" : "Tandai favorit"}
                    onClick={() => toggleFavorite(n.id, n.is_favorite)}
                  >
                    {n.is_favorite ? "★" : "☆"}
                  </button>
                  <div className="babyname-info">
                    <div className="babyname-name">
                      {n.name}
                      {g && <span className="gender-pill" style={{ color: g.color, borderColor: g.color }}>{g.label}</span>}
                    </div>
                    {n.note && <div className="babyname-note">{n.note}</div>}
                  </div>
                  <ConfirmButton className="babyname-remove" title="Hapus nama ini" onConfirm={() => handleDelete(n.id)}>✕</ConfirmButton>
                </div>
              );
            })
          )}
        </div>
      </div>

      <p className="disclaimer">
        Usia kehamilan cuma perkiraan kalender (aturan Naegele: HPHT + 280 hari), bukan pengganti
        perhitungan USG dokter. Daftar calon nama bersifat pribadi dan cuma bisa diakses lewat
        akunmu — cocok buat brainstorming nama bareng pasangan sebelum diputuskan.
      </p>
    </div>
  );
}
