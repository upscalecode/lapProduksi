# Mengaktifkan perbaikan performa

1. Perbarui kode project Google Apps Script dengan `Code.gs` dari repository ini.
2. Dari editor Apps Script, jalankan `setupPerformanceMaintenance()` sekali dan selesaikan otorisasi Google. Fungsi ini memasang satu trigger pembersihan sesi setiap jam; menjalankannya kembali tidak membuat trigger ganda. Tidak perlu menjalankan ulang `setupSpreadsheet()`.
3. Perbarui deployment Web App yang digunakan aplikasi ke versi kode terbaru. Pertahankan URL deployment yang sama; jika memakai URL baru, perbarui `CONFIG.WEB_APP_URL` di `script.js`.
4. Unggah seluruh HTML, `script.js`, dan `style.css` terbaru ke hosting aplikasi, lalu refresh browser. Versi URL JavaScript pada HTML harus ikut diperbarui agar browser tidak memakai kode navigasi lama.

Login tidak lagi melakukan pembersihan sesi. Saat aplikasi dibuka, satu snapshot periode awal dimuat untuk seluruh menu yang diizinkan: bulan berjalan dan tujuh hari terakhir jika melintasi bulan. Setelah pemuatan awal selesai, perpindahan tab dan submenu laporan memakai data dalam memori tanpa request atau loading baru. Tabel operasional tetap menampilkan hari ini; laporan dimulai pada bulan berjalan. SPK yang belum selesai dan saldo Press lama tetap disertakan.

Filter yang meminta periode di luar snapshot mengambil data periode tersebut sekali, lalu menggabungkannya tanpa menghapus data periode awal. Membuka kembali periode yang sudah diambil tidak membuat request baru. Berganti hari, refresh halaman, atau tombol Muat Ulang memperbarui data; perubahan pengguna lain tidak otomatis muncul hanya dengan berpindah tab. Penyimpanan dan penghapusan lokal tetap memperbarui state yang digunakan bersama oleh semua tab.

Jika backend versi sebelumnya belum mengenali snapshot seluruh menu, frontend memakai endpoint appdata lengkap yang sudah ada. Navigasi tetap bisa memakai data awal, tetapi pembatasan riwayat memerlukan deployment backend terbaru.

Respons halaman di-cache selama 60 detik, terpisah per pengguna, hak akses, halaman, dan periode. Penulisan melalui API aplikasi membatalkan cache sebelum dan sesudah operasi, termasuk ketika operasi gagal setelah sebagian perubahan. Perubahan langsung di Spreadsheet atau lewat fungsi editor dapat baru terlihat setelah cache kedaluwarsa. Respons besar dibaca langsung tanpa cache.

Data produksi tidak dihapus atau diarsipkan oleh perbaikan ini. Backend masih membaca kolom ringkasan riwayat untuk menjaga kapasitas SPK dan saldo lama; detail hanya dikirim sesuai periode. Tabel tetap memakai pagination browser yang sudah ada. Memilih semua periode atau menyimpan perubahan yang membutuhkan alokasi seluruh riwayat masih bisa lebih lambat. Kecepatan deployment perlu diukur langsung; tes lokal tidak mengukur latensi Google atau jaringan.

Verifikasi lokal: `node --test tools/*.test.mjs` dan `node --check script.js`.

## Alasan SPK dan penutupan Filling

Form SPK memiliki kolom Alasan opsional, maksimal 500 karakter, termasuk saat preview diedit dan disimpan batch. Backend menambah kolom M–Q pada sheet SPK: Alasan, Qty Filling Ditutup, Alasan Penutupan Filling, Ditutup Filling Oleh, dan Ditutup Filling Pada. Kolom A–L dipertahankan. Kolom tambahan yang tidak dikenali akan menghentikan migrasi agar tidak ditimpa.

Tombol Hapus pada antrean SPK → Filling, termasuk Hapus Massal, menutup sisa SPK dengan alasan wajib 5–500 karakter. Aksi ini menyimpan jumlah sisa berdasarkan data server, operator, dan waktu; tidak menghapus SPK atau data produksi dan tidak mengurangi saldo Press yang sudah terbentuk. Preview Filling terkait harus disimpan atau dibuang terlebih dahulu. Setelah ditutup, SPK tidak menerima Filling baru atau perubahan Qty; koreksi data tersimpan tanpa perubahan Qty tetap diizinkan. Penutupan juga menghilangkan sisa tersebut dari antrean dan alert Filling.

Izin mengikuti pola penutupan Press: Administrator Filling, atau akses baca Filling dengan izin Hapus Sisa Filling / Press (`deleteUnpressed`). Tidak ada fitur membuka kembali penutupan. Deployment `Code.gs` terbaru diperlukan sebelum memakai penutupan Filling. Unggah HTML, JavaScript, dan CSS terbaru, lalu refresh browser.
