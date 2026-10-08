# FASIH Auto-Complete

Kumpulan userscript Tampermonkey untuk membantu pengisian dokumen FASIH SE2026 (fasih-sm.bps.go.id) secara otomatis. Semua skrip jalan 100% di browser sendiri — file Excel dibaca langsung di memori browser, datanya tidak pernah dikirim ke server mana pun selain FASIH itu sendiri.

Ada beberapa skrip di folder ini, untuk dua tahap pekerjaan yang berbeda:

| File | Nama di Tampermonkey | Buat apa |
|---|---|---|
| [`script`](script) | FASIH Batch Otomatis - Tahap 1 + 2 | Transkripsi hasil penyisiran Excel ke dokumen FASIH: cari dokumen rumah tangga yang cocok, isi Blok P + Blok II (usaha lama/baru), tentukan KBLI, kirim & approve. |
| [`fasih-koreksi-r27.user.js`](fasih-koreksi-r27.user.js) | FASIH Koreksi R.27 - Pendapatan (27.a / 27.b) | Ganti isian 27.a (`nilai_pendapatan`) = R.27a dan 27.b (`pendapatan_lain`) = R.27b di kartu usaha yang tepat, lalu kirim & approve. Pintasan Alt+9. |
| [`fasih-koreksi-gaji.user.js`](fasih-koreksi-gaji.user.js) | FASIH Koreksi Gaji + R.27 (gaji / 27.a / 27.b) | Sama persis dengan Koreksi R.27 (semua fitur di bagian 3), ditambah isian `gaji` = kolom Gaji dari Excel upah/gaji. Pintasan Alt+6. |
| [`fasih-koreksi-ntb.user.js`](fasih-koreksi-ntb.user.js) | FASIH Koreksi Anomali NTB (26.a - 28.b) | Sama persis dengan Koreksi R.27 (bagian 3), untuk Excel Pengecekan Anomali NTB: ganti 26.a–26.d, 27.a dan 28.b (dari kolom r28c) = kolom `rXX input`, plus catatan `#DC_04` di tiap rincian yang diubah. Muat puluhan ribu dokumen. Pintasan Alt+5. |
| [`fasih-ganti-wilayah-oss.user.js`](fasih-ganti-wilayah-oss.user.js) | FASIH OSS -> Keluarga: Pindah + Tautkan | Pindahkan assignment OSS ke SLS keluarganya (Ganti Wilayah), lalu tautkan ke usaha keluarga lewat "Pilih UMKM dalam satu SLS" — atau tutup/gandakan kalau memang tidak ada yang cocok. |

Semuanya independen — bisa dipasang salah satu atau dua-duanya sekaligus.

## Instalasi

Panduan versi bergambar (ilustrasi tiap langkah): <https://claude.ai/artifact/UhoGB1C5nHAvidE5DguKKP>, atau ikuti langkah teks di bawah ini.

### 1. Pasang ekstensi Tampermonkey

Pasang ekstensi **Tampermonkey** di browser (Chrome, Edge, atau Firefox) lewat halaman Web Store/Add-ons resmi browser masing-masing — cari "Tampermonkey" di sana.

### 2. Nyalakan "Allow User Scripts" (WAJIB di Chrome/Edge versi baru — paling sering kelewat!)

Chrome dan Edge versi baru mewajibkan izin tambahan supaya Tampermonkey boleh menjalankan skrip buatan sendiri (bukan yang dipasang dari toko resmi). **Tanpa langkah ini, skrip di repo ini akan kelihatan "Enabled" di Tampermonkey tapi sebenarnya tidak pernah jalan** — tidak ada tombol mengambang yang muncul di FASIH, dan tidak ada log apa pun di Console. Ini penyebab paling umum kalau "sudah dipasang tapi kok tidak ada reaksi sama sekali".

Firefox **tidak perlu** langkah ini — langsung lompat ke bagian 3.

Untuk Chrome/Edge:
1. Buka `chrome://extensions` (Edge: `edge://extensions`).
2. Nyalakan **Developer mode** di pojok kanan atas kalau belum nyala.
3. Cari kartu **Tampermonkey**, klik **Details** (Detail).
4. Di halaman detail itu, cari saklar **"Allow User Scripts"** (kadang diterjemahkan "Izinkan Skrip Pengguna" / "Izinkan Tampermonkey mengelola skrip pengguna") — nyalakan.
5. Kalau saklar itu tidak ada di halaman Detail, biasanya artinya Developer mode belum aktif (ulangi langkah 2) atau versi Tampermonkey-nya perlu diperbarui dulu.

### 3. Tempel isi skrip ke Tampermonkey

