# FASIH Auto-Complete

Kumpulan userscript Tampermonkey untuk membantu pengisian dokumen FASIH SE2026 (fasih-sm.bps.go.id) secara otomatis. Semua skrip jalan 100% di browser sendiri — file Excel dibaca langsung di memori browser, datanya tidak pernah dikirim ke server mana pun selain FASIH itu sendiri.

Ada dua skrip di folder ini, untuk dua tahap pekerjaan yang berbeda:

| File | Nama di Tampermonkey | Buat apa |
|---|---|---|
| [`script`](script) | FASIH Batch Otomatis - Tahap 1 + 2 | Transkripsi hasil penyisiran Excel ke dokumen FASIH: cari dokumen rumah tangga yang cocok, isi Blok P + Blok II (usaha lama/baru), tentukan KBLI, kirim & approve. |
| [`fasih-koreksi-r27.user.js`](fasih-koreksi-r27.user.js) | FASIH Koreksi R.27 - Pendapatan (27.a / 27.b) | Ganti isian 27.a (`nilai_pendapatan`) = R.27a dan 27.b (`pendapatan_lain`) = R.27b di kartu usaha yang tepat, lalu kirim & approve. |
| [`fasih-ganti-wilayah-oss.user.js`](fasih-ganti-wilayah-oss.user.js) | FASIH OSS -> Keluarga: Pindah + Tautkan | Pindahkan assignment OSS ke SLS keluarganya (Ganti Wilayah), lalu tautkan ke usaha keluarga lewat "Pilih UMKM dalam satu SLS" — atau tutup/gandakan kalau memang tidak ada yang cocok. |

Semuanya independen — bisa dipasang salah satu atau dua-duanya sekaligus.

## Instalasi

1. Pasang ekstensi **Tampermonkey** di Chrome/Edge/Firefox.
2. Buka dashboard Tampermonkey → **Create a new script**, lalu tempel seluruh isi file yang mau dipakai. (Untuk file [`script`](script): karena namanya tanpa akhiran `.user.js`, Tampermonkey tidak bisa langsung drag-drop — harus copy-paste isinya ke editor Tampermonkey, atau ganti nama filenya jadi `*.user.js` dulu baru di-drag.)
3. Simpan. Buka halaman `https://fasih-sm.bps.go.id/...` — tombol pelontar skrip akan muncul mengambang di pojok kiri bawah.

---

## 1. `script` — FASIH Batch Otomatis (Tahap 1 + 2)

### Gambaran umum

Skrip ini untuk tahap **penyisiran**: kamu sudah punya data usaha rumah tangga hasil survei lapangan dalam Excel (kolom `Tindak Lanjut Fasih` = FALSE/0 artinya belum diisi ke FASIH), dan skrip ini akan: **cari dokumen FASIH rumah tangga yang cocok → buka → isi Blok P & Blok II → tentukan KBLI → kirim → approve**, baris demi baris, otomatis.

> ⚠️ **Provinsi/Kabupaten dikunci ke KALIMANTAN SELATAN / HULU SUNGAI TENGAH** di dalam kode — bukan pengaturan di panel. Kalau dipakai di kabupaten lain, isi default ini harus diubah langsung di source code-nya.

### Format Excel yang dibaca

Semua sheet di workbook dibaca (bukan cuma satu sheet bernama tertentu). Header kolom dicocokkan **tanpa peduli huruf besar/kecil dan boleh sebagian kata** (substring), jadi nama kolom persisnya fleksibel asal mengandung kata kuncinya:

| Kolom wajib ada | Kata kunci di header |
|---|---|
| Kepala Rumah Tangga | "kepala rumah tangga" |
| Tindak Lanjut Fasih | "tindak lanjut fasih" (baris dipakai hanya kalau isinya `0`/`FALSE`) |

Kolom opsional yang dipakai kalau ada: nama petugas, no urut bangunan, alamat rumah, nama usaha, penanggung jawab, produk yang dihasilkan, tenaga kerja (laki/perempuan/dibayar/tidak dibayar), upah/gaji, biaya produksi, pembelian barang, biaya operasional/non-operasional, pendapatan/nilai produksi, aset tanah & bangunan, aset selain itu, luas tanah, tahun berdiri, PML (dipakai sebagai cadangan kalau tahun berdiri kosong).

Sheet yang tidak punya kolom KRT atau Tindak Lanjut Fasih otomatis dilewati. Satu KRT boleh punya beberapa baris usaha (usaha ke-1, ke-2, dst) — semuanya masuk ke dokumen FASIH yang sama.

