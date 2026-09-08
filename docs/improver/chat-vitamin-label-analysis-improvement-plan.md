# Improvement Plan — Chat: analisa label vitamin/kemasan + "Simpan sebagai vitamin ke Dashboard"

## Goal

1. Perluas analisa foto Gemini di Chat dari 2 mode (`is_log` true/false) menjadi 3
   kategori — **makanan** (termasuk membaca label Nutrition Facts kemasan
   makanan/minuman secara langsung kalau angkanya tercetak, bukan cuma menaksir dari
   tampilan), **vitamin/suplemen** (dari label botol ATAU resep dokter — bisa
   mengekstrak **lebih dari satu** vitamin dari satu foto/pesan), dan **obrolan biasa**.
2. Untuk kategori vitamin, tiap item yang terdeteksi dapat tombol **"Simpan ke
   Dashboard"** sendiri-sendiri yang insert ke tabel `vitamins` — alur yang sama
   persis dengan foto makanan sekarang (`meals`), termasuk undo (`Hapus`).

Keputusan dari sesi klarifikasi: fokus permintaan #2 ("tambah vitamin ke dashboard")
adalah alur **via Chat** ini — form manual "Tambah vitamin" di Dashboard sudah ada
sebelumnya dan tidak perlu diubah.

## Current behavior

Lihat `docs/improver/chat-vitamin-label-analysis-assessment.md` untuk detail lengkap +
referensi baris. Ringkas:

- `lib/gemini.js:22-61` — schema/prompt Gemini cuma kenal `is_log` boolean: true selalu
  diperlakukan sebagai "makanan sedang dimakan" (nama menu + `NUTRIENT_ORDER`), false =
  obrolan biasa. Tidak ada jalur untuk label vitamin/suplemen atau instruksi membaca
  angka dari label kemasan secara langsung.
- `app/dashboard/chat/page.js:240-247,257-268,337-352` — hasil analisis food-shaped
  disimpan ke `chat_messages.analysis` lalu tombol "Simpan ke Dashboard"
  (`saveAnalysisToMeals`) insert 1 baris ke `meals`, linknya disimpan balik ke
  `chat_messages.saved_meal_id`.
- `app/dashboard/page.js:328-401` — form manual "Tambah vitamin" (`handleAddVitamin`)
  sudah ada, sudah mirror pola "Tambah menu manual" persis, insert ke `vitamins`
  (termasuk `extra_nutrients` jsonb untuk nutrisi di luar `NUTRIENT_ORDER`). Tidak ada
  perubahan yang diperlukan di sini.
- `supabase/schema.sql:139-149` — `chat_messages` cuma punya `saved_meal_id` (FK
  tunggal ke `meals`), tidak ada padanan untuk vitamin.

## Proposed change

### 1. `lib/gemini.js` — schema + prompt 3-kategori

- `buildResponseSchema()` diganti dari `is_log` boolean menjadi `category: STRING enum
  ["food","vitamin","chat"]`, dengan struktur:
  - `meal` + semua field `NUTRIENT_ORDER` (NUMBER) — tetap seperti sekarang, dipakai
    kalau `category === "food"`.
  - `vitamins`: ARRAY of OBJECT, tiap item = `{ name: STRING, ...NUTRIENT_ORDER (NUMBER),
    extra_nutrients: ARRAY of { label: STRING, unit: STRING, value: NUMBER } }` — dipakai
    kalau `category === "vitamin"`, boleh berisi lebih dari 1 item.
  - `reply: STRING` — tetap paling akhir di schema (alasan sama seperti komentar yang
    sudah ada: field pendek/atomik diputuskan Gemini duluan sebelum menulis `reply`,
    supaya streaming `reply` tidak lebih lambat).
