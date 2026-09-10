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
3. Klik **Run**. Ini akan membuat tabel-tabel (`profiles`, `meals`, `vitamins`,
   `vitamin_checks`, `journal_entries`, `journal_attachments`, `baby_names`,
   `chat_messages`, `weight_logs`) lengkap dengan Row Level Security — jadi tiap pengguna
   hanya bisa lihat & ubah datanya sendiri — **dan** sebuah Storage bucket
   privat `journal-media` (untuk foto/video/voice note di jurnal) dengan batas
   45MB per file dan RLS yang sama (per-pemilik). Aman dijalankan ulang kalau
   nanti ada update skema — tabel & bucket yang sudah ada tidak akan
   tertimpa/hilang datanya.

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

## 5. (Opsional) Aktifkan fitur AI (chat gizi + transkrip voice note)

Satu API key Gemini yang sama menghidupkan dua fitur:

- Tab **Chat** di dashboard — obrolan biasa dengan AI soal kehamilan & gizi.
  Kalau kamu cerita atau kirim foto makanan/minuman yang kamu makan, Bloom
  mengenalinya sebagai permintaan mencatat: dianalisis kandungan gizinya,
  dibalas dengan insight singkat, dan kamu tinggal klik "Simpan ke Dashboard"
  untuk memasukkannya ke menu hari ini (tidak otomatis tersimpan).
- Tombol "📝 Transkrip & rapikan jadi jurnal" di **Jurnal**, muncul di setiap
  voice note yang baru direkam (sebelum catatannya disimpan) — menghasilkan
  transkrip apa adanya plus draf jurnal yang sudah dirapikan, tinggal klik
  "Gunakan sebagai catatan" untuk menempelkannya ke kolom catatan.

Semua terjadi di dalam app pakai akun yang sudah login — tidak perlu nomor
WhatsApp, akun Meta, atau setup tambahan apa pun selain langkah di bawah.

1. Buat API key gratis di https://aistudio.google.com/apikey → **Create API
   key**. Tidak perlu kartu kredit untuk tier gratisnya.
2. Tambahkan ke `.env.local` (lokal) **dan** Vercel → Project Settings →
   Environment Variables (produksi):
   ```
   GEMINI_API_KEY=...                       # dari langkah 1
   GEMINI_API_KEY_FALLBACKS=                 # opsional, daftar API key cadangan dipisah koma —
                                             # dicoba urut (per model, bukan per tier — lihat di
                                             # bawah) kalau key di atas gagal/habis kuotanya.
                                             # Bikin lagi API key gratis lain di link yang sama
                                             # kalau mau isi ini.

   # Ada 2 "tier" model, masing-masing opsional (nilai di bawah ini defaultnya):
   # - tier "chat" dipakai tab Chat + transkrip Jurnal (butuh baca foto/audio,
   #   jadi selalu model paling mumpuni)
   # - tier "low" dipakai notifikasi cron (generate kalimat/fakta tambahan,
   #   teks doang, jadi model termurah/tercepat cukup)
   GEMINI_CHAT_MODEL=gemini-2.5-pro          # tier "chat"
   GEMINI_CHAT_FALLBACK_MODELS=              # opsional, daftar model cadangan tier "chat"
                                             # dipisah koma, dicoba urut kalau yang di atas gagal
                                             # (kena limit kuota/429, atau model-nya sudah dipensiunkan
                                             # Google/404, atau error lain) — mis. gemini-3.1-pro-preview
   GEMINI_MODEL=gemini-3.5-flash-lite        # tier "low" — PERHATIAN: nama env var ini dulu
                                             # dipakai bareng buat SEMUA panggilan Gemini
                                             # (termasuk Chat); sekarang cuma tier "low"
   GEMINI_FALLBACK_MODELS=                   # opsional, daftar model cadangan tier "low",
                                             # format sama seperti GEMINI_CHAT_FALLBACK_MODELS

   # Kalau tier "chat" di atas gagal di SEMUA modelnya (jarang terjadi),
   # otomatis jatuh ke tier "low" sebagai jalan terakhir — supaya tetap dapat
   # balasan daripada gagal total — dan balasannya dikasih catatan kecil kalau
   # itu dari model cadangan yang lebih sederhana, jadi jangan langsung
   # disimpan mentah-mentah, cek ulang dulu.

   # Urutan coba-cobanya: tiap model dicoba dengan SEMUA API key (urut dari
   # GEMINI_API_KEY_FALLBACKS) dulu sebelum pindah ke model berikutnya — jadi
   # kalau key pertama habis kuotanya, dicoba dulu key kedua di model yang
   # sama, baru kalau semua key juga gagal di model itu, pindah ke model
   # cadangan berikutnya (dan mulai lagi dari key pertama).

   # (Opsional) API key TERPISAH khusus tier "chat" -- kalau diisi, tab Chat +
   # transkrip Jurnal pakai key/kuota ini sendiri, sama sekali tidak berbagi
   # dengan GEMINI_API_KEY di atas (yang tetap dipakai notifikasi cron/tier
   # "low" apa pun yang terjadi). Kosongkan/hapus untuk kembali ke perilaku
   # default: semua fitur berbagi satu GEMINI_API_KEY yang sama, seperti di
   # atas -- jadi ini aman ditambahkan belakangan, tidak wajib diisi sekarang.
   # Kalau tier "chat" gagal total dan jatuh ke tier "low" sebagai jalan
   # terakhir (lihat catatan di atas), key yang dipakai pun ikut pindah ke
   # GEMINI_API_KEY, bukan tetap pakai key khusus chat ini.
   GEMINI_CHAT_API_KEY=                      # opsional -- API key gratis lain dari link langkah 1
   GEMINI_CHAT_API_KEY_FALLBACKS=            # opsional, daftar cadangan khusus tier "chat", format
                                             # sama seperti GEMINI_API_KEY_FALLBACKS

   # Google kadang mem-pensiunkan model lama — ganti nilai di atas kalau suatu
   # saat muncul error "model ... no longer available".
   ```
