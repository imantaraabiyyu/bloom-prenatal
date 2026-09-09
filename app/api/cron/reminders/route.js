import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";
import { sendPush } from "@/lib/pushSender";
import { sendReminderEmail } from "@/lib/emailSender";
import { generateDailyNudge, generateMealFact } from "@/lib/gemini";
import {
  pickMissing, buildReminderBody, buildMorningBody, buildLunchBody, buildNightBody,
  pickFallbackNudge, pickMealFactFallback, sumReminderResults, buildLimitWarningClause,
  WEIGHT_NUDGE_TEXT,
} from "@/lib/reminderLogic";
import { todayISOInTimeZone, LIMIT_ORDER, groupLimitTotalsByUser, mergeUserTotals, exceededLimitLabels } from "@/lib/nutrition";
import { computeGestationalAge, trimesterForWeeks, addDays } from "@/lib/pregnancy";

// How far back the morning slot's "belum timbang" check looks -- 7 days
// inclusive of today (addDays(today, -6) through today), so a user who
// weighs in roughly weekly never gets nudged, regardless of which day of
// the week they happen to log on.
const WEIGHT_NUDGE_WINDOW_DAYS = 6;

// The one scheduled sender behind all 4 daily slots (see vercel.json):
//   07:00 WIB morning (unconditional), 12:00 WIB lunch (unconditional),
//   19:00 WIB dinner (only if meal and/or vitamin isn't logged yet today),
//   21:30 WIB night (unconditional).
// One shared route dispatched by `?kind=` instead of 4 near-duplicate files
// -- only "what content does this slot send" differs; fetching
// subscriptions/profiles and the send+prune loop are identical across kinds.
export const runtime = "nodejs";
export const maxDuration = 60;

const KINDS = new Set(["morning", "lunch", "dinner", "night"]);
const TITLES = { morning: "☀️ Bloom", lunch: "🍽️ Bloom", dinner: "💊 Bloom", night: "🌙 Bloom" };
const TZ = "Asia/Jakarta";

