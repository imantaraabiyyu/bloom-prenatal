"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import ConfirmButton from "@/components/ConfirmButton";
import {
  ALL_TRACKED_NUTRIENTS, ALL_TRACKED_META,
  todayISO, vitaminItemToRow, buildExtraNutrientsMap,
} from "@/lib/nutrition";
import {
  Home, NotebookText, MessageCircle, User, X, Check, Paperclip,
  Camera, Images, AlertTriangle, History, Plus,
  Image as ImageIcon, // aliased -- this file's resizeImageForChat uses the
                       // real global `new Image()`, which a same-named
                       // import would shadow and silently break
} from "lucide-react";

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
// chat_messages.analysis after a reload — same text either way. Iterates
// ALL_TRACKED_NUTRIENTS (floor + ceiling type combined) so sugar/sodium/etc.
// show up next to calories/protein/etc. the same way, plus any ad-hoc
// extra_nutrients (Omega-3, Zinc, ...) Gemini found on this item.
function formatAnalysisText(result) {
  const detail = [
    ...ALL_TRACKED_NUTRIENTS.filter((n) => result[n] > 0).map((n) => `${ALL_TRACKED_META[n].label} ${result[n]}${ALL_TRACKED_META[n].unit}`),
    ...(result.extra_nutrients || []).map((e) => `${e.label} ${e.value}${e.unit || ""}`),
  ].join(" · ");
  return `🍽️ *${result.meal}*\n${detail}\n\n💬 ${result.reply}`;
}

// Vitamin-category counterpart of formatAnalysisText above — one line per
// detected item (name + nutrient/extra_nutrients detail), followed by the
// shared `reply`. `extra_nutrients` here is still the raw {label,unit,value}
// array lib/gemini.js's sanitizeChatTurnResult returns, not yet the
// slug-keyed map vitaminItemToRow (lib/nutrition.js) builds for the DB row.
function formatVitaminAnalysisText(result) {
  const lines = (result.vitamins || []).map((v) => {
    const detail = [
      ...ALL_TRACKED_NUTRIENTS.filter((n) => v[n] > 0).map((n) => `${ALL_TRACKED_META[n].label} ${v[n]}${ALL_TRACKED_META[n].unit}`),
      ...(v.extra_nutrients || []).map((e) => `${e.label} ${e.value}${e.unit || ""}`),
    ].join(" · ");
    return `• *${v.name}*${detail ? ` — ${detail}` : ""}`;
  });
  return `💊 *Vitamin terdeteksi:*\n${lines.join("\n")}\n\n💬 ${result.reply}`;
}

// Soft, non-alarming badge copy for a category="food" analysis's verdict
// (lib/gemini.js's VERDICT_VALUES) — deliberately no red/alarm styling here;
// red is reserved for the deterministic exceeded-limit warning banner on the
// Dashboard (app/dashboard/page.js), which is exact math, not this
// per-item qualitative judgment call. `kurangi_dulu` still renders amber, not
// red, per the explicit "keep a bad verdict soft" requirement.
const VERDICT_BADGES = {
  aman: { label: "✅ Aman dikonsumsi", className: "verdict-badge verdict-safe" },
  waspada: { label: "🤔 Boleh, tapi dibatasi", className: "verdict-badge verdict-caution" },
  kurangi_dulu: { label: "🍃 Porsinya dikurangi dulu ya", className: "verdict-badge verdict-caution" },
};

