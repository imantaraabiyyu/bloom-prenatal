import "server-only";
import { createClient } from "@supabase/supabase-js";

// The first (and only) service-role Supabase client in this codebase.
// Bypasses RLS entirely — used ONLY by app/api/cron/reminders/route.js,
// which genuinely needs to see across every user's push_subscriptions,
// meals, and vitamin_checks to decide who to remind. Every other read/write
// in this app goes through lib/supabaseClient.js (browser, anon key) or
// lib/supabaseServer.js (cookie-session, anon key) and stays RLS-scoped to
// the calling user — never import this file from a client component or
// return anything derived from it directly in a client-facing response.
export function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY belum diisi di .env.local / Vercel (lihat README) -- ambil dari " +
      "Supabase dashboard -> Project Settings -> API -> service_role secret."
    );
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