- `SYSTEM_PROMPT` ditulis ulang jadi 3 skenario eksplisit:
  1. **food** — cerita/foto makanan-minuman yang sedang/baru dikonsumsi, **ATAU** foto
     label Nutrition Facts pada kemasan makanan/minuman kemasan — untuk kasus kedua,
     instruksikan Gemini **membaca langsung angka yang tercetak di label**, bukan
     menaksir dari tampilan. `vitamins = []`.
  2. **vitamin** — foto/cerita tentang vitamin atau suplemen: label botol
     vitamin/suplemen, **atau** foto/daftar resep dokter yang menyebut satu atau
     lebih nama vitamin/suplemen. `vitamins` diisi **satu objek per
     vitamin/suplemen yang terdeteksi** (boleh >1 kalau memang ada beberapa nama
     disebut/terlihat dalam satu foto/pesan — mis. resep dokter berisi 2-3 nama).
     Per item: `name` = nama produk; field `NUTRIENT_ORDER` diisi sesuai angka di
     label/kemasan **kalau terlihat/diketahui**, isi 0 kalau tidak ada info gizinya
     (mis. resep dokter yang cuma menyebut nama produk tanpa kandungan gizi
     tercetak) — **jangan mengarang angka pasti**. `extra_nutrients` untuk nutrisi
     di luar daftar utama (mis. Zinc, Vitamin B6, Iodium) kalau terlihat di label,
     array kosong kalau tidak ada. `meal` + field `NUTRIENT_ORDER` di level atas
     dikosongkan/0 (tidak dipakai untuk kategori ini).
  3. **chat** — selain dua di atas, sama seperti sekarang.
  - Instruksi lama soal riwayat percakapan + "jangan ulang sapaan pembuka" tetap
    dipertahankan apa adanya.
- Blok sanitasi hasil (`lib/gemini.js:242-247`) ditulis ulang, diekstrak jadi fungsi
  murni `sanitizeChatTurnResult(parsed)` (diekspor) supaya bisa di-unit-test tanpa
  network call:
  - `category` divalidasi terhadap `["food","vitamin"]`, selain itu → `"chat"`.
  - `category === "food"` tapi `meal` kosong → diturunkan jadi `"chat"` (tidak ada
    yang bisa disimpan kalau nama menunya kosong).
  - `category === "vitamin"`: tiap item divalidasi (`name` wajib ada, numeric fields
    di-`toSafeNumber`, `extra_nutrients` di-slice cap 20 & item tanpa `label` dibuang),
    array keseluruhan di-slice cap 10 item; kalau hasil akhirnya array kosong (mis.
    semua item tanpa nama) → diturunkan jadi `"chat"` juga.
  - `reply` tetap di-slice 800 char seperti sekarang, berlaku untuk ketiga kategori.
  - `streamNutritionChatTurn` memanggil `sanitizeChatTurnResult(parsed)` menggantikan
    blok inline yang sekarang — logika streaming/`extractPartialStringValue("reply")`
    tidak berubah sama sekali (field `reply` tetap top-level string, posisi terakhir).

### 2. `lib/nutrition.js` — helper baru (dipakai bareng oleh form manual + chat)

- `buildExtraNutrientsMap(rows)` — dipindah dari logika inline `handleAddVitamin`
  (dashboard/page.js:362-368) jadi fungsi murni yang diekspor: `rows` = array
  `{label, unit, value}` (value boleh string mentah dari form atau number dari
  Gemini) → `{ [slug]: {label, unit, value} }`, baris tanpa label/value valid
  dibuang diam-diam (perilaku persis seperti komentar yang sudah ada sekarang).
  `handleAddVitamin` diubah memanggil helper ini alih-alih inline.
- `vitaminItemToRow(item, userId)` — item Gemini (`{name, ...NUTRIENT_ORDER,
  extra_nutrients: [...]}`) → baris siap-insert ke tabel `vitamins` (`{user_id, name,
  ...NUTRIENT_ORDER, extra_nutrients: buildExtraNutrientsMap(...)}`), dipakai oleh
  handler simpan-vitamin-dari-chat yang baru.

### 3. `app/dashboard/chat/page.js` — UI + save/undo per item

- `formatVitaminAnalysisText(result)` (fungsi baru, pola sama seperti
  `formatAnalysisText` yang sudah ada) — merender tiap item `result.vitamins` sebagai
  satu baris (`• *nama* — detail gizi`), diikuti `reply`.
- `toHistoryEntry(m)` — cabang baru: `m.analysis?.category === "vitamin"` →
  `formatVitaminAnalysisText`; selain itu (termasuk baris lama tanpa `category`,
  demi kompatibilitas mundur riwayat chat sebelum perubahan ini) tetap
  `formatAnalysisText` seperti sekarang.