1. Klik ikon Tampermonkey di toolbar browser → **Dashboard**.
2. Klik tombol **"+"** (Create a new script).
3. Hapus semua isi editor bawaan (Ctrl+A lalu Delete), lalu tempel **seluruh isi** file skrip yang mau dipakai dari tabel di atas (buka file-nya, select all, copy, lalu paste di editor Tampermonkey).
   > Khusus file [`script`](script): namanya tanpa akhiran `.user.js`, jadi Tampermonkey **tidak bisa** drag-drop langsung — harus copy-paste manual seperti di atas. File yang namanya sudah `*.user.js` ([`fasih-koreksi-r27.user.js`](fasih-koreksi-r27.user.js), [`fasih-ganti-wilayah-oss.user.js`](fasih-ganti-wilayah-oss.user.js)) sebenarnya bisa langsung di-drag ke halaman Dashboard Tampermonkey untuk dipasang otomatis, tapi copy-paste manual tetap berlaku sama kalau lebih mudah.
4. Simpan dengan **Ctrl+S** (atau menu **File → Save**).
5. Cek status skrip itu di daftar Dashboard: saklarnya harus **hijau (Enabled)**. Skrip baru biasanya otomatis aktif, tapi tidak ada salahnya dicek ulang.
6. Ulangi langkah 2–5 untuk tiap skrip lain yang mau dipasang — ketiganya independen, boleh pasang satu, dua, atau semuanya sekaligus.

### 4. Pastikan jalan di FASIH

1. Buka halaman `https://fasih-sm.bps.go.id/...` (halaman **DATA survei**, bukan halaman login).
2. Tombol pelontar mengambang akan muncul di pojok kiri bawah — ikonnya tergantung skrip mana yang aktif: **⚡ FASIH Otomatis** (Batch Otomatis), **🔀 OSS → Keluarga** (Ganti Wilayah OSS), **27 Koreksi Pendapatan** (R.27), **Rp Koreksi Gaji** (Koreksi Gaji), atau **NTB Koreksi NTB** (Koreksi Anomali NTB). Kalau lebih dari satu skrip dipasang, semua tombolnya numpuk di situ.
3. Buka Console browser (tekan **F12** → tab **Console**) dan refresh halaman. Harus ada baris log seperti `[FASIH Batch Otomatis v2.0] Skrip termuat di ...` (teksnya beda-beda tergantung skrip). **Kalau log ini tidak muncul sama sekali**, skrip belum benar-benar jalan — balik cek langkah 2 (Allow User Scripts) dan langkah 3.5 (status Enabled).
4. Kalau muncul izin browser semacam "Izinkan ekstensi ini membaca dan mengubah data Anda di situs ini" saat halaman FASIH pertama kali dibuka, klik **Allow/Izinkan** — tanpa ini skrip tidak bisa membaca/mengisi form.

### Memperbarui skrip setelah ada perbaikan

Kalau salah satu skrip diperbaiki (misalnya setelah laporan bug), tidak perlu pasang ulang dari nol:
1. Buka skrip yang sama di Dashboard Tampermonkey (klik nama skripnya).
2. **Select all** isi editornya (Ctrl+A), hapus, lalu tempel isi file yang sudah diperbarui.
3. Ctrl+S lagi.

Progres kerja (antrean Excel yang sudah dimuat, daftar wilayah, kamus KBLI, dll) tersimpan terpisah di `localStorage` browser, **tidak ikut hilang** saat isi skrip ditimpa ulang seperti ini.

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
- **"🧩 Gabung rekap JSON"** (di kartu ① Data Excel & wilayah, sebelah Muat Excel) — kalau Excel sudah dimuat tapi rekap JSON lama tertinggal, pilih file export itu. Baris dicocokkan per `id` + nama KRT; yang sudah terkirim di rekap ditandai dan tidak dikerjakan ulang. Ringkasannya ditampilkan dulu sebelum diterapkan.

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
- **Kotak statistik** (klik buat filter, termasuk filter khusus **"OSS Ganda"** yang baca sub-kategori dari status "OSS tutup"): Belum dipindah, Dipindah/belum ditautkan, Ditautkan, OSS tutup, **OSS Ganda**, Perlu cek, Gagal, Selesai manual, Uji, Semua.
- **Jalankan**:
  - **🧪 Uji 1** — jalankan 1 baris, berhenti sebelum tiap Kirim (dialog Ganti Wilayah, Kirim keluarga, Kirim OSS) buat diperiksa manual lewat tombol "✓ Kirim sekarang"/"Lewati" di bar atas.
  - **🔗 Tautkan yang sudah dipindah** — lanjutkan baris yang statusnya "dipindah" tapi belum ditautkan.
  - **⚡ Force submit ulang OSS ditemukan** — kirim ulang (revoke → Submit Paksa → approve) OSS yang sudah **Ditemukan/tertaut**, tanpa menyentuh keluarga. Dipakai misalnya setelah skrip-nya diperbaiki dan OSS lama perlu di-refresh.
  - **🔎 Cek ulang Ganda dari OSS Tutup** — lihat bagian khusus di bawah.
  - **▶ Yang dicentang / ▶ 5 / ▶ 20 / ▶ Semua** — jalankan baris sesuai pilihan, mulai dari fase pindah wilayah lalu lanjut tautkan.