// One entry per past turn, used as Gemini's conversation context — never
// includes past photos (those aren't stored, see chat_messages in
// supabase/schema.sql), just a placeholder so the model knows one was sent.
function toHistoryEntry(m) {
  if (m.analysis?.category === "vitamin") return { role: m.role, text: formatVitaminAnalysisText(m.analysis) };
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
  const [sessions, setSessions] = useState([]); // chat_sessions rows, newest-updated first
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false); // mobile/tablet-only slide-in (<820px)
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null); // { file, url }
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false); // tap-to-toggle on mobile; CSS :hover also reveals it on desktop
  const threadEndRef = useRef(null);
  const attachMenuRef = useRef(null);

  // One raw chat_messages row -> the shape local state uses — shared by the
  // initial session load and every subsequent session switch.
  function rowToMessage(r) {
    return {
      id: r.id, role: r.role, text: r.text, hadImage: r.had_image,
      analysis: r.analysis, savedMealId: r.saved_meal_id,
    };
  }

  // Replaces `messages` with one session's history. Gemini's own
  // conversation context (the `history` built in handleSend below) is
  // derived straight from `messages`, so swapping it here is also what
  // scopes Gemini's memory of prior turns to the session you're actually
  // looking at — switching sessions gives Gemini a clean slate, not a mix
  // of every conversation you've ever had.
  async function loadMessagesForSession(sessionId) {
    const { data: rows } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    setMessages((rows || []).map(rowToMessage));
  }

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      const u = sessionData.session.user;
      setUser(u);

      // Session list, newest-active-first (chat_sessions.updated_at — see
      // touchSession below). A brand-new user (or one whose only sessions
      // were all deleted) gets one fresh empty session created on the spot
      // so there's always somewhere to chat into.
      let { data: sessionRows } = await supabase
        .from("chat_sessions")
        .select("*")
        .eq("user_id", u.id)
        .order("updated_at", { ascending: false });
      if (!sessionRows || sessionRows.length === 0) {
        const { data: created } = await supabase
          .from("chat_sessions").insert({ user_id: u.id }).select().maybeSingle();
        sessionRows = created ? [created] : [];
      }
      setSessions(sessionRows);
      const active = sessionRows[0] || null;
      setActiveSessionId(active?.id || null);
      // Photos themselves are never stored (see disclaimer below), so a
      // reloaded user message with had_image just shows a placeholder
      // instead of the actual photo.
      if (active) await loadMessagesForSession(active.id);
      setLoading(false);
    })();
  }, [supabase, router]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Closes the attach menu on an outside tap/click — needed since on mobile
  // it's opened by tapping (no hover state to rely on for dismissing it).
  useEffect(() => {
    if (!attachMenuOpen) return;
    function handleOutside(e) {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target)) setAttachMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [attachMenuOpen]);

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
      .insert({ user_id: user.id, session_id: activeSessionId, ...fields })
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

  // Sets a still-untitled session's title from its first message (plain
  // truncation — no extra Gemini call just to name a chat), and always
  // bumps updated_at so the session you're actually talking in sorts first
  // in the list. Called once per turn (right after the user message saves),
  // not once per saveMessage call, to keep this to one extra write per turn.
  async function touchSession(sessionId, { text, hadImage }) {
    const current = sessions.find((s) => s.id === sessionId);
    const updates = { updated_at: new Date().toISOString() };
    if (current && !current.title) {
      updates.title = text ? text.slice(0, 60) : (hadImage ? "Chat dari foto" : "Chat baru");
    }
    const { data } = await supabase.from("chat_sessions").update(updates).eq("id", sessionId).select().maybeSingle();
    if (!data) return;
    setSessions((prev) => prev
      .map((s) => (s.id === sessionId ? data : s))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)));
  }

  async function handleSend() {
    const text = input.trim();
    if (!text && !pendingImage) return;

    // Context for Gemini is everything BEFORE this turn — captured now,
    // since the messages state updates from saveMessage() below won't be
    // reflected in this closure's `messages` until the next render. Scoped
    // to the active session only (see loadMessagesForSession above), so
    // Gemini's memory of prior turns never bleeds across sessions.
    const history = messages.map(toHistoryEntry).filter(Boolean).slice(-12);

    const imageUrl = pendingImage?.url;
    const file = pendingImage?.file;
    const hadImage = !!pendingImage;
    const savedUserMsg = await saveMessage({ role: "user", text: text || null, had_image: hadImage }, hadImage ? { imageUrl } : {});
    if (savedUserMsg) touchSession(activeSessionId, { text, hadImage });
    setInput("");
    setPendingImage(null);
    setSending(true);
    // Local-only placeholder that grows as delta events arrive — replaced by
    // the real (persisted) message once the stream finishes, same swap the
    // old "typing" placeholder did, just with real text growing meanwhile.
    const streamId = `stream-${nextTypingId++}`;
    setMessages((prev) => [...prev, { id: streamId, role: "assistant", text: "", streaming: true }]);
    function appendDelta(delta) {
      setMessages((prev) => prev.map((m) => (m.id === streamId ? { ...m, text: (m.text || "") + delta } : m)));
    }

    try {
      const image = file ? await resizeImageForChat(file) : null;
      const res = await fetch("/api/nutrition-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `today`: browser-local todayISO() -- lets the route fetch today's
        // already-saved cumulative sugar/sodium/etc. totals (server-side,
        // read-only) so Gemini's verdict can reason about the whole day, not
        // just this one item (see app/api/nutrition-chat/route.js).
        body: JSON.stringify({ message: text || null, image, history, today: todayISO() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessages((prev) => prev.filter((m) => m.id !== streamId));
        await saveMessage({ role: "assistant", text: `⚠ ${data.error || "Ada gangguan, coba lagi ya."}`, had_image: false });
        return;
      }

      // Newline-delimited JSON events: {type:"delta"|"done"|"error", ...}
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      let streamError = null;

      function handleLine(line) {
        if (!line.trim()) return;
        let evt;
        try { evt = JSON.parse(line); } catch { return; }
        if (evt.type === "delta") appendDelta(evt.text);
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

      setMessages((prev) => prev.filter((m) => m.id !== streamId));

      if (streamError) {
        await saveMessage({ role: "assistant", text: `⚠ ${streamError}`, had_image: false });
      } else if (!finalResult) {
        await saveMessage({ role: "assistant", text: "⚠ Ada gangguan, coba lagi ya.", had_image: false });
      } else if (
        (finalResult.category === "food" && finalResult.meal) ||
        (finalResult.category === "vitamin" && finalResult.vitamins?.length > 0)
      ) {
        // Saved as analysis only — the "Simpan ke Dashboard" button(s) below
        // are what actually insert into `meals`/`vitamins`, so nothing's
        // logged until the user confirms it looks right.
        await saveMessage({ role: "assistant", had_image: false, analysis: finalResult });
      } else {
        await saveMessage({ role: "assistant", had_image: false, text: finalResult.reply || "…" });
      }
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== streamId));
      await saveMessage({ role: "assistant", text: "⚠ Ada gangguan, coba kirim ulang beberapa saat lagi.", had_image: false });
    } finally {
      setSending(false);
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    }
  }

  async function saveAnalysisToMeals(msgId, analysis) {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, saving: true, saveError: "" } : m)));
    const row = { user_id: user.id, date: todayISO(), meal: analysis.meal, source: "chat" };
    ALL_TRACKED_NUTRIENTS.forEach((n) => { row[n] = analysis[n]; });
    row.extra_nutrients = buildExtraNutrientsMap(analysis.extra_nutrients);
    const { data: saved, error } = await supabase.from("meals").insert(row).select().maybeSingle();
    if (error) {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, saving: false, saveError: "Gagal menyimpan, coba lagi." } : m)));
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

  // Applies `updater` to message `msgId`'s analysis.vitamins[itemIndex] and
  // returns the updated full `analysis` object so the caller can persist it
  // in one shot — chat_messages has no per-vitamin-item column (unlike
  // meals' single saved_meal_id), since one turn can now save more than one
  // vitamin, so the whole jsonb `analysis` blob is what's written back to
  // mark one item saved/undone. No schema change needed.
  function updateVitaminItemLocal(msgId, itemIndex, updater) {
    let updatedAnalysis = null;
    setMessages((prev) => prev.map((m) => {
      if (m.id !== msgId || !m.analysis?.vitamins) return m;
      const vitamins = m.analysis.vitamins.map((v, i) => (i === itemIndex ? updater(v) : v));
      updatedAnalysis = { ...m.analysis, vitamins };
      return { ...m, analysis: updatedAnalysis };
    }));
    return updatedAnalysis;
  }

  // Saving/error state is keyed by item index on the message itself (not a
  // single shared flag) so multiple "Simpan" buttons within one vitamin
  // reply can be clicked independently without interfering with each other.
  async function saveVitaminItemToDashboard(msgId, itemIndex, item) {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? {
      ...m,
      vitaminSaving: { ...(m.vitaminSaving || {}), [itemIndex]: true },
      vitaminErrors: { ...(m.vitaminErrors || {}), [itemIndex]: "" },
    } : m)));
    const row = vitaminItemToRow(item, user.id);
    const { data: saved, error } = await supabase.from("vitamins").insert(row).select().maybeSingle();
    if (error) {
      setMessages((prev) => prev.map((m) => (m.id === msgId ? {
        ...m,
        vitaminSaving: { ...(m.vitaminSaving || {}), [itemIndex]: false },
        vitaminErrors: { ...(m.vitaminErrors || {}), [itemIndex]: "Gagal menyimpan, coba lagi." },
      } : m)));
      return;
    }
    const updatedAnalysis = updateVitaminItemLocal(msgId, itemIndex, (v) => ({ ...v, saved_vitamin_id: saved.id }));
    setMessages((prev) => prev.map((m) => (m.id === msgId ? {
      ...m, vitaminSaving: { ...(m.vitaminSaving || {}), [itemIndex]: false },
    } : m)));
    if (updatedAnalysis) await supabase.from("chat_messages").update({ analysis: updatedAnalysis }).eq("id", msgId);
  }

  async function undoSavedVitaminItem(msgId, itemIndex, vitaminId) {
    const updatedAnalysis = updateVitaminItemLocal(msgId, itemIndex, (v) => {
      const { saved_vitamin_id, ...rest } = v;
      return { ...rest, undone: true };
    });
    await supabase.from("vitamins").delete().eq("id", vitaminId);
    if (updatedAnalysis) await supabase.from("chat_messages").update({ analysis: updatedAnalysis }).eq("id", msgId);
  }

  // Starts a fresh, empty session and switches to it — this is the "New
  // chat" action; the session you were just in stays in the list untouched.
  async function startNewSession() {
    const { data: created } = await supabase.from("chat_sessions").insert({ user_id: user.id }).select().maybeSingle();
    if (!created) return;
    setSessions((prev) => [created, ...prev]);
    setActiveSessionId(created.id);
    setMessages([]);
    setSessionDrawerOpen(false);
  }

  async function switchSession(sessionId) {
    if (sessionId !== activeSessionId) {
      setActiveSessionId(sessionId);
      await loadMessagesForSession(sessionId);
    }
    setSessionDrawerOpen(false);
  }

  // Deletes one session — its messages cascade-delete with it (see the
  // session_id FK's `on delete cascade` in supabase/schema.sql), no separate
  // chat_messages cleanup needed. Keeps the page usable afterward: switches
  // to whatever's now most recent, or spins up a fresh empty session if that
  // was the user's last one, so there's never a moment with zero sessions.
  async function deleteSession(sessionId) {
    await supabase.from("chat_sessions").delete().eq("id", sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    if (remaining.length === 0) {
      const { data: created } = await supabase.from("chat_sessions").insert({ user_id: user.id }).select().maybeSingle();
      setSessions(created ? [created] : []);
      setActiveSessionId(created?.id || null);
      setMessages([]);
      return;
    }
    setSessions(remaining);
    if (sessionId === activeSessionId) {
      setActiveSessionId(remaining[0].id);
      await loadMessagesForSession(remaining[0].id);
    }
  }

  // "Hapus semua riwayat" — wipes every session (and, via cascade, every
  // message) for this user, distinct from "Hapus riwayat chat" below which
  // only clears the one session currently open.
  async function deleteAllHistory() {
    await supabase.from("chat_sessions").delete().eq("user_id", user.id);
    const { data: created } = await supabase.from("chat_sessions").insert({ user_id: user.id }).select().maybeSingle();
    setSessions(created ? [created] : []);
    setActiveSessionId(created?.id || null);
    setMessages([]);
  }

  function formatSessionMeta(s) {
    return new Date(s.updated_at).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  if (loading) return <div className="center-loading">Memuat data…</div>;

  return (
    <div className="wrap chat-page">
      <div className="topbar">
        <div className="topbar-left">
          <div className="avatar">{(user?.email || "?").charAt(0).toUpperCase()}</div>
          <span className="user-name">{user?.email}</span>
        </div>
        <div className="topbar-nav">
          <Link href="/dashboard" className="nav-link"><Home size={19} /><span>Dashboard</span></Link>
          <Link href="/dashboard/journal" className="nav-link"><NotebookText size={19} /><span>Jurnal</span></Link>
          <Link href="/dashboard/chat" className="nav-link active"><MessageCircle size={19} /><span>Chat</span></Link>
          <Link href="/dashboard/profile" className="nav-link"><User size={19} /><span>Profil</span></Link>
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Chat gizi · AI</p>
        <h1 className="bloom-title">Chat</h1>
        <p className="bloom-sub">
          Ngobrol santai soal kehamilan & gizi, ceritakan/kirim foto makananmu, atau foto label
          vitamin/suplemen (dari kemasan atau resep dokter) dan label gizi kemasan makanan/minuman —
          Bloom akan menganalisisnya dan kamu tinggal simpan ke Dashboard.
        </p>
      </div>

      <div className="bloom-grid">
        {/* Backdrop only visually/interactively exists below the 820px
            bloom-grid breakpoint (app/globals.css) -- above it the session
            panel is a normal static sidebar column, not a drawer. */}
        <div
          className={`chat-session-backdrop ${sessionDrawerOpen ? "open" : ""}`}
          onClick={() => setSessionDrawerOpen(false)}
        />
        <div className={`panel chat-session-panel ${sessionDrawerOpen ? "open" : ""}`}>
          <div className="chat-session-header">
            <h2><History size={16} /> Riwayat Chat</h2>
            <button type="button" className="chat-new-session-btn" onClick={startNewSession} title="Chat baru">
              <Plus size={14} /> Chat baru
            </button>
          </div>
          <div className="chat-session-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`chat-session-item ${s.id === activeSessionId ? "active" : ""}`}
                onClick={() => switchSession(s.id)}
              >
                <div className="chat-session-info">
                  <div className="chat-session-title">{s.title || "Chat baru"}</div>
                  <div className="chat-session-meta">{formatSessionMeta(s)}</div>
                </div>
                <div onClick={(e) => e.stopPropagation()}>
                  <ConfirmButton className="chat-session-remove" title="Hapus sesi ini" onConfirm={() => deleteSession(s.id)}>
                    <X size={13} />
                  </ConfirmButton>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className={`panel chat-thread-panel ${dragActive ? "chat-drag-active" : ""}`}
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
        >
          <div className="chat-toolbar">
            <button type="button" className="chat-session-toggle" onClick={() => setSessionDrawerOpen(true)}>
              <History size={14} /> Riwayat
            </button>
            {messages.length > 0 && (
              <>
                <ConfirmButton
                  className="chat-clear-btn" onConfirm={() => deleteSession(activeSessionId)}
                  note="Menu yang sudah tersimpan ke Dashboard tidak ikut terhapus."
                >
                  Hapus riwayat chat ini
                </ConfirmButton>
                {sessions.length > 1 && (
                  <ConfirmButton
                    className="chat-clear-btn" onConfirm={deleteAllHistory}
                    note="Semua sesi chat akan dihapus. Menu yang sudah tersimpan ke Dashboard tidak ikut terhapus."
                  >
                    Hapus semua riwayat
                  </ConfirmButton>
                )}
              </>
            )}
          </div>
          <div className="chat-thread">
            {messages.length === 0 && (
              <div className="chat-empty">Belum ada percakapan. Sapa Bloom atau kirim foto makanan di bawah untuk mulai 🌱</div>
            )}
            {messages.map((m) => (
              <div className={`chat-msg-row ${m.role}`} key={m.id}>
                <div className="chat-bubble">
                  {m.streaming ? (
                    <span>{m.text}<span className="chat-cursor" /></span>
                  ) : (
                    <>
                      {m.imageUrl && <img className="chat-bubble-image" src={m.imageUrl} alt="" />}
                      {!m.imageUrl && m.hadImage && <div className="chat-photo-placeholder"><ImageIcon size={13} /> Foto (tidak disimpan)</div>}
                      {m.text && <span>{m.text}</span>}
                      {m.analysis?.category === "vitamin" ? (
                        <>
                          <span>{formatVitaminAnalysisText(m.analysis)}</span>
                          {m.analysis.vitamins.map((v, i) => (
                            <div className="chat-bubble-actions" key={i}>
                              {!v.saved_vitamin_id && !v.undone && (
                                <button
                                  type="button" className="chat-save-meal-btn"
                                  onClick={() => saveVitaminItemToDashboard(m.id, i, v)}
                                  disabled={!!m.vitaminSaving?.[i]}
                                >
                                  {m.vitaminSaving?.[i] ? "Menyimpan…" : `Simpan "${v.name}" ke Dashboard`}
                                </button>
                              )}
                              {m.vitaminErrors?.[i] && <div className="chat-save-error"><AlertTriangle size={12} /> {m.vitaminErrors[i]}</div>}
                              {v.saved_vitamin_id && !v.undone && (
                                <>
                                  <span className="chat-saved-tag"><Check size={11} /> &quot;{v.name}&quot; tersimpan ke vitamin</span>
                                  <ConfirmButton onConfirm={() => undoSavedVitaminItem(m.id, i, v.saved_vitamin_id)}>Hapus</ConfirmButton>
                                </>
                              )}
                              {v.undone && <span className="chat-saved-tag">Dihapus dari vitamin</span>}
                            </div>
                          ))}
                        </>
                      ) : (
                        <>
                          {m.analysis && <span>{formatAnalysisText(m.analysis)}</span>}
                          {m.analysis?.category === "food" && VERDICT_BADGES[m.analysis.verdict] && (
                            <div className={VERDICT_BADGES[m.analysis.verdict].className}>
                              {VERDICT_BADGES[m.analysis.verdict].label}
                              {m.analysis.verdict_reason && ` — ${m.analysis.verdict_reason}`}
                            </div>
                          )}
                          {m.analysis && !m.savedMealId && !m.undone && (
                            <div className="chat-bubble-actions">
                              <button type="button" className="chat-save-meal-btn" onClick={() => saveAnalysisToMeals(m.id, m.analysis)} disabled={m.saving}>
                                {m.saving ? "Menyimpan…" : "Simpan ke Dashboard"}
                              </button>
                            </div>
                          )}
                          {m.saveError && <div className="chat-save-error"><AlertTriangle size={12} /> {m.saveError}</div>}
                          {m.savedMealId && !m.undone && (
                            <div className="chat-bubble-actions">
                              <span className="chat-saved-tag"><Check size={11} /> Tersimpan ke menu hari ini</span>
                              <ConfirmButton onConfirm={() => undoSavedMeal(m.id, m.savedMealId)}>Hapus</ConfirmButton>
                            </div>
                          )}
                          {m.undone && <div className="chat-bubble-actions"><span className="chat-saved-tag">Dihapus dari menu</span></div>}
                        </>
                      )}
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
                  <button type="button" onClick={removePendingImage}><X size={11} /></button>
                </div>
              </div>
            )}
            <div className="chat-input-row">
              <div className={`attach-menu ${attachMenuOpen ? "open" : ""}`} ref={attachMenuRef}>
                <button
                  type="button" className="attach-btn attach-menu-trigger" title="Lampirkan foto"
                  onClick={() => setAttachMenuOpen((o) => !o)}
                >
                  <Paperclip size={14} /> Foto
                </button>
                <div className="attach-menu-list">
                  <label className="attach-menu-item" onClick={() => setAttachMenuOpen(false)}>
                    <Camera size={15} /> Kamera
                    <input
                      type="file" accept="image/*" capture="environment"
                      onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }}
                    />
                  </label>
                  <label className="attach-menu-item" onClick={() => setAttachMenuOpen(false)}>
                    <Images size={15} /> Galeri
                    <input type="file" accept="image/*" onChange={(e) => { pickImage(e.target.files?.[0]); e.target.value = ""; }} />
                  </label>
                </div>
              </div>
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
        juga estimasi kasar, bukan pengukuran presisi; hasil baca label kemasan/vitamin juga bisa
        salah baca — cek lagi ke kemasan aslinya kalau ragu. Klik "Simpan ke Dashboard" untuk
        menambahkan menu atau vitamin yang terdeteksi (bisa dihapus dari Dashboard kapan saja).
        Fotonya sendiri tidak disimpan di Bloom — cuma dikirim ke Gemini untuk dianalisis lalu
        dibuang; riwayat chat menyimpan teks dan hasil analisisnya saja.
      </p>
    </div>
  );
}
