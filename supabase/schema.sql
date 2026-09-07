-- Bloom — skema database Supabase (Postgres)
-- Jalankan file ini di Supabase Dashboard → SQL Editor → New query → Run.

-- ================= CLEANUP: bekas fitur agen WhatsApp =================
-- Fitur logging gizi lewat WhatsApp sempat ada di versi sebelumnya, lalu
-- diganti dengan chat AI langsung di dalam app (tidak perlu Meta/nomor
-- WhatsApp lagi). Blok ini membersihkan sisa tabel/kolomnya kalau kamu sempat
-- menjalankan versi schema yang lama — aman dijalankan juga kalau belum
-- pernah ada (semua "if exists").
drop table if exists public.whatsapp_link_codes;
drop table if exists public.whatsapp_messages;
alter table if exists public.profiles drop column if exists phone_number;
alter table if exists public.profiles drop column if exists phone_verified_at;

-- 1) Profil (menyimpan trimester per pengguna)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trimester text not null default 't2' check (trimester in ('t1','t2','t3')),
  created_at timestamptz not null default now()
);
-- HPHT (Hari Pertama Haid Terakhir) — satu-satunya tanggal yang disimpan;
-- usia kehamilan, HPL (perkiraan lahir), dan progress-nya semua dihitung dari
-- ini di lib/pregnancy.js, tidak disimpan terpisah (sama seperti target/status
-- gizi yang selalu dihitung, bukan disimpan).
alter table public.profiles add column if not exists hpht date;

-- 2) Menu makan (riwayat harian)
create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date date not null,
  meal text,
  calories numeric default 0,
  protein_g numeric default 0,
  iron_mg numeric default 0,
  calcium_mg numeric default 0,
  folate_mcg numeric default 0,
  vitamin_d_mcg numeric default 0,
  fiber_g numeric default 0,
  water_ml numeric default 0,
  created_at timestamptz not null default now()
);
create index if not exists meals_user_date_idx on public.meals (user_id, date);
-- Menandai menu yang tercatat otomatis lewat foto di Chat (vs. diisi manual
-- di dashboard) supaya bisa ditampilkan beda di riwayat. Constraint di-drop +
-- dibuat ulang terpisah (bukan inline di ADD COLUMN) supaya kalau kolom ini
-- sudah ada dari versi lama (waktu nilainya masih 'whatsapp'), constraint-nya
-- ikut ter-update ke nilai yang sekarang valid.
alter table public.meals add column if not exists source text not null default 'manual';
alter table public.meals drop constraint if exists meals_source_check;
alter table public.meals add constraint meals_source_check check (source in ('manual','chat'));
-- DHA & vitamin K — nutrisi tambahan yang dilacak (lihat NUTRIENT_ORDER di lib/nutrition.js).
alter table public.meals add column if not exists dha_mg numeric default 0;
alter table public.meals add column if not exists vitamin_k_mcg numeric default 0;

-- 3) Katalog vitamin/suplemen milik pengguna
create table if not exists public.vitamins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  calories numeric default 0,
  protein_g numeric default 0,
  iron_mg numeric default 0,
  calcium_mg numeric default 0,
  folate_mcg numeric default 0,
  vitamin_d_mcg numeric default 0,
  fiber_g numeric default 0,
  water_ml numeric default 0,
  created_at timestamptz not null default now()
);
alter table public.vitamins add column if not exists dha_mg numeric default 0;
alter table public.vitamins add column if not exists vitamin_k_mcg numeric default 0;
-- Free-form nutrients not in the fixed list above (mis. Zinc, Vitamin B6,
-- Iodium) — { [slug]: { label, unit, value } }, ditambahkan lewat form manual
-- di dashboard (lihat lib/nutrition.js -> slugifyNutrientLabel/mergeExtraNutrients).
alter table public.vitamins add column if not exists extra_nutrients jsonb not null default '{}'::jsonb;

-- 4) Checklist vitamin per tanggal
create table if not exists public.vitamin_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date date not null,
  vitamin_id uuid not null references public.vitamins(id) on delete cascade,
  checked boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (user_id, date, vitamin_id)
);
create index if not exists vitamin_checks_user_date_idx on public.vitamin_checks (user_id, date);

-- 5) Jurnal harian (catatan bebas + mood)
create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  entry_date date not null default current_date,
  mood text,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists journal_entries_user_date_idx on public.journal_entries (user_id, entry_date);

-- 6) Lampiran jurnal (foto/video/voice note — banyak per entry)
-- File aslinya disimpan di Storage bucket "journal-media" (dibuat di bawah);
-- baris ini cuma menyimpan path + metadata-nya.
create table if not exists public.journal_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  entry_id uuid not null references public.journal_entries(id) on delete cascade,
  kind text not null check (kind in ('photo','video','voice')),
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists journal_attachments_entry_idx on public.journal_attachments (entry_id);

