# Bloom — Pelacak Gizi Kehamilan (Next.js + Supabase)

Versi ini pakai **login/register beneran** (Supabase Auth) dan **database Postgres**
(Supabase) — jadi datamu tersinkron di semua perangkat, bukan cuma tersimpan di
satu browser seperti versi statis sebelumnya. Tetap gratis untuk pemakaian
pribadi/keluarga, dan tetap di-deploy ke Vercel.

## Yang perlu disiapkan sebelum deploy

### 1. Buat project Supabase (gratis)
1. Buka https://supabase.com → **Start your project** → daftar/masuk (bisa pakai GitHub).
2. Klik **New project**, kasih nama bebas (mis. `bloom`), pilih region terdekat
   (mis. Singapore), buat password database (simpan baik-baik, jarang dipakai manual).
3. Tunggu ~1-2 menit sampai project siap.

### 2. Buat tabel database
1. Di dashboard Supabase, buka **SQL Editor** (ikon di sidebar kiri) → **New query**.
2. Copy-paste seluruh isi file `supabase/schema.sql` yang ada di folder ini.
3. Klik **Run**. Ini akan membuat 4 tabel (`profiles`, `meals`, `vitamins`,
   `vitamin_checks`) lengkap dengan Row Level Security — jadi tiap pengguna
   hanya bisa lihat & ubah datanya sendiri.

### 3. Ambil API key
1. Di dashboard Supabase, buka **Project Settings → API**.
2. Catat dua nilai ini:
   - **Project URL** (mis. `https://xxxxxxxxxxxx.supabase.co`)
   - **anon public key** (kunci panjang di bagian "Project API keys")

### 4. (Opsional tapi disarankan) Matikan konfirmasi email
Supaya proses daftar akun langsung bisa dipakai tanpa perlu klik link di email:
1. **Authentication → Providers → Email**.
2. Matikan **"Confirm email"**.
(Kalau dibiarkan aktif, setelah daftar pengguna harus klik link konfirmasi di
inbox emailnya dulu sebelum bisa login — juga valid, cuma satu langkah ekstra.)

## Coba di komputer sendiri dulu (opsional)

```
npm install
cp .env.local.example .env.local
# lalu edit .env.local, isi dua nilai dari langkah 3 di atas
npm run dev
```
Buka `http://localhost:3000`.

## Deploy ke Vercel (gratis)

**Lewat GitHub (disarankan):**
1. Push seluruh folder ini ke repo GitHub baru.
2. Buka https://vercel.com → **Add New → Project → Import Git Repository** → pilih repo ini.
3. Sebelum klik Deploy, buka bagian **Environment Variables**, tambahkan:
   - `NEXT_PUBLIC_SUPABASE_URL` = Project URL dari langkah 3
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = anon public key dari langkah 3
4. Klik **Deploy**. Vercel otomatis mendeteksi ini project Next.js, tidak perlu
   pengaturan build tambahan.
5. Setelah live, kalau nanti ganti kode → `git push` → otomatis re-deploy.

**Lewat CLI:**
```
npm install -g vercel
cd bloom-supabase
vercel
# saat ditanya environment variables, isi NEXT_PUBLIC_SUPABASE_URL dan
# NEXT_PUBLIC_SUPABASE_ANON_KEY, atau tambahkan lewat dashboard Vercel
# setelahnya (Project Settings → Environment Variables) lalu `vercel --prod`
```

## Struktur project

```
app/
  page.js            → redirect ke /dashboard atau /login
  login/page.js       → form login & daftar (Supabase Auth)
  dashboard/page.js    → dashboard utama (rings, checklist vitamin, tren, riwayat)
  globals.css          → tema visual (dark plum)
lib/
  supabaseClient.js    → koneksi ke Supabase
  nutrition.js         → target gizi per trimester, parser CSV, dll
supabase/
  schema.sql           → skema tabel + Row Level Security
```

## Catatan

- Target gizi adalah panduan umum per trimester, bukan anjuran medis personal.
- Nilai gizi contoh untuk Folamil Genio & Cavit D3 diambil dari label umum
  produk — sesuaikan dengan kemasan asli/anjuran dokter kamu lewat panel
  upload CSV vitamin di dashboard.
- Data sekarang tersimpan di Supabase (Postgres) dengan Row Level Security,
  jauh lebih aman daripada versi localStorage sebelumnya — tapi tetap bukan
  aplikasi medis resmi, hanya alat bantu pencatatan pribadi.
