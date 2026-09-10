"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabaseClient";
import ConfirmButton from "@/components/ConfirmButton";
import HelpTip from "@/components/HelpTip";
import { Home, NotebookText, MessageCircle, User, X, Star, AlertTriangle, Scale, Target } from "lucide-react";
import {
  todayISO, ALL_TRACKED_NUTRIENTS,
  resolveEffectiveGoals, collectKnownExtraNutrientSlugs, slugifyNutrientLabel,
} from "@/lib/nutrition";
import {
  computeHPL, computeHPHTFromHPL, computeGestationalAge, formatGestationalAge, trimesterForDate,
  gestationalProgressPct, formatDateID, FULL_TERM_WEEKS,
} from "@/lib/pregnancy";
import {
  computeBMI, bmiCategory, BMI_CATEGORY_META, TOTAL_GAIN_RANGE_KG,
  expectedGainRangeAtWeek, gainStatusForWeek, GAIN_STATUS_META, computeMonthlyGain,
} from "@/lib/weight";
import { isPushSupported, getPushState, subscribeToPush, unsubscribeFromPush } from "@/lib/push";

const GENDER_META = {
  boy: { label: "Laki-laki", color: "#7FA9C7" },
  girl: { label: "Perempuan", color: "#C97B63" },
  unisex: { label: "Unisex", color: "#8FAE8B" },
};

const FILTERS = [
  { key: "all", label: "Semua" },
  { key: "favorite", label: "Favorit" },
  { key: "boy", label: "Laki-laki" },
  { key: "girl", label: "Perempuan" },
  { key: "unisex", label: "Unisex" },
];

// Sentinel value for the "Tambah nutrisi kustom" picker's freehand-entry
// option -- never a real slug (slugifyNutrientLabel never produces
// underscores-wrapped-in-double-underscore output), so it can't collide.
const CUSTOM_FREE_TEXT = "__custom__";

