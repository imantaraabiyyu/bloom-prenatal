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

### 2. Buat tabel database + storage bucket jurnal

1. Di dashboard Supabase, buka **SQL Editor** (ikon di sidebar kiri) → **New query**.
2. Copy-paste seluruh isi file `supabase/schema.sql` yang ada di folder ini.
3. Klik **Run**. Ini akan membuat 6 tabel (`profiles`, `meals`, `vitamins`,
   `vitamin_checks`, `journal_entries`, `journal_attachments`) lengkap dengan
   Row Level Security — jadi tiap pengguna hanya bisa lihat & ubah datanya
   sendiri — **dan** sebuah Storage bucket privat `journal-media` (untuk
   foto/video/voice note di jurnal) dengan batas 45MB per file dan RLS yang
   sama (per-pemilik). Aman dijalankan ulang kalau nanti ada update skema —
   tabel & bucket yang sudah ada tidak akan tertimpa/hilang datanya.

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

## 5. (Opsional) Aktifkan chat gizi AI

Fitur ini membuka tab **Chat** di dashboard — kirim foto makanan/minuman lewat
chat di dalam app, AI (Gemini, gratis) menganalisis kandungan gizinya dan
membalas dengan insight singkat, lalu otomatis menyimpannya ke menu hari ini.
Semua terjadi di dalam app pakai akun yang sudah login — tidak perlu nomor
WhatsApp, akun Meta, atau setup tambahan apa pun selain langkah di bawah.

1. Buat API key gratis di https://aistudio.google.com/apikey → **Create API
   key**. Tidak perlu kartu kredit untuk tier gratisnya.
2. Tambahkan ke `.env.local` (lokal) **dan** Vercel → Project Settings →
   Environment Variables (produksi):
   ```
   GEMINI_API_KEY=...               # dari langkah 1
   GEMINI_MODEL=gemini-2.0-flash    # opsional, ini nilai defaultnya
   ```
3. Kalau belum, jalankan ulang `supabase/schema.sql` (lihat langkah 2 di atas)
   — aman dijalankan ulang, tidak menghapus data yang sudah ada.

Tanpa `GEMINI_API_KEY` diisi, tab Chat tetap muncul tapi analisis fotonya akan
gagal dengan pesan error yang jelas — fitur lain di Bloom tidak terpengaruh.

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
  page.js               → redirect ke /dashboard atau /login
  login/page.js          → form login & daftar (Supabase Auth)
  dashboard/page.js       → dashboard utama (rings, checklist vitamin, tren, riwayat)
  dashboard/journal/page.js → jurnal harian (catatan + mood + foto/video/voice note)
  dashboard/chat/page.js  → chat gizi AI (kirim foto makanan, dapat analisis + insight)
  api/nutrition-chat/route.js → satu-satunya route backend: proxy terautentikasi ke
                                 Gemini API buat analisis foto (tidak menyentuh database —
                                 client yang menyimpan hasilnya ke `meals` sendiri)
  globals.css             → tema visual (dark plum)
lib/
  supabaseClient.js      → koneksi ke Supabase dari browser (anon key)
  supabaseServer.js      → koneksi ke Supabase dari server, baca sesi login dari cookie
                            (bukan service role — cuma buat mengecek "siapa yang chat")
  nutrition.js           → target gizi per trimester, parser CSV, dll
  journal.js             → daftar mood + konstanta lampiran jurnal (limit ukuran/jumlah file)
  gemini.js              → pemanggil Gemini API untuk analisis gizi dari foto makanan
supabase/
  schema.sql              → skema tabel + storage bucket + Row Level Security
```

## Catatan

- Target gizi adalah panduan umum per trimester, bukan anjuran medis personal.
- Nilai gizi contoh untuk Folamil Genio & Cavit D3 diambil dari label umum
  produk — sesuaikan dengan kemasan asli/anjuran dokter kamu lewat panel
  upload CSV vitamin di dashboard.
- Kalau vitamin/suplemenmu punya kandungan yang tidak ada di daftar gizi utama
  (mis. Zinc, Vitamin B6, Iodium), tambahkan lewat "+ Tambah nutrisi lain" di
  form manual vitamin. Nutrisi ini ditampilkan sebagai catatan harian (jumlah
  dari semua vitamin yang dicentang hari itu) tanpa target/ring — belum ada
  patokan AKG bawaan untuk nutrisi bebas seperti ini. Belum didukung lewat
  upload CSV, cuma lewat form manual.
- Data sekarang tersimpan di Supabase (Postgres) dengan Row Level Security,
  jauh lebih aman daripada versi localStorage sebelumnya — tapi tetap bukan
  aplikasi medis resmi, hanya alat bantu pencatatan pribadi.
- Jurnal (`journal_entries` + `journal_attachments`) mendukung foto, video,
  dan voice note (rekam langsung dari mic browser). Filenya disimpan di
  Storage bucket privat `journal-media` — cuma bisa diakses lewat signed URL
  milik pemiliknya sendiri, bukan tautan publik. Batasnya (ditegakkan di
  server, bukan cuma di browser): maks 45MB per file, maks 10 lampiran per
  catatan, rekaman voice note otomatis berhenti di 10 menit. Free tier
  Supabase Storage sendiri: 1GB total storage, 5GB bandwidth/bulan — video
  paling cepat menghabiskan kuota, jadi pantau pemakaiannya kalau sering
  upload video.
- Chat gizi AI (opsional, lihat bagian 5 di atas) memakai Gemini untuk menebak
  kandungan gizi dari foto — hasilnya estimasi, bukan pengukuran lab, dan menu
  hasil tebakan tetap bisa diedit/dihapus manual dari dashboard kalau meleset.
  Fotonya tidak disimpan di Bloom, cuma dikirim ke Gemini untuk dianalisis lalu
  dibuang. Tier gratis Gemini punya batas rate limit harian; untuk pemakaian
  pribadi/keluarga biasanya jauh dari batas tersebut.
