-- Bloom — skema database Supabase (Postgres)
-- Jalankan file ini di Supabase Dashboard → SQL Editor → New query → Run.

-- 1) Profil (menyimpan trimester per pengguna)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trimester text not null default 't2' check (trimester in ('t1','t2','t3')),
  created_at timestamptz not null default now()
);

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

-- 5) Jurnal harian (catatan bebas + mood, teks saja — tanpa lampiran media)
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

-- ================= ROW LEVEL SECURITY =================
-- Setiap tabel hanya bisa diakses oleh pemiliknya (auth.uid() = user_id).

alter table public.profiles enable row level security;
alter table public.meals enable row level security;
alter table public.vitamins enable row level security;
alter table public.vitamin_checks enable row level security;
alter table public.journal_entries enable row level security;

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