- **Centang semua tampil / Kosongkan centang** — centang cepat semua baris yang sedang ditampilkan (menghormati filter status & pencarian aktif), buat dipakai bareng "▶ Yang dicentang". *(Catatan: "▶ Yang dicentang" cuma memproses baris yang statusnya bukan `Ditautkan`/`OSS tutup` — untuk baris yang sudah selesai dan mau dicek ulang, pakai tombol Force Submit / Cek ulang Ganda, bukan ini.)*
- **✓ Pilih status akhir** — untuk baris yang sudah kamu selesaikan manual di FASIH (biasanya dari Gagal/Perlu cek). Centang baris-baris itu, klik tombol ini, lalu pilih status akhirnya: **Ditautkan**, **Tutup**, **Ganda**, atau **Selesaikan sendiri** (baris tidak dihitung sebagai ketiga status lain, cuma ditandai selesai). Pilihanmu ikut terbaca di Laporan CSV (kolom `status` & `hasil_tautan`), jadi kelihatan jelas baris itu akhirnya masuk ke mana. Baris yang sudah dipilih tidak akan diproses otomatis lagi.
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
- **"🧩 Gabung rekap JSON"** (di Persiapan, setelah Muat Excel target) — kalau file Excel-nya sudah dimuat tapi rekap JSON lama tertinggal, pilih file rekap itu. Baris dicocokkan per `assignment_id`; baris yang sudah punya progres di rekap disalin statusnya (ditautkan / tutup / ganda / selesai manual / gagal / perlu cek), jadi tidak perlu dijalankan ulang. Sebelum diterapkan muncul ringkasan: berapa yang cocok, berapa yang belum ada progres, dan berapa baris rekap yang tidak ada di Excel ini.
- **Nama file ekspor** otomatis memakai nama wilayah dari antrean, misalnya `laporan-oss-keluarga-<KECAMATAN>-<DESA>-<tanggal-jam>.csv` atau `antrean-oss-keluarga-<DESA>-<tanggal-jam>.json`. Kalau antrean berisi beberapa desa dalam satu kecamatan, yang dipakai nama kecamatannya; kalau beberapa kecamatan, dipakai jumlah kecamatannya (mis. `3-kecamatan`).

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
| Selesai (dicek manual) | ditandai sendiri lewat "✓ Pilih status akhir → Selesaikan sendiri"; tidak diproses otomatis lagi |

### Kecepatan & rate limit (429)

Sama seperti skrip Batch Otomatis — memakai key `localStorage` yang sama (`fasih_rate_limit`), jadi kalau salah satu skrip kena 429, jeda berlaku untuk keduanya sekaligus. Level kecepatan juga otomatis turun satu tingkat tiap kena 429.

---

## 3. `fasih-koreksi-r27.user.js`, `fasih-koreksi-gaji.user.js` & `fasih-koreksi-ntb.user.js` — Koreksi R.27 / Gaji / NTB

Ketiga skrip ini **isinya sama persis**; yang beda cuma blok `KONFIGURASI` di bagian atas file (isian yang diganti, kolom Excel, nama, pintasan). Antrean & progres masing-masing terpisah, jadi boleh dipasang bersamaan.

| | Koreksi R.27 | Koreksi Gaji | Koreksi NTB |
|---|---|---|---|
| Tombol / pintasan | **27 Koreksi Pendapatan** · Alt+9 | **Rp Koreksi Gaji** · Alt+6 | **NTB Koreksi NTB** · Alt+5 |
| Isian yang diganti | 27.a ← `R.27a`, 27.b ← `R.27b` | `gaji` ← `Gaji`, 27.a ← `R.27a`, 27.b ← `R.27b` | 26.a `gaji`, 26.b `biaya_produksi`, 26.c `biaya_pembelian`, 26.d `operasional`, 27.a `nilai_pendapatan` ← `r26a input` … `r27a input`; 28.b `aset_lain_thn` ← `r28c input` |
| Kolom nilai lama | `nilai_pendapatan`, `pendapatan_lain` | `gaji` (kolom gaji yang di depan), `nilai_pendapatan`, `pendapatan_lain` | `r26a awal` … `r27a awal` (28.b tidak dipakai mengenali kartu, cuma diisi) |