**Resume otomatis**: status progres TIDAK disimpan balik ke Excel. Kalau file Excel yang sama dimuat ulang, skrip mencocokkan baris lama vs baru (sheet + nomor baris + nama KRT) dan mempertahankan status/hasil yang sudah ada — tidak mengulang dari nol.

### Cara mencari dokumen yang cocok

1. **Tentukan desa** dari alamat Excel (cocokkan nama desa persis / nama tanpa spasi / fuzzy-match), atau ditebak dari nama jalan yang sama / nama petugas yang sama kalau baris-baris lain di sekitarnya sudah ketemu desanya. Kalau tidak ketemu sama sekali → baris ditandai **kuning**, bisa diisi manual lewat tombol "Set desa".
2. Filter daftar dokumen FASIH ke Kecamatan+Desa (+SLS/RT kalau kebaca dari alamat).
3. Cari berdasarkan nama KRT, lalu skor tiap kandidat dari kemiripan nama (toleran typo, urutan kata, nama panggilan seperti Muhammad/Muhamad/Haji) + kecocokan "No urut bangunan".
4. Hasilnya: **hijau** (1 kandidat jelas paling cocok → langsung diisi), **kuning** (beberapa kandidat sama kuatnya → pilih manual di panel lewat "▶ Pilih & isi"), atau **merah** (tidak ketemu sama sekali).
5. Bisa juga ditautkan manual lewat tombol "📎 Set link" (paste link dokumen FASIH-nya langsung).

### Yang diisi di dokumen

- **Blok P**: semua kategori usaha yang relevan (tanaman pangan, hortikultura, perkebunan, peternakan, kehutanan, perikanan, jasa pertanian, usaha keliling, konstruksi, kos, usaha lain) dijawab "Ya" sesuai KBLI produknya; kategori yang ternyata tidak ada kartu usahanya di Blok II otomatis dibalik lagi ke "Tidak".
- **Blok II**: dicocokkan ke kartu usaha yang **sudah ada** (usaha lama) berdasar kemiripan nama, atau kalau tidak ada yang cocok → **Tambah Baru**. Field yang diisi per usaha: nama usaha (+nama pemilik), alamat (dipadatkan otomatis kalau kependekan), RT, No HP (diperbaiki otomatis — format harus `08xxxxxxxx` atau `9999`), jenis kawasan, jenis usaha, Provinsi/Kabupaten, NIB, badan usaha, laporan keuangan, **penanggung jawab usaha (12.a)**, kegiatan utama, KBLI, input/proses (dibuat otomatis dari kata kunci produk), serta semua angka dari Excel (tenaga kerja, gaji, biaya, pendapatan, aset).
- **KBLI 2025**: dicocokkan otomatis lewat kamus kata kunci (~1.559 kode) + "kamus" belajar yang tersimpan di browser (produk yang sama akan otomatis pakai kode yang sama di lain waktu). Kalau tidak yakin/bentrok dengan Kegiatan Utama, muncul dialog konfirmasi berisi kandidat untuk dipilih manual — bisa juga diselesaikan semua sekaligus sebelum mulai lewat tombol **"🏷 Tentukan KBLI · N produk"** di panel.
- **Penanggung jawab usaha**: diambil dari kolom "penanggung jawab" Excel; kalau orang itu ternyata sudah tidak tinggal di rumah (meninggal/pindah), otomatis diganti ke anggota rumah tangga lain yang masih tinggal, dan dicatat sebagai catatan di baris tersebut.
- **Galat (validasi)**: sebelum kirim, semua galat yang muncul dicoba diperbaiki otomatis (sampai 3 putaran) lewat berbagai aturan bawaan (angka kosong → 0, tahun 2026 → 2025, field kepanjangan dipotong, dsb). Kalau masih ada galat yang tidak bisa diperbaiki otomatis, baris itu ditandai perlu dicek manual — **tidak ada jalur "kirim paksa" di skrip ini**, galat harus 0 dulu sebelum terkirim.

### Kirim & Approve

Sebelum Kirim, toggle "Tampilkan Anomali Usaha dan Keluarga" di halaman CATATAN selalu dinyalakan dulu. Lalu klik Kirim → (galat diperbaiki kalau ada) → Konfirmasi → (opsional) Approve otomatis kalau toggle "Approve setelah kirim" aktif.

### Panel kontrol

Buka lewat tombol mengambang **"⚡ FASIH Otomatis"** di kiri bawah, atau **Alt+7**.

