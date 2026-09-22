UPDATE HAK AKSES USER / SUPER USER

File:
- Code.gs
- index.html
- script.js
- style.css
- login.html (tidak diubah, disertakan agar paket lengkap)

Langkah pemasangan:
1. Ganti file Code.gs pada Google Apps Script dengan versi ini.
2. Ganti index.html, script.js, dan style.css pada hosting/web app frontend.
3. Jalankan setupSpreadsheet() SATU KALI dari editor Apps Script.
   - Header sheet Users akan menjadi:
     A username
     B passwordHash
     C name
     D role
     E active
     F createdAt
     G permissionsJson
   - User lama yang kolom G-nya kosong akan diisi otomatis.
4. Deploy ulang Apps Script sebagai Web App / buat version deployment baru.
5. Pastikan CONFIG.WEB_APP_URL pada script.js mengarah ke URL /exec deployment aktif.
   Jika Laporan kosong dan aplikasi menampilkan "Backend laporan perlu diperbarui", deploy ulang Code.gs dan periksa URL /exec yang tersimpan pada browser.
6. Login sebagai Super User, buka SETTING > Kelola User & Hak Akses > Atur Akses.

Default USER BIASA:
- Filling: YA
- Press: YA
- Laporan: TIDAK
- Hapus Pengerjaan belum di press: TIDAK
- Lihat semua data user: TIDAK
- Edit data sendiri: YA
- Edit data user lain: TIDAK
- Hapus data sendiri: TIDAK
- Hapus data user lain: TIDAK
- Setting / Master Data: TIDAK

Catatan keamanan:
- Permission divalidasi di backend Apps Script, bukan hanya UI.
- Super User selalu dianggap memiliki seluruh permission.
- Hak akses User Biasa diatur per bagian melalui Read, Write, dan Administrator.
- Read pada Filling/Press menampilkan seluruh data pada bagian itu; ubah/hapus tetap mengikuti izin Kelola Data.
- Write mencakup Read serta tambah/ubah/hapus pada bagian tersebut; pada Filling, Press, dan APD terbatas pada data sendiri.
- Administrator berlaku hanya pada bagian yang dipilih dan dapat mengubah data user lain di bagian itu.
- Filling, Press, dan APD memiliki izin Kelola Data Sendiri dan Kelola Data User Lain untuk mengubah atau menghapus data sesuai pemiliknya.
- Administrator pada bagian data otomatis mencakup kedua izin kelola; Write diperlukan untuk menambah data.
- Dashboard dan Laporan tidak memiliki aksi tulis; opsi Write dinonaktifkan.
- Akses Laporan adalah induk: Administrator membuka semua laporan turunan, sedangkan Read hanya membuka laporan turunan yang dipilih.
- Kelola User & Hak Akses hanya tersedia untuk Super User dan tidak memiliki checkbox permission untuk User Biasa.