- `handleSend()` — kondisi penyimpanan `analysis` diperluas: `category === "food" &&
  meal` (setara `is_log` lama) ATAU `category === "vitamin" && vitamins.length > 0` →
  simpan sebagai `analysis`; selain itu → simpan sebagai teks balasan biasa (sama
  seperti sekarang).
- Handler baru `saveVitaminItemToDashboard(msgId, itemIndex, item)` — insert 1 baris
  via `vitaminItemToRow` ke `vitamins`, lalu **update field `analysis` (seluruh
  kolom jsonb) di `chat_messages`** untuk menandai item itu ke-index sudah tersimpan
  (`analysis.vitamins[itemIndex].saved_vitamin_id = <id baru>`) — dipilih dibanding
  menambah kolom baru di `chat_messages` supaya **tidak perlu migration sama sekali**
  (satu turn bisa punya banyak vitamin tersimpan, tidak muat di satu kolom FK
  skalar seperti `saved_meal_id`). State per-item disimpan lokal di message object
  (`savingVitaminIndex`, error per index) supaya beberapa tombol simpan dalam satu
  balasan tidak saling mengganggu statusnya.
- Handler baru `undoSavedVitaminItem(msgId, itemIndex, vitaminId)` — hapus baris dari
  `vitamins`, lalu update balik `analysis.vitamins[itemIndex]` (hapus
  `saved_vitamin_id`) dengan pola undo yang sama seperti `undoSavedMeal`.
- Blok render pesan (chat/page.js:333-354) — cabang baru: kalau
  `m.analysis?.category === "vitamin"`, render `formatVitaminAnalysisText` + satu
  tombol "Simpan ke Dashboard"/"✓ tersimpan + Hapus" **per item** array `vitamins`;
  selain itu (food/legacy) render persis seperti sekarang, tidak diubah.
- Copy kecil: `bloom-sub` (chat/page.js:302-305) dan disclaimer (chat/page.js:408-415)
  disebutkan kemampuan baru (baca label vitamin/kemasan) — supaya user tahu fitur ini
  ada, konsisten dengan gaya copy yang sudah ada.

### 4. `app/api/nutrition-chat/route.js`, `supabase/schema.sql`

Tidak ada perubahan. Route ini cuma passthrough (tidak membaca field `is_log`/`meal`
secara spesifik, cuma stream delta + forward `result` apa adanya) — bentuk baru
`result` otomatis ikut lewat tanpa perubahan kode di sini. Schema tidak berubah (lihat
poin "Data / schema impact" di bawah).

## Scope

### In scope
- `lib/gemini.js` — `buildResponseSchema`, `SYSTEM_PROMPT`, ekstraksi
  `sanitizeChatTurnResult`, `streamNutritionChatTurn` (pemanggilan sanitizer saja,
  loop streaming tidak berubah).
- `lib/nutrition.js` — tambah `buildExtraNutrientsMap`, `vitaminItemToRow`.
- `app/dashboard/page.js` — `handleAddVitamin` memanggil `buildExtraNutrientsMap`
  alih-alih inline (satu baris berubah, perilaku identik).
- `app/dashboard/chat/page.js` — `formatVitaminAnalysisText` (baru), `toHistoryEntry`,
  `handleSend`, `saveVitaminItemToDashboard`+`undoSavedVitaminItem` (baru), blok
  render pesan, copy `bloom-sub`/disclaimer.
- `lib/nutrition.test.js` — test baru untuk `buildExtraNutrientsMap`,
  `vitaminItemToRow`.
- `lib/gemini.test.js` (baru) — test untuk `sanitizeChatTurnResult`.

### Out of scope / non-goals
- Form manual "Tambah vitamin" di Dashboard — sudah ada, tidak disentuh (keputusan
  klarifikasi).
- Kategori "food" tidak diperluas untuk multi-item (tetap 1 menu per giliran, sama
  seperti sekarang) — multi-item cuma untuk kategori vitamin, sesuai keputusan
  klarifikasi.
- Fitur "edit" vitamin/menu tersimpan (baik dari form manual maupun dari chat) — tidak
  ada sekarang untuk keduanya (cuma tambah/hapus), tidak ditambahkan di sini.
- Uji coba langsung ke Gemini API sungguhan (live smoke test) — file `lib/gemini.js`
  memang tidak punya test yang memanggil API sungguhan sekarang (perlu API key +
  network); tetap mengikuti batas cakupan test yang sudah ada di repo ini
  (unit test cuma untuk fungsi murni). Verifikasi end-to-end prompt baru ini di
  Gemini asli tetap perlu dicoba manual oleh kamu setelah deploy.

