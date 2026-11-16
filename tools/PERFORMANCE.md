# Mengaktifkan perbaikan performa

1. Perbarui kode project Google Apps Script dengan `Code.gs` dari repository ini.
2. Dari editor Apps Script, jalankan `setupPerformanceMaintenance()` sekali dan selesaikan otorisasi Google. Fungsi ini memasang satu trigger pembersihan sesi setiap jam; menjalankannya kembali tidak membuat trigger ganda. Tidak perlu menjalankan ulang `setupSpreadsheet()`.
3. Perbarui deployment Web App yang digunakan aplikasi ke versi kode terbaru. Pertahankan URL deployment yang sama; jika memakai URL baru, perbarui `CONFIG.WEB_APP_URL` di `script.js`.
4. Unggah `script.js` dan `style.css` terbaru ke hosting aplikasi, lalu refresh browser.

Login tidak lagi melakukan pembersihan sesi. Aplikasi meminta data sesuai halaman dan periode; Filling, Press, dan APD meminta hari ini, sedangkan Laporan Hasil dimulai pada bulan berjalan. Riwayat tetap tersedia melalui filter, termasuk pilihan semua periode. SPK yang belum selesai dan saldo Press lama tetap disertakan.

Respons halaman di-cache selama 60 detik, terpisah per pengguna, hak akses, halaman, dan periode. Penulisan melalui API aplikasi membatalkan cache sebelum dan sesudah operasi, termasuk ketika operasi gagal setelah sebagian perubahan. Perubahan langsung di Spreadsheet atau lewat fungsi editor dapat baru terlihat setelah cache kedaluwarsa. Respons besar dibaca langsung tanpa cache.

Data produksi tidak dihapus atau diarsipkan oleh perbaikan ini. Backend masih membaca kolom ringkasan riwayat untuk menjaga kapasitas SPK dan saldo lama; detail hanya dikirim sesuai periode. Tabel tetap memakai pagination browser yang sudah ada. Memilih semua periode atau menyimpan perubahan yang membutuhkan alokasi seluruh riwayat masih bisa lebih lambat. Kecepatan deployment perlu diukur langsung; tes lokal tidak mengukur latensi Google atau jaringan.

Verifikasi lokal: `node --test tools/*.test.mjs` dan `node --check script.js`.
