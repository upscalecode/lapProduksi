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
- Kelola User & Hak Akses hanya tersedia untuk Super User dan tidak memiliki checkbox permission untuk User Biasa.