3. Kalau belum, jalankan ulang `supabase/schema.sql` (lihat langkah 2 di atas)
   — aman dijalankan ulang, tidak menghapus data yang sudah ada.

Tanpa `GEMINI_API_KEY` diisi, tab Chat dan tombol transkrip di Jurnal tetap
muncul tapi akan gagal dengan pesan error yang jelas — fitur lain di Bloom
tidak terpengaruh.

## 6. (Opsional) Aktifkan notifikasi push (pengingat menu/vitamin)

Bloom bisa kirim 4 pengingat lewat Web Push tiap hari (jam WIB): **07:00**
pagi (sapaan + semangat/fakta kehamilan), **12:00** siang (ajakan makan siang
+ fakta gizi), **19:00** malam (cuma kalau menu atau vitamin hari itu belum
dicatat), dan **21:30** menjelang tidur (pengingat istirahat + afirmasi).
Diaktifkan per pengguna lewat tombol di tab **Profil**.

Ini murni web push bawaan browser (VAPID) — bukan lewat layanan pihak ketiga
(OneSignal dkk), jadi tidak ada data yang keluar ke server siapa pun selain
Supabase & Google (buat kalimat variasinya lewat Gemini, opsional juga).

**Batasan platform (bukan bug):** di iPhone/iPad, notifikasi cuma muncul kalau
Bloom sudah ditambahkan ke Layar Utama dulu (Safari → tombol Share → **Add to
Home Screen**), dan minimal iOS 16.4. Ini batasan Apple sendiri, bukan
sesuatu yang bisa dilewati dari kode. Di Android/Chrome & desktop, langsung
jalan tanpa langkah tambahan itu.

1. **service_role key** — di dashboard Supabase, buka **Project Settings →
   API**, salin nilai di bagian **service_role secret** (BEDA dari anon key
   yang sudah dipakai di langkah 3 — ini bisa baca lintas pengguna, cuma
   dipakai server-side oleh cron, jangan pernah ditaruh di kode yang jalan di
   browser).
2. **VAPID keys + CRON_SECRET** — sudah digenerate sekali dan ditaruh di
   `.env.local` kamu; salin nilai yang sama ke Vercel → Project Settings →
   Environment Variables. Kalau mau generate ulang (rotasi), jalankan:
   ```
   node -e "console.log(require('web-push').generateVAPIDKeys())"
   ```
3. Tambahkan semua variabel ini ke `.env.local` (lokal) **dan** Vercel
   (produksi):
   ```
   SUPABASE_SERVICE_ROLE_KEY=...         # dari langkah 1
   NEXT_PUBLIC_VAPID_PUBLIC_KEY=...      # dari langkah 2
   VAPID_PRIVATE_KEY=...                 # dari langkah 2
   VAPID_SUBJECT=https://domain-app-kamu.vercel.app   # URL app kamu, bukan email pribadi
   CRON_SECRET=...                       # dari langkah 2 -- token acak, lindungi URL cron
   ```
