# Improvement Plan — Log cron/reminders result (SIMPLE)

## Goal

Tambahkan `console.log` di `app/api/cron/reminders/route.js` di kedua titik yang
mengembalikan `{kind, sent, pruned, skipped, subscribers}`, supaya angka itu
langsung kelihatan di Vercel Runtime Logs (yang tidak menangkap response body)
tanpa instrumentasi tambahan.

## Current behavior

- `route.js:52-54` — early return `{kind, sent:0, pruned:0, skipped:0,
  subscribers:0}` saat tidak ada baris `push_subscriptions` sama sekali. Tidak
  ada log.
- `route.js:141-143` — return akhir `{kind, sent, pruned, skipped, subscribers:
  userIds.length}` setelah `sumReminderResults`. Tidak ada log.

## Proposed change

Tambah satu baris `console.log` tepat sebelum masing-masing `return
NextResponse.json(...)` di dua titik di atas, format seragam supaya mudah
di-`grep`/filter di Vercel Logs:

```
cron/reminders kind=<kind> sent=<n> pruned=<n> skipped=<n> subscribers=<n>
```

Tidak diekstrak jadi fungsi/helper terpisah (2 pemanggilan, masing-masing 1
baris template literal langsung di lokasi return-nya) — mengekstrak jadi fungsi
bernama hanya untuk 2 baris identik ini tidak menambah kejelasan, dan supaya
tidak perlu meng-export helper baru dari file route Next.js hanya demi
testability (lihat Test plan).

## Scope

- `app/api/cron/reminders/route.js` — tambah `console.log` sebelum return di
  baris ~53 (early return, subscribers=0) dan sebelum return di baris ~143
  (return akhir). Tidak ada perubahan pada shape/isi response JSON yang
  dikirim ke client — murni tambahan log, behavior lain di file ini
  sepenuhnya tidak berubah.

## Steps

1. Tambah `console.log(\`cron/reminders kind=${kind} sent=0 pruned=0 skipped=0 subscribers=0\`)` tepat sebelum `return NextResponse.json({ kind, sent: 0, pruned: 0, skipped: 0, subscribers: 0 })` di early-return "tidak ada subscriber".
2. Tambah `console.log(\`cron/reminders kind=${kind} sent=${sent} pruned=${pruned} skipped=${skipped} subscribers=${userIds.length}\`)` tepat sebelum `return NextResponse.json({ kind, sent, pruned, skipped, subscribers: userIds.length })` di akhir handler.

## Test plan

`app/api/cron/reminders/route.js` (dan setiap `route.js` lain di app ini) tidak
punya test otomatis sekarang — handler-nya bergantung pada
`getSupabaseAdminClient`/`sendPush`/Gemini yang semuanya `import "server-only"`
+ butuh network/DB sungguhan untuk dijalankan penuh, konsisten dengan pola test
repo ini (cuma fungsi murni di `lib/*.js` yang di-unit-test — lihat
`lib/nutrition.test.js`, `lib/reminderLogic.test.js`, `lib/gemini.test.js`).
Karena perubahan ini murni menambah `console.log` tanpa fungsi baru yang layak
diekspor/di-unit-test terpisah, tidak ada file test baru — mengikuti pola yang
sudah ada, bukan menambah cakupan test palsu untuk 2 baris logging.

Verifikasi dilakukan dengan:
1. `node --check` pada file yang diedit (sudah standar dipakai run-run
   sebelumnya di sesi ini).
2. Verifikasi manual format string persis (dry-run template literal di luar
   file, dengan nilai-nilai contoh) untuk memastikan output-nya sesuai yang
   diminta sebelum ditempel ke kode — dicatat di
   `cron-reminders-result-logging-implementation-log.md`.
3. `npx vitest run` — memastikan suite yang sudah ada (43 test) tetap hijau,
   sebagai regression guard bahwa perubahan ini tidak menyentuh apa pun yang
   sudah di-test.

## Triage

SIMPLE — 1 file, tanpa perubahan schema/response shape, tanpa area `$KDOCS`,
tanpa ambiguitas, blast radius nol (murni observability, tidak mengubah
behavior yang bisa dikonsumsi apa pun).
