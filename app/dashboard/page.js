"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import {
  TARGETS, NUTRIENT_META, NUTRIENT_ORDER,
  SAMPLE_MEAL_CSV, SAMPLE_VIT_CSV, DEFAULT_VITAMINS,
  parseMealCsv, parseVitaminCsv, computeActiveNutrients, groupMealsByDay, dedupeMeals, todayISO,
} from "@/lib/nutrition";

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function Dashboard() {
  const router = useRouter();
  const supabase = useMemo(() => {
    try { return getSupabaseClient(); } catch (e) { return null; }
  }, []);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trimester, setTrimester] = useState("t2");
  const [meals, setMeals] = useState([]);
  const [vitamins, setVitamins] = useState([]);
  const [vitaminChecks, setVitaminChecks] = useState({}); // { date: { vitaminId: true } }
  const [dayIndex, setDayIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [mealError, setMealError] = useState("");
  const [mealFileName, setMealFileName] = useState("");
  const [vitError, setVitError] = useState("");
  const [vitFileName, setVitFileName] = useState("");
  const mealDropRef = useRef(null);
  const vitDropRef = useRef(null);

  // ---------------- bootstrap ----------------
  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      const u = sessionData.session.user;
      setUser(u);

      // profile / trimester
      let { data: profile } = await supabase.from("profiles").select("*").eq("user_id", u.id).maybeSingle();
      if (!profile) {
        const { data: created } = await supabase.from("profiles").insert({ user_id: u.id, trimester: "t2" }).select().maybeSingle();
        profile = created;
      }
      setTrimester(profile?.trimester || "t2");

      // vitamins catalog (seed defaults if empty)
      let { data: vitRows } = await supabase.from("vitamins").select("*").eq("user_id", u.id).order("created_at", { ascending: true });
      if (!vitRows || vitRows.length === 0) {
        const seed = DEFAULT_VITAMINS.map((v) => ({ ...v, user_id: u.id }));
        const { data: inserted } = await supabase.from("vitamins").insert(seed).select();
        vitRows = inserted || [];
      }
      setVitamins(vitRows || []);

      // meals
      const { data: mealRows } = await supabase.from("meals").select("*").eq("user_id", u.id).order("date", { ascending: true });
      setMeals(mealRows || []);

      // vitamin checks
      const { data: checkRows } = await supabase.from("vitamin_checks").select("*").eq("user_id", u.id);
      const map = {};
      (checkRows || []).forEach((c) => {
        if (!map[c.date]) map[c.date] = {};
        map[c.date][c.vitamin_id] = c.checked;
      });
      setVitaminChecks(map);

      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // ---------------- derived data ----------------
  const dates = useMemo(() => {
    const set = new Set();
    meals.forEach((r) => set.add(r.date));
    Object.keys(vitaminChecks).forEach((d) => set.add(d));
    set.add(todayISO());
    return Array.from(set).sort();
  }, [meals, vitaminChecks]);

  const clampedDayIndex = Math.min(Math.max(dayIndex, 0), Math.max(dates.length - 1, 0));
  const currentDate = dates[clampedDayIndex];
  const targets = TARGETS[trimester];
  const activeNutrients = useMemo(() => computeActiveNutrients(meals), [meals]);
  const mealsByDay = useMemo(() => groupMealsByDay(meals), [meals]);

  function dayTotals(date) {
    const base = mealsByDay[date] || {};
    const totals = {};
    NUTRIENT_ORDER.forEach((n) => { totals[n] = base[n] || 0; });
    const checks = vitaminChecks[date] || {};
    vitamins.forEach((v) => {
      if (checks[v.id]) NUTRIENT_ORDER.forEach((n) => { if (v[n] != null) totals[n] += Number(v[n]); });
    });
    return totals;
  }

  const totals = currentDate ? dayTotals(currentDate) : {};
  const datesWithMeals = dates.filter((d) => meals.some((r) => r.date === d));

  // ---------------- actions ----------------
  async function changeTrimester(t) {
    setTrimester(t);
    await supabase.from("profiles").upsert({ user_id: user.id, trimester: t }, { onConflict: "user_id" });
  }

  async function handleMealFile(file) {
    if (!file) return;
    setMealError("");
    const text = await file.text();
    const parsed = parseMealCsv(text);
    if (parsed.length === 0) {
      setMealError("⚠ Tidak ada baris yang dikenali. Pastikan ada kolom date dan minimal satu kolom gizi.");
      return;
    }
    const { unique, duplicateCount } = dedupeMeals(meals, parsed);
    if (unique.length === 0) {
      setMealError(`⚠ Semua ${parsed.length} baris sudah ada sebelumnya (tanggal + nama menu sama). Tidak ada yang ditambahkan.`);
      return;
    }
    const rows = unique.map((r) => ({ ...r, user_id: user.id }));
    const { data, error } = await supabase.from("meals").insert(rows).select();
    if (error) { setMealError("⚠ " + error.message); return; }
    setMeals((prev) => [...prev, ...(data || [])]);
    const dupNote = duplicateCount > 0 ? ` · ${duplicateCount} baris duplikat dilewati` : "";
    setMealFileName(`✓ ${file.name} ditambahkan · total ${meals.length + (data?.length || 0)} baris menu${dupNote}`);
  }

  async function handleVitFile(file) {
    if (!file) return;
    setVitError("");
    const text = await file.text();
    const parsed = parseVitaminCsv(text);
    if (parsed.length === 0) {
      setVitError("⚠ Tidak ada baris yang dikenali. Pastikan ada kolom name.");
      return;
    }
    const rows = parsed.map((v) => {
      const full = { name: v.name, user_id: user.id };
      NUTRIENT_ORDER.forEach((n) => { full[n] = v[n] || 0; });
      return full;
    });
    const { data, error } = await supabase.from("vitamins").insert(rows).select();
    if (error) { setVitError("⚠ " + error.message); return; }
    setVitamins((prev) => [...prev, ...(data || [])]);
    setVitFileName(`✓ ${file.name} · ${data?.length || 0} vitamin ditambahkan`);
  }

  async function toggleVitaminCheck(vitaminId, checked) {
    setVitaminChecks((prev) => {
      const next = { ...prev, [currentDate]: { ...(prev[currentDate] || {}), [vitaminId]: checked } };
      return next;
    });
    await supabase.from("vitamin_checks").upsert(
      { user_id: user.id, date: currentDate, vitamin_id: vitaminId, checked },
      { onConflict: "user_id,date,vitamin_id" }
    );
  }

  async function removeVitamin(vitaminId) {
    setVitamins((prev) => prev.filter((v) => v.id !== vitaminId));
    setVitaminChecks((prev) => {
      const next = {};
      Object.keys(prev).forEach((d) => {
        const { [vitaminId]: _, ...rest } = prev[d];
        next[d] = rest;
      });
      return next;
    });
    await supabase.from("vitamins").delete().eq("id", vitaminId);
  }

  function makeDropHandlers(onFile) {
    return {
      onDragOver: (e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#E3B65E"; },
      onDragLeave: (e) => { e.currentTarget.style.borderColor = ""; },
      onDrop: (e) => {
        e.preventDefault(); e.currentTarget.style.borderColor = "";
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      },
    };
  }

  if (loading) return <div className="center-loading">Memuat data…</div>;

  const visibleNutrients = showAll ? activeNutrients : activeNutrients.slice(0, 5);

  // pcts for summary
  const pcts = activeNutrients.map((n) => (targets[n] ? (totals[n] || 0) / targets[n] * 100 : 0));
  const metCount = pcts.filter((p) => p >= 100).length;
  const avg = pcts.length ? pcts.reduce((a, b) => a + Math.min(b, 100), 0) / pcts.length : 0;
  const statusClass = avg >= 85 ? "status-good" : avg >= 60 ? "status-mid" : "status-low";
  const tagline = avg >= 85 ? "Gizi hari ini sudah mekar penuh 🌸"
    : avg >= 60 ? "Sudah lumayan, tinggal sedikit lagi"
    : "Masih ada beberapa nutrisi yang perlu dilengkapi";
  const lowestIdx = pcts.length ? pcts.indexOf(Math.min(...pcts)) : -1;
  const lowestLabel = lowestIdx >= 0 ? NUTRIENT_META[activeNutrients[lowestIdx]].label : "—";

  // rings geometry
  const size = 320, center = size / 2, baseRadius = 44, ringGap = 22, strokeWidth = 13;

  // trend geometry
  const trendData = datesWithMeals.map((d) => {
    const t = dayTotals(d);
    const out = { date: d };
    activeNutrients.forEach((n) => { out[n] = targets[n] ? (t[n] || 0) / targets[n] * 100 : 0; });
    return out;
  });
  const tw = Math.max(560, trendData.length * 90), th = 300;
  const padL = 40, padR = 16, padT = 16, padB = 34;
  const plotW = tw - padL - padR, plotH = th - padT - padB;
  let maxVal = 100;
  trendData.forEach((d) => activeNutrients.forEach((n) => { if (d[n] > maxVal) maxVal = d[n]; }));
  maxVal = Math.ceil(maxVal / 20) * 20 + 20;
  const xPos = (i) => padL + (trendData.length === 1 ? plotW / 2 : (i / (trendData.length - 1)) * plotW);
  const yPos = (v) => padT + plotH - (v / maxVal) * plotH;
  const gridTicks = [0, 25, 50, 75, 100, 125].filter((v) => v <= maxVal);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="topbar-left">
          <div className="avatar">{(user?.email || "?").charAt(0).toUpperCase()}</div>
          <span className="user-name">{user?.email}</span>
        </div>
        <div className="topbar-nav">
          <Link href="/dashboard" className="nav-link active">Dashboard</Link>
          <Link href="/dashboard/journal" className="nav-link">Jurnal</Link>
        </div>
        <button className="btn-ghost" onClick={handleLogout}>Keluar</button>
      </div>

      <div className="bloom-header">
        <p className="bloom-eyebrow">Pelacak gizi · kehamilan</p>
        <h1 className="bloom-title">Bloom</h1>
        <p className="bloom-sub">
          Catat menu makan dan vitamin harianmu, lalu lihat apakah kebutuhan gizi hari ini sudah
          tercukupi — datanya tersinkron lewat akunmu di semua perangkat.
        </p>
        <div className="trimester-row">
          {[["t1", "Trimester 1"], ["t2", "Trimester 2"], ["t3", "Trimester 3"]].map(([key, label]) => (
            <button key={key} className={`trimester-btn ${trimester === key ? "active" : ""}`} onClick={() => changeTrimester(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeNutrients.length > 0 && (
        <div className="summary-row">
          <div className="summary-card"><div className="big">{Math.round(avg)}%</div><div className="lbl">Rata-rata tercapai</div></div>
          <div className="summary-card"><div className="big">{metCount}/{activeNutrients.length}</div><div className="lbl">Nutrisi tercukupi</div></div>
          <div className="summary-card"><div className="big">{lowestLabel}</div><div className="lbl">Perlu perhatian</div></div>
          <div className="summary-card summary-tagline">
            <span className={`status-pill ${statusClass}`}>{Math.round(avg)}%</span>
            <span>{tagline}</span>
          </div>
        </div>
      )}

      <div className="bloom-grid">
        {/* Upload column */}
        <div>
          <div className="panel">
            <h2>Menu makan</h2>
            <label className="upload-drop" {...makeDropHandlers(handleMealFile)}>
              <input type="file" accept=".csv,text/csv" onChange={(e) => handleMealFile(e.target.files?.[0])} />
              <div className="ico">🍽️</div>
              <p>Unggah CSV menu makan</p>
              <span>date, meal, calories, protein_g, iron_mg...</span>
            </label>
            {mealFileName && <div className="file-name">{mealFileName}</div>}
            {mealError && <div className="error-box">{mealError}</div>}
            <button className="sample-btn" onClick={() => downloadText("contoh-menu.csv", SAMPLE_MEAL_CSV)}>⬇ Contoh CSV menu</button>
            <div className="format-hint">
              Kolom yang dikenali: <code>date</code>, <code>meal</code>, <code>calories</code>, <code>protein_g</code>,{" "}
              <code>iron_mg</code>, <code>calcium_mg</code>, <code>folate_mcg</code>, <code>vitamin_d_mcg</code>,{" "}
              <code>fiber_g</code>, <code>water_ml</code>. Baris dengan tanggal sama akan dijumlahkan otomatis.
            </div>

            <div className="divider" />

            <h2>Vitamin dari dokter</h2>
            <label className="upload-drop" {...makeDropHandlers(handleVitFile)}>
              <input type="file" accept=".csv,text/csv" onChange={(e) => handleVitFile(e.target.files?.[0])} />
              <div className="ico">💊</div>
              <p>Unggah CSV vitamin (isi 1x saja)</p>
              <span>name, folate_mcg, iron_mg, calcium_mg, vitamin_d_mcg...</span>
            </label>
            {vitFileName && <div className="file-name">{vitFileName}</div>}
            {vitError && <div className="error-box">{vitError}</div>}
            <button className="sample-btn" onClick={() => downloadText("contoh-vitamin.csv", SAMPLE_VIT_CSV)}>⬇ Contoh CSV vitamin (Folamil Genio, Cavit D3)</button>
            <div className="format-hint">
              Nilai gizi per vitamin bersifat contoh berdasarkan label umum — sesuaikan dengan
              kemasan asli dan anjuran dokter/apoteker kamu.
            </div>
          </div>
        </div>

        {/* Rings + day nav */}
        <div className="panel rings-panel">
          {!currentDate || activeNutrients.length === 0 ? (
            <div className="rings-empty">
              <div style={{ fontSize: 26 }}>🌱</div>
              <p>Belum ada data. Unggah menu hari ini untuk melihat cincin gizinya.</p>
            </div>
          ) : (
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rings-svg">
              {activeNutrients.map((key, i) => {
                const radius = baseRadius + i * ringGap;
                const circumference = 2 * Math.PI * radius;
                const value = totals[key] || 0;
                const target = targets[key];
                const pct = target ? value / target : 0;
                const drawPct = Math.min(pct, 1);
                const meta = NUTRIENT_META[key];
                return (
                  <g key={key}>
                    <circle cx={center} cy={center} r={radius} fill="none" stroke="rgba(243,237,233,0.09)" strokeWidth={strokeWidth} />
                    <circle
                      cx={center} cy={center} r={radius} fill="none" stroke={meta.color} strokeWidth={strokeWidth}
                      strokeDasharray={`${circumference * drawPct} ${circumference}`} strokeLinecap="round"
                      transform={`rotate(-90 ${center} ${center})`} opacity={pct < 0.6 ? 0.75 : 1}
                    />
                    {pct > 1.02 && (
                      <circle cx={center + radius * Math.cos(-Math.PI / 2)} cy={center + radius * Math.sin(-Math.PI / 2)} r={strokeWidth / 2.6} fill="#F3EDE9" />
                    )}
                  </g>
                );
              })}
              <text x={center} y={center - 6} textAnchor="middle" fill="#F3EDE9" fontFamily="IBM Plex Mono, monospace" fontSize="13">{currentDate}</text>
              <text x={center} y={center + 16} textAnchor="middle" fill="#a591a3" fontSize="10">{activeNutrients.length} nutrisi dilacak</text>
            </svg>
          )}
          {dates.length > 0 && (
            <div className="day-nav">
              <button onClick={() => setDayIndex(Math.max(0, clampedDayIndex - 1))} disabled={clampedDayIndex <= 0}>‹</button>
              <select className="date-select" value={clampedDayIndex} onChange={(e) => setDayIndex(parseInt(e.target.value, 10))}>
                {dates.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
              <button onClick={() => setDayIndex(Math.min(dates.length - 1, clampedDayIndex + 1))} disabled={clampedDayIndex >= dates.length - 1}>›</button>
            </div>
          )}
        </div>

        {/* Vitamin checklist */}
        <div className="panel full">
          <h3>Vitamin — {currentDate}</h3>
          {vitamins.length === 0 ? (
            <div className="vitamin-empty">Belum ada vitamin. Unggah CSV vitamin di panel kiri.</div>
          ) : (
            vitamins.map((v) => {
              const checked = !!(vitaminChecks[currentDate]?.[v.id]);
              const detailParts = NUTRIENT_ORDER.filter((n) => v[n]).map((n) => `${NUTRIENT_META[n].label} ${v[n]}${NUTRIENT_META[n].unit}`);
              return (
                <div className="vitamin-row" key={v.id}>
                  <input type="checkbox" className="vitamin-check" checked={checked} onChange={(e) => toggleVitaminCheck(v.id, e.target.checked)} />
                  <div className="vitamin-info">
                    <div className="vitamin-name">{v.name}</div>
                    <div className="vitamin-detail">{detailParts.join(" · ") || "tanpa data gizi"}</div>
                  </div>
                  <button className="vitamin-remove" title="Hapus vitamin ini" onClick={() => removeVitamin(v.id)}>✕</button>
                </div>
              );
            })
          )}
        </div>

        {/* Nutrient list */}
        {currentDate && activeNutrients.length > 0 && (
          <div className="panel full">
            <h2>{currentDate} — rincian per nutrisi</h2>
            {visibleNutrients.map((key) => {
              const meta = NUTRIENT_META[key];
              const value = totals[key] || 0;
              const target = targets[key];
              const pct = target ? (value / target) * 100 : 0;
              return (
                <div className="nutrient-row" key={key}>
                  <span className="nutrient-name">{meta.label}</span>
                  <div className="nutrient-bar-track"><div className="nutrient-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: meta.color }} /></div>
                  <span className="nutrient-value">{Math.round(value)}/{target}{meta.unit} · {Math.round(pct)}%</span>
                </div>
              );
            })}
            {activeNutrients.length > 5 && (
              <button className="toggle-more" onClick={() => setShowAll((s) => !s)}>
                {showAll ? "Tampilkan lebih sedikit ▲" : `Tampilkan semua ${activeNutrients.length} ▼`}
              </button>
            )}
          </div>
        )}

        {/* Trend */}
        {datesWithMeals.length > 1 && (
          <div className="panel full">
            <h3>Tren dari hari ke hari</h3>
            <p className="trend-note">Setiap garis menunjukkan % dari target harian — garis putus-putus di 100% berarti "tercukupi penuh".</p>
            <div className="trend-svg-wrap">
              <svg width={tw} height={th} viewBox={`0 0 ${tw} ${th}`}>
                {gridTicks.map((v) => (
                  <g key={v}>
                    <line x1={padL} x2={tw - padR} y1={yPos(v)} y2={yPos(v)} stroke="rgba(243,237,233,0.08)" strokeWidth="1" />
                    <text x={padL - 8} y={yPos(v) + 4} textAnchor="end" fill="#a591a3" fontSize="10">{v}%</text>
                  </g>
                ))}
                <line x1={padL} x2={tw - padR} y1={yPos(100)} y2={yPos(100)} stroke="#F3EDE9" strokeWidth="1.2" strokeDasharray="4 4" opacity="0.4" />
                {trendData.map((d, i) => (
                  <text key={d.date} x={xPos(i)} y={th - padB + 18} textAnchor="middle" fill="#a591a3" fontSize="10">{d.date}</text>
                ))}
                {activeNutrients.map((n) => {
                  const meta = NUTRIENT_META[n];
                  const points = trendData.map((d, i) => `${xPos(i)},${yPos(d[n])}`).join(" ");
                  return (
                    <g key={n}>
                      <polyline points={points} fill="none" stroke={meta.color} strokeWidth="2" />
                      {trendData.map((d, i) => <circle key={i} cx={xPos(i)} cy={yPos(d[n])} r="3" fill={meta.color} />)}
                    </g>
                  );
                })}
              </svg>
            </div>
            <div className="legend">
              {activeNutrients.map((n) => (
                <div className="legend-item" key={n}><span className="legend-dot" style={{ background: NUTRIENT_META[n].color }} />{NUTRIENT_META[n].label}</div>
              ))}
            </div>
          </div>
        )}

        {/* History */}
        {datesWithMeals.length > 0 && (
          <div className="panel full">
            <h3>Ringkasan riwayat</h3>
            <table className="hist-table">
              <thead><tr><th>Tanggal</th><th style={{ width: "55%" }}>Rata-rata tercapai</th><th>Status</th></tr></thead>
              <tbody>
                {datesWithMeals.slice().reverse().map((d) => {
                  const t = dayTotals(d);
                  const p = activeNutrients.map((n) => (targets[n] ? (t[n] || 0) / targets[n] * 100 : 0));
                  const a = p.length ? p.reduce((x, y) => x + Math.min(y, 100), 0) / p.length : 0;
                  const color = a >= 85 ? "#8FAE8B" : a >= 60 ? "#E3B65E" : "#C77B7B";
                  const statusText = a >= 85 ? "Tercukupi" : a >= 60 ? "Hampir" : "Kurang";
                  return (
                    <tr key={d}>
                      <td>{d}</td>
                      <td>
                        <div className="hist-bar-cell">
                          <div className="hist-bar-track"><div className="hist-bar-fill" style={{ width: `${Math.min(a, 100)}%`, background: color }} /></div>
                          <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: "var(--text-dimmer)" }}>{Math.round(a)}%</span>
                        </div>
                      </td>
                      <td><span style={{ color, fontSize: 12, fontWeight: 600 }}>{statusText}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="disclaimer">
        Target gizi yang ditampilkan adalah panduan umum untuk kehamilan dewasa per trimester,
        bukan anjuran personal. Kebutuhan bisa berbeda tergantung usia, berat badan sebelum hamil,
        aktivitas, dan kondisi seperti anemia atau diabetes gestasional — konsultasikan detailnya
        dengan dokter/bidan kamu.
      </p>
    </div>
  );
}