- **Kotak statistik** (klik buat filter): Belum dicek, Hijau/siap, Terkirim, Kuning, Merah, Terisi (uji), Dibuka manual, Semua.
- **Persiapan**: Muat Excel, Baca daftar wilayah (sekali saja), Tentukan KBLI (kalau ada produk belum terpetakan), jeda setelah loading (2–30 detik).
- **Jalankan otomatis**: mode **Uji** (berhenti di halaman CATATAN tiap dokumen, perlu klik "✓ Kirim sekarang"/"Lewati") vs **Otomatis penuh** (langsung kirim tanpa berhenti); kecepatan **Cepat / Normal / Aman** + saklar **⚡ Turbo** (cuma aktif di kecepatan Cepat, mati sendiri kalau kena 429); tombol jalan: ▶ Yang dicentang, ▶ 5, ▶ 10, ▶ 20, ▶ Semua.
- **Daftar baris**: pencarian, centang semua/hapus centang, "📍 Set desa (dicentang)" buat set desa banyak baris sekaligus, dan per baris: Cari & buka, Set desa, Set link manual, Buka dokumen, Isi langsung.
- **⋯ Menu lainnya**: "🔍 Cek kecocokan semua" (cuma cari & skor, belum isi — buat review dulu), "Buka berikutnya (manual)", "↻ Kuning/merah → cek ulang", "🗑 Hapus antrean", saklar "Buka manual di tab baru".
- Status progres tampil di bar bawah-tengah selama proses jalan, dengan tombol Lanjut/Jeda/Stop dan ringkasan terkirim/kuning/merah.
- **"📋 Simpan HTML form"** (tombol kecil pojok kanan bawah, muncul di semua halaman termasuk saat edit dokumen) — murni alat bantu debug: menyimpan HTML form yang sedang tampil jadi file, buat dikirim ke pembuat skrip kalau ada masalah yang perlu dicek.

### Ekspor / Impor data

- **"⬇ Laporan CSV"** — laporan hasil kerja yang bisa dibaca orang (status, alasan, KBLI, dsb). Ini laporan, bukan buat dimuat balik.
- **"💾 Export data"** — ekspor **seluruh state kerja** (antrean + daftar wilayah yang sudah dibaca + kamus KBLI) jadi satu file JSON, supaya bisa lanjut kerja di laptop lain tanpa baca ulang Excel / baca ulang daftar wilayah dari nol.
- **"📂 Import data"** — muat file itu balik. Ini **menimpa** data yang ada di laptop/browser saat itu (selalu dikonfirmasi dulu sebelum menimpa).

### Kecepatan & rate limit (429)

Server FASIH membalas 429 kalau kebanyakan permintaan. Begitu kedeteksi, skrip otomatis berhenti (15/30/60 menit, makin lama kalau berulang dalam 2 jam terakhir) lalu lanjut sendiri, dan level kecepatan ikut diturunkan sementara. Ada juga batas jumlah dokumen/jam sesuai level kecepatan yang dipakai.

---

## 2. `fasih-ganti-wilayah-oss.user.js` — OSS → Keluarga: Pindah + Tautkan

### Gambaran umum

Skrip ini untuk tahap **menautkan OSS ke keluarga**: assignment OSS dipindah wilayahnya (⋮ > Ganti Wilayah) ke SLS keluarga yang jadi pemiliknya, lalu dokumen keluarga dibuka untuk:
1. Menyalin **Blok P** (alamat, nomor bangunan, geotag) dari keluarga ke OSS, dan
2. **Menautkan** OSS ke usaha yang sesuai lewat isian "Pilih UMKM dalam satu SLS" di kartu usaha keluarga.

Hasil akhirnya salah satu dari:
- **Ditemukan** — OSS tertaut ke satu usaha keluarga; alamat & geotag keluarga disalin ke OSS.
- **Tutup** — keluarga tidak punya usaha, atau usahanya ada tapi OSS ini memang tidak ada di pilihan UMKM mana pun.
- **Ganda** — kartu usaha keluarga tidak punya isian "Pilih UMKM dalam satu SLS" sama sekali (baik karena kolomnya memang tidak ada, atau ada tapi terkunci/disabled) → artinya usaha itu sudah dicatat langsung oleh keluarga, jadi OSS ini dianggap data ganda.

Keluarga & OSS, dua-duanya dikirim dan (opsional) di-approve.

### Format Excel yang dibaca

