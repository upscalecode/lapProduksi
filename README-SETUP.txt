PAKET LAPORAN PRODUKSI — SETUP
================================

FILE WEBSITE
- login.html  : halaman login terpisah
- index.html  : aplikasi utama
- style.css   : tampilan responsif + form di atas tabel + pagination
- script.js   : koneksi Apps Script + CRUD + pagination 20 baris

FILE APPS SCRIPT
- Code.gs     : backend Google Spreadsheet

LANGKAH PEMASANGAN
1. Buka Google Spreadsheet yang akan digunakan.
2. Buka Extensions > Apps Script.
3. Hapus isi Code.gs lama lalu tempel isi Code.gs dari paket ini.
4. Jalankan fungsi setupSpreadsheet() SATU KALI dan izinkan akses.
5. Apps Script akan membuat/menyiapkan sheet:
   - Master      : Kolom A Operator, B Produk, C Botol
   - Users       : akun login
   - Sessions    : sesi login
   - Pengerjaan  : data Filling dan Press
6. Deploy > New deployment > Web app.
   - Execute as: Me
   - Who has access: Anyone
7. Copy URL Web App yang berakhir /exec.
8. Buka script.js dan ganti nilai CONFIG.WEB_APP_URL dengan URL /exec tersebut.
9. Upload login.html, index.html, style.css, dan script.js ke hosting/GitHub Pages pada folder yang sama.
10. Buka login.html.

AKUN DEMO SETELAH setupSpreadsheet()
Super User:
- username: admin
- password: admin123
- role: Super User

User Biasa:
- username: operator
- password: operator123
- role: User Biasa

CATATAN KONEKSI
Frontend tidak mengirim application/json atau custom header. POST menggunakan URL encoded form agar tidak memicu CORS preflight seperti konfigurasi fetch JSON.

PAGINATION
Daftar Filling, Press, dan tampilan Laporan dibatasi 20 baris per halaman. Jika data lebih dari 20, tombol halaman 2, 3, dan seterusnya muncul otomatis.


UPDATE — OPTIMISTIC / INSTANT SAVE
----------------------------------
- Saat tombol + Tambah List ditekan, data langsung tampil di tabel dan form langsung kosong.
- Status sementara: Menyimpan…
- Request ke Spreadsheet masuk antrean dan dikirim satu per satu agar tidak bentrok LockService.
- Jika gagal, baris menampilkan Gagal disimpan + tombol Coba Lagi.
- clientRequestId dipakai sebagai ID backend agar retry tidak membuat data duplikat.
- Laporan dan export hanya memakai data yang sudah dikonfirmasi tersimpan di Spreadsheet.

PENTING: karena Code.gs berubah, buat New version pada deployment Web App setelah mengganti Code.gs.
