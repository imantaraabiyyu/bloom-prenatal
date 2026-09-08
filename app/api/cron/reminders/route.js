import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabaseAdmin";
import { sendPush } from "@/lib/pushSender";
import { generateDailyNudge, generateMealFact } from "@/lib/gemini";
import {
  pickMissing, buildReminderBody, buildMorningBody, buildLunchBody, buildNightBody,
  pickFallbackNudge, pickMealFactFallback,
} from "@/lib/reminderLogic";
import { todayISOInTimeZone } from "@/lib/nutrition";
import { computeGestationalAge, trimesterForWeeks } from "@/lib/pregnancy";

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
    return NextResponse.json({ kind, sent: 0, pruned: 0, skipped: 0, subscribers: 0 });
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
  // other 3 slots are unconditional, so skip these two queries entirely for
  // them (no point paying for a scan the content doesn't use).
  let mealUserIds = new Set();
  let vitaminUserIds = new Set();
  if (kind === "dinner") {
    const [{ data: mealRows }, { data: vitaminRows }] = await Promise.all([
      supabase.from("meals").select("user_id").eq("date", today).in("user_id", userIds),
      supabase.from("vitamin_checks").select("user_id").eq("date", today).eq("checked", true).in("user_id", userIds),
    ]);
    mealUserIds = distinctUserIds(mealRows);
    vitaminUserIds = distinctUserIds(vitaminRows);
  }

  let sent = 0, pruned = 0, skipped = 0;

  for (const userId of userIds) {
    const profile = profileByUser.get(userId);
    const name = profile?.name || null;
    const ga = profile?.hpht ? computeGestationalAge(profile.hpht, today) : null;
    const trimester = ga ? trimesterForWeeks(ga.weeks) : null;
    const weeks = ga ? ga.weeks : null;

    let body;
    if (kind === "dinner") {
      const { missingMeal, missingVitamin } = pickMissing(mealUserIds, vitaminUserIds, userId);
      if (!missingMeal && !missingVitamin) { skipped++; continue; } // both already logged -- nothing to nudge about
      let nudge;
      try { nudge = await generateDailyNudge({ trimester, weeks }); }
      catch { nudge = pickFallbackNudge(`${userId}:${today}:dinner`); }
      body = buildReminderBody({ missingMeal, missingVitamin, nudge, name });
    } else if (kind === "morning" || kind === "night") {
      let nudge;
      try { nudge = await generateDailyNudge({ trimester, weeks }); }
      catch { nudge = pickFallbackNudge(`${userId}:${today}:${kind}`); }
      body = kind === "morning" ? buildMorningBody({ name, nudge }) : buildNightBody({ name, nudge });
    } else { // lunch
      let mealFact;
      try { mealFact = await generateMealFact({ trimester, weeks }); }
      catch { mealFact = pickMealFactFallback(`${userId}:${today}:lunch`); }
      body = buildLunchBody({ name, mealFact });
    }

    const payload = { title: TITLES[kind], body, url: "/dashboard" };
    for (const row of subscriptionsByUser.get(userId)) {
      const result = await sendPush(row, payload);
      if (result.ok) {
        sent++;
      } else if (result.isDead) {
        await supabase.from("push_subscriptions").delete().eq("id", row.id);
        pruned++;
      }
      // A non-dead failure (network hiccup, push service outage, ...) is
      // logged by sendPush itself and just moved past -- no same-run retry.
    }
  }

  return NextResponse.json({ kind, sent, pruned, skipped, subscribers: userIds.length });
}
