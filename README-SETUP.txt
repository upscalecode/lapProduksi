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
   Untuk fitur foto APD, jalankan juga authorizeApdPhotoStorage() dari editor
   Apps Script dengan akun pemilik deployment. Setujui izin Google Drive yang
   diminta. Fungsi ini membuat folder bukti APD jika belum ada.
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

JIKA UNGGAH FOTO APD GAGAL KARENA IZIN DRIVE
- Pastikan pemilik deployment membuka project Apps Script yang sama dan menjalankan
  authorizeApdPhotoStorage() dari editor, lalu menyetujui seluruh izin Drive.
- Jika appsscript.json memakai oauthScopes eksplisit, tambahkan
  https://www.googleapis.com/auth/drive dan simpan project sebelum otorisasi.
- Deploy > Manage deployments > Edit > Version: New version > Deploy.
  Pastikan Execute as tetap Me. Lalu coba unggah foto lagi.

PERUBAHAN URUTAN KOLOM APD
- Hentikan input APD sementara selama migrasi dan pembaruan deployment.
- Setelah menempel Code.gs terbaru, jalankan migrateApdColumnOrder() sekali
  dari editor Apps Script, lalu segera terapkan versi deployment baru.
- Fungsi ini memindahkan nilai Kebersihan Sepatu dari kolom Q ke kolom I,
  tepat setelah Memakai aksesoris. Kolom metadata bergeser ke M:Q.

OPTIMASI PENYIMPANAN APD
- Header yang sudah sesuai tidak diformat ulang dan data lama tidak dipindai
  untuk migrasi pada setiap request. Pemeriksaan struktur digunakan kembali
  selama request yang sama; data penilaian tidak dicache lintas request.
- Simpan batch membaca data sekali, menulis batch sekali, lalu mengonfirmasi
  penulisan dengan flush sebelum mengirim respons. Riwayat respons disusun dari
  data yang sudah dibaca dan ditulis, tanpa membaca seluruh Sheet kembali.
- setupSpreadsheet() dan migrateApdColumnOrder() tetap menjalankan pemeriksaan
  serta perbaikan struktur secara lengkap bila dipanggil dari editor.
- Terapkan Code.gs sebagai New version pada deployment aktif untuk mengaktifkan optimasi.
