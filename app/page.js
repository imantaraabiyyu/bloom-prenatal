"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseClient } from "@/lib/supabaseClient";

export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (e) {
      // Supabase not configured yet — send to login, which shows setup help.
      router.replace("/login");
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      router.replace(data.session ? "/dashboard" : "/login");
      setChecking(false);
    });
  }, [router]);

  return <div className="center-loading">{checking ? "Memuat…" : null}</div>;
}
