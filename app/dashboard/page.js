"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import ConfirmButton from "@/components/ConfirmButton";
import MiniCalendar from "@/components/MiniCalendar";
import HelpTip from "@/components/HelpTip";
import {
  Home, NotebookText, MessageCircle, User, UtensilsCrossed, Pill, Droplet,
  Sprout, X, Check, AlertTriangle,
} from "lucide-react";
import {
  NUTRIENT_META, NUTRIENT_ORDER,
  LIMIT_META, LIMIT_ORDER, ALL_TRACKED_NUTRIENTS, ALL_TRACKED_META,
  SAMPLE_MEAL_CSV, SAMPLE_VIT_CSV, DEFAULT_VITAMINS,
  parseMealCsv, parseVitaminCsv, computeActiveTrackedNutrients,
  groupMealsByDay, dedupeMeals, todayISO,
  statusForPct, statusForGoal, exceededGoalLabels, mergeExtraNutrients, buildExtraNutrientsMap,
  resolveEffectiveGoals,
} from "@/lib/nutrition";
import { trimesterForDate } from "@/lib/pregnancy";

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
  // Trimester is no longer a manual choice — it's derived from HPHT (set in
  // Profil) + whichever date is being viewed, see the `trimester` const below.
  const [hpht, setHpht] = useState(null);
  const [meals, setMeals] = useState([]);
  const [vitamins, setVitamins] = useState([]);
  const [vitaminChecks, setVitaminChecks] = useState({}); // { date: { vitaminId: true } }
  const [goalRows, setGoalRows] = useState([]); // nutrient_goals rows -- see effectiveGoals below
  const [dayIndex, setDayIndex] = useState(0);
  const [extraDates, setExtraDates] = useState([]); // dates jumped-to via the date picker that have no data yet
  const [pendingJumpDate, setPendingJumpDate] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(todayISO().slice(0, 7)); // "YYYY-MM" — which month the calendar shows

  const [showAll, setShowAll] = useState(false);
  const [mealError, setMealError] = useState("");
  const [mealFileName, setMealFileName] = useState("");
  const [vitError, setVitError] = useState("");
  const [vitFileName, setVitFileName] = useState("");
  const mealDropRef = useRef(null);
  const vitDropRef = useRef(null);

  // manual "add meal" form
  const [mealFormOpen, setMealFormOpen] = useState(false);
  const [mealFormDate, setMealFormDate] = useState(todayISO());
  const [mealFormName, setMealFormName] = useState("");
  const [mealFormValues, setMealFormValues] = useState({});
  const [mealFormExtra, setMealFormExtra] = useState([]); // [{ label, unit, value }] — nutrients outside ALL_TRACKED_NUTRIENTS
  const [mealFormSaving, setMealFormSaving] = useState(false);
  const [mealFormError, setMealFormError] = useState("");

  // manual "add vitamin" form
  const [vitFormOpen, setVitFormOpen] = useState(false);
  const [vitFormName, setVitFormName] = useState("");
  const [vitFormValues, setVitFormValues] = useState({});
  const [vitFormExtra, setVitFormExtra] = useState([]); // [{ label, unit, value }] — nutrients outside ALL_TRACKED_NUTRIENTS
  const [vitFormSaving, setVitFormSaving] = useState(false);
  const [vitFormError, setVitFormError] = useState("");

  // quick water log
  const [waterAmount, setWaterAmount] = useState("");
  const [waterSaving, setWaterSaving] = useState(false);
  const [waterError, setWaterError] = useState("");

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
        const { data: created } = await supabase.from("profiles").insert({ user_id: u.id }).select().maybeSingle();
        profile = created;
      }
      setHpht(profile?.hpht || null);

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

      // nutrient goals (targets/limits) -- see effectiveGoals below. Seeded
      // per-nutrient by app/dashboard/profile/page.js's "Konfigurasi nutrisi"
      // section on first visit there; until then this is simply empty and
      // resolveEffectiveGoals falls back to today's global defaults, same as
      // every user saw before this feature existed.
      const { data: goalData } = await supabase.from("nutrient_goals").select("*").eq("user_id", u.id);
      setGoalRows(goalData || []);

      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // ---------------- derived data ----------------
  // `extraDates` lets the day-nav jump to any date (not just ones that
  // already have meals/checks) so a past day can be backfilled from scratch.
  const dates = useMemo(() => {
    const set = new Set();
    meals.forEach((r) => set.add(r.date));
    Object.keys(vitaminChecks).forEach((d) => set.add(d));
    extraDates.forEach((d) => set.add(d));
    set.add(todayISO());
    return Array.from(set).sort();
  }, [meals, vitaminChecks, extraDates]);

  // Once a jumped-to date has been folded into `dates` above, land the
  // day-nav on it (can't compute the index synchronously — `dates` only
  // updates on the next render after setExtraDates).
  useEffect(() => {
    if (!pendingJumpDate) return;
    const idx = dates.indexOf(pendingJumpDate);
    if (idx >= 0) { setDayIndex(idx); setPendingJumpDate(null); }
  }, [dates, pendingJumpDate]);

  // Default view is today, not the oldest day in history: `dates` is sorted
  // ascending, so `dayIndex`'s initial 0 only happened to land on today for
  // an account with no history yet — as soon as there's a single day of
  // meals/checks before today, index 0 becomes the oldest entry instead.
  // Runs once after real data loads (dates is just [todayISO()] before
  // that, so there's nothing to correct yet), never again afterward so it
  // doesn't fight the day-nav/"Hari ini"/date-jump the user does later.
  const initialDaySetRef = useRef(false);
  useEffect(() => {
    if (loading || initialDaySetRef.current) return;
    initialDaySetRef.current = true;
    const idx = dates.indexOf(todayISO());
    if (idx >= 0) setDayIndex(idx);
  }, [loading, dates]);

  function jumpToDate(dateStr) {
    if (!dateStr) return;
    setExtraDates((prev) => (prev.includes(dateStr) ? prev : [...prev, dateStr]));
    setPendingJumpDate(dateStr);
  }

  // today is always present in `dates` (see the useMemo above), so this
  // never needs the extraDates/pendingJumpDate dance jumpToDate uses.
  function goToToday() {
    const idx = dates.indexOf(todayISO());
    if (idx >= 0) setDayIndex(idx);
  }

  const clampedDayIndex = Math.min(Math.max(dayIndex, 0), Math.max(dates.length - 1, 0));
  const currentDate = dates[clampedDayIndex];

  // Days actually worth marking green on the calendar — unlike `dates`
  // above, this excludes `extraDates` (those are just navigation targets
  // you jumped to, not real entries) and doesn't force today in either.
  const datesWithData = useMemo(() => {
    const set = new Set();
    meals.forEach((r) => set.add(r.date));
    Object.keys(vitaminChecks).forEach((d) => set.add(d));
    return set;
  }, [meals, vitaminChecks]);

  // Keeps the calendar showing the month of whatever day is currently
  // selected — e.g. after "Hari ini" or picking a date in a different month.
  useEffect(() => {
    if (currentDate) setCalendarMonth(currentDate.slice(0, 7));
  }, [currentDate]);

  // Derived, not stored: which trimester the currently-viewed day falls in,
  // based on HPHT (set in Profil). Browsing to a past date via the calendar
  // shows what trimester you were in *then* — not always "now" — and the
  // nutrient targets below follow along automatically. Falls back to
  // Trimester 1 until HPHT/HPL is set (see the info note near the pills).
  const trimester = trimesterForDate(hpht, currentDate || todayISO());
  // Every nutrient's target/limit, direction included -- a user's own
  // nutrient_goals row (goalRows) when they have one, else today's global
  // TARGETS/LIMITS default (same as every user saw before this feature
  // existed). The single seam every render block below reads through
  // instead of TARGETS/LIMITS/NUTRIENT_META/LIMIT_META directly, so a
  // flipped direction (e.g. protein_g set to max-type) is reflected
  // consistently everywhere at once.
  const effectiveGoals = useMemo(() => resolveEffectiveGoals(goalRows, trimester), [goalRows, trimester]);
  // Which of the 15 ALL_TRACKED_NUTRIENTS keys actually have logged data,
  // split into floor-type ("ring"/target) vs ceiling-type ("batas harian"
  // bar) groups by each key's CURRENT effectiveGoals direction -- not by
  // fixed NUTRIENT_ORDER/LIMIT_ORDER membership, since a user can flip
  // either way per nutrient. A flipped nutrient simply moves from one
  // group/section to the other.
  const activeTrackedNutrients = useMemo(() => computeActiveTrackedNutrients(meals), [meals]);
  const activeNutrients = useMemo(
    () => activeTrackedNutrients.filter((k) => effectiveGoals[k]?.goalType !== "max"),
    [activeTrackedNutrients, effectiveGoals]
  );
  const activeLimitNutrients = useMemo(
    () => activeTrackedNutrients.filter((k) => effectiveGoals[k]?.goalType === "max"),
    [activeTrackedNutrients, effectiveGoals]
  );
  const mealsByDay = useMemo(() => groupMealsByDay(meals), [meals]);

  // Sums every ALL_TRACKED_NUTRIENTS field for one day (meals + every
  // checked vitamin that day) -- floor/ceiling direction is a rendering
  // concern now (effectiveGoals), not a data-shape one, so this no longer
  // needs two parallel NUTRIENT_ORDER-only/LIMIT_ORDER-only variants.
  function dayNutrientTotals(date) {
    const base = mealsByDay[date] || {};
    const totals = {};
    ALL_TRACKED_NUTRIENTS.forEach((n) => { totals[n] = base[n] || 0; });
    const checks = vitaminChecks[date] || {};
    vitamins.forEach((v) => {
      if (checks[v.id]) ALL_TRACKED_NUTRIENTS.forEach((n) => { if (v[n] != null) totals[n] += Number(v[n]); });
    });
    return totals;
  }

  // Custom (non-ALL_TRACKED_NUTRIENTS) nutrients from every checked vitamin
  // AND every meal logged that day — meals gained their own extra_nutrients
  // column alongside vitamins' (supabase/schema.sql), so an ad-hoc
  // composition fact Gemini found on a food label shows up here too.
  // Informational only, no target/ring (see lib/nutrition.js).
  function extraTotals(date) {
    const checks = vitaminChecks[date] || {};
    const merged = {};
    vitamins.forEach((v) => { if (checks[v.id]) mergeExtraNutrients(merged, v.extra_nutrients); });
    meals.forEach((m) => { if (m.date === date) mergeExtraNutrients(merged, m.extra_nutrients); });
    return merged;
  }

  const totals = currentDate ? dayNutrientTotals(currentDate) : {};
  // Single source of truth (lib/nutrition.js) shared with the dinner-reminder
  // trigger (app/api/cron/reminders/route.js) — same "what counts as
  // exceeded" math on both the Dashboard and the notification.
  const exceededToday = exceededGoalLabels(totals, effectiveGoals);
  const todaysExtraTotals = currentDate ? extraTotals(currentDate) : {};
  const datesWithMeals = dates.filter((d) => meals.some((r) => r.date === d));
  const todaysMeals = currentDate ? meals.filter((r) => r.date === currentDate) : [];
  const waterTotal = totals.water_ml || 0;
  const waterTarget = effectiveGoals.water_ml.targetValue;
  const waterPct = waterTarget ? (waterTotal / waterTarget) * 100 : 0;
  const waterStatus = statusForGoal(waterPct, effectiveGoals.water_ml.goalType);

  // ---------------- actions ----------------
  async function handleMealFile(file) {
    if (!file) return;
    setMealError("");
    const text = await file.text();
    const parsed = parseMealCsv(text);
    if (parsed.length === 0) {
      setMealError("Tidak ada baris yang dikenali. Pastikan ada kolom date dan minimal satu kolom gizi.");
      return;
    }
    const { unique, duplicateCount } = dedupeMeals(meals, parsed);
    if (unique.length === 0) {
      setMealError(`Semua ${parsed.length} baris sudah ada sebelumnya (tanggal + nama menu sama). Tidak ada yang ditambahkan.`);
      return;
    }
    const rows = unique.map((r) => ({ ...r, user_id: user.id }));
    const { data, error } = await supabase.from("meals").insert(rows).select();
    if (error) { setMealError(error.message); return; }
    setMeals((prev) => [...prev, ...(data || [])]);
    const dupNote = duplicateCount > 0 ? ` · ${duplicateCount} baris duplikat dilewati` : "";
    setMealFileName(`${file.name} ditambahkan · total ${meals.length + (data?.length || 0)} baris menu${dupNote}`);
  }

  async function handleVitFile(file) {
    if (!file) return;
    setVitError("");
    const text = await file.text();
    const parsed = parseVitaminCsv(text);
    if (parsed.length === 0) {
      setVitError("Tidak ada baris yang dikenali. Pastikan ada kolom name.");
      return;
    }
    const rows = parsed.map((v) => {
      const full = { name: v.name, user_id: user.id };
      ALL_TRACKED_NUTRIENTS.forEach((n) => { full[n] = v[n] || 0; });
      return full;
    });
    const { data, error } = await supabase.from("vitamins").insert(rows).select();
    if (error) { setVitError(error.message); return; }
    setVitamins((prev) => [...prev, ...(data || [])]);
    setVitFileName(`${file.name} · ${data?.length || 0} vitamin ditambahkan`);
  }

  // ---------------- manual meal entry ----------------
  function openMealForm() {
    setMealFormOpen(true);
    setMealFormDate(currentDate || todayISO());
    setMealFormName("");
    setMealFormValues({});
    setMealFormExtra([]);
    setMealFormError("");
  }

  function closeMealForm() {
    setMealFormOpen(false);
    setMealFormError("");
  }

  // "nutrisi lain" rows for the meal form — same pattern as
  // addVitExtraRow/updateVitExtraRow/removeVitExtraRow below, for anything
  // not in ALL_TRACKED_NUTRIENTS (e.g. Omega-3 printed on a food label).
  function addMealExtraRow() {
    setMealFormExtra((prev) => [...prev, { label: "", unit: "", value: "" }]);
  }
  function updateMealExtraRow(idx, field, value) {
    setMealFormExtra((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }
  function removeMealExtraRow(idx) {
    setMealFormExtra((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleAddMeal() {
    setMealFormError("");
    const name = mealFormName.trim();
    if (!name) { setMealFormError("Isi dulu nama menunya."); return; }
    if (!mealFormDate) { setMealFormError("Pilih tanggal untuk menu ini."); return; }
    setMealFormSaving(true);
    const row = { user_id: user.id, date: mealFormDate, meal: name };
    ALL_TRACKED_NUTRIENTS.forEach((n) => {
      const v = parseFloat(mealFormValues[n]);
      row[n] = isNaN(v) ? 0 : v;
    });
    row.extra_nutrients = buildExtraNutrientsMap(mealFormExtra);
    const { data, error } = await supabase.from("meals").insert(row).select().maybeSingle();
    setMealFormSaving(false);
    if (error) { setMealFormError(error.message); return; }
    setMeals((prev) => [...prev, data]);
    setMealFormName("");
    setMealFormValues({});
    setMealFormExtra([]);
  }

  async function handleDeleteMeal(id) {
    setMeals((prev) => prev.filter((m) => m.id !== id));
    await supabase.from("meals").delete().eq("id", id);
  }

  // ---------------- quick water log ----------------
  async function addWater(amount) {
    if (!currentDate || !amount || amount <= 0) return;
    setWaterError("");
    setWaterSaving(true);
    const row = { user_id: user.id, date: currentDate, meal: "Air minum", water_ml: amount };
    const { data, error } = await supabase.from("meals").insert(row).select().maybeSingle();
    setWaterSaving(false);
    if (error) { setWaterError(error.message); return; }
    setMeals((prev) => [...prev, data]);
  }

  function handleWaterCustomAdd() {
    const amt = parseFloat(waterAmount);
    if (!amt || amt <= 0) { setWaterError("Masukkan jumlah ml yang valid."); return; }
    addWater(amt);
    setWaterAmount("");
  }

  // ---------------- manual vitamin entry ----------------
  function openVitForm() {
    setVitFormOpen(true);
    setVitFormName("");
    setVitFormValues({});
    setVitFormExtra([]);
    setVitFormError("");
  }

  function closeVitForm() {
    setVitFormOpen(false);
    setVitFormError("");
  }

  // "nutrisi lain" rows — anything not in ALL_TRACKED_NUTRIENTS (Zinc, Vitamin B6, ...)
  function addVitExtraRow() {
    setVitFormExtra((prev) => [...prev, { label: "", unit: "", value: "" }]);
  }
  function updateVitExtraRow(idx, field, value) {
    setVitFormExtra((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }
  function removeVitExtraRow(idx) {
    setVitFormExtra((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleAddVitamin() {
    setVitFormError("");
    const name = vitFormName.trim();
    if (!name) { setVitFormError("Isi dulu nama vitamin/suplemennya."); return; }
    setVitFormSaving(true);
    const row = { user_id: user.id, name };
    ALL_TRACKED_NUTRIENTS.forEach((n) => {
      const v = parseFloat(vitFormValues[n]);
      row[n] = isNaN(v) ? 0 : v;
    });
    row.extra_nutrients = buildExtraNutrientsMap(vitFormExtra);
    const { data, error } = await supabase.from("vitamins").insert(row).select().maybeSingle();
    setVitFormSaving(false);
    if (error) { setVitFormError(error.message); return; }
    setVitamins((prev) => [...prev, data]);
    setVitFormName("");
    setVitFormValues({});
    setVitFormExtra([]);
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

  // pcts for summary -- floor-type (min-goal) nutrients only, same as
  // before this feature: a mixed floor/ceiling average wouldn't mean
  // anything coherent (100% of a ceiling-type goal is "at the limit", not
  // "done"), so this summary stays scoped to activeNutrients (min-type).
  const pcts = activeNutrients.map((n) => (effectiveGoals[n].targetValue ? (totals[n] || 0) / effectiveGoals[n].targetValue * 100 : 0));
  const metCount = pcts.filter((p) => p >= 100).length;
  const avg = pcts.length ? pcts.reduce((a, b) => a + Math.min(b, 100), 0) / pcts.length : 0;
  const overallStatus = statusForPct(avg);
  const statusClass = "status-" + overallStatus.key;
  const tagline = overallStatus.key === "good" ? "Gizi hari ini sudah mekar penuh 🌸"
    : overallStatus.key === "mid" ? "Sudah lumayan, tinggal sedikit lagi"
    : "Masih ada beberapa nutrisi yang perlu dilengkapi";
  const lowestIdx = pcts.length ? pcts.indexOf(Math.min(...pcts)) : -1;
  const lowestLabel = lowestIdx >= 0 ? effectiveGoals[activeNutrients[lowestIdx]].label : "—";

  // rings geometry — cap concurrent rings at 3 (same as Apple Watch's activity
  // rings): color now marks status (tercukupi/hampir/kurang), not identity, but
  // concentric arcs at different radii are still hard to compare by eye once
  // there are more than a few, so the rest live in the legend + detail list below.
  const size = 320, center = size / 2, baseRadius = 50, ringGap = 28, strokeWidth = 16;
  const ringNutrients = activeNutrients.slice(0, 3);
  const overflowCount = activeNutrients.length - ringNutrients.length;

  // trend geometry
  const trendData = datesWithMeals.map((d) => {
    const t = dayNutrientTotals(d);
    const out = { date: d };
    activeNutrients.forEach((n) => { out[n] = effectiveGoals[n].targetValue ? (t[n] || 0) / effectiveGoals[n].targetValue * 100 : 0; });
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

  // "batas harian" trend geometry — structurally mirrors the trend geometry
  // above but computed from activeLimitNutrients/effectiveGoals (ceiling-
  // type, % of a daily limit) instead of activeNutrients/effectiveGoals
  // (floor-type, % of a daily target). Kept as its own parallel block rather
  // than a shared/generic helper — see LIMIT_ORDER's own comment in
  // lib/nutrition.js for why floor and ceiling stay separate instead of
  // averaging together (still true even though direction is now per-user:
  // a day's mixed floor+ceiling trend still wouldn't mean anything coherent
  // averaged onto one chart).
  const limitTrendData = datesWithMeals.map((d) => {
    const t = dayNutrientTotals(d);
    const out = { date: d };
    activeLimitNutrients.forEach((n) => { out[n] = effectiveGoals[n].targetValue ? (t[n] || 0) / effectiveGoals[n].targetValue * 100 : 0; });
    return out;
  });
  const ltw = Math.max(560, limitTrendData.length * 90), lth = 300;
  const lpadL = 40, lpadR = 16, lpadT = 16, lpadB = 34;
  const lplotW = ltw - lpadL - lpadR, lplotH = lth - lpadT - lpadB;
  let lmaxVal = 100;
  limitTrendData.forEach((d) => activeLimitNutrients.forEach((n) => { if (d[n] > lmaxVal) lmaxVal = d[n]; }));
  lmaxVal = Math.ceil(lmaxVal / 20) * 20 + 20;
  const lxPos = (i) => lpadL + (limitTrendData.length === 1 ? lplotW / 2 : (i / (limitTrendData.length - 1)) * lplotW);
  const lyPos = (v) => lpadT + lplotH - (v / lmaxVal) * lplotH;
  const lgridTicks = [0, 25, 50, 75, 100, 125].filter((v) => v <= lmaxVal);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="topbar-left">
          <div className="avatar">{(user?.email || "?").charAt(0).toUpperCase()}</div>
          <span className="user-name">{user?.email}</span>
        </div>
        <div className="topbar-nav">
          <Link href="/dashboard" className="nav-link active"><Home size={19} /><span>Dashboard</span></Link>
          <Link href="/dashboard/journal" className="nav-link"><NotebookText size={19} /><span>Jurnal</span></Link>
          <Link href="/dashboard/chat" className="nav-link"><MessageCircle size={19} /><span>Chat</span></Link>
          <Link href="/dashboard/profile" className="nav-link"><User size={19} /><span>Profil</span></Link>
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
        {/* Read-only now — trimester follows HPHT (set in Profil) + whichever
            date you're viewing, not a manual choice. */}
        <div className="trimester-row">
          {[["t1", "Trimester 1"], ["t2", "Trimester 2"], ["t3", "Trimester 3"]].map(([key, label]) => (
            <span key={key} className={`trimester-btn readonly ${trimester === key ? "active" : ""}`}>
              {label}
            </span>
          ))}
        </div>
        {!hpht && (
          <p className="format-hint trimester-hint">
            <AlertTriangle size={14} />
            <span>
              HPL/HPHT belum diset, jadi trimester ditampilkan sebagai Trimester 1 sementara.
              Atur di <Link href="/dashboard/profile">tab Profil</Link> supaya trimester dan target
              gizi ikut usia kehamilanmu yang sebenarnya.
            </span>
          </p>
        )}
      </div>

      {currentDate && exceededToday.length > 0 && (
        <div className="limit-warning-banner">
          <AlertTriangle size={16} />
          <span>
            ⚠️ Sudah melebihi batas harian {currentDate}: <strong>{exceededToday.join(", ")}</strong>.
            Coba dikurangi dulu untuk sisa hari ini ya — lihat detailnya di panel &quot;Batas
            harian&quot; di bawah.
          </span>
        </div>
      )}

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
            <h2>
              Menu makan
              <HelpTip label="Format kolom CSV">
                Kolom yang dikenali: <code>date</code>, <code>meal</code>, <code>calories</code>, <code>protein_g</code>,{" "}
                <code>iron_mg</code>, <code>calcium_mg</code>, <code>folate_mcg</code>, <code>vitamin_d_mcg</code>,{" "}
                <code>fiber_g</code>, <code>water_ml</code>, <code>dha_mg</code>, <code>vitamin_k_mcg</code>, plus kolom
                batas harian <code>sugar_g</code>, <code>sodium_mg</code>, <code>cholesterol_mg</code>,{" "}
                <code>saturated_fat_g</code>, <code>caffeine_mg</code>. Baris dengan tanggal sama akan dijumlahkan
                otomatis.
              </HelpTip>
            </h2>
            <label className="upload-drop" {...makeDropHandlers(handleMealFile)}>
              <input type="file" accept=".csv,text/csv" onChange={(e) => handleMealFile(e.target.files?.[0])} />
              <div className="ico"><UtensilsCrossed size={22} /></div>
              <p>Unggah CSV menu makan</p>
              <span>date, meal, calories, protein_g, iron_mg...</span>
            </label>
            {mealFileName && <div className="file-name"><Check size={12} /> {mealFileName}</div>}
            {mealError && <div className="error-box"><AlertTriangle size={13} /> {mealError}</div>}
            <button className="sample-btn" onClick={() => downloadText("contoh-menu.csv", SAMPLE_MEAL_CSV)}>⬇ Contoh CSV menu</button>

            <button className="manual-form-toggle" onClick={() => (mealFormOpen ? closeMealForm() : openMealForm())}>
              {mealFormOpen ? "▲ Tutup form manual" : "+ Tambah menu manual"}
            </button>
            {mealFormOpen && (
              <div className="manual-form">
                <div className="manual-form-row">
                  <input
                    type="text" placeholder="Nama menu (mis. Nasi goreng)"
                    value={mealFormName} onChange={(e) => setMealFormName(e.target.value)}
                  />
                  <input type="date" value={mealFormDate} onChange={(e) => setMealFormDate(e.target.value)} />
                </div>
                <div className="manual-form-grid">
                  {NUTRIENT_ORDER.map((n) => {
                    const meta = NUTRIENT_META[n];
                    return (
                      <div className="manual-form-field" key={n}>
                        <label>{meta.label} ({meta.unit})</label>
                        <input
                          type="number" inputMode="decimal" min="0" step="any" placeholder="0"
                          value={mealFormValues[n] ?? ""}
                          onChange={(e) => setMealFormValues((prev) => ({ ...prev, [n]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </div>

                <label className="extra-nutrient-label">Batas harian (opsional) — gula, natrium, dll.</label>
                <div className="manual-form-grid">
                  {LIMIT_ORDER.map((n) => {
                    const meta = LIMIT_META[n];
                    return (
                      <div className="manual-form-field" key={n}>
                        <label>{meta.label} ({meta.unit})</label>
                        <input
                          type="number" inputMode="decimal" min="0" step="any" placeholder="0"
                          value={mealFormValues[n] ?? ""}
                          onChange={(e) => setMealFormValues((prev) => ({ ...prev, [n]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </div>

                <div className="extra-nutrient-section">
                  <label className="extra-nutrient-label">Nutrisi lain (opsional) — kalau ada yang tidak ada di daftar di atas, mis. Omega-3, Zinc, Vitamin B6</label>
                  {mealFormExtra.length > 0 && (
                    <div className="extra-nutrient-list">
                      {mealFormExtra.map((r, i) => (
                        <div className="extra-nutrient-row" key={i}>
                          <input
                            type="text" placeholder="Nama (mis. Omega-3)"
                            value={r.label} onChange={(e) => updateMealExtraRow(i, "label", e.target.value)}
                          />
                          <input
                            type="number" inputMode="decimal" min="0" step="any" placeholder="Jumlah"
                            value={r.value} onChange={(e) => updateMealExtraRow(i, "value", e.target.value)}
                          />
                          <input
                            type="text" placeholder="Satuan (mis. mg)"
                            value={r.unit} onChange={(e) => updateMealExtraRow(i, "unit", e.target.value)}
                          />
                          <button type="button" onClick={() => removeMealExtraRow(i)} title="Hapus baris ini"><X size={15} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button type="button" className="extra-nutrient-add" onClick={addMealExtraRow}>+ Tambah nutrisi lain</button>
                </div>

                {mealFormError && <div className="error-box"><AlertTriangle size={13} /> {mealFormError}</div>}
                <div className="manual-form-actions">
                  <button className="manual-form-save" onClick={handleAddMeal} disabled={mealFormSaving}>
                    {mealFormSaving ? "Menyimpan…" : "Simpan menu"}
                  </button>
                  <button className="manual-form-cancel" onClick={closeMealForm}>Batal</button>
                </div>
              </div>
            )}

            <div className="divider" />

            <h2>
              Vitamin dari dokter
              <HelpTip label="Soal keakuratan data gizi">
                Nilai gizi per vitamin bersifat contoh berdasarkan label umum — sesuaikan dengan
                kemasan asli dan anjuran dokter/apoteker kamu.
              </HelpTip>
            </h2>
            <label className="upload-drop" {...makeDropHandlers(handleVitFile)}>
              <input type="file" accept=".csv,text/csv" onChange={(e) => handleVitFile(e.target.files?.[0])} />
              <div className="ico"><Pill size={22} /></div>
              <p>Unggah CSV vitamin (isi 1x saja)</p>
              <span>name, folate_mcg, iron_mg, calcium_mg, vitamin_d_mcg...</span>
            </label>
            {vitFileName && <div className="file-name"><Check size={12} /> {vitFileName}</div>}
            {vitError && <div className="error-box"><AlertTriangle size={13} /> {vitError}</div>}
            <button className="sample-btn" onClick={() => downloadText("contoh-vitamin.csv", SAMPLE_VIT_CSV)}>⬇ Contoh CSV vitamin (Folamil Genio, Cavit D3)</button>

            <button className="manual-form-toggle" onClick={() => (vitFormOpen ? closeVitForm() : openVitForm())}>
              {vitFormOpen ? "▲ Tutup form manual" : "+ Tambah vitamin manual"}
            </button>
            {vitFormOpen && (
              <div className="manual-form">
                <div className="manual-form-row">
                  <input
                    type="text" placeholder="Nama vitamin/suplemen (mis. Folamil Genio)"
                    value={vitFormName} onChange={(e) => setVitFormName(e.target.value)}
                  />
                </div>
                <div className="manual-form-grid">
                  {NUTRIENT_ORDER.map((n) => {
                    const meta = NUTRIENT_META[n];
                    return (
                      <div className="manual-form-field" key={n}>
                        <label>{meta.label} ({meta.unit})</label>
                        <input
                          type="number" inputMode="decimal" min="0" step="any" placeholder="0"
                          value={vitFormValues[n] ?? ""}
                          onChange={(e) => setVitFormValues((prev) => ({ ...prev, [n]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </div>

                <label className="extra-nutrient-label">Batas harian (opsional) — gula, natrium, dll. (mis. vitamin C effervescent)</label>
                <div className="manual-form-grid">
                  {LIMIT_ORDER.map((n) => {
                    const meta = LIMIT_META[n];
                    return (
                      <div className="manual-form-field" key={n}>
                        <label>{meta.label} ({meta.unit})</label>
                        <input
                          type="number" inputMode="decimal" min="0" step="any" placeholder="0"
                          value={vitFormValues[n] ?? ""}
                          onChange={(e) => setVitFormValues((prev) => ({ ...prev, [n]: e.target.value }))}
                        />
                      </div>
                    );
                  })}
                </div>

                <div className="extra-nutrient-section">
                  <label className="extra-nutrient-label">Nutrisi lain (opsional) — kalau ada yang tidak ada di daftar di atas, mis. Zinc, Vitamin B6, Iodium</label>
                  {vitFormExtra.length > 0 && (
                    <div className="extra-nutrient-list">
                      {vitFormExtra.map((r, i) => (
                        <div className="extra-nutrient-row" key={i}>
                          <input
                            type="text" placeholder="Nama (mis. Zinc)"
                            value={r.label} onChange={(e) => updateVitExtraRow(i, "label", e.target.value)}
                          />
                          <input
                            type="number" inputMode="decimal" min="0" step="any" placeholder="Jumlah"
                            value={r.value} onChange={(e) => updateVitExtraRow(i, "value", e.target.value)}
                          />
                          <input
                            type="text" placeholder="Satuan (mis. mg)"
                            value={r.unit} onChange={(e) => updateVitExtraRow(i, "unit", e.target.value)}
                          />
                          <button type="button" onClick={() => removeVitExtraRow(i)} title="Hapus baris ini"><X size={15} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  <button type="button" className="extra-nutrient-add" onClick={addVitExtraRow}>+ Tambah nutrisi lain</button>
                </div>

                {vitFormError && <div className="error-box"><AlertTriangle size={13} /> {vitFormError}</div>}
                <div className="manual-form-actions">
                  <button className="manual-form-save" onClick={handleAddVitamin} disabled={vitFormSaving}>
                    {vitFormSaving ? "Menyimpan…" : "Simpan vitamin"}
                  </button>
                  <button className="manual-form-cancel" onClick={closeVitForm}>Batal</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Rings + day nav */}
        <div className="panel rings-panel">
          {!currentDate || activeNutrients.length === 0 ? (
            <div className="rings-empty">
              <div style={{ color: "var(--sage)" }}><Sprout size={30} /></div>
              <p>Belum ada data. Unggah menu hari ini untuk melihat cincin gizinya.</p>
            </div>
          ) : (
            <>
              <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rings-svg">
                {ringNutrients.map((key, i) => {
                  const radius = baseRadius + i * ringGap;
                  const circumference = 2 * Math.PI * radius;
                  const value = totals[key] || 0;
                  const target = effectiveGoals[key].targetValue;
                  const frac = target ? value / target : 0;
                  const drawPct = Math.min(frac, 1);
                  const status = statusForGoal(frac * 100, effectiveGoals[key].goalType);
                  return (
                    <g key={key}>
                      <circle cx={center} cy={center} r={radius} fill="none" stroke="rgba(243,237,233,0.09)" strokeWidth={strokeWidth} />
                      <circle
                        cx={center} cy={center} r={radius} fill="none" stroke={status.color} strokeWidth={strokeWidth}
                        strokeDasharray={`${circumference * drawPct} ${circumference}`} strokeLinecap="round"
                        transform={`rotate(-90 ${center} ${center})`}
                      />
                      {frac > 1.02 && (
                        <circle cx={center + radius * Math.cos(-Math.PI / 2)} cy={center + radius * Math.sin(-Math.PI / 2)} r={strokeWidth / 2.6} fill="#F3EDE9" />
                      )}
                    </g>
                  );
                })}
                <text x={center} y={center - 6} textAnchor="middle" fill="#F3EDE9" fontFamily="IBM Plex Mono, monospace" fontSize="13">{currentDate}</text>
                <text x={center} y={center + 16} textAnchor="middle" fill="#a591a3" fontSize="10">{ringNutrients.length} nutrisi utama</text>
              </svg>

              <div className="ring-legend">
                {ringNutrients.map((key) => {
                  const goal = effectiveGoals[key];
                  const value = totals[key] || 0;
                  const target = goal.targetValue;
                  const pct = target ? (value / target) * 100 : 0;
                  const status = statusForGoal(pct, goal.goalType);
                  return (
                    <div className="ring-legend-item" key={key}>
                      <span className="ring-legend-dot" style={{ background: status.color }} />
                      <span className="ring-legend-name">{goal.label}</span>
                      <span className="ring-legend-value">{Math.round(value)}/{target}{goal.unit}</span>
                      <span className="ring-legend-pct" style={{ color: status.color }}>{Math.round(pct)}%</span>
                    </div>
                  );
                })}
                {overflowCount > 0 && (
                  <a className="ring-legend-more" href="#nutrient-detail">+{overflowCount} nutrisi lainnya di bawah ↓</a>
                )}
              </div>
            </>
          )}
          <div className="date-controls">
            <div className="divider" />
            <button
              type="button"
              className={`today-btn ${currentDate === todayISO() ? "active" : ""}`}
              onClick={goToToday}
            >
              Hari ini
            </button>
            <MiniCalendar
              month={calendarMonth}
              onMonthChange={setCalendarMonth}
              selectedDate={currentDate}
              markedDates={datesWithData}
              todayDate={todayISO()}
              onSelectDate={jumpToDate}
            />
          </div>
        </div>

        {/* Vitamin checklist */}
        <div className="panel full">
          <h3>Vitamin — {currentDate}</h3>
          {vitamins.length === 0 ? (
            <div className="vitamin-empty">Belum ada vitamin. Unggah CSV vitamin di panel kiri.</div>
          ) : (
            vitamins.map((v) => {
              const checked = !!(vitaminChecks[currentDate]?.[v.id]);
              const detailParts = [
                ...ALL_TRACKED_NUTRIENTS.filter((n) => v[n]).map((n) => `${ALL_TRACKED_META[n].label} ${v[n]}${ALL_TRACKED_META[n].unit}`),
                ...Object.values(v.extra_nutrients || {}).filter((e) => e?.label).map((e) => `${e.label} ${e.value}${e.unit || ""}`),
              ];
              return (
                <div className="vitamin-row" key={v.id}>
                  <input type="checkbox" className="vitamin-check" checked={checked} onChange={(e) => toggleVitaminCheck(v.id, e.target.checked)} />
                  <div className="vitamin-info">
                    <div className="vitamin-name">{v.name}</div>
                    <div className="vitamin-detail">{detailParts.join(" · ") || "tanpa data gizi"}</div>
                  </div>
                  <ConfirmButton className="vitamin-remove" title="Hapus vitamin ini" onConfirm={() => removeVitamin(v.id)}><X size={16} /></ConfirmButton>
                </div>
              );
            })
          )}
        </div>

        {/* Nutrisi tambahan (custom, di luar ALL_TRACKED_NUTRIENTS) dari vitamin yang dicentang + menu hari ini.
            Slug dengan goal tersimpan (diatur di Profil -> Konfigurasi nutrisi)
            render sebagai bar progres; yang belum diatur tetap chip biasa,
            sama seperti sebelum fitur ini ada. */}
        {currentDate && Object.keys(todaysExtraTotals).length > 0 && (
          <div className="panel full">
            <h3>
              Nutrisi lain — {currentDate}
              <HelpTip>
                Nutrisi tambahan — atur target/batasnya di Profil (Konfigurasi nutrisi) kalau mau
                dipantau progresnya, kalau tidak cuma ditampilkan sebagai catatan.
              </HelpTip>
            </h3>
            <div className="extra-today-list">
              {Object.entries(todaysExtraTotals).map(([slug, e]) => {
                const goal = effectiveGoals[slug];
                if (!goal?.isCustom) {
                  return <span className="extra-today-chip" key={slug}>{e.label} {Math.round(e.value * 100) / 100}{e.unit}</span>;
                }
                const pct = goal.targetValue ? (e.value / goal.targetValue) * 100 : 0;
                const status = statusForGoal(pct, goal.goalType);
                return (
                  <div className="nutrient-row extra-today-goal-row" key={slug}>
                    <span className="nutrient-name">{e.label}</span>
                    <div className="nutrient-bar-track"><div className={`nutrient-bar-fill${pct > 102 ? " over" : ""}`} style={{ width: `${Math.min(pct, 100)}%`, background: status.color }} /></div>
                    <span className="nutrient-value">{Math.round(e.value * 100) / 100}/{goal.targetValue}{goal.unit} · {Math.round(pct)}% · {status.label}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Cairan + menu hari ini */}
        {currentDate && (
          <div className="panel full">
            <h2><Droplet size={18} /> Cairan — {currentDate}</h2>
            <div className="water-widget">
              <div className="water-widget-label">
                <span>Cairan hari ini</span>
                <span className="water-widget-value">{Math.round(waterTotal)}/{waterTarget}ml · {Math.round(waterPct)}%</span>
              </div>
              <div className="water-bar-track">
                <div className={`water-bar-fill${waterPct > 102 ? " over" : ""}`} style={{ width: `${Math.min(waterPct, 100)}%`, background: waterStatus.color }} />
              </div>
              <div className="water-quick-row">
                {[100, 200, 250, 500].map((ml) => (
                  <button key={ml} className="water-btn" onClick={() => addWater(ml)} disabled={waterSaving}>+{ml}ml</button>
                ))}
              </div>
              <div className="water-custom-row">
                <input
                  type="number" inputMode="decimal" min="0" step="any" placeholder="Jumlah ml lainnya"
                  value={waterAmount} onChange={(e) => setWaterAmount(e.target.value)}
                />
                <button onClick={handleWaterCustomAdd} disabled={waterSaving}>Tambah</button>
              </div>
              {waterError && <div className="error-box"><AlertTriangle size={13} /> {waterError}</div>}
            </div>

            <div className="divider" />

            <h2><UtensilsCrossed size={18} /> Menu yang sudah dimakan — {currentDate}</h2>
            {todaysMeals.length === 0 ? (
              <div className="meal-list-empty">Belum ada menu tercatat untuk tanggal ini. Unggah CSV atau tambah manual di panel kiri.</div>
            ) : (
              todaysMeals.map((m) => {
                const detailParts = [
                  ...ALL_TRACKED_NUTRIENTS.filter((n) => m[n]).map((n) => `${ALL_TRACKED_META[n].label} ${m[n]}${ALL_TRACKED_META[n].unit}`),
                  ...Object.values(m.extra_nutrients || {}).filter((e) => e?.label).map((e) => `${e.label} ${e.value}${e.unit || ""}`),
                ];
                return (
                  <div className="meal-list-item" key={m.id}>
                    <div className="meal-list-info">
                      <div className="meal-list-name">
                        {m.meal || "Tanpa nama"}
                        {m.source === "chat" && <span className="meal-source-badge" title="Dicatat otomatis lewat foto di Chat"><MessageCircle size={12} /></span>}
                      </div>
                      <div className="meal-list-detail">{detailParts.join(" · ") || "tanpa data gizi"}</div>
                    </div>
                    <ConfirmButton className="meal-list-remove" title="Hapus menu ini" onConfirm={() => handleDeleteMeal(m.id)}><X size={15} /></ConfirmButton>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Nutrient list */}
        {currentDate && activeNutrients.length > 0 && (
          <div className="panel full" id="nutrient-detail">
            <h2>{currentDate} — rincian per nutrisi</h2>
            {visibleNutrients.map((key) => {
              const goal = effectiveGoals[key];
              const value = totals[key] || 0;
              const target = goal.targetValue;
              const pct = target ? (value / target) * 100 : 0;
              return (
                <div className="nutrient-row" key={key}>
                  <span className="nutrient-name">{goal.label}</span>
                  <div className="nutrient-bar-track"><div className={`nutrient-bar-fill${pct > 102 ? " over" : ""}`} style={{ width: `${Math.min(pct, 100)}%`, background: ALL_TRACKED_META[key].color }} /></div>
                  <span className="nutrient-value">{Math.round(value)}/{target}{goal.unit} · {Math.round(pct)}%</span>
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
            <h3>
              Tren dari hari ke hari
              <HelpTip>
                Setiap garis menunjukkan % dari target harian — garis putus-putus di 100% berarti "tercukupi penuh".
              </HelpTip>
            </h3>
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
                  // ALL_TRACKED_META (not NUTRIENT_META) -- activeNutrients is
                  // now filtered by each key's CURRENT effectiveGoals
                  // direction, not fixed NUTRIENT_ORDER membership, so a
                  // flipped-to-min key normally in LIMIT_META (e.g. sodium_mg)
                  // can land here too; NUTRIENT_META alone would be undefined
                  // for it.
                  const meta = ALL_TRACKED_META[n];
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
                <div className="legend-item" key={n}><span className="legend-dot" style={{ background: ALL_TRACKED_META[n].color }} />{effectiveGoals[n].label}</div>
              ))}
            </div>
          </div>
        )}

        {/* Batas harian (ceiling-type nutrients) — kept as its own section,
            separate from the floor-type rings/nutrient-list/trend above (see
            LIMIT_ORDER's comment in lib/nutrition.js for why). */}
        {currentDate && activeLimitNutrients.length > 0 && (
          <div className="panel full">
            <h2>
              {currentDate} — batas harian
              <HelpTip label="Soal batas harian">
                Gula, natrium, kolesterol, lemak jenuh, dan kafein punya BATAS MAKSIMUM harian, bukan
                target minimum seperti nutrisi lain — jadi persentase di sini sebaiknya tetap RENDAH,
                bukan dikejar sampai 100%. Angka batasnya panduan umum, bukan anjuran medis personal.
              </HelpTip>
            </h2>
            {activeLimitNutrients.map((key) => {
              const goal = effectiveGoals[key];
              const value = totals[key] || 0;
              const limit = goal.targetValue;
              const pct = limit ? (value / limit) * 100 : 0;
              const status = statusForGoal(pct, goal.goalType);
              return (
                <div className="nutrient-row" key={key}>
                  <span className="nutrient-name">{goal.label}</span>
                  <div className="nutrient-bar-track"><div className={`nutrient-bar-fill${pct > 100 ? " over" : ""}`} style={{ width: `${Math.min(pct, 100)}%`, background: status.color }} /></div>
                  <span className="nutrient-value">{Math.round(value)}/{limit}{goal.unit} · {Math.round(pct)}% · {status.label}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Tren batas harian — structurally mirrors the "Tren dari hari ke
            hari" trend above, computed from limitTrendData/effectiveGoals
            (ceiling-type) instead of trendData/effectiveGoals (floor-type)
            (see the geometry block near the top of this component).
            Deliberately a parallel block, not a shared/generic component
            with the floor-type trend. */}
        {datesWithMeals.length > 1 && activeLimitNutrients.length > 0 && (
          <div className="panel full">
            <h3>
              Tren batas harian
              <HelpTip>
                Setiap garis menunjukkan % dari BATAS harian — garis putus-putus di 100% berarti
                "sudah di batas maksimum". Beda dari tren di atas, di sini sebaiknya garisnya tetap
                di BAWAH garis putus-putus, bukan di atasnya.
              </HelpTip>
            </h3>
            <div className="trend-svg-wrap">
              <svg width={ltw} height={lth} viewBox={`0 0 ${ltw} ${lth}`}>
                {lgridTicks.map((v) => (
                  <g key={v}>
                    <line x1={lpadL} x2={ltw - lpadR} y1={lyPos(v)} y2={lyPos(v)} stroke="rgba(243,237,233,0.08)" strokeWidth="1" />
                    <text x={lpadL - 8} y={lyPos(v) + 4} textAnchor="end" fill="#a591a3" fontSize="10">{v}%</text>
                  </g>
                ))}
                <line x1={lpadL} x2={ltw - lpadR} y1={lyPos(100)} y2={lyPos(100)} stroke="#F3EDE9" strokeWidth="1.2" strokeDasharray="4 4" opacity="0.4" />
                {limitTrendData.map((d, i) => (
                  <text key={d.date} x={lxPos(i)} y={lth - lpadB + 18} textAnchor="middle" fill="#a591a3" fontSize="10">{d.date}</text>
                ))}
                {activeLimitNutrients.map((n) => {
                  // ALL_TRACKED_META (not LIMIT_META) -- same reasoning as the
                  // floor-type trend above: activeLimitNutrients can now
                  // include a flipped-to-max key normally in NUTRIENT_META
                  // (e.g. protein_g), which LIMIT_META alone wouldn't have.
                  const meta = ALL_TRACKED_META[n];
                  const points = limitTrendData.map((d, i) => `${lxPos(i)},${lyPos(d[n])}`).join(" ");
                  return (
                    <g key={n}>
                      <polyline points={points} fill="none" stroke={meta.color} strokeWidth="2" />
                      {limitTrendData.map((d, i) => <circle key={i} cx={lxPos(i)} cy={lyPos(d[n])} r="3" fill={meta.color} />)}
                    </g>
                  );
                })}
              </svg>
            </div>
            <div className="legend">
              {activeLimitNutrients.map((n) => (
                <div className="legend-item" key={n}><span className="legend-dot" style={{ background: ALL_TRACKED_META[n].color }} />{effectiveGoals[n].label}</div>
              ))}
            </div>
          </div>
        )}

        {/* History */}
        {datesWithMeals.length > 0 && (
          <div className="panel full">
            <h3>Ringkasan riwayat</h3>
            <div className="hist-table-wrap">
              <table className="hist-table">
                <thead><tr><th>Tanggal</th><th style={{ width: "55%" }}>Rata-rata tercapai</th><th>Status</th></tr></thead>
                <tbody>
                  {datesWithMeals.slice().reverse().map((d) => {
                    const t = dayNutrientTotals(d);
                    const p = activeNutrients.map((n) => (effectiveGoals[n].targetValue ? (t[n] || 0) / effectiveGoals[n].targetValue * 100 : 0));
                    const a = p.length ? p.reduce((x, y) => x + Math.min(y, 100), 0) / p.length : 0;
                    const st = statusForPct(a);
                    return (
                      <tr key={d}>
                        <td>{d}</td>
                        <td>
                          <div className="hist-bar-cell">
                            <div className="hist-bar-track"><div className="hist-bar-fill" style={{ width: `${Math.min(a, 100)}%`, background: st.color }} /></div>
                            <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, color: "var(--text-dimmer)" }}>{Math.round(a)}%</span>
                          </div>
                        </td>
                        <td><span style={{ color: st.color, fontSize: 12, fontWeight: 600 }}>{st.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