## Data / schema impact

**Tidak ada.** Status tersimpan per item vitamin disimpan di dalam kolom jsonb
`chat_messages.analysis` yang sudah ada (menambah field `saved_vitamin_id` di dalam
tiap objek array `vitamins[i]`), bukan kolom baru — jadi tidak perlu migration SQL
sama sekali.

## Risks & mitigations

- **Gemini salah klasifikasi** (mis. foto botol vitamin dikira makanan) — mitigasi:
  instruksi prompt yang eksplisit membedakan ciri kedua kategori; kalau salah, user
  tinggal bilang di chat ("itu vitamin, bukan makanan") dan giliran berikutnya
  terkoreksi — sama seperti cara kerja chat biasa sekarang.
- **Schema nested array (vitamins[].extra_nutrients[]) tidak didukung/berperilaku
  aneh di Gemini structured output** — mitigasi: kedalaman nesting dibatasi 2 level
  (sesuai dokumentasi resmi Gemini responseSchema), dan ini adalah item yang perlu
  smoke-test manual (lihat "Out of scope" di atas) karena repo ini memang belum
  pernah unit-test panggilan Gemini sungguhan.
- **Kompatibilitas mundur riwayat chat lama** (baris `chat_messages.analysis` dari
  sebelum perubahan ini tidak punya field `category`) — mitigasi:
  `toHistoryEntry`/blok render mengecek `category === "vitamin"` secara eksplisit;
  selain itu (termasuk `undefined`) jatuh ke render food yang sudah ada, yang memang
  cocok karena baris lama semuanya food-shaped (chat lama cuma simpan `analysis`
  waktu `is_log === true`).
- **Beberapa tombol "Simpan" dalam satu balasan** — mitigasi: status
  saving/error disimpan per-index di dalam object pesan itu sendiri, bukan state
  global, supaya klik satu tombol tidak memengaruhi tombol lain di balasan yang sama
  atau balasan lain.

## Test plan

Vitest (`npm test`), mengikuti konvensi repo (cuma fungsi murni di `lib/*.js` yang
di-unit-test — `lib/gemini.js`/`app/**/*.js` yang menyentuh network/DOM/browser tidak
punya test sekarang juga, tidak diperluas cakupannya di run ini):

**`lib/nutrition.test.js`** (tambahan):
- `buildExtraNutrientsMap`: baris lengkap → masuk map dengan slug yang benar; baris
  tanpa label atau value non-numeric → dibuang diam-diam; label dengan spasi/kapital
  berbeda tapi sama setelah slugify → baris terakhir menang; `unit` kosong → default
  string kosong.
- `vitaminItemToRow`: nama kosong → fallback yang masuk akal; tiap field
  `NUTRIENT_ORDER` yang hilang/non-numeric → 0; `extra_nutrients` dari item Gemini
  ikut ter-konversi lewat `buildExtraNutrientsMap`; `user_id` ikut disisipkan.

**`lib/gemini.test.js`** (baru):
- `sanitizeChatTurnResult`: category "food" normal (meal + nutrients numerik) → lolos
  apa adanya; category "food" tanpa `meal` → diturunkan ke "chat"; category "vitamin"
  dengan 2 item lengkap (termasuk `extra_nutrients`) → lolos, tiap item numeric-safe;
  item vitamin tanpa `name` → dibuang dari array; array vitamin kosong/semua item
  invalid → diturunkan ke "chat"; array vitamins/extra_nutrients melebihi cap →
  terpotong ke batas; category tidak dikenal/hilang → default "chat"; `reply`
  selalu ke-slice ke 800 karakter di ketiga kategori.

Semua test dijalankan (`npx vitest run` atau `npm test`) dan outputnya dilampirkan di
`chat-vitamin-label-analysis-implementation-log.md` sebelum commit akhir.

## Standards notes

Tidak ada area `kredivo-docs` yang tersentuh (bukan GCP/BigQuery/AWS-auth, bukan
SSO, bukan Terraform/IaC, bukan Dockerfile/compose) — tidak ada standar yang perlu
dirujuk untuk perubahan ini.
