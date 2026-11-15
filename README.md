# Validator Watchdog

Agent pemantau kesehatan endpoint JSON-RPC blockchain publik. Agent ini
memeriksa sekumpulan kecil endpoint publik secara berkala, mengklasifikasikan
kondisinya (healthy / degraded / stalled / down), dan menerbitkan setiap
observasi sebagai entri laporan yang **ditandatangani (Ed25519)** dan
**dirangkai hash (hash-chained)** — sehingga siapa pun bisa memeriksa ulang
laporan itu tanpa harus percaya pada agent.

Dibangun untuk track **Wildcard** pada Agent Games zkVerify. Kode orisinal,
Node.js stdlib saja, **nol dependensi**.

## Masalah yang diselesaikan

Operator validator dan siapa pun yang bergantung pada endpoint RPC publik
punya masalah sederhana: endpoint bisa lambat, tertinggal (stuck di ketinggian
blok yang sama), atau mati — dan biasanya ketahuannya dari pengguna yang
mengeluh duluan. Watchdog mengubah itu menjadi observasi terjadwal yang
tercatat, terklasifikasi, dan bisa diverifikasi pihak ketiga.

Siapa yang dibantu: operator node/validator kecil, peneliti infrastruktur,
dan siapa pun yang butuh catatan kesehatan RPC yang bisa diaudit.

## Cara kerja

1. **Checker** — Setiap siklus (default 60 detik), agent memeriksa tiap
   target secara **berurutan dan berjeda**: satu panggilan `eth_chainId`,
   lalu satu panggilan `eth_blockNumber`, lalu jeda sebelum target
   berikutnya. Tidak pernah batch, tidak pernah paralel. Kalau sebuah
   endpoint menjawab HTTP 429, target itu diistirahatkan (backoff) dan tidak
   dihantam ulang.
2. **Klasifikasi** — Dari riwayat per target:
   - `healthy` — terjangkau, cepat, ketinggian blok maju.
   - `degraded` — satu kegagalan terakhir, atau respons lebih lambat dari
     ambang `WATCHDOG_SLOW_MS` (tepat di ambang masih healthy).
   - `stalled` — ketinggian blok sama selama `WATCHDOG_STALL_CHECKS` cek
     berturut-turut **sementara** minimal satu target lain maju dalam jendela
     yang sama. Tanpa bukti peer yang maju, ketinggian yang datar tidak
     disebut stalled (rantai yang sepi bukan endpoint yang macet).
   - `down` — gagal berturut-turut sampai ambang `WATCHDOG_DOWN_FAILURES`.
3. **Laporan bertanda tangan** — Setiap observasi menjadi satu entri berisi
   timestamp, target, keterjangkauan, latensi, chainId, ketinggian blok,
   status, `prevHash` (SHA-256 entri sebelumnya), dan tanda tangan Ed25519
   atas byte kanonis entri. Entri disimpan append-only di `data/reports.jsonl`.
4. **Server HTTP** — Dashboard HTML, API JSON, kunci publik, dan health check
   (lihat Endpoint di bawah).

## Verifikasi: jangan percaya, periksa

Kunci publik diterbitkan di `GET /public-key`. Skrip verifikasi mengambil
log laporan + kunci publik, lalu menghitung ulang rantai hash dan memeriksa
setiap tanda tangan — tanpa memakai kode server (implementasi independen,
supaya bug di server tidak bisa bersembunyi di balik kode bersama):

```sh
node scripts/verify.js https://<endpoint-publik-anda>
# keluar 0 bila semua entri valid; keluar bukan-0 bila ada yang dirusak
```