export default function ProfilePage() {
  const router = useRouter();
  const supabase = useMemo(() => {
    try { return getSupabaseClient(); } catch (e) { return null; }
  }, []);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

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

  // nama ibu — dipakai untuk sapaan personal di notifikasi Web Push (lihat
  // app/api/cron/reminders/route.js), bukan cuma kosmetik.
  const [name, setName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState("");

  // berat badan sebelum hamil + tinggi badan — dipakai lib/weight.js untuk
  // BMI + target kenaikan berat badan (IOM), ditampilkan di panel "Berat
  // badan" di bawah. Keduanya opsional.
  const [prePregWeightKg, setPrePregWeightKg] = useState(null);
  const [heightCm, setHeightCm] = useState(null);
  const [bioDraftWeight, setBioDraftWeight] = useState("");
  const [bioDraftHeight, setBioDraftHeight] = useState("");
  const [bioSaving, setBioSaving] = useState(false);
  const [bioError, setBioError] = useState("");

  // catatan berat badan (weight_logs) — satu nilai per tanggal (upsert),
  // dipindahkan ke sini dari Dashboard supaya jadi satu bagian utuh bareng
  // panel berat/tinggi sebelum hamil di atas.
  const [weightLogs, setWeightLogs] = useState([]); // sorted ascending by date
  const [weightFormOpen, setWeightFormOpen] = useState(false);
  const [weightDraft, setWeightDraft] = useState("");
  const [weightFormDate, setWeightFormDate] = useState(todayISO());
  const [weightDateOpen, setWeightDateOpen] = useState(false); // de-emphasized date field, closed by default
  const [weightSaving, setWeightSaving] = useState(false);
  const [weightError, setWeightError] = useState("");

  // notifikasi push (Web Push) — lihat lib/push.js
  const [pushSupported, setPushSupported] = useState(true); // asumsi optimis sampai dicek di client
  const [pushPermission, setPushPermission] = useState("default");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState("");

  // calon nama bayi
  const [names, setNames] = useState([]);
  const [filter, setFilter] = useState("all");
  const [formName, setFormName] = useState("");
  const [formGender, setFormGender] = useState("");
  const [formNote, setFormNote] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // konfigurasi nutrisi (nutrient_goals) — target/batas per nutrisi, fixed
  // (ALL_TRACKED_NUTRIENTS, di-seed otomatis lihat bootstrap effect) atau
  // custom (dari extra_nutrients yang pernah dicatat, atau nama manual).
  const [goalRows, setGoalRows] = useState([]);
  const [knownExtraSlugs, setKnownExtraSlugs] = useState([]); // [{slug,label,unit}], seluruh riwayat
  // Draft per nutrient_key -- lazily seeded from effectiveGoals the first
  // time a row is touched (see goalDraftFor), same "own local edit buffer,
  // synced from confirmed state until dirty" pattern as nameDraft/bioDraft.
  const [goalDrafts, setGoalDrafts] = useState({});
  const [goalSaving, setGoalSaving] = useState({});
  const [goalErrors, setGoalErrors] = useState({});

  // tambah nutrisi kustom
  const [customPickSlug, setCustomPickSlug] = useState(CUSTOM_FREE_TEXT);
  const [customLabel, setCustomLabel] = useState("");
  const [customUnit, setCustomUnit] = useState("");
  const [customGoalType, setCustomGoalType] = useState("max");
  const [customTargetValue, setCustomTargetValue] = useState("");
  const [customSaving, setCustomSaving] = useState(false);
  const [customError, setCustomError] = useState("");

  useEffect(() => {
    if (!supabase) { router.replace("/login"); return; }
    (async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) { router.replace("/login"); return; }
      const u = sessionData.session.user;
      setUser(u);

      let { data: profile } = await supabase.from("profiles").select("*").eq("user_id", u.id).maybeSingle();
      if (!profile) {
        const { data: created } = await supabase.from("profiles").insert({ user_id: u.id }).select().maybeSingle();
        profile = created;
      }
      setHpht(profile?.hpht || null);
      setName(profile?.name || "");
      setNameDraft(profile?.name || "");
      setPrePregWeightKg(profile?.pre_pregnancy_weight_kg ?? null);
      setHeightCm(profile?.height_cm ?? null);
      setBioDraftWeight(profile?.pre_pregnancy_weight_kg != null ? String(profile.pre_pregnancy_weight_kg) : "");
      setBioDraftHeight(profile?.height_cm != null ? String(profile.height_cm) : "");

      const { data: nameRows } = await supabase
        .from("baby_names")
        .select("*")
        .eq("user_id", u.id)
        .order("is_favorite", { ascending: false })
        .order("name", { ascending: true });
      setNames(nameRows || []);

      const { data: weightRows } = await supabase
        .from("weight_logs")
        .select("*")
        .eq("user_id", u.id)
        .order("date", { ascending: true });
      setWeightLogs(weightRows || []);

      // nutrient_goals — seed every fixed nutrient with today's global
      // default (direction + value, per this profile's own trimester) the
      // first time this section is opened, so there's always a real, edited
      // row to show/edit rather than an ephemeral computed fallback. Uses
      // `profile.hpht` directly (not the `hpht` state, not yet updated this
      // tick) so seeding reflects the profile actually just loaded above.
      let { data: goalRowsData } = await supabase.from("nutrient_goals").select("*").eq("user_id", u.id);
      const hasAnyFixedGoal = (goalRowsData || []).some((g) => ALL_TRACKED_NUTRIENTS.includes(g.nutrient_key));
      if (!hasAnyFixedGoal) {
        const seedTrimester = trimesterForDate(profile?.hpht || null, todayISO());
        const seeded = resolveEffectiveGoals([], seedTrimester);
        const seedRows = ALL_TRACKED_NUTRIENTS.map((key) => ({
          user_id: u.id, nutrient_key: key, label: seeded[key].label, unit: seeded[key].unit,
          goal_type: seeded[key].goalType, target_value: seeded[key].targetValue, is_custom: false,
        }));
        const { data: inserted } = await supabase.from("nutrient_goals").insert(seedRows).select();
        goalRowsData = [...(goalRowsData || []), ...(inserted || [])];
      }
      setGoalRows(goalRowsData || []);

      // Every custom extra_nutrients slug this user has ever logged (not
      // just today's, unlike the Dashboard's own per-day extraTotals) —
      // offered as add-candidates in "Tambah nutrisi kustom" below. Light
      // projection (just the one jsonb column) since this can scan a
      // user's whole history.
      const [{ data: mealExtraRows }, { data: vitExtraRows }] = await Promise.all([
        supabase.from("meals").select("extra_nutrients").eq("user_id", u.id),
        supabase.from("vitamins").select("extra_nutrients").eq("user_id", u.id),
      ]);
      setKnownExtraSlugs(collectKnownExtraNutrientSlugs([...(mealExtraRows || []), ...(vitExtraRows || [])]));

      setLoading(false);
    })();
  }, [supabase, router]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  // refresh push permission/subscription state on mount -- runs once, client-
  // only (Notification/PushManager don't exist during SSR).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = isPushSupported();
      setPushSupported(supported);
      if (!supported) return;
      const state = await getPushState();
      if (cancelled) return;
      setPushPermission(state.permission);
      setPushSubscribed(state.subscribed);
    })();
    return () => { cancelled = true; };
  }, []);

  // ---------------- nama ----------------
  async function saveName() {
    setNameError("");
    const trimmed = nameDraft.trim();
    setNameSaving(true);
    const { error } = await supabase.from("profiles").upsert({ user_id: user.id, name: trimmed || null }, { onConflict: "user_id" });
    setNameSaving(false);
    if (error) { setNameError(error.message); return; }
    setName(trimmed);
  }

  // ---------------- berat & tinggi badan sebelum hamil ----------------
  // Both optional -- an empty draft saves null (not 0), same "don't force a
  // fake number" spirit as name's `trimmed || null` above.
  async function saveBio() {
    setBioError("");
    const w = parseFloat(bioDraftWeight);
    const h = parseFloat(bioDraftHeight);
    if (bioDraftWeight.trim() && (isNaN(w) || w <= 0)) { setBioError("Berat badan tidak valid."); return; }
    if (bioDraftHeight.trim() && (isNaN(h) || h <= 0)) { setBioError("Tinggi badan tidak valid."); return; }
    setBioSaving(true);
    const nextWeight = bioDraftWeight.trim() ? w : null;
    const nextHeight = bioDraftHeight.trim() ? h : null;
    const { error } = await supabase.from("profiles").upsert(
      { user_id: user.id, pre_pregnancy_weight_kg: nextWeight, height_cm: nextHeight },
      { onConflict: "user_id" }
    );
    setBioSaving(false);
    if (error) { setBioError(error.message); return; }
    setPrePregWeightKg(nextWeight);
    setHeightCm(nextHeight);
  }

  // ---------------- berat badan (weight_logs) ----------------
  function openWeightForm() {
    setWeightFormOpen(true);
    setWeightDraft("");
    setWeightFormDate(todayISO());
    setWeightDateOpen(false);
    setWeightError("");
  }

  function closeWeightForm() {
    setWeightFormOpen(false);
    setWeightError("");
  }

  // Upsert on (user_id, date) -- logging again for a date already saved
  // overwrites its value instead of creating a duplicate row (see
  // supabase/schema.sql's unique(user_id, date) on weight_logs) -- same
  // logic the Dashboard version of this feature had.
  async function handleSaveWeight() {
    setWeightError("");
    const kg = parseFloat(weightDraft);
    if (!kg || kg <= 0) { setWeightError("Masukkan berat badan (kg) yang valid."); return; }
    if (!weightFormDate) { setWeightError("Pilih tanggal untuk catatan ini."); return; }
    setWeightSaving(true);
    const { data, error } = await supabase
      .from("weight_logs")
      .upsert({ user_id: user.id, date: weightFormDate, weight_kg: kg }, { onConflict: "user_id,date" })
      .select()
      .maybeSingle();
    setWeightSaving(false);
    if (error) { setWeightError(error.message); return; }
    setWeightLogs((prev) => [...prev.filter((w) => w.date !== weightFormDate), data].sort((a, b) => a.date.localeCompare(b.date)));
    setWeightFormOpen(false);
  }

  async function handleDeleteWeight(id) {
    setWeightLogs((prev) => prev.filter((w) => w.id !== id));
    await supabase.from("weight_logs").delete().eq("id", id);
  }

  // ---------------- notifikasi push ----------------
  async function handleEnablePush() {
    setPushError("");
    setPushBusy(true);
    try {
      await subscribeToPush();
      setPushSubscribed(true);
      setPushPermission("granted");
    } catch (e) {
      setPushError(e.message);
      // permission could've ended up "denied" even though subscribe threw --
      // re-read so the panel reflects the browser's actual state either way.
      if (typeof Notification !== "undefined") setPushPermission(Notification.permission);
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisablePush() {
    setPushError("");
    setPushBusy(true);
    try {
      await unsubscribeFromPush();
      setPushSubscribed(false);
    } catch (e) {
      setPushError(e.message);
    } finally {
      setPushBusy(false);
    }
  }

  // ---------------- usia kehamilan ----------------
  const gestationalAge = useMemo(() => computeGestationalAge(hpht, todayISO()), [hpht]);
  const hpl = useMemo(() => computeHPL(hpht), [hpht]);
  const gaProgressPct = gestationalProgressPct(gestationalAge);
  // Same derivation the Dashboard uses (for "today" specifically here) — see
  // trimesterForDate in lib/pregnancy.js. Nothing to store: this is always
  // freshly computed from hpht, never a saved preference.
  const trimester = trimesterForDate(hpht, todayISO());

  // PRE-PREGNANCY BMI (see the important caveat on bmiCategory in
  // lib/weight.js) — never computed from a logged current weight.
  const bmi = useMemo(() => computeBMI(prePregWeightKg, heightCm), [prePregWeightKg, heightCm]);
  const bmiCat = bmiCategory(bmi);

  // ---------------- konfigurasi nutrisi ----------------
  const effectiveGoals = useMemo(() => resolveEffectiveGoals(goalRows, trimester), [goalRows, trimester]);
  const customGoalRows = useMemo(() => goalRows.filter((g) => !ALL_TRACKED_NUTRIENTS.includes(g.nutrient_key)), [goalRows]);
  const configuredCustomKeys = useMemo(() => new Set(customGoalRows.map((g) => g.nutrient_key)), [customGoalRows]);
  // Known extras not yet configured -- these are the add-candidates offered
  // in "Tambah nutrisi kustom"; a slug already configured is edited in the
  // "Nutrisi kustom" list above instead, not re-offered here.
  const unconfiguredKnownExtras = knownExtraSlugs.filter((e) => !configuredCustomKeys.has(e.slug));

  // Lazily seeded from the row's current effective value the first time
  // it's touched -- same "own local edit buffer until dirty" pattern as
  // nameDraft/bioDraftWeight above, just keyed by nutrient_key since this is
  // a multi-row section instead of one field.
  function goalDraftFor(key) {
    const current = effectiveGoals[key];
    return goalDrafts[key] || { goalType: current.goalType, targetValue: String(current.targetValue) };
  }
  function setGoalDraftField(key, field, value) {
    setGoalDrafts((prev) => ({ ...prev, [key]: { ...goalDraftFor(key), [field]: value } }));
  }
  function isGoalDirty(key) {
    const draft = goalDraftFor(key);
    const current = effectiveGoals[key];
    return draft.goalType !== current.goalType || draft.targetValue !== String(current.targetValue);
  }

  // Shared by both fixed and custom rows -- label/unit/is_custom always
  // come from the row's own current effectiveGoals entry (not editable
  // inline), only direction + target value are ever drafted/saved here.
  async function saveGoal(key) {
    const draft = goalDraftFor(key);
    const current = effectiveGoals[key];
    setGoalErrors((prev) => ({ ...prev, [key]: "" }));
    const value = parseFloat(draft.targetValue);
    if (!draft.targetValue.trim() || isNaN(value) || value <= 0) {
      setGoalErrors((prev) => ({ ...prev, [key]: "Masukkan angka target yang valid." }));
      return;
    }
    setGoalSaving((prev) => ({ ...prev, [key]: true }));
    const { data, error } = await supabase.from("nutrient_goals").upsert(
      {
        user_id: user.id, nutrient_key: key, label: current.label, unit: current.unit,
        goal_type: draft.goalType, target_value: value, is_custom: current.isCustom,
      },
      { onConflict: "user_id,nutrient_key" }
    ).select().maybeSingle();
    setGoalSaving((prev) => ({ ...prev, [key]: false }));
    if (error) { setGoalErrors((prev) => ({ ...prev, [key]: error.message })); return; }
    setGoalRows((prev) => [...prev.filter((g) => g.nutrient_key !== key), data]);
    setGoalDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });
  }

  async function handleDeleteCustomGoal(key, id) {
    setGoalRows((prev) => prev.filter((g) => g.id !== id));
    setGoalDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });
    await supabase.from("nutrient_goals").delete().eq("id", id);
  }

  async function handleAddCustomGoal() {
    setCustomError("");
    const picked = customPickSlug !== CUSTOM_FREE_TEXT ? knownExtraSlugs.find((e) => e.slug === customPickSlug) : null;
    const label = (picked ? picked.label : customLabel).trim();
    const unit = (picked ? picked.unit : customUnit).trim();
    const nutrientKey = picked ? picked.slug : slugifyNutrientLabel(label);
    if (!label) { setCustomError("Isi dulu nama nutrisinya, atau pilih dari daftar."); return; }
    if (!nutrientKey) { setCustomError("Nama nutrisi tidak valid — coba nama lain."); return; }
    const value = parseFloat(customTargetValue);
    if (!customTargetValue.trim() || isNaN(value) || value <= 0) { setCustomError("Masukkan angka target/batas yang valid."); return; }
    setCustomSaving(true);
    const { data, error } = await supabase.from("nutrient_goals").insert({
      user_id: user.id, nutrient_key: nutrientKey, label, unit, goal_type: customGoalType, target_value: value, is_custom: true,
    }).select().maybeSingle();
    setCustomSaving(false);
    if (error) {
      setCustomError(error.code === "23505" ? "Nutrisi ini sudah dikonfigurasi — edit langsung di daftar di atas." : error.message);
      return;
    }
    setGoalRows((prev) => [...prev, data]);
    setCustomPickSlug(CUSTOM_FREE_TEXT);
    setCustomLabel(""); setCustomUnit(""); setCustomTargetValue(""); setCustomGoalType("max");
  }

  // ---------------- berat badan (weight_logs) ----------------
  // weightLogs is always kept sorted ascending by date (fetched that way,
  // and re-sorted after every save) -- so the last entry is the latest one,
  // no separate "currentDate" concept needed now this lives outside the
  // Dashboard's day-nav.
  const latestWeightRow = weightLogs.length > 0 ? weightLogs[weightLogs.length - 1] : null;
  const firstWeightRow = weightLogs.length > 0 ? weightLogs[0] : null;
  const totalGainRange = bmiCat ? TOTAL_GAIN_RANGE_KG[bmiCat] : null;
  const gaForLatest = latestWeightRow ? computeGestationalAge(hpht, latestWeightRow.date) : null;
  const expectedRangeLatest = gaForLatest ? expectedGainRangeAtWeek(bmiCat, gaForLatest.weeks) : null;
  const actualGainLatest = (latestWeightRow && prePregWeightKg != null) ? latestWeightRow.weight_kg - prePregWeightKg : null;
  const gainStatusLatest = actualGainLatest != null ? gainStatusForWeek(actualGainLatest, expectedRangeLatest) : null;
  const monthlyGain = useMemo(() => computeMonthlyGain(weightLogs, prePregWeightKg), [weightLogs, prePregWeightKg]);

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
      setHphtError(hphtInputMode === "hpl" ? "Pilih tanggal HPL dulu." : "Pilih tanggal HPHT dulu.");
      return;
    }
    const hphtToSave = hphtInputMode === "hpl" ? computeHPHTFromHPL(hphtDraft) : hphtDraft;
    if (!computeGestationalAge(hphtToSave, todayISO())) {
      setHphtError("Tanggal ini menghasilkan usia kehamilan yang tidak valid (di masa depan). Cek lagi tanggalnya.");
      return;
    }
    setHphtSaving(true);
    const { error } = await supabase.from("profiles").upsert({ user_id: user.id, hpht: hphtToSave }, { onConflict: "user_id" });
    setHphtSaving(false);
    if (error) { setHphtError(error.message); return; }
    setHpht(hphtToSave);
    setHphtEditing(false);
  }

  // ---------------- calon nama bayi ----------------
  async function handleAdd() {
    setFormError("");
    const name = formName.trim();
    if (!name) { setFormError("Isi dulu namanya."); return; }
    setFormSaving(true);
    const row = { user_id: user.id, name, gender: formGender || null, note: formNote.trim() || null };
    const { data, error } = await supabase.from("baby_names").insert(row).select().maybeSingle();
    setFormSaving(false);
    if (error) { setFormError(error.message); return; }
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

  // ---------------- weight trend geometry ----------------
  // Ported from the Dashboard version of this feature — same math, now
  // driven directly by the fetched `weightLogs` array instead of a
  // day-nav-derived subset. Handles 0/1/2+ entries correctly: at 0 the panel
  // below shows an empty-state instead of this SVG at all; at 1,
  // wxPos/wyPos already center the lone point (no division by zero).
  const canShowGainBand = !!(bmiCat && hpht && prePregWeightKg != null);
  const weightTrendData = weightLogs.map((row) => {
    let expectedMinKg = null, expectedMaxKg = null;
    if (canShowGainBand) {
      const ga = computeGestationalAge(hpht, row.date);
      const expected = ga ? expectedGainRangeAtWeek(bmiCat, ga.weeks) : null;
      if (expected) {
        expectedMinKg = prePregWeightKg + expected.minKg;
        expectedMaxKg = prePregWeightKg + expected.maxKg;
      }
    }
    return { date: row.date, weight: Number(row.weight_kg), expectedMinKg, expectedMaxKg };
  });
  const wtw = Math.max(560, weightTrendData.length * 90), wth = 300;
  const wpadL = 44, wpadR = 16, wpadT = 16, wpadB = 34;
  const wplotW = wtw - wpadL - wpadR, wplotH = wth - wpadT - wpadB;
  let wMinVal = Infinity, wMaxVal = -Infinity;
  weightTrendData.forEach((d) => {
    [d.weight, d.expectedMinKg, d.expectedMaxKg].forEach((v) => {
      if (v != null) { if (v < wMinVal) wMinVal = v; if (v > wMaxVal) wMaxVal = v; }
    });
  });
  if (!Number.isFinite(wMinVal)) { wMinVal = 0; wMaxVal = 1; } // defensive — panel gated on length > 0
  const wSpan = Math.max(wMaxVal - wMinVal, 1);
  const wValPad = wSpan * 0.15;
  wMinVal -= wValPad; wMaxVal += wValPad;
  const wxPos = (i) => wpadL + (weightTrendData.length === 1 ? wplotW / 2 : (i / (weightTrendData.length - 1)) * wplotW);
  const wyPos = (v) => wpadT + wplotH - ((v - wMinVal) / (wMaxVal - wMinVal)) * wplotH;
  const wGridTicks = Array.from({ length: 5 }, (_, i) => wMinVal + (i * (wMaxVal - wMinVal)) / 4);
  const weightPoints = weightTrendData.map((d, i) => `${wxPos(i)},${wyPos(d.weight)}`).join(" ");
  const expectedMinPoints = weightTrendData.map((d, i) => (d.expectedMinKg != null ? `${wxPos(i)},${wyPos(d.expectedMinKg)}` : null)).filter(Boolean).join(" ");
  const expectedMaxPoints = weightTrendData.map((d, i) => (d.expectedMaxKg != null ? `${wxPos(i)},${wyPos(d.expectedMaxKg)}` : null)).filter(Boolean).join(" ");

  // ---------------- monthly gain bar chart geometry ----------------
  // A 4th hand-rolled SVG block, same house style as the trend charts above
  // — bars diverge from a zero-line since a month's gain can be negative
  // (weight loss), unlike the always-nonnegative trend line above.
  const mtw = Math.max(420, monthlyGain.length * 80), mth = 220;
  const mpadL = 44, mpadR = 16, mpadT = 16, mpadB = 28;
  const mplotW = mtw - mpadL - mpadR, mplotH = mth - mpadT - mpadB;
  let mMinVal = 0, mMaxVal = 0;
  monthlyGain.forEach((d) => { if (d.gainKg < mMinVal) mMinVal = d.gainKg; if (d.gainKg > mMaxVal) mMaxVal = d.gainKg; });
  if (mMinVal === 0 && mMaxVal === 0) mMaxVal = 1; // defensive — panel gated on length > 0
  mMaxVal *= 1.15;
  if (mMinVal < 0) mMinVal *= 1.15;
  const myPos = (v) => mpadT + mplotH - ((v - mMinVal) / (mMaxVal - mMinVal)) * mplotH;
  const mZeroY = myPos(0);
  const mBarSlot = monthlyGain.length > 0 ? mplotW / monthlyGain.length : mplotW;
  const mBarWidth = Math.min(36, mBarSlot * 0.5);
  const mxCenter = (i) => mpadL + (i + 0.5) * mBarSlot;
  const mGridTicks = Array.from({ length: 5 }, (_, i) => mMinVal + (i * (mMaxVal - mMinVal)) / 4);

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="topbar-left">
          <div className="avatar">{(user?.email || "?").charAt(0).toUpperCase()}</div>
          <span className="user-name">{user?.email}</span>
        </div>
        <div className="topbar-nav">
          <Link href="/dashboard" className="nav-link"><Home size={19} /><span>Dashboard</span></Link>
          <Link href="/dashboard/journal" className="nav-link"><NotebookText size={19} /><span>Jurnal</span></Link>
          <Link href="/dashboard/chat" className="nav-link"><MessageCircle size={19} /><span>Chat</span></Link>
          <Link href="/dashboard/profile" className="nav-link active"><User size={19} /><span>Profil</span></Link>
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
        {/* Nama — dipakai untuk sapaan personal di notifikasi Web Push */}
        <div className="panel full">
          <h2>
            Nama
            <HelpTip>
              Dipakai buat menyapa kamu secara personal di notifikasi pengingat Bloom (mis. "Pagi,
              Sarah!"). Boleh dikosongkan — notifikasinya tetap jalan pakai sapaan umum.
            </HelpTip>
          </h2>
          <div className="manual-form-row">
            <input
              type="text" placeholder="Nama kamu (mis. Sarah)"
              value={nameDraft} onChange={(e) => setNameDraft(e.target.value)}
            />
            <button className="manual-form-save" onClick={saveName} disabled={nameSaving || nameDraft.trim() === name}>
              {nameSaving ? "Menyimpan…" : "Simpan"}
            </button>
          </div>
          {nameError && <div className="error-box"><AlertTriangle size={13} /> {nameError}</div>}
        </div>

        {/* Notifikasi — Web Push (lihat lib/push.js + app/api/cron/reminders) */}
        <div className="panel full">
          <h2>
            Notifikasi
            <HelpTip label="Soal notifikasi push">
              Kalau diaktifkan, Bloom mengirim 4 pengingat tiap hari: pagi (sapaan + semangat/fakta
              kehamilan), siang (ajakan makan siang + fakta gizi), malam pukul 19:00 (kalau menu
              atau vitamin hari ini belum dicatat), dan menjelang tidur (pengingat istirahat +
              afirmasi). Di iPhone, tambahkan Bloom ke Layar Utama dulu (Safari → Share → Add to
              Home Screen) — notifikasi cuma bisa muncul lewat itu di iOS 16.4 ke atas.
            </HelpTip>
          </h2>
          {!pushSupported ? (
            <p className="format-hint" style={{ marginTop: 0 }}>
              <AlertTriangle size={13} /> Push notification belum didukung di browser ini.
            </p>
          ) : (
            <>
              {pushPermission === "denied" && (
                <div className="error-box">
                  <AlertTriangle size={13} /> Izin notifikasi ditolak di browser ini. Aktifkan lagi lewat pengaturan situs
                  (biasanya ikon gembok di address bar), lalu muat ulang halaman ini.
                </div>
              )}
              {pushSubscribed ? (
                <button className="manual-form-cancel" onClick={handleDisablePush} disabled={pushBusy}>
                  {pushBusy ? "Memproses…" : "Matikan pengingat"}
                </button>
              ) : (
                <button
                  className="manual-form-save" onClick={handleEnablePush}
                  disabled={pushBusy || pushPermission === "denied"}
                >
                  {pushBusy ? "Memproses…" : "Aktifkan pengingat"}
                </button>
              )}
              {pushError && <div className="error-box"><AlertTriangle size={13} /> {pushError}</div>}
            </>
          )}
        </div>

        {/* Usia kehamilan (dari HPHT) + progress tracker */}
        <div className="panel full">
          <h2>
            Usia kehamilan
            <HelpTip label="Apa itu HPHT">
              <strong>HPHT</strong> = Hari Pertama Haid Terakhir, yaitu tanggal mulai menstruasi
              terakhirmu sebelum hamil. Ini patokan standar dokter/bidan untuk menghitung usia
              kehamilan dan HPL (Hari Perkiraan Lahir) — Bloom memakai tanggal yang sama (aturan
              Naegele: HPL = HPHT + 280 hari).
            </HelpTip>
          </h2>
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
              {hphtError && <div className="error-box"><AlertTriangle size={13} /> {hphtError}</div>}
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
                  <span className="pregnancy-stat-label">Dihitung otomatis</span>
                </div>
              </div>
              <div className="water-bar-track">
                <div className="water-bar-fill" style={{ width: `${gaProgressPct}%`, background: "var(--lilac)" }} />
              </div>
              <div className="pregnancy-progress-label">
                <span>Minggu {gestationalAge?.weeks ?? 0} dari {FULL_TERM_WEEKS}</span>
              </div>
              <button className="extra-nutrient-add" style={{ marginTop: 12 }} onClick={openHphtForm}>Ubah HPHT/HPL</button>
            </div>
          )}
        </div>

        {/* Berat & tinggi badan sebelum hamil — dipakai lib/weight.js untuk
            BMI + target kenaikan berat badan (panel "Berat badan" di bawah).
            Keduanya opsional. */}
        <div className="panel full">
          <h2>
            Berat & tinggi badan sebelum hamil
            <HelpTip label="Kenapa ini dibutuhkan">
              Dipakai untuk menghitung BMI dan target kenaikan berat badan selama kehamilan
              (panduan IOM 2009) — ditampilkan di panel &quot;Berat badan&quot; di bawah. Boleh
              dikosongkan; panel target kenaikan cuma tidak muncul kalau salah satu belum diisi.
              Panduan umum, bukan pengganti anjuran dokter/bidan (dan cuma berlaku untuk kehamilan
              satu janin, bukan kembar).
            </HelpTip>
          </h2>
          <div className="manual-form-row">
            <input
              type="number" inputMode="decimal" min="0" step="any" placeholder="Berat sebelum hamil (kg)"
              value={bioDraftWeight} onChange={(e) => setBioDraftWeight(e.target.value)}
            />
            <input
              type="number" inputMode="decimal" min="0" step="any" placeholder="Tinggi badan (cm)"
              value={bioDraftHeight} onChange={(e) => setBioDraftHeight(e.target.value)}
            />
          </div>
          {bioError && <div className="error-box"><AlertTriangle size={13} /> {bioError}</div>}
          {bmi != null && (
            <p className="format-hint" style={{ marginTop: 10 }}>
              BMI sebelum hamil: <strong>{bmi.toFixed(1)}</strong> ·{" "}
              <span style={{ color: BMI_CATEGORY_META[bmiCat]?.color, fontWeight: 600 }}>
                {BMI_CATEGORY_META[bmiCat]?.label}
              </span>
            </p>
          )}
          <div className="manual-form-actions">
            <button className="manual-form-save" onClick={saveBio} disabled={bioSaving}>
              {bioSaving ? "Menyimpan…" : "Simpan"}
            </button>
          </div>
        </div>

        {/* Berat badan — consolidated section (moved here from Dashboard,
            redesigned per a reference app the user shared: a featured stat
            card, a static start/change/now range bar, a daily trend, and a
            monthly gain bar chart — same structure, Bloom's own dark theme). */}
        <div className="panel full">
          <h2>
            <Scale size={18} /> Berat badan
            <HelpTip label="Soal target kenaikan berat badan">
              Target kenaikan (panduan IOM 2009) dihitung dari BMI sebelum hamil — isi panel di
              atas untuk melihatnya di sini. Panduan umum, bukan pengganti anjuran dokter/bidan,
              dan cuma berlaku untuk kehamilan satu janin (bukan kembar).
            </HelpTip>
          </h2>

          <div className="weight-feature-card">
            <div className="weight-feature-value">{latestWeightRow ? `${latestWeightRow.weight_kg}kg` : "—"}</div>
            <div className="weight-feature-label">
              Berat badan terakhir{latestWeightRow ? ` · ${latestWeightRow.date}` : ""}
            </div>
            {!weightFormOpen && (
              <button type="button" className="weight-add-btn" onClick={openWeightForm}>+ Tambahkan berat</button>
            )}
          </div>

          {weightFormOpen && (
            <div className="manual-form">
              <div className="manual-form-row">
                <input
                  type="number" inputMode="decimal" min="0" step="any" placeholder="Berat badan (kg)"
                  value={weightDraft} onChange={(e) => setWeightDraft(e.target.value)}
                />
              </div>
              {!weightDateOpen ? (
                <button type="button" className="weight-date-toggle" onClick={() => setWeightDateOpen(true)}>
                  Catat untuk tanggal lain (bukan hari ini)
                </button>
              ) : (
                <div className="manual-form-row">
                  <input type="date" value={weightFormDate} onChange={(e) => setWeightFormDate(e.target.value)} />
                </div>
              )}
              {weightError && <div className="error-box"><AlertTriangle size={13} /> {weightError}</div>}
              <div className="manual-form-actions">
                <button className="manual-form-save" onClick={handleSaveWeight} disabled={weightSaving}>
                  {weightSaving ? "Menyimpan…" : "Simpan"}
                </button>
                <button className="manual-form-cancel" onClick={closeWeightForm}>Batal</button>
              </div>
            </div>
          )}

          {latestWeightRow && !weightFormOpen && (
            <div className="manual-form-actions" style={{ marginTop: 10 }}>
              <ConfirmButton onConfirm={() => handleDeleteWeight(latestWeightRow.id)}>Hapus catatan terakhir</ConfirmButton>
            </div>
          )}

          {!(prePregWeightKg && heightCm) ? (
            <p className="format-hint">
              <AlertTriangle size={14} />
              <span>
                Isi berat badan sebelum hamil & tinggi badan di panel di atas untuk melihat BMI
                dan target kenaikan berat badan di sini.
              </span>
            </p>
          ) : (
            <div style={{ marginTop: 14 }}>
              <p className="format-hint" style={{ marginTop: 0 }}>
                BMI sebelum hamil: <strong>{bmi.toFixed(1)}</strong> ·{" "}
                <span style={{ color: BMI_CATEGORY_META[bmiCat]?.color, fontWeight: 600 }}>
                  {BMI_CATEGORY_META[bmiCat]?.label}
                </span>{" "}
                · Target kenaikan total: <strong>{totalGainRange[0]}–{totalGainRange[1]}kg</strong>
              </p>
              {actualGainLatest != null && expectedRangeLatest && gainStatusLatest && (
                <p className="format-hint" style={{ marginTop: 6 }}>
                  Kenaikan sejauh ini: <strong>{actualGainLatest >= 0 ? "+" : ""}{actualGainLatest.toFixed(1)}kg</strong>{" "}
                  (target minggu ke-{gaForLatest.weeks}:{" "}
                  {expectedRangeLatest.minKg.toFixed(1)}–{expectedRangeLatest.maxKg.toFixed(1)}kg) ·{" "}
                  <span style={{ color: GAIN_STATUS_META[gainStatusLatest]?.color, fontWeight: 600 }}>
                    {GAIN_STATUS_META[gainStatusLatest]?.label}
                  </span>
                </p>
              )}
            </div>
          )}

          {weightLogs.length >= 2 && firstWeightRow && latestWeightRow && (
            <div className="weight-range-bar">
              <div className="weight-range-end">
                <strong>{firstWeightRow.weight_kg}kg</strong>
                <span>Mulai</span>
              </div>
              <div className="weight-range-line" />
              <div className="weight-range-mid">
                <strong>
                  {latestWeightRow.weight_kg - firstWeightRow.weight_kg >= 0 ? "+" : ""}
                  {(latestWeightRow.weight_kg - firstWeightRow.weight_kg).toFixed(1)}kg
                </strong>
                <span>Ubah</span>
              </div>
              <div className="weight-range-line" />
              <div className="weight-range-end">
                <strong>{latestWeightRow.weight_kg}kg</strong>
                <span>Sekarang</span>
              </div>
            </div>
          )}

          <div className="divider" />

          <h3>
            Tren berat badan
            <HelpTip>
              Garis penuh = berat badanmu. Kalau BMI sebelum hamil & HPHT sudah diisi, dua garis
              putus-putus menunjukkan rentang kenaikan berat badan yang diharapkan (panduan IOM) di
              setiap tanggal — idealnya garis beratmu ada DI ANTARA keduanya.
            </HelpTip>
          </h3>
          {weightLogs.length === 0 ? (
            <div className="rings-empty">
              <div style={{ color: "var(--lilac)" }}><Scale size={26} /></div>
              <p>Belum ada catatan berat badan. Klik &quot;Tambahkan berat&quot; di atas untuk mulai.</p>
            </div>
          ) : (
            <>
              <div className="trend-svg-wrap">
                <svg width={wtw} height={wth} viewBox={`0 0 ${wtw} ${wth}`}>
                  {wGridTicks.map((v, i) => (
                    <g key={i}>
                      <line x1={wpadL} x2={wtw - wpadR} y1={wyPos(v)} y2={wyPos(v)} stroke="rgba(243,237,233,0.08)" strokeWidth="1" />
                      <text x={wpadL - 8} y={wyPos(v) + 4} textAnchor="end" fill="#a591a3" fontSize="10">{v.toFixed(1)}kg</text>
                    </g>
                  ))}
                  {weightTrendData.map((d, i) => (
                    <text key={d.date} x={wxPos(i)} y={wth - wpadB + 18} textAnchor="middle" fill="#a591a3" fontSize="10">{d.date}</text>
                  ))}
                  {expectedMinPoints && <polyline points={expectedMinPoints} fill="none" stroke="#a591a3" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />}
                  {expectedMaxPoints && <polyline points={expectedMaxPoints} fill="none" stroke="#a591a3" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.6" />}
                  <polyline points={weightPoints} fill="none" stroke="#C9A6D0" strokeWidth="2.5" />
                  {weightTrendData.map((d, i) => <circle key={i} cx={wxPos(i)} cy={wyPos(d.weight)} r="3.5" fill="#C9A6D0" />)}
                </svg>
              </div>
              <div className="legend">
                <div className="legend-item"><span className="legend-dot" style={{ background: "#C9A6D0" }} />Berat badan</div>
                {canShowGainBand && (
                  <div className="legend-item"><span className="legend-dot" style={{ background: "#a591a3" }} />Rentang target (IOM)</div>
                )}
              </div>
            </>
          )}

          <div className="divider" />

          <h3>
            Riwayat — peningkatan berat bulanan
            <HelpTip>
              Kenaikan berat badan per bulan, dibandingkan dengan bulan sebelumnya (atau berat
              sebelum hamil untuk bulan pertama).
            </HelpTip>
          </h3>
          {monthlyGain.length === 0 ? (
            <div className="rings-empty">
              <p>Belum cukup data untuk melihat peningkatan bulanan.</p>
            </div>
          ) : (
            <div className="trend-svg-wrap">
              <svg width={mtw} height={mth} viewBox={`0 0 ${mtw} ${mth}`}>
                {mGridTicks.map((v, i) => (
                  <g key={i}>
                    <line x1={mpadL} x2={mtw - mpadR} y1={myPos(v)} y2={myPos(v)} stroke="rgba(243,237,233,0.08)" strokeWidth="1" />
                    <text x={mpadL - 8} y={myPos(v) + 4} textAnchor="end" fill="#a591a3" fontSize="10">{v.toFixed(1)}kg</text>
                  </g>
                ))}
                <line x1={mpadL} x2={mtw - mpadR} y1={mZeroY} y2={mZeroY} stroke="#F3EDE9" strokeWidth="1.2" opacity="0.4" />
                {monthlyGain.map((d, i) => {
                  const top = d.gainKg >= 0 ? myPos(d.gainKg) : mZeroY;
                  const height = Math.abs(myPos(d.gainKg) - mZeroY);
                  return (
                    <rect
                      key={d.month} x={mxCenter(i) - mBarWidth / 2} y={top} width={mBarWidth}
                      height={Math.max(height, 1)} rx="3" fill="#E0A94A"
                    />
                  );
                })}
                {monthlyGain.map((d, i) => (
                  <text key={d.month} x={mxCenter(i)} y={mth - mpadB + 18} textAnchor="middle" fill="#a591a3" fontSize="10">{d.month}</text>
                ))}
              </svg>
            </div>
          )}
        </div>

        {/* Konfigurasi nutrisi — target/batas per nutrisi, termasuk custom
            dari extra_nutrients yang pernah dicatat (mis. Laktosa dari label
            kemasan). Baris fixed di-seed otomatis begitu bagian ini pertama
            kali dibuka (lihat bootstrap effect); baris custom ditambahkan
            manual di bawah. Dipakai langsung oleh Dashboard, peringatan
            batas harian, dan chat gizi Bloom (lihat lib/nutrition.js's
            resolveEffectiveGoals). */}
        <div className="panel full">
          <h2>
            <Target size={18} /> Konfigurasi nutrisi
            <HelpTip label="Soal target & batas nutrisi">
              Tiap nutrisi bisa kamu atur sendiri arahnya: &quot;capai minimal&quot; (mis. protein)
              atau &quot;jangan sampai lewat batas&quot; (mis. gula) — termasuk nutrisi kustom yang
              pernah tercatat dari foto label makanan/vitamin. Perubahan di sini langsung dipakai di
              Dashboard, peringatan batas harian, dan analisis chat gizi Bloom.
            </HelpTip>
          </h2>

          <h3 style={{ marginTop: 0 }}>Nutrisi tetap</h3>
          <div className="goal-list">
            {ALL_TRACKED_NUTRIENTS.map((key) => {
              const draft = goalDraftFor(key);
              const current = effectiveGoals[key];
              const dirty = isGoalDirty(key);
              return (
                <div className="goal-row" key={key}>
                  <span className="goal-row-name">{current.label}</span>
                  <div className="goal-row-controls">
                    <div className="goal-direction-toggle">
                      <button
                        type="button" className={`goal-direction-btn ${draft.goalType === "min" ? "active" : ""}`}
                        onClick={() => setGoalDraftField(key, "goalType", "min")}
                      >
                        Capai minimal
                      </button>
                      <button
                        type="button" className={`goal-direction-btn ${draft.goalType === "max" ? "active" : ""}`}
                        onClick={() => setGoalDraftField(key, "goalType", "max")}
                      >
                        Jangan lewat batas
                      </button>
                    </div>
                    <input
                      type="number" inputMode="decimal" min="0" step="any" className="goal-value-input"
                      value={draft.targetValue} onChange={(e) => setGoalDraftField(key, "targetValue", e.target.value)}
                    />
                    <span className="goal-unit">{current.unit}</span>
                    {dirty && (
                      <button className="manual-form-save goal-save-btn" onClick={() => saveGoal(key)} disabled={goalSaving[key]}>
                        {goalSaving[key] ? "…" : "Simpan"}
                      </button>
                    )}
                  </div>
                  {goalErrors[key] && <div className="error-box"><AlertTriangle size={13} /> {goalErrors[key]}</div>}
                </div>
              );
            })}
          </div>

          <div className="divider" />

          <h3>Nutrisi kustom</h3>
          {customGoalRows.length === 0 ? (
            <p className="format-hint" style={{ marginTop: 0 }}>
              Belum ada nutrisi kustom yang diatur. Tambahkan dari nutrisi yang pernah kamu catat,
              atau isi manual di bawah.
            </p>
          ) : (
            <div className="goal-list">
              {customGoalRows.map((row) => {
                const key = row.nutrient_key;
                const draft = goalDraftFor(key);
                const current = effectiveGoals[key];
                const dirty = isGoalDirty(key);
                return (
                  <div className="goal-row" key={key}>
                    <span className="goal-row-name">{current.label}</span>
                    <div className="goal-row-controls">
                      <div className="goal-direction-toggle">
                        <button
                          type="button" className={`goal-direction-btn ${draft.goalType === "min" ? "active" : ""}`}
                          onClick={() => setGoalDraftField(key, "goalType", "min")}
                        >
                          Capai minimal
                        </button>
                        <button
                          type="button" className={`goal-direction-btn ${draft.goalType === "max" ? "active" : ""}`}
                          onClick={() => setGoalDraftField(key, "goalType", "max")}
                        >
                          Jangan lewat batas
                        </button>
                      </div>
                      <input
                        type="number" inputMode="decimal" min="0" step="any" className="goal-value-input"
                        value={draft.targetValue} onChange={(e) => setGoalDraftField(key, "targetValue", e.target.value)}
                      />
                      <span className="goal-unit">{current.unit}</span>
                      {dirty && (
                        <button className="manual-form-save goal-save-btn" onClick={() => saveGoal(key)} disabled={goalSaving[key]}>
                          {goalSaving[key] ? "…" : "Simpan"}
                        </button>
                      )}
                      <ConfirmButton className="goal-remove" title="Hapus nutrisi kustom ini" onConfirm={() => handleDeleteCustomGoal(key, row.id)}>
                        <X size={14} />
                      </ConfirmButton>
                    </div>
                    {goalErrors[key] && <div className="error-box"><AlertTriangle size={13} /> {goalErrors[key]}</div>}
                  </div>
                );
              })}
            </div>
          )}

          <h3>Tambah nutrisi kustom</h3>
          <div className="manual-form">
            <div className="manual-form-row">
              <select
                className="babyname-gender-select" value={customPickSlug}
                onChange={(e) => setCustomPickSlug(e.target.value)}
              >
                <option value={CUSTOM_FREE_TEXT}>Nama manual…</option>
                {unconfiguredKnownExtras.map((e) => (
                  <option key={e.slug} value={e.slug}>{e.label} ({e.unit || "tanpa satuan"})</option>
                ))}
              </select>
            </div>
            {customPickSlug === CUSTOM_FREE_TEXT && (
              <div className="manual-form-row">
                <input
                  type="text" placeholder="Nama nutrisi (mis. Laktosa)"
                  value={customLabel} onChange={(e) => setCustomLabel(e.target.value)}
                />
                <input
                  type="text" placeholder="Satuan (mis. g)"
                  value={customUnit} onChange={(e) => setCustomUnit(e.target.value)}
                />
              </div>
            )}
            <div className="manual-form-row">
              <div className="goal-direction-toggle">
                <button type="button" className={`goal-direction-btn ${customGoalType === "min" ? "active" : ""}`} onClick={() => setCustomGoalType("min")}>
                  Capai minimal
                </button>
                <button type="button" className={`goal-direction-btn ${customGoalType === "max" ? "active" : ""}`} onClick={() => setCustomGoalType("max")}>
                  Jangan lewat batas
                </button>
              </div>
              <input
                type="number" inputMode="decimal" min="0" step="any" placeholder="Target/batas"
                value={customTargetValue} onChange={(e) => setCustomTargetValue(e.target.value)}
              />
            </div>
            {customError && <div className="error-box"><AlertTriangle size={13} /> {customError}</div>}
            <div className="manual-form-actions">
              <button className="manual-form-save" onClick={handleAddCustomGoal} disabled={customSaving}>
                {customSaving ? "Menyimpan…" : "Tambah nutrisi kustom"}
              </button>
            </div>
          </div>
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
            {formError && <div className="error-box"><AlertTriangle size={13} /> {formError}</div>}
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
                {f.key === "favorite" && <Star size={12} />} {f.label}
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
                    <Star size={16} fill={n.is_favorite ? "currentColor" : "none"} />
                  </button>
                  <div className="babyname-info">
                    <div className="babyname-name">
                      {n.name}
                      {g && <span className="gender-pill" style={{ color: g.color, borderColor: g.color }}>{g.label}</span>}
                    </div>
                    {n.note && <div className="babyname-note">{n.note}</div>}
                  </div>
                  <ConfirmButton className="babyname-remove" title="Hapus nama ini" onConfirm={() => handleDelete(n.id)}><X size={15} /></ConfirmButton>
                </div>
              );
            })
          )}
        </div>
      </div>

      <p className="disclaimer">
        Usia kehamilan cuma perkiraan kalender (aturan Naegele: HPHT + 280 hari), bukan pengganti
        perhitungan USG dokter. Daftar calon nama bersifat pribadi dan cuma bisa diakses lewat
        akunmu — cocok buat brainstorming nama bareng pasangan sebelum diputuskan. Target kenaikan
        berat badan mengikuti panduan umum IOM (2009) berdasarkan BMI sebelum hamil, cuma berlaku
        untuk kehamilan satu janin, dan juga bukan anjuran medis personal.
      </p>
    </div>
  );
}
