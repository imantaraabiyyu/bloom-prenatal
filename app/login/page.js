"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [configError, setConfigError] = useState(false);
  const [supabase, setSupabase] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { getSupabaseClient } = await import("@/lib/supabaseClient");
        const client = getSupabaseClient();
        setSupabase(client);
        const { data } = await client.auth.getSession();
        if (data.session) router.replace("/dashboard");
      } catch (e) {
        setConfigError(true);
      }
    })();
  }, [router]);

  async function handleLogin() {
    setError(""); setInfo("");
    if (!email || !password) { setError("Isi email dan kata sandi."); return; }
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    router.replace("/dashboard");
  }

  async function handleRegister() {
    setError(""); setInfo("");
    if (!email || !password) { setError("Isi email dan kata sandi."); return; }
    if (password.length < 6) { setError("Kata sandi minimal 6 karakter."); return; }
    setLoading(true);
    const { data, error: err } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    if (data.session) {
      router.replace("/dashboard");
    } else {
      setInfo("Akun dibuat. Cek email kamu untuk konfirmasi, lalu masuk di sini.");
      setMode("login");
    }
  }

  if (configError) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p className="auth-eyebrow">Bloom</p>
          <h1 className="auth-title">Setup diperlukan</h1>
          <p className="auth-sub">
            Environment variable Supabase belum diisi. Buat file <code>.env.local</code> berisi
            <code>NEXT_PUBLIC_SUPABASE_URL</code> dan <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
            (lihat README.md), lalu jalankan ulang, atau set keduanya di Vercel → Project Settings → Environment Variables.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <p className="auth-eyebrow">Bloom</p>
        <h1 className="auth-title">{mode === "login" ? "Masuk" : "Buat akun"}</h1>
        <p className="auth-sub">
          {mode === "login"
            ? "Masuk untuk melihat riwayat menu dan gizi harianmu."
            : "Satu akun untuk menyimpan riwayat menu dan vitaminmu, tersinkron di semua perangkat."}
        </p>

        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nama@email.com" autoComplete="email" />
        </div>
        <div className="field">
          <label>Kata sandi{mode === "register" ? " (min. 6 karakter)" : ""}</label>
          <input
            type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••" autoComplete={mode === "login" ? "current-password" : "new-password"}
            onKeyDown={(e) => { if (e.key === "Enter") (mode === "login" ? handleLogin() : handleRegister()); }}
          />
        </div>

        <button className="btn-primary" disabled={loading} onClick={mode === "login" ? handleLogin : handleRegister}>
          {loading ? "Memproses…" : mode === "login" ? "Masuk" : "Buat akun"}
        </button>

        {error && <div className="auth-error">{error}</div>}
        {info && <div className="auth-info">{info}</div>}

        <div className="auth-switch">
          {mode === "login" ? (
            <span>Belum punya akun? <button onClick={() => { setMode("register"); setError(""); setInfo(""); }}>Daftar</button></span>
          ) : (
            <span>Sudah punya akun? <button onClick={() => { setMode("login"); setError(""); setInfo(""); }}>Masuk</button></span>
          )}
        </div>

        <p className="auth-note">
          Login ini memakai Supabase Auth sungguhan — akun dan datamu tersimpan di database,
          bisa diakses dari HP maupun laptop, bukan hanya di satu browser.
        </p>
      </div>
    </div>
  );
}