4. Kalau belum, jalankan ulang `supabase/schema.sql` (lihat langkah 2 di
   bagian atas) — bagian tambahannya (`push_subscriptions`, kolom
   `profiles.name`) aman dijalankan ulang.
5. Deploy ke Vercel (lihat bagian **Deploy ke Vercel** di bawah) — jadwal
   crons di `vercel.json` otomatis aktif begitu project live.

**Cek batas plan Vercel-mu:** ada 4 cron job terpisah di `vercel.json` (satu
per jam pengingat). Plan gratis (Hobby) Vercel membatasi jumlah cron job per
project dan frekuensinya — angka pastinya bisa berubah dari waktu ke waktu,
jadi cek dulu di dashboard Vercel-mu sebelum deploy. Kalau 4 tidak muat di
plan-mu, pilihannya: gabung beberapa slot jadi satu jadwal, atau upgrade ke
Pro.

Tanpa `GEMINI_API_KEY` diisi, notifikasinya tetap terkirim — kalimat
tambahannya jatuh ke daftar kalimat afirmasi/fakta statis di
`lib/reminderLogic.js` alih-alih hasil generate Gemini.

## 7. (Opsional) Aktifkan fallback email kalau push gagal terkirim

Kadang satu push notification gagal sampai ke HP — bukan karena langganan
push-nya sudah dihapus (itu ditangani sendiri, lihat bagian 6 di atas),
tapi gangguan sementara (jaringan, layanan push lagi down, dll). Kalau
diisi, Bloom otomatis kirim isi pengingat yang sama lewat email begitu
**semua** perangkat push milik satu pengguna gagal di satu waktu jadwal
tertentu — bukan cuma kalau salah satu dari beberapa perangkatnya gagal
(kalau perangkat lain masih berhasil, pengguna itu sudah ke-notify, jadi
email tidak dikirim lagi).

