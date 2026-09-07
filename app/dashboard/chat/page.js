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

let nextMsgId = 1;
function newId() { return nextMsgId++; }

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
  const threadEndRef = useRef(null);

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      setUser(sessionData.session.user);
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

  function removePendingImage() {
    if (pendingImage?.url) URL.revokeObjectURL(pendingImage.url);
    setPendingImage(null);
  }

  function pushMessage(msg) {
    setMessages((prev) => [...prev, { id: newId(), ...msg }]);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text && !pendingImage) return;

    if (!pendingImage) {
      // No photo attached — this chat is scoped to photo-based logging for
      // now, so nudge instead of pretending to answer free-form questions.
      pushMessage({ role: "user", text });
      pushMessage({ role: "assistant", text: "Kirim foto makanan/minumanmu ya, biar aku bisa analisis gizinya dan catat otomatis ke Bloom 📸🍽️" });
      setInput("");
      return;
    }

    const imageUrl = pendingImage.url;
    const file = pendingImage.file;
    pushMessage({ role: "user", text, imageUrl });
    setInput("");
    setPendingImage(null);
    setSending(true);
    const typingId = newId();
    setMessages((prev) => [...prev, { id: typingId, role: "assistant", typing: true }]);

    try {
      const { base64, mimeType } = await resizeImageForChat(file);
      const res = await fetch("/api/nutrition-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: { base64, mimeType } }),
      });
      const data = await res.json();
      setMessages((prev) => prev.filter((m) => m.id !== typingId));

      if (!res.ok) {
        pushMessage({ role: "assistant", text: `⚠ ${data.error || "Ada gangguan, coba lagi ya."}` });
        return;
      }

      const result = data.result;
      if (!result.is_food) {
        pushMessage({ role: "assistant", text: result.note || "🤔 Sepertinya ini bukan foto makanan, atau aku nggak yakin apa isinya. Coba foto lain yang lebih jelas ya." });
        return;
      }

      const row = { user_id: user.id, date: todayISO(), meal: result.meal, source: "chat" };
      NUTRIENT_ORDER.forEach((n) => { row[n] = result[n]; });
      const { data: saved, error: saveError } = await supabase.from("meals").insert(row).select().maybeSingle();

      const detail = NUTRIENT_ORDER
        .filter((n) => result[n] > 0)
        .map((n) => `${NUTRIENT_META[n].label} ${result[n]}${NUTRIENT_META[n].unit}`)
        .join(" · ");

      if (saveError) {
        pushMessage({ role: "assistant", text: `🍽️ *${result.meal}*\n${detail}\n\n💡 ${result.note}\n\n⚠ Gagal menyimpan ke menu — coba lagi sebentar lagi.` });
      } else {
        pushMessage({ role: "assistant", text: `🍽️ *${result.meal}*\n${detail}\n\n💡 ${result.note}`, savedMealId: saved.id, mealName: result.meal });
      }
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== typingId));
      pushMessage({ role: "assistant", text: "⚠ Ada gangguan pas menganalisis fotonya. Coba kirim ulang beberapa saat lagi." });
    } finally {
      setSending(false);
      URL.revokeObjectURL(imageUrl);
    }
  }

  async function undoSavedMeal(msgId, mealId) {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, undone: true } : m)));
    await supabase.from("meals").delete().eq("id", mealId);
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
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Chat gizi · AI</p>
        <h1 className="bloom-title">Chat</h1>
        <p className="bloom-sub">
          Kirim foto makanan/minumanmu — dianalisis oleh AI (Gemini), lengkap dengan insight gizinya,
          dan otomatis tersimpan ke menu hari ini di Dashboard.
        </p>
      </div>

      <div className="bloom-grid">
        <div className="panel full">
          <div className="chat-thread">
            {messages.length === 0 && (
              <div className="chat-empty">Belum ada percakapan. Lampirkan foto makanan lewat 🖼️ di bawah untuk mulai 🌱</div>
            )}
            {messages.map((m) => (
              <div className={`chat-msg-row ${m.role}`} key={m.id}>
                <div className="chat-bubble">
                  {m.typing ? (
                    <span className="chat-typing">mengetik…</span>
                  ) : (
                    <>
                      {m.imageUrl && <img className="chat-bubble-image" src={m.imageUrl} alt="" />}
                      {m.text && <span>{m.text}</span>}
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
                🖼️
                <input type="file" accept="image/*" onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <textarea
                rows={1}
                placeholder="Tulis catatan (opsional), lampirkan foto makanan, lalu kirim…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              />
              <button className="chat-send-btn" onClick={handleSend} disabled={sending || (!input.trim() && !pendingImage)}>
                {sending ? "Mengirim…" : "Kirim"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <p className="disclaimer">
        Perkiraan gizi dari foto dibuat oleh AI dan bersifat estimasi kasar berdasarkan porsi yang
        terlihat — bukan pengukuran presisi. Menu yang tercatat lewat chat tetap bisa kamu edit atau
        hapus dari Dashboard. Fotonya tidak disimpan di Bloom — cuma dikirim ke Gemini untuk dianalisis.
      </p>
    </div>
  );
}
