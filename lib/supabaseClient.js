"use client";
import { createBrowserClient } from "@supabase/ssr";

let client;

// Returns a singleton Supabase browser client. Reads the project URL and
// anon (public) key from environment variables set in Vercel / .env.local.
export function getSupabaseClient() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase belum dikonfigurasi. Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY di .env.local (lihat README)."
    );
  }
  client = createBrowserClient(url, anonKey);
  return client;
}
