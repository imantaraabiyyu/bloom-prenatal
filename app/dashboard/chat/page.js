"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { NUTRIENT_ORDER, NUTRIENT_META, todayISO } from "@/lib/nutrition";

// Downscales a photo client-side before it ever leaves the browser — phone
// camera photos can be 5-10MB+, which is both slow to upload and pushes
// against the API route's request-size guard. No library: a canvas resize is
// plenty for what Gemini needs to read a plate of food.
function resizeImageForChat(file, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Gagal memuat foto.")); };
    img.src = objectUrl;
  });
}

// Shared between a freshly-received analysis and one hydrated back from
// chat_messages.analysis after a reload — same text either way.
function formatAnalysisText(result) {
  const detail = NUTRIENT_ORDER
    .filter((n) => result[n] > 0)
    .map((n) => `${NUTRIENT_META[n].label} ${result[n]}${NUTRIENT_META[n].unit}`)
    .join(" · ");
  return `🍽️ *${result.meal}*\n${detail}\n\n💬 ${result.reply}`;
}

// One entry per past turn, used as Gemini's conversation context — never
// includes past photos (those aren't stored, see chat_messages in
// supabase/schema.sql), just a placeholder so the model knows one was sent.
function toHistoryEntry(m) {
  if (m.analysis) return { role: m.role, text: formatAnalysisText(m.analysis) };
  if (m.text) return { role: m.role, text: m.text };
  if (m.hadImage) return { role: m.role, text: "(mengirim foto makanan)" };
  return null;
}

let nextTypingId = 1;