-- 7) Daftar calon nama bayi
create table if not exists public.baby_names (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  gender text check (gender in ('boy','girl','unisex')),
  note text,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists baby_names_user_idx on public.baby_names (user_id);

-- 8) Riwayat chat gizi AI (lihat app/dashboard/chat/page.js)
-- Fotonya sendiri TIDAK disimpan di sini (cuma dikirim ke Gemini lalu
-- dibuang) — cuma teks + hasil analisisnya, supaya histori chat tetap ada
-- tanpa menyimpan foto makanan penggunanya. `saved_meal_id` menautkan ke
-- baris `meals` kalau hasil analisis itu sudah disimpan pengguna ke dashboard
-- (lewat tombol "Simpan ke Dashboard") — null berarti belum/sudah dibatalkan.
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  role text not null check (role in ('user','assistant')),
  text text,
  had_image boolean not null default false,
  analysis jsonb,
  saved_meal_id uuid references public.meals(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_created_idx on public.chat_messages (user_id, created_at);

-- ================= STORAGE (foto/video/voice note jurnal) =================
-- Bucket privat — file cuma bisa diakses lewat signed URL yang dibuat oleh
-- pemiliknya sendiri, bukan URL publik. Path filenya WAJIB berbentuk
-- "{user_id}/{entry_id}/{nama file}" karena RLS di bawah mengecek folder
-- pertama = auth.uid() pengunggah (lihat lib/journal.js -> attachmentPath).
--
-- file_size_limit & allowed_mime_types ditegakkan oleh Supabase Storage API
-- sendiri (bukan cuma validasi di browser) — jadi permintaan upload yang
-- lebih besar dari 45MB atau bukan foto/video/audio akan ditolak duluan
-- sebelum sempat tersimpan. Angka 47185920 = 45 * 1024 * 1024 bytes, harus
-- sinkron dengan MAX_ATTACHMENT_MB di lib/journal.js kalau diubah.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('journal-media', 'journal-media', false, 47185920, array['image/*', 'video/*', 'audio/*'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "journal-media: owner select" on storage.objects for select
  using (bucket_id = 'journal-media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "journal-media: owner insert" on storage.objects for insert
  with check (bucket_id = 'journal-media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "journal-media: owner delete" on storage.objects for delete
  using (bucket_id = 'journal-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- ================= ROW LEVEL SECURITY =================
-- Setiap tabel hanya bisa diakses oleh pemiliknya (auth.uid() = user_id).

alter table public.profiles enable row level security;
alter table public.meals enable row level security;
alter table public.vitamins enable row level security;
alter table public.vitamin_checks enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_attachments enable row level security;
alter table public.baby_names enable row level security;
alter table public.chat_messages enable row level security;

create policy "profiles: owner select" on public.profiles for select using (auth.uid() = user_id);
create policy "profiles: owner insert" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles: owner update" on public.profiles for update using (auth.uid() = user_id);

create policy "meals: owner select" on public.meals for select using (auth.uid() = user_id);
create policy "meals: owner insert" on public.meals for insert with check (auth.uid() = user_id);
create policy "meals: owner update" on public.meals for update using (auth.uid() = user_id);
create policy "meals: owner delete" on public.meals for delete using (auth.uid() = user_id);

create policy "vitamins: owner select" on public.vitamins for select using (auth.uid() = user_id);
create policy "vitamins: owner insert" on public.vitamins for insert with check (auth.uid() = user_id);
create policy "vitamins: owner update" on public.vitamins for update using (auth.uid() = user_id);
create policy "vitamins: owner delete" on public.vitamins for delete using (auth.uid() = user_id);

create policy "vitamin_checks: owner select" on public.vitamin_checks for select using (auth.uid() = user_id);
create policy "vitamin_checks: owner insert" on public.vitamin_checks for insert with check (auth.uid() = user_id);
create policy "vitamin_checks: owner update" on public.vitamin_checks for update using (auth.uid() = user_id);
create policy "vitamin_checks: owner delete" on public.vitamin_checks for delete using (auth.uid() = user_id);

create policy "journal_entries: owner select" on public.journal_entries for select using (auth.uid() = user_id);
create policy "journal_entries: owner insert" on public.journal_entries for insert with check (auth.uid() = user_id);
create policy "journal_entries: owner update" on public.journal_entries for update using (auth.uid() = user_id);
create policy "journal_entries: owner delete" on public.journal_entries for delete using (auth.uid() = user_id);

create policy "journal_attachments: owner select" on public.journal_attachments for select using (auth.uid() = user_id);
create policy "journal_attachments: owner insert" on public.journal_attachments for insert with check (auth.uid() = user_id);
create policy "journal_attachments: owner delete" on public.journal_attachments for delete using (auth.uid() = user_id);

create policy "baby_names: owner select" on public.baby_names for select using (auth.uid() = user_id);
create policy "baby_names: owner insert" on public.baby_names for insert with check (auth.uid() = user_id);
create policy "baby_names: owner update" on public.baby_names for update using (auth.uid() = user_id);
create policy "baby_names: owner delete" on public.baby_names for delete using (auth.uid() = user_id);

create policy "chat_messages: owner select" on public.chat_messages for select using (auth.uid() = user_id);
create policy "chat_messages: owner insert" on public.chat_messages for insert with check (auth.uid() = user_id);
create policy "chat_messages: owner update" on public.chat_messages for update using (auth.uid() = user_id);
create policy "chat_messages: owner delete" on public.chat_messages for delete using (auth.uid() = user_id);
