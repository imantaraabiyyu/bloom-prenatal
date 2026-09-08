import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

// Authenticated CRUD for the caller's own push_subscriptions row(s) — same
// cookie-session auth pattern as app/api/nutrition-chat/route.js and
// app/api/journal/transcribe/route.js. No service-role client needed here:
// a user writing/deleting their own subscription is exactly what RLS is
// already scoped to allow (see supabase/schema.sql's "push_subscriptions:
// owner *" policies).

export async function POST(request) {
  const supabase = getSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Kamu perlu login dulu." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid." }, { status: 400 });
  }

  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const authKey = body?.keys?.auth;
  if (!endpoint || !p256dh || !authKey) {
    return NextResponse.json({ error: "Data langganan push tidak lengkap." }, { status: 400 });
  }

  // Upsert on endpoint (unique) rather than checking existence first --
  // simplest correct handling of "same device resubscribes" without an
  // extra round-trip.
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      { user_id: user.id, endpoint, p256dh, auth_key: authKey },
      { onConflict: "endpoint" }
    );
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request) {
  const supabase = getSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Kamu perlu login dulu." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body request tidak valid." }, { status: 400 });
  }

  const endpoint = body?.endpoint;
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint wajib diisi." }, { status: 400 });
  }

  // `.eq("user_id", user.id)` is redundant with RLS (a user can't delete
  // someone else's row regardless), kept explicit so the query's intent is
  // readable without having to cross-reference the RLS policy.
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", user.id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