export default function ChatPage() {
  const router = useRouter();
  const supabase = useMemo(() => {
    try { return getSupabaseClient(); } catch (e) { return null; }
  }, []);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null); // { file, url }
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const threadEndRef = useRef(null);

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      const u = sessionData.session.user;
      setUser(u);

      // Chat history — photos themselves are never stored (see disclaimer
      // below), so a reloaded user message with had_image just shows a
      // placeholder instead of the actual photo.
      const { data: rows } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("user_id", u.id)
        .order("created_at", { ascending: true });
      setMessages((rows || []).map((r) => ({
        id: r.id, role: r.role, text: r.text, hadImage: r.had_image,
        analysis: r.analysis, savedMealId: r.saved_meal_id,
      })));
      setLoading(false);
    })();
  }, [supabase, router]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  function pickImage(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    if (pendingImage?.url) URL.revokeObjectURL(pendingImage.url);
    setPendingImage({ file, url: URL.createObjectURL(file) });
  }

  // Three ways to attach a photo: the 🖼️ button, dragging a file onto the
  // panel, or pasting an image straight from the clipboard.
  function handleDragOver(e) { e.preventDefault(); setDragActive(true); }
  function handleDragLeave() { setDragActive(false); }
  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    pickImage(e.dataTransfer.files?.[0]);
  }
  function handlePaste(e) {
    const item = Array.from(e.clipboardData?.items || []).find((it) => it.type.startsWith("image/"));
    if (item) pickImage(item.getAsFile());
  }

  function removePendingImage() {
    if (pendingImage?.url) URL.revokeObjectURL(pendingImage.url);
    setPendingImage(null);
  }

  // Persists one message and adds it to local state, returning its DB row.
  async function saveMessage(fields, extraLocal = {}) {
    const { data, error } = await supabase
      .from("chat_messages")
      .insert({ user_id: user.id, ...fields })
      .select()
      .maybeSingle();
    if (error || !data) {
      console.error("chat_messages insert error:", error);
      return null;
    }
    setMessages((prev) => [...prev, {
      id: data.id, role: data.role, text: data.text, hadImage: data.had_image,
      analysis: data.analysis, savedMealId: data.saved_meal_id, ...extraLocal,
    }]);
    return data;
  }

  async function handleSend() {
    const text = input.trim();
    if (!text && !pendingImage) return;

    // Context for Gemini is everything BEFORE this turn — captured now,
    // since the messages state updates from saveMessage() below won't be
    // reflected in this closure's `messages` until the next render.
    const history = messages.map(toHistoryEntry).filter(Boolean).slice(-12);

    const imageUrl = pendingImage?.url;
    const file = pendingImage?.file;
    const hadImage = !!pendingImage;
    await saveMessage({ role: "user", text: text || null, had_image: hadImage }, hadImage ? { imageUrl } : {});
    setInput("");
    setPendingImage(null);
    setSending(true);
    const typingId = `typing-${nextTypingId++}`;
    setMessages((prev) => [...prev, { id: typingId, role: "assistant", typing: true }]);

    try {
      const image = file ? await resizeImageForChat(file) : null;
      const res = await fetch("/api/nutrition-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text || null, image, history }),
      });
      const data = await res.json();
      setMessages((prev) => prev.filter((m) => m.id !== typingId));

      if (!res.ok) {
        await saveMessage({ role: "assistant", text: `⚠ ${data.error || "Ada gangguan, coba lagi ya."}`, had_image: false });
        return;
      }

      const result = data.result;
      if (result.is_log && result.meal) {
        // Saved as analysis only — the "Simpan ke Dashboard" button (below)
        // is what actually inserts it into `meals`, so nothing's logged
        // until the user confirms it looks right.
        await saveMessage({ role: "assistant", had_image: false, analysis: result });
      } else {
        await saveMessage({ role: "assistant", had_image: false, text: result.reply || "…" });
      }
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== typingId));
      await saveMessage({ role: "assistant", text: "⚠ Ada gangguan, coba kirim ulang beberapa saat lagi.", had_image: false });
    } finally {
      setSending(false);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    }
  }

  async function saveAnalysisToMeals(msgId, analysis) {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, saving: true, saveError: "" } : m)));
    const row = { user_id: user.id, date: todayISO(), meal: analysis.meal, source: "chat" };
    NUTRIENT_ORDER.forEach((n) => { row[n] = analysis[n]; });
    const { data: saved, error } = await supabase.from("meals").insert(row).select().maybeSingle();
    if (error) {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, saving: false, saveError: "⚠ Gagal menyimpan, coba lagi." } : m)));
      return;
    }
    await supabase.from("chat_messages").update({ saved_meal_id: saved.id }).eq("id", msgId);
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, saving: false, savedMealId: saved.id } : m)));
  }

  async function undoSavedMeal(msgId, mealId) {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, savedMealId: null, undone: true } : m)));
    await supabase.from("meals").delete().eq("id", mealId);
    await supabase.from("chat_messages").update({ saved_meal_id: null }).eq("id", msgId);
  }

  async function clearHistory() {
    if (typeof window !== "undefined" && !window.confirm("Hapus semua riwayat chat? Menu yang sudah tersimpan ke Dashboard tidak ikut terhapus.")) return;
    setMessages([]);
    await supabase.from("chat_messages").delete().eq("user_id", user.id);
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
          <Link href="/dashboard/journal" className="nav-link">Jurnal</Link>
          <Link href="/dashboard/chat" className="nav-link active">Chat</Link>
          <Link href="/dashboard/baby-names" className="nav-link">Nama Bayi</Link>
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Chat gizi · AI</p>
        <h1 className="bloom-title">Chat</h1>
        <p className="bloom-sub">
          Ngobrol santai soal kehamilan & gizi, atau ceritakan/kirim foto makananmu — kalau itu menu
          yang mau dicatat, Bloom akan menganalisis gizinya dan kamu tinggal simpan ke menu hari ini.
        </p>
      </div>

      <div className="bloom-grid">
        <div
          className={`panel full ${dragActive ? "chat-drag-active" : ""}`}
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
        >
          <div className="chat-toolbar">
            {messages.length > 0 && <button className="chat-clear-btn" onClick={clearHistory}>Hapus riwayat chat</button>}
          </div>
          <div className="chat-thread">
            {messages.length === 0 && (
              <div className="chat-empty">Belum ada percakapan. Sapa Bloom atau kirim foto makanan di bawah untuk mulai 🌱</div>
            )}
            {messages.map((m) => (
              <div className={`chat-msg-row ${m.role}`} key={m.id}>
                <div className="chat-bubble">
                  {m.typing ? (
                    <span className="chat-typing">mengetik…</span>
                  ) : (
                    <>
                      {m.imageUrl && <img className="chat-bubble-image" src={m.imageUrl} alt="" />}
                      {!m.imageUrl && m.hadImage && <div className="chat-photo-placeholder">📷 Foto (tidak disimpan)</div>}
                      {m.text && <span>{m.text}</span>}
                      {m.analysis && <span>{formatAnalysisText(m.analysis)}</span>}
                      {m.analysis && !m.savedMealId && !m.undone && (
                        <div className="chat-bubble-actions">
                          <button type="button" className="chat-save-meal-btn" onClick={() => saveAnalysisToMeals(m.id, m.analysis)} disabled={m.saving}>
                            {m.saving ? "Menyimpan…" : "Simpan ke Dashboard"}
                          </button>
                        </div>
                      )}
                      {m.saveError && <div className="chat-save-error">{m.saveError}</div>}
                      {m.savedMealId && !m.undone && (
                        <div className="chat-bubble-actions">
                          <span className="chat-saved-tag">✓ Tersimpan ke menu hari ini</span>
                          <button type="button" onClick={() => undoSavedMeal(m.id, m.savedMealId)}>Hapus</button>
                        </div>
                      )}
                      {m.undone && <div className="chat-bubble-actions"><span className="chat-saved-tag">Dihapus dari menu</span></div>}
                    </>
                  )}
                </div>
              </div>
            ))}
            <div ref={threadEndRef} />
          </div>

          <div className="chat-input-area">
            {pendingImage && (
              <div className="pending-attachments">
                <div className="pending-item">
                  <img src={pendingImage.url} alt="" />
                  <button type="button" onClick={removePendingImage}>✕</button>
                </div>
              </div>
            )}
            <div className="chat-input-row">
              <label className="attach-btn" title="Lampirkan foto">
                🖼️ Foto
                <input type="file" accept="image/*" onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <textarea
                rows={1}
                placeholder="Tulis pesan, atau lampirkan/tempel/seret foto makanan, lalu kirim…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                onPaste={handlePaste}
              />
              <button className="chat-send-btn" onClick={handleSend} disabled={sending || (!input.trim() && !pendingImage)}>
                {sending ? "Mengirim…" : "Kirim"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <p className="disclaimer">
        Balasan Bloom dibuat oleh AI (Gemini) — obrolan umum soal gizi/kehamilan bersifat informasi
        umum, bukan pengganti konsultasi dokter/bidan. Perkiraan gizi dari menu yang diceritakan/difoto
        juga estimasi kasar, bukan pengukuran presisi — klik "Simpan ke Dashboard" untuk menambahkannya
        ke menu hari ini (bisa diedit/dihapus dari Dashboard kapan saja). Fotonya sendiri tidak
        disimpan di Bloom — cuma dikirim ke Gemini untuk dianalisis lalu dibuang; riwayat chat
        menyimpan teks dan hasil analisisnya saja.
      </p>
    </div>
  );
}
