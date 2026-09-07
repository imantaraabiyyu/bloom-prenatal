"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";

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

export default function BabyNamesPage() {
  const router = useRouter();
  const supabase = useMemo(() => {
    try { return getSupabaseClient(); } catch (e) { return null; }
  }, []);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
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
      const { data: rows } = await supabase
        .from("baby_names")
        .select("*")
        .eq("user_id", u.id)
        .order("is_favorite", { ascending: false })
        .order("name", { ascending: true });
      setNames(rows || []);
      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

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
          <Link href="/dashboard/baby-names" className="nav-link active">Nama Bayi</Link>
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Daftar · calon nama</p>
        <h1 className="bloom-title">Nama Bayi</h1>
        <p className="bloom-sub">
          Kumpulkan calon nama bayi yang kamu suka, tandai favorit, dan catat artinya.
        </p>
      </div>

      <div className="bloom-grid">
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
                  <button className="babyname-remove" title="Hapus nama ini" onClick={() => handleDelete(n.id)}>✕</button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <p className="disclaimer">
        Daftar ini pribadi dan cuma bisa diakses lewat akunmu — cocok buat brainstorming nama bareng
        pasangan sebelum diputuskan.
      </p>
    </div>
  );
}