Identitas penanda tangan:
- Bila `WATCHDOG_PRIVATE_KEY` diisi (kunci privat Ed25519 format PEM PKCS#8),
  identitasnya **stabil** di semua boot: semua laporan terverifikasi terhadap
  satu kunci publik yang sama.
- Bila variabel itu kosong, keypair baru dibuat di setiap boot (**ephemeral**):
  laporan dari satu boot hanya terverifikasi terhadap kunci publik yang
  diterbitkan boot itu juga. Server mencatat mode ini dengan jelas di log
  saat start.
- Kunci privat tidak pernah ditulis ke disk, tidak pernah dicatat di log,
  dan tidak pernah keluar dari proses ini.

## Endpoint

| Route | Keterangan |
| --- | --- |
| `GET /` | Dashboard HTML: tabel target, status, latensi, ketinggian. |
| `GET /api/status` | Ringkasan JSON: identitas, jumlah laporan, status per target. |
| `GET /api/reports` | Daftar entri, terbaru dulu. `?limit=` dibatasi `maxReportLimit`. |
| `GET /api/reports/:seq` | Satu entri berdasarkan nomor urut. |
| `GET /public-key` | Kunci publik PEM untuk verifikasi offline. |
| `GET /health` | `{"ok":true}`. |

## Menjalankan lokal

```sh
node src/index.js
# lalu buka http://localhost:3000
```

Tes (tanpa jaringan; checker diuji dengan fetch tiruan):

```sh
npm test
```

## Variabel environment

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port listen. Railway mengisinya otomatis. |
| `WATCHDOG_TARGETS` | BSC dataseed, eth.llamarpc.com, polygon-rpc.com | Daftar URL dipisah koma. |
| `WATCHDOG_INTERVAL_MS` | `60000` | Jeda antar siklus (min. 5000). |
| `WATCHDOG_TARGET_DELAY_MS` | `1000` | Jeda antar target dalam satu siklus. |
| `WATCHDOG_REQUEST_TIMEOUT_MS` | `10000` | Timeout per panggilan RPC. |
| `WATCHDOG_SLOW_MS` | `2000` | Ambang lambat (strictly greater). |
| `WATCHDOG_DOWN_FAILURES` | `2` | Gagal berturut-turut sebelum `down`. |
| `WATCHDOG_STALL_CHECKS` | `3` | Cek datar berturut-turut sebelum `stalled`. |
| `WATCHDOG_BACKOFF_MS` | `60000` | Istirahat target setelah HTTP 429. |
| `WATCHDOG_REPORT_LIMIT` | `100` | Jumlah default entri di `/api/reports`. |
| `WATCHDOG_DATA_DIR` | `data` | Direktori file log laporan. |
| `WATCHDOG_PRIVATE_KEY` | _(kosong)_ | Kunci privat Ed25519 PEM untuk identitas stabil. Jangan pernah commit. |

Lihat `.env.example` untuk template (placeholder saja, tanpa secret).

## Deploy (Railway)

Sesuai pola proyek sibling: deploy dari repo GitHub, Railway mendeteksi Node
otomatis dan menjalankan `npm start` (`node src/index.js`). Server membaca
`PORT` dari environment dan tidak mengikat host tertentu. Tidak ada build
step, tidak ada database. Untuk identitas stabil, isi `WATCHDOG_PRIVATE_KEY`
di Variables Railway (jangan pernah menaruhnya di repo atau chat). Buat kunci
dengan `openssl genpkey -algorithm Ed25519`.

## Bagian kejujuran (baca sebelum menilai)

- **Laporan ditandatangani Ed25519, BUKAN proof zkVerify.** Agent ini tidak
  mengklaim "verifiability plus" zkVerify. Yang bisa diperiksa siapa pun
  adalah: rantai hash utuh dan tanda tangan valid — artinya laporan tidak
  diubah setelah ditandatangani, dan berasal dari pemegang kunci yang
  kuncinya dipublikasikan. Itu tidak membuktikan isi observasinya benar
  terhadap dunia nyata; isi observasi bergantung pada jawaban endpoint RPC
  yang diperiksa.
- **Data bergantung pada endpoint publik dan limit mereka.** Endpoint publik
  bisa rate-limit, pindah, atau mati. Dalam smoke test lokal (15 Nov 2026),
  BSC dataseed menjawab sehat, eth.llamarpc.com menjawab HTTP 525 pada 3/3
  percobaan, dan polygon-rpc.com timeout 10 detik pada satu percobaan —
  semua dari jaringan VM ini, dan hasilnya bisa berbeda dari jaringan
  deploy. Daftar target default perlu diperiksa ulang dari lingkungan deploy,
  dan `WATCHDOG_TARGETS` memang disediakan untuk itu.
- **Persistensi file terbatas.** `data/reports.jsonl` adalah file lokal.
  Pada hosting diskless/serverless, redeploy menghapus riwayat dan rantai
  dimulai dari awal (dengan identitas baru pula bila tanpa kunci stabil).
  Untuk riwayat permanen, log perlu dipindah ke penyimpanan persisten —
  belum diimplementasikan.
- **Klasifikasi `stalled` bersifat relatif.** Ia hanya berarti "target ini
  diam sementara yang lain maju", bukan diagnosis penyebabnya.
- **Yang sudah diverifikasi live:** server menjawab 3 siklus nyata (6
  observasi, 2 target), klasifikasi `healthy → degraded → down` teramati,
  dan `scripts/verify.js` mengonfirmasi rantai + tanda tangan atas log live
  tersebut. Yang belum: perilaku jangka panjang, target ketiga dalam
  kondisi sehat, dan pengoperasian dari jaringan deploy. Detail lengkap di
  `TEST_REPORT.md`.
