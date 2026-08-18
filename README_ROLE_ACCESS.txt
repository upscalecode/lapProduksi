LAPORAN PRODUKSI — CUSTOM ROLE ACCESS
=====================================

Konsep akses:

1. SUPER USER
   - Selalu memiliki akses penuh.
   - Filling dan Press.
   - Laporan.
   - Melihat semua data.
   - Edit/hapus semua data.
   - Setting / Master Data.
   - Kelola User dan Hak Akses.

2. USER BIASA
   Hak akses dapat diatur PER AKUN dari:
   SETTING > Kelola User & Hak Akses > Atur Akses

   Pilihan custom:
   - Akses Filling
   - Akses Press
   - Akses Laporan
   - Lihat Semua Data User / jika tidak dicentang hanya Data Sendiri
   - Edit Data Sendiri
   - Edit Data User Lain
   - Hapus Data Sendiri
   - Hapus Data User Lain
   - Akses Setting / Master Data

   Kelola User & Hak Akses TIDAK dapat diberikan ke User Biasa.
   Fitur tersebut tetap hanya untuk Super User.

PENYIMPANAN PERMISSION
----------------------
Sheet Users sekarang memakai kolom:
A username
B passwordHash
C name
D role
E active
F createdAt
G permissionsJson

Kolom G diisi otomatis oleh aplikasi saat Super User menekan Simpan Hak Akses.
Jangan perlu mengedit JSON secara manual.

DEFAULT USER BIASA
------------------
- Filling: YA
- Press: YA
- Laporan: TIDAK
- Data: hanya milik sendiri
- Edit data sendiri: YA
- Edit data user lain: TIDAK
- Hapus data: TIDAK
- Master Data: TIDAK

CARA UPDATE
-----------
1. Ganti Code.gs dengan file dari paket ini.
2. Jalankan setupSpreadsheet() sekali lagi dari editor Apps Script.
   Ini menambahkan header permissionsJson pada kolom G tanpa menghapus data user lama.
3. Deploy Apps Script sebagai Web App versi terbaru.
4. Pastikan CONFIG.WEB_APP_URL pada script.js mengarah ke URL /exec yang digunakan.
5. Ganti script.js dan index.html pada web Anda.
6. Logout dan login kembali sebagai Super User.
7. Buka SETTING > Kelola User & Hak Akses.
8. Pada User Biasa klik Atur Akses, centang hak yang dibutuhkan, lalu Simpan Hak Akses.
9. User yang diubah akan dipaksa login ulang supaya permission terbaru langsung aktif.

KEAMANAN
--------
Permission diperiksa lagi pada Code.gs (backend), bukan hanya dengan menyembunyikan tombol/menu di browser.
User Biasa tidak dapat memberikan hak akses kepada dirinya sendiri melalui request frontend.