**Kolom Excel**: `link` / `link_fasih`, `nama_usaha` / `Nama usaha`, kolom nilai lama & baru seperti tabel di atas. Opsional: `idsbr`, `kec`, `desa`, `nm_sls`, `nama_kab`, `assignment_status_alias`, `Isian yang harus diinput` (ditampilkan di panel).

**Catatan `#DC_04`** (Koreksi NTB): di tiap rincian yang nilainya diubah, tombol Catatan di samping isian dibuka dan `#DC_04` ditambahkan — kecuali thread-nya sudah memuat `#DC_04` (tidak diisi dua kali; catatan lain dibiarkan). Kalau nilainya sudah benar tapi catatannya belum ada, catatan tetap ditambahkan (di Review kalau bisa, kalau tidak lewat Edit). Catatan yang gagal masuk → dokumen ditandai "Perlu cek".

**Antrean besar**: antrean disimpan di IndexedDB browser (bukan localStorage), jadi puluhan ribu dokumen (mis. Excel NTB ±29 ribu dokumen) tetap muat; Excel puluhan MB terbaca dalam beberapa detik. Antrean dari versi lama dipindahkan otomatis. Baris dengan link yang sama digabung jadi satu dokumen (keluarga dengan beberapa usaha). Di Excel gaji ada dua kolom "gaji": yang **paling dekat dengan R.27a** dibaca sebagai nilai baru, yang lain nilai lama.

**Alur per dokumen**: Buka → (opsional) cek di Review → Edit/Revoke → ganti nilai → Kirim → Approve.
- **Kartu yang benar** harus cocok **nilainya** (sama dengan nilai lama/baru di Excel; R.27 juga boleh jumlah 27.a+27.b yang sama) **dan nama usahanya** (`nama_usaha` Excel). Nama dibanding tanpa bagian (PEMILIK); nomor harus sama (SDN 1 ≠ SDN 2), jenjang sekolah harus sama (SD ≠ SMP), pemilik harus sama. Nilainya cocok tapi namanya beda → kartu tidak disentuh.
- **Cek dulu di Review** (default aktif): dokumen yang nilainya sudah benar tidak di-revoke sama sekali; dokumen yang tidak memuat kartu yang cocok juga tidak di-revoke.
- **Link salah / Forbidden / tidak bisa dibuka** → dicari di halaman daftar assignment lewat **Filter Kecamatan → Desa → SLS** (dari Excel; Excel tanpa kolom wilayah langsung dicari pakai nama): BKU (nama usaha) dulu, lalu dokumen keluarga (nama pemilik di dalam kurung); kalau di SLS kosong, dicari di seluruh desa. Kandidat dicoba satu per satu sampai ada yang memuat semua usahanya. **Buka halaman daftar assignment sekali** sebelum mulai supaya alamatnya diingat. Tetap Forbidden → status "Forbidden", dilewati.
- **Galat**: default-nya berhenti dan ditandai "Perlu cek". Aktifkan "Submit Paksa kalau ada galat" kalau galatnya memang boleh diabaikan.
- **Mode uji** (🧪 Uji 1 dokumen): berhenti tepat sebelum Kirim, lalu pilih "✓ Kirim sekarang" atau "Lewati".
- **⏸ Jeda / ▶ Lanjut** di bar progres saat berjalan. Bar progres & panel bantu bisa **digeser** (tarik judulnya, klik dua kali = kembali) dan **diperkecil** (–).

**Kerjakan manual** (tombol **✍** di tiap baris): dokumen dibuka di tab ini dan muncul panel bantu di kanan bawah — nilai lama → baru, isi kartu yang sedang terbuka, tombol **✏ Isi ke kartu ini**, **✓ Tandai selesai manual**, **🏷 Status…**, **↻ Otomatis**.

**🏷 Atur status** (baris dicentang): pilih status hasil cek manual (Selesai, Sudah sesuai, Selesai manual, Perlu cek, Gagal, Forbidden, Belum) + catatan; ikut ke Laporan CSV.

**Ekspor**: ⬇ Laporan CSV (nilai lama/baru tiap isian, status, keterangan, hasil, link dokumen yang dipakai) dan 💾 Ekspor / 📂 Impor JSON; nama file memuat nama wilayah.

## Catatan

- Semua skrip menyimpan semua progres di `localStorage` browser (per-perangkat, per-browser). Pakai fitur Ekspor/Impor di masing-masing panel kalau mau pindah laptop.
- Mode uji di kedua skrip ada supaya baris pertama bisa diperiksa manual dulu sebelum menjalankan sisanya tanpa berhenti.
- Jangan refresh halaman berulang-ulang saat kena rate limit (429) — skrip sudah menangani jeda otomatis dan akan lanjut sendiri.

## Feedback

Jangan lupa upload hasil feedback ke sini:
https://drive.google.com/drive/folders/1PFLyovJrbNZaNGzyBiuJ7MlQsy6EAvPY