Sheet bernama **"Pindah"** (kalau tidak ada, pakai sheet pertama). Kolom wajib: `assignment_id`, `kec_kode`, `desa_kode`, `sls_asal`, `nama_usaha`, `sls_tujuan`, `subsls_tujuan`. Kolom opsional yang ikut dipakai: `proses` (isi `1`/`YA`/`Y`/`TRUE` supaya baris diproses — kalau kolom ini ada tapi isinya bukan itu, baris dilewati), `yakin`, `kec_nama`, `desa_nama`, `subsls_asal`, `sls_asal_nama`, `sls_tujuan_nama`, `kel_anggota`, `link_oss`, `link_keluarga`, `kel_assignment_id` (atau diambil dari link keluarga), `status_awal` (isi "dipindah" kalau baris itu dari laporan sebelumnya sudah dipindah tapi belum ditautkan, supaya langsung lanjut ke tahap tautkan tanpa pindah ulang).

Memuat ulang file Excel yang sama akan mempertahankan status baris yang sudah diproses (bukan status "belum dipindah").

### Panel kontrol

Buka lewat tombol mengambang **"🔀 OSS → Keluarga"** di kiri bawah, atau **Alt+8**.

- **Persiapan**: Muat Excel target, email Pengawas & Pencacah (buat isian petugas saat Ganti Wilayah), kecepatan **Turbo/Kilat/Cepat/Normal**, saklar "setelah dipindah: buka keluarga, pilih UMKM, isi OSS, kirim" dan "Approve setelah kirim", ID survei (UUID prefix URL, dipelajari otomatis), saklar "Wajib cocok assignment_id" (lebih ketat, bisa lebih banyak masuk kategori "perlu cek").
- **Kotak statistik** (klik buat filter, termasuk filter khusus **"OSS Ganda"** yang baca sub-kategori dari status "OSS tutup"): Belum dipindah, Dipindah/belum ditautkan, Ditautkan, OSS tutup, **OSS Ganda**, Perlu cek, Gagal, Uji, Semua.
- **Jalankan**:
  - **🧪 Uji 1** — jalankan 1 baris, berhenti sebelum tiap Kirim (dialog Ganti Wilayah, Kirim keluarga, Kirim OSS) buat diperiksa manual lewat tombol "✓ Kirim sekarang"/"Lewati" di bar atas.
  - **🔗 Tautkan yang sudah dipindah** — lanjutkan baris yang statusnya "dipindah" tapi belum ditautkan.
  - **⚡ Force submit ulang OSS ditemukan** — kirim ulang (revoke → Submit Paksa → approve) OSS yang sudah **Ditemukan/tertaut**, tanpa menyentuh keluarga. Dipakai misalnya setelah skrip-nya diperbaiki dan OSS lama perlu di-refresh.
  - **🔎 Cek ulang Ganda dari OSS Tutup** — lihat bagian khusus di bawah.
  - **▶ Yang dicentang / ▶ 5 / ▶ 20 / ▶ Semua** — jalankan baris sesuai pilihan, mulai dari fase pindah wilayah lalu lanjut tautkan.
- **Centang semua tampil / Kosongkan centang** — centang cepat semua baris yang sedang ditampilkan (menghormati filter status & pencarian aktif), buat dipakai bareng "▶ Yang dicentang". *(Catatan: "▶ Yang dicentang" cuma memproses baris yang statusnya bukan `Ditautkan`/`OSS tutup` — untuk baris yang sudah selesai dan mau dicek ulang, pakai tombol Force Submit / Cek ulang Ganda, bukan ini.)*
- Baris lain: Reset Gagal/Perlu cek → belum, Hapus antrean.
- Tiap baris menampilkan badge status (termasuk badge terpisah "OSS Ganda"), alasan, dan link cepat ke dokumen OSS & Keluarga.

### 🔎 Cek ulang Ganda dari OSS Tutup

Fitur ini mengoreksi baris "OSS Tutup" lama yang alasannya "tidak ada di pilihan UMKM" — sebelum diperbaiki, kartu usaha tanpa isian Pilih UMKM selalu kebaca salah sebagai Tutup, padahal seharusnya Ganda.

Cara kerjanya **dirancang hemat revoke**: dicek dulu dari halaman **Review keluarga tanpa klik Edit sama sekali** (halaman Review ternyata menampilkan field yang sama, cuma dikunci). Hasilnya menentukan langkah:
- **Tetap Tutup** → baris tidak disentuh sama sekali (keluarga maupun OSS), cuma ditandai sudah dicek supaya tidak diulang terus tiap tombol diklik lagi.
- **Ternyata Ganda** → keluarga tetap tidak disentuh, cuma **OSS yang direvoke** untuk diubah ke kode Ganda.
- **Ternyata ada kemungkinan cocok ke UMKM** → baru di sini keluarga direvoke, karena memilih UMKM memang butuh mode Edit.

