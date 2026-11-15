# TEST REPORT — Validator Watchdog

Tanggal: 15 Nov 2026. Node v24.22.1. Nol dependensi (`node --test`, stdlib saja).

## Tes unit + integrasi: 47/47 lolos, 0 gagal

`npm test` — 47 tes dalam 6 file, ~2 detik:

| File | Cakupan |
| --- | --- |
| `test/keys.test.js` (7) | Sign/verify Ed25519, penolakan kunci salah, byte rusak, signature malformed (false bersih, bukan throw), identitas stabil dari PEM, penolakan kunci non-Ed25519, round-trip kunci publik. |
| `test/reportLog.test.js` (9) | Rantai hash + verifikasi, deteksi rusaknya isi, rusaknya signature, rusaknya prevHash, kunci penanda lain, persistensi + reload utuh, reload hanya menyimpan prefix valid setelah dirusak, baris malformed dibuang dengan peringatan, `listNewestFirst`/`get`. |
| `test/classify.test.js` (11) | healthy/degraded/down/stalled termasuk batas: latensi tepat di ambang masih healthy, 1 gagal = degraded, 2 gagal = down, datar tanpa peer maju bukan stalled, jendela < stallChecks tidak bisa stalled, kegagalan mengalahkan stall, `computePeersAdvanced` mengabaikan target sendiri dan butuh ≥2 titik. |
| `test/checker.test.js` (9) | Fetch TIRUAN saja, tanpa jaringan: parse chainId/height + latensi, urutan panggilan strictly sequential, lambat vs batas, gagal→degraded→down→pulih, error JSON-RPC, backoff HTTP 429 (skip siklus berikut, dicoba lagi setelah backoff), stall saat satu target datar dan peer maju, datar di semua target bukan stall, timeout bersih, snapshot `unknown` sebelum siklus pertama. |
| `test/server.test.js` (7) | `/health`, `/public-key` (PEM persis), `/api/status` (bentuk + fingerprint), `/api/reports` (terbaru dulu, `?limit=`), `/api/reports/:seq` + 404, dashboard HTML, 404/405. |
| `test/verify-script.test.js` (3) | End-to-end: `scripts/verify.js` keluar 0 atas log live server sungguhan (membuktikan implementasi independen skrip cocok dengan server), keluar bukan-0 + `TAMPER DETECTED` atas log yang dirusak, keluar bukan-0 saat server tak terjangkau. |

## Smoke test live (terbatas, 15 Nov 2026 ~16.54–16.55 WIB)

Server sungguhan dijalankan ±70 detik dengan 2 target, interval 30 detik,
jeda antar target 1,5 detik, berurutan — total 3 siklus, 6 observasi, lalu
dihentikan. Tidak ada 429, tidak ada retry agresif.

| Target | Hasil |
| --- | --- |
| BSC dataseed (`0x38`) | Sehat 3/3. Ketinggian maju 133.715.100 → 133.715.173 → 133.715.240. Latensi 646–913 ms. Status `healthy` di semua siklus. |
| eth.llamarpc.com | Gagal 3/3 dengan `HTTP 525` (error Cloudflare dari jaringan VM ini). Status bertransisi `degraded` → `down` → `down`, tepat sesuai aturan ambang. Bukan rate-limit; tidak ada backoff yang terpicu. |

Selama server live: `GET /api/status` benar, dashboard HTML ter-render, dan
`node scripts/verify.js http://localhost:3101` keluar 0 dengan pesan
"checked 6 report entries ... OK: hash chain intact, all signatures valid".

Pemeriksaan tambahan satu target (di luar smoke server): `polygon-rpc.com`
timeout 10 detik pada satu percobaan dari VM ini (`request timed out`,
`degraded`). Hanya satu percobaan — tidak cukup untuk menyimpulkan kondisi
endpoint itu; dicatat apa adanya.

## Yang BELUM diverifikasi

- Target default ketiga (`polygon-rpc.com`) dalam kondisi sehat, dari
  jaringan mana pun.
- Perilaku jangka panjang: puluhan siklus, rotasi backoff berulang, file log
  besar, dan reload setelah restart dengan kunci stabil.
- Operasi dari jaringan deploy (Railway): hasil per-target bisa berbeda dari
  VM ini — daftar target harus diperiksa ulang setelah deploy.
- Persistensi melampaui redeploy diskless (diketahui hilang; didokumentasikan
  di README, bukan disembunyikan).
- Tidak ada klaim zkVerify: tidak ada proof, tidak ada pengiriman ke Kurier,
  tidak ada interaksi on-chain apa pun dalam proyek ini.