1. Daftar gratis di [resend.com](https://resend.com) → buat API key.
2. Tambahkan ke `.env.local` (lokal) **dan** Vercel (produksi):
   ```
   RESEND_API_KEY=...     # dari langkah 1
   EMAIL_FROM=...         # opsional -- default "Bloom <onboarding@resend.dev>",
                          # alamat sandbox Resend sendiri yang sudah bisa kirim
                          # ke email siapa pun tanpa verifikasi domain dulu.
                          # Ganti ke alamat di domain kamu sendiri kapan saja
                          # kalau sudah verifikasi domain di Resend.
   ```
3. Tidak perlu ubah `supabase/schema.sql` — fitur ini cuma membaca email
   akun (`auth.users`, lewat service-role key yang sama seperti bagian 6),
   tidak menyimpan apa pun baru.

Tanpa `RESEND_API_KEY` diisi, fitur ini otomatis tidak aktif (fallback-nya
dilewati, bukan error) — notifikasi push tetap jalan seperti biasa, cuma
tanpa jaring pengaman email itu.

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
  dashboard/journal/page.js → jurnal harian (catatan + mood + foto/video/voice note,
                               transkrip AI dari voice note sebelum catatan disimpan)
  dashboard/chat/page.js  → chat gizi AI (kirim foto makanan, dapat analisis + insight,
                             riwayat chat tersimpan, "Simpan ke Dashboard" per hasil analisis)
  dashboard/profile/page.js → profil kehamilan: nama, usia kehamilan/HPL dari HPHT, daftar
                               calon nama bayi (favorit, gender, catatan/arti), dan panel
                               notifikasi push
  api/nutrition-chat/route.js → proxy terautentikasi ke Gemini API buat chat, dialirkan
                                 sebagai newline-delimited JSON (balasan Bloom muncul
                                 progresif) — tidak menyentuh database, client yang
                                 menyimpan hasilnya ke `meals` sendiri
  api/journal/transcribe/route.js → proxy terautentikasi ke Gemini API buat transkrip +
                                     merapikan voice note jurnal (juga tidak menyentuh database)
  api/push/subscribe/route.js → simpan/hapus langganan Web Push milik pengguna sendiri
                                 (RLS biasa, bukan service role)
  api/cron/reminders/route.js → pengirim 4 pengingat harian (dipicu oleh vercel.json's
                                 crons, dilindungi CRON_SECRET) — satu route, dibedakan
                                 lewat query ?kind=morning|lunch|dinner|night
  globals.css             → tema visual (dark plum)
components/
  ConfirmButton.js       → tombol hapus dengan konfirmasi inline "[Ya, hapus] [Batal]"
                            (dipakai semua tombol ✕ hapus di seluruh app, ganti native confirm())
  ServiceWorkerRegister.js → daftarkan public/sw.js sekali saat app dimuat (dirender dari
                              app/layout.js)
lib/
  supabaseClient.js      → koneksi ke Supabase dari browser (anon key)
  supabaseServer.js      → koneksi ke Supabase dari server, baca sesi login dari cookie
                            (bukan service role — cuma buat mengecek "siapa yang chat/transkrip")
  supabaseAdmin.js       → koneksi service-role (bypass RLS) -- CUMA dipakai
                            api/cron/reminders/route.js, jangan diimpor dari kode client
  nutrition.js           → target gizi per trimester, parser CSV, dll
  pregnancy.js           → usia kehamilan/HPL dari HPHT (Naegele's rule), dihitung bukan disimpan
  journal.js             → daftar mood + konstanta lampiran jurnal (limit ukuran/jumlah file)
  gemini.js              → semua panggilan ke Gemini API: chat, transkrip voice note jurnal,
                            dan kalimat variasi pengingat push (nudge/fakta gizi)
  push.js                → helper client-side: minta izin notifikasi, subscribe/unsubscribe
                            PushManager
  pushSender.js          → wrapper web-push (server-only) -- setup VAPID + kirim notifikasi
  emailSender.js         → wrapper Resend (server-only) -- fallback email kalau SEMUA push
                            milik satu pengguna gagal terkirim (lihat README bagian 7),
                            no-op kalau RESEND_API_KEY belum diisi
  reminderLogic.js       → logika murni pengingat push (siapa yang belum catat apa, susun
                            isi pesan, bank kalimat fallback) -- tanpa I/O, gampang di-test
supabase/
  schema.sql              → skema tabel + storage bucket + Row Level Security
public/
  manifest.json           → PWA manifest (nama, ikon, display standalone)
  sw.js                   → service worker: terima push, buka app saat notifikasi diklik
  icons/                  → ikon PWA (placeholder polos, gampang diganti brandingnya)
vercel.json               → jadwal 4 cron pengingat harian (WIB, lihat bagian 6 di atas)
```

## Testing

```
npm test
```

Menjalankan `vitest` sekali (bukan watch mode) atas `lib/reminderLogic.test.js` dan
`lib/nutrition.test.js` — logika murni pengingat push (siapa yang belum catat apa, susunan
pesan, bank kalimat fallback) dan satu regression test untuk `todayISOInTimeZone` di titik
pergantian hari WIB. Tidak ada test untuk panggilan jaringan (Gemini, Supabase, web-push) —
itu diverifikasi manual lewat `npm run build` + uji coba nyata setelah deploy.

## Catatan

- Notifikasi push (bagian 6) cuma bekerja penuh di iPhone/iPad kalau Bloom
  sudah ditambahkan ke Layar Utama (iOS 16.4+) — batasan platform dari Apple,
  bukan bug Bloom. Di Android/Chrome & desktop langsung jalan.
- Ikon PWA (`public/icons/`) masih placeholder polos (lingkaran satu warna) —
  gampang diganti kapan saja tanpa menyentuh kode lain, tinggal timpa file
  PNG-nya.
- Target gizi adalah panduan umum per trimester, bukan anjuran medis personal.
- Nilai gizi contoh untuk Folamil Genio & Cavit D3 diambil dari label umum
  produk — sesuaikan dengan kemasan asli/anjuran dokter kamu lewat panel
  upload CSV vitamin di dashboard.
- Selain nutrisi "target minimum" di atas, Bloom juga melacak 5 nutrisi
  "batas harian" (jangan dilewati): gula (25g), natrium (2300mg), kolesterol
  (300mg), lemak jenuh (20g), dan kafein (200mg — khusus kehamilan). Angka ini
  panduan umum dewasa/kehamilan (AHA/WHO/ACOG), bukan anjuran medis personal —
  lihat panel "Batas harian" di dashboard, yang memberi peringatan kalau
  salah satu terlewat hari ini (juga muncul di notifikasi pengingat 19:00
  WIB kalau berlaku). Chat AI (bagian 5) ikut membaca kelima nutrisi ini dari
  foto makanan/label kemasan, dan memberi verdict "aman/waspada/kurangi dulu"
  yang mempertimbangkan asupanmu hari ini juga — nadanya sengaja dibuat
  lembut, bukan peringatan medis yang menakutkan.
- Kalau vitamin/suplemen ATAU menu makan yang kamu catat punya kandungan yang
  tidak ada di daftar gizi utama (mis. Zinc, Vitamin B6, Omega-3, Iodium),
  tambahkan lewat "+ Tambah nutrisi lain" di form manual (vitamin maupun
  menu) — Chat AI juga bisa mengisi ini otomatis dari foto/label yang
  dianalisis. Nutrisi ini ditampilkan sebagai catatan harian (jumlah dari
  semua menu + vitamin yang tercatat/dicentang hari itu) tanpa target/ring —
  belum ada patokan AKG bawaan untuk nutrisi bebas seperti ini. Belum
  didukung lewat upload CSV, cuma lewat form manual atau Chat AI.
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
- Transkrip voice note (opsional, butuh `GEMINI_API_KEY`, lihat bagian 5)
  cuma tersedia saat menulis catatan baru — buka di voice note yang baru
  direkam, sebelum catatannya disimpan. Belum ada tombol transkrip untuk
  voice note lama yang sudah tersimpan (termasuk lewat "✏️ Ubah" di bawah —
  form edit cuma untuk tanggal/mood/teks catatan, lampiran tidak diutak-atik
  di sana). Rekamannya sendiri (bukan cuma transkripnya) dikirim ke Gemini
  untuk dianalisis — beda dari foto di Chat, rekaman voice note memang sudah
  tersimpan di Storage terlepas dari fitur ini.
- Catatan yang sudah tersimpan bisa diubah lewat "✏️" di riwayat (tanggal,
  mood, teks catatan) — lampiran (foto/video/voice note) tetap cuma bisa
  dihapus, belum ada fitur menambah lampiran baru ke catatan yang sudah ada.
- Chat gizi AI (opsional, lihat bagian 5 di atas) adalah obrolan bebas — bisa
  dipakai untuk ngobrol/tanya-tanya biasa, dan Gemini sendiri yang menentukan
  kapan suatu pesan (teks dan/atau foto) itu cerita soal makanan/minuman yang
  perlu dicatat vs. sekadar obrolan. Untuk yang perlu dicatat, kandungan
  gizinya cuma estimasi (bukan pengukuran lab) dan harus dikonfirmasi lewat
  tombol "Simpan ke Dashboard" dulu sebelum masuk ke menu hari ini (tidak
  otomatis) — tetap bisa diedit/dihapus manual dari dashboard kalau meleset.
  Foto bisa dilampirkan lewat tombol 🖼️, drag-and-drop ke panel chat, atau
  paste dari clipboard. Fotonya sendiri tidak disimpan di Bloom, cuma dikirim
  ke Gemini untuk
  dianalisis lalu dibuang — riwayat chat (`chat_messages`) menyimpan teks dan
  hasil analisisnya saja, bukan fotonya. Tier gratis Gemini punya batas rate
  limit harian; untuk pemakaian pribadi/keluarga biasanya jauh dari batas
  tersebut.
- Usia kehamilan dihitung dari HPHT (Hari Pertama Haid Terakhir — tanggal
  mulai menstruasi terakhir sebelum hamil) yang diisi di tab **Profil**. Kalau
  yang kamu punya cuma HPL (perkiraan lahir dari dokter/USG), pakai toggle
  "Saya tahu HPL" — Bloom membalikkannya jadi HPHT otomatis (aturan Naegele:
  HPL = HPHT + 280 hari), keduanya saling bisa dihitung dari yang lain. Cuma
  perkiraan kalender, bukan pengganti perhitungan USG dokter.
- Trimester di Dashboard bukan lagi pilihan manual — dihitung otomatis dari
  HPHT + tanggal yang sedang dilihat (lewat kalender di panel cincin gizi),
  jadi membuka tanggal di masa lalu menampilkan trimester (dan target gizi)
  sesuai usia kehamilan saat itu, bukan selalu trimester hari ini. Sebelum
  HPHT/HPL diisi, ditampilkan sebagai Trimester 1 sementara, dengan info
  ajakan mengisinya di tab Profil.
- Panel cincin gizi di dashboard punya kalender kecil (bukan lagi dropdown
  tanggal) — hari yang sudah ada datanya ditandai hijau, klik tanggal mana
  pun untuk mengisi data lama (backdate), dan tombol "Hari ini" selalu ada
  untuk kembali cepat.
- Daftar calon nama bayi (`baby_names`, di tab **Profil**) murni untuk
  brainstorming pribadi — belum ada fitur berbagi/kolaborasi lintas akun (mis.
  dengan pasangan), jadi kalau berdua-duaan mencatat, sepakati dulu satu akun
  yang dipakai.