### Ekspor / Impor Antrean

- **"⬇ Laporan CSV"** — laporan status untuk dibaca manusia (alasan, hasil tautan, alamat yang disalin, dll).
- **"⬇ Ekspor Antrean"** — unduh **seluruh antrean mentah** (semua field + progres + pengaturan) sebagai JSON. Tidak perlu lagi bawa file Excel aslinya untuk lanjut kerja, karena semua data Excel sudah ikut tersimpan di sini.
- **"📤 Impor Antrean"** — muat file itu di laptop lain untuk lanjut persis dari titik terakhir (dikonfirmasi dulu sebelum menimpa antrean yang ada).

### Status & label

| Status | Arti |
|---|---|
| Belum dipindah | belum diproses sama sekali |
| Dipindah, belum ditautkan | wilayah sudah dipindah, tautan ke keluarga belum dikerjakan |
| Ditautkan | selesai, OSS Ditemukan & tertaut ke usaha keluarga |
| OSS tutup | selesai, OSS Tutup (atau **Ganda** — lihat badge/filter terpisah) |
| Terisi (uji) | diisi di Mode Uji tapi sengaja tidak dikirim |
| Gagal | error yang menghentikan baris itu |
| Perlu cek | kemungkinan soft-error (misal nama tidak unik, data OSS sudah dipindah sebelumnya) |

### Kecepatan & rate limit (429)

Sama seperti skrip Batch Otomatis — memakai key `localStorage` yang sama (`fasih_rate_limit`), jadi kalau salah satu skrip kena 429, jeda berlaku untuk keduanya sekaligus. Level kecepatan juga otomatis turun satu tingkat tiap kena 429.

---

## 3. `fasih-koreksi-r27.user.js` — Koreksi Pendapatan R.27

Panel: tombol **"27 Koreksi Pendapatan"** di kiri bawah, atau **Alt+9**. Bisa mulai dari halaman FASIH mana saja, karena tiap dokumen dibuka lewat kolom `link` di Excel.

**Kolom Excel**: `link`, `nilai_pendapatan`, `pendapatan_lain` (nilai lama), `R.27a`, `R.27b` (nilai baru). Kolom opsional yang ikut ditampilkan: `nama_usaha`, `idsbr`, `kec`, `desa`, `nm_sls`, `assignment_status_alias`. Baris dengan link yang sama digabung jadi satu dokumen (keluarga dengan beberapa usaha).

**Alur per dokumen**: Buka → (opsional) cek di Review → Edit/Revoke → ganti 27.a & 27.b → Kirim → Approve.
- **Dokumen keluarga**: masuk Blok II, kartu usaha dicek satu per satu. **Dokumen usaha tunggal**: langsung ke satu-satunya kartu.
- Kartu yang benar dikenali dari **nilai lamanya** (27.a & 27.b sama persis dengan Excel). Kalau nilainya sudah sama dengan nilai baru, kartu itu dianggap sudah sesuai. Kalau tidak ada yang persis sama, dipakai jumlah 27.a+27.b yang sama ditambah nama yang mirip (atau memang cuma ada satu kartu). Kalau tetap tidak cocok, kartu **tidak diubah** dan dokumennya ditandai "Perlu cek".
- **Cek dulu di Review** (default aktif): dokumen yang nilainya sudah benar tidak di-revoke sama sekali.
- **Galat**: default-nya berhenti dan ditandai "Perlu cek". Aktifkan "Submit Paksa kalau ada galat" kalau galatnya memang boleh diabaikan.
- **Mode uji** (🧪 Uji 1 dokumen): berhenti tepat sebelum Kirim, lalu pilih "✓ Kirim sekarang" atau "Lewati".

## Catatan

- Kedua skrip menyimpan semua progres di `localStorage` browser (per-perangkat, per-browser). Pakai fitur Ekspor/Impor di masing-masing panel kalau mau pindah laptop.
- Mode uji di kedua skrip ada supaya baris pertama bisa diperiksa manual dulu sebelum menjalankan sisanya tanpa berhenti.
- Jangan refresh halaman berulang-ulang saat kena rate limit (429) — skrip sudah menangani jeda otomatis dan akan lanjut sendiri.

## Feedback

Jangan lupa upload hasil feedback ke sini:
https://drive.google.com/drive/folders/1PFLyovJrbNZaNGzyBiuJ7MlQsy6EAvPY