// Distinct user_ids from an array of rows -- Supabase JS has no
// "select distinct", and at this app's personal/family scale, deduping the
// returned rows in JS is simpler than a raw SQL RPC for the same result.
function distinctUserIds(rows) {
  return new Set((rows || []).map((r) => r.user_id));
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const kind = new URL(request.url).searchParams.get("kind");
  if (!KINDS.has(kind)) {
    return NextResponse.json({ error: `kind wajib salah satu dari: ${[...KINDS].join(", ")}` }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  const today = todayISOInTimeZone(TZ);

  const { data: subscriptionRows, error: subError } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth_key");
  if (subError) return NextResponse.json({ error: subError.message }, { status: 500 });
  if (!subscriptionRows || subscriptionRows.length === 0) {
    // Vercel Runtime Logs don't capture response bodies, only console
    // output -- without this, a "no subscriptions at all" run (e.g. every
    // subscription got pruned as dead, see the isDead branch below) looks
    // identical to a healthy send in the dashboard: just a 200.
    console.log(`cron/reminders kind=${kind} sent=0 pruned=0 skipped=0 emailed=0 subscribers=0`);
    return NextResponse.json({ kind, sent: 0, pruned: 0, skipped: 0, emailed: 0, subscribers: 0 });
  }

  const userIds = [...distinctUserIds(subscriptionRows)];
  const subscriptionsByUser = new Map();
  subscriptionRows.forEach((row) => {
    if (!subscriptionsByUser.has(row.user_id)) subscriptionsByUser.set(row.user_id, []);
    subscriptionsByUser.get(row.user_id).push(row);
  });

  const { data: profileRows } = await supabase
    .from("profiles")
    .select("user_id, hpht, name")
    .in("user_id", userIds);
  const profileByUser = new Map((profileRows || []).map((p) => [p.user_id, p]));

  // Only the dinner slot needs to know who's already logged today -- the
  // other 3 slots are unconditional, so skip these queries entirely for them
  // (no point paying for a scan the content doesn't use).
  let mealUserIds = new Set();
  let vitaminUserIds = new Set();
  // Per-user sugar/sodium/etc. totals for today, `{ [userId]: { [limitKey]: number } }`
  // -- lets the dinner slot warn independently of the missing-meal/vitamin
  // check below (a user who logged everything can still be over a limit).
  let limitTotalsByUser = {};
  if (kind === "dinner") {
    const limitCols = LIMIT_ORDER.join(",");
    const [{ data: mealRows }, { data: vitaminCheckRows }] = await Promise.all([
      supabase.from("meals").select(`user_id, ${limitCols}`).eq("date", today).in("user_id", userIds),
      supabase.from("vitamin_checks").select("user_id, vitamin_id").eq("date", today).eq("checked", true).in("user_id", userIds),
    ]);
    mealUserIds = distinctUserIds(mealRows);
    vitaminUserIds = distinctUserIds(vitaminCheckRows);

    // vitamin_checks only names which vitamin_id was checked -- need each of
    // those vitamins' own limit-column values to actually sum anything.
    const checkedVitaminIds = [...new Set((vitaminCheckRows || []).map((c) => c.vitamin_id))];
    let vitaminRows = [];
    if (checkedVitaminIds.length > 0) {
      const { data } = await supabase.from("vitamins").select(`id, ${limitCols}`).in("id", checkedVitaminIds);
      vitaminRows = data || [];
    }
    const vitaminById = new Map(vitaminRows.map((v) => [v.id, v]));
    // Re-attach each check row's own user_id to its vitamin's limit columns
    // (one vitamins row, looked up per check, since the same catalog vitamin
    // could in principle be checked by more than one check row).
    const vitaminRowsWithUser = (vitaminCheckRows || [])
      .map((c) => {
        const v = vitaminById.get(c.vitamin_id);
        return v ? { ...v, user_id: c.user_id } : null;
      })
      .filter(Boolean);

    limitTotalsByUser = mergeUserTotals(groupLimitTotalsByUser(mealRows || []), groupLimitTotalsByUser(vitaminRowsWithUser));
  }

  // Only the morning slot carries the weekly "belum timbang" nudge -- same
  // "only query what a slot's content needs" discipline as the dinner-only
  // block above, so the other 3 slots pay nothing extra.
  let weighedUserIds = new Set();
  if (kind === "morning") {
    const { data: weightRows } = await supabase
      .from("weight_logs")
      .select("user_id")
      .gte("date", addDays(today, -WEIGHT_NUDGE_WINDOW_DAYS))
      .in("user_id", userIds);
    weighedUserIds = distinctUserIds(weightRows);
  }

  // Every user is independent (own Gemini call, own subscriptions to push
  // to), so they're processed concurrently rather than summed one-by-one --
  // total wall-clock becomes roughly "slowest single user" instead of "every
  // user's time added together", which is what let this route blow past
  // Vercel's 60s function timeout as the subscriber count grew. Each task
  // returns its own { sent, pruned, skipped } instead of mutating a shared
  // counter, and sumReminderResults (lib/reminderLogic.js) adds them up once
  // every task has settled.
  const userResults = await Promise.all(userIds.map(async (userId) => {
    const profile = profileByUser.get(userId);
    const name = profile?.name || null;
    const ga = profile?.hpht ? computeGestationalAge(profile.hpht, today) : null;
    const trimester = ga ? trimesterForWeeks(ga.weeks) : null;
    const weeks = ga ? ga.weeks : null;

    let body;
    if (kind === "dinner") {
      const { missingMeal, missingVitamin } = pickMissing(mealUserIds, vitaminUserIds, userId);
      const exceededLabels = exceededLimitLabels(limitTotalsByUser[userId] || {});
      // Both already logged AND no daily limit exceeded -- nothing to nudge
      // about. A user who logged everything but went over a limit still
      // gets a heads-up (the `exceededLabels.length === 0` clause is new).
      if (!missingMeal && !missingVitamin && exceededLabels.length === 0) return { sent: 0, pruned: 0, skipped: 1 };
      let nudge;
      try { nudge = await generateDailyNudge({ trimester, weeks }); }
      catch { nudge = pickFallbackNudge(`${userId}:${today}:dinner`); }
      body = buildReminderBody({ missingMeal, missingVitamin, nudge, name, limitWarning: buildLimitWarningClause(exceededLabels) });
    } else if (kind === "morning" || kind === "night") {
      let nudge;
      try { nudge = await generateDailyNudge({ trimester, weeks }); }
      catch { nudge = pickFallbackNudge(`${userId}:${today}:${kind}`); }
      body = kind === "morning"
        ? buildMorningBody({ name, nudge, weightNudge: weighedUserIds.has(userId) ? "" : WEIGHT_NUDGE_TEXT })
        : buildNightBody({ name, nudge });
    } else { // lunch
      let mealFact;
      try { mealFact = await generateMealFact({ trimester, weeks }); }
      catch { mealFact = pickMealFactFallback(`${userId}:${today}:lunch`); }
      body = buildLunchBody({ name, mealFact });
    }

    const payload = { title: TITLES[kind], body, url: "/dashboard" };
    // Same reasoning one level down: this user's own devices/subscriptions
    // are independent sends, so they go out concurrently too instead of
    // one-by-one.
    const subResults = await Promise.all(subscriptionsByUser.get(userId).map(async (row) => {
      const result = await sendPush(row, payload);
      if (result.ok) return { sent: 1, pruned: 0 };
      if (result.isDead) {
        await supabase.from("push_subscriptions").delete().eq("id", row.id);
        return { sent: 0, pruned: 1 };
      }
      // A non-dead failure (network hiccup, push service outage, ...) is
      // logged by sendPush itself and just moved past -- no same-run retry.
      return { sent: 0, pruned: 0 };
    }));

    const sentCount = subResults.reduce((n, r) => n + r.sent, 0);
    const prunedCount = subResults.reduce((n, r) => n + r.pruned, 0);

    // Last-resort fallback: every subscription this user had failed this
    // run (whether just pruned as dead above, or a transient failure
    // sendPush already logged) -- try email instead of leaving them with
    // nothing. subscriptionsByUser.get(userId) is never empty here (userIds
    // only contains users who had >=1 subscription row to begin with), so
    // this only fires on a genuine "push attempted, none of it landed" --
    // never for the dinner slot's early-return skip above, which never
    // reaches this point at all.
    let emailedCount = 0;
    if (sentCount === 0) {
      const { data: authUser } = await supabase.auth.admin.getUserById(userId);
      const email = authUser?.user?.email;
      if (email && await sendReminderEmail(email, TITLES[kind], body)) emailedCount = 1;
    }

    return { sent: sentCount, pruned: prunedCount, skipped: 0, emailed: emailedCount };
  }));

  const { sent, pruned, skipped, emailed } = sumReminderResults(userResults);

  // Same reasoning as the early-return above -- this is the only place the
  // real per-run outcome (did anything actually get pushed, or did every
  // subscription silently fail/get pruned, and did the email fallback catch
  // it) is visible anywhere, since it otherwise only exists in the response
  // body Vercel Logs doesn't show.
  console.log(`cron/reminders kind=${kind} sent=${sent} pruned=${pruned} skipped=${skipped} emailed=${emailed} subscribers=${userIds.length}`);
  return NextResponse.json({ kind, sent, pruned, skipped, emailed, subscribers: userIds.length });
}
