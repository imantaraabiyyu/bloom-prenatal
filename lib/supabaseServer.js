import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Per-request Supabase client that reads the caller's own session from
// cookies (set by the browser's createBrowserClient in lib/supabaseClient.js
// — @supabase/ssr syncs auth state to cookies precisely so a server route can
// read it back like this). Used only by app/api/nutrition-chat/route.js to
// confirm "is this a logged-in Bloom user?" before spending a Gemini call —
// it never bypasses RLS like a service-role client would, and this route
// doesn't touch the database at all (the client inserts the resulting meal
// itself, same as every other write in this app).
export function getSupabaseServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "Supabase belum dikonfigurasi. Isi NEXT_PUBLIC_SUPABASE_URL dan NEXT_PUBLIC_SUPABASE_ANON_KEY di .env.local (lihat README)."
    );
  }
  const cookieStore = cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      // No-op: this route only reads the session (getUser()) and never
      // refreshes/rotates it, so there's nothing to write back.
      setAll: () => {},
    },
  });
}
