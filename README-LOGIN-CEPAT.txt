VERSI LOGIN CEPAT — LAPORAN PRODUKSI

Perubahan:
1. Pilihan Role Akses di halaman login dihapus dari tampilan.
2. Role otomatis mengikuti kolom role pada Sheet Users.
3. Halaman login tidak lagi menunggu request ping sebelum tombol Login aktif.
4. Token lama langsung diarahkan ke index.html dan divalidasi di halaman aplikasi.
5. Sesi baru disimpan di Script Properties + CacheService, bukan appendRow ke Sheet Sessions pada setiap login.
6. Data akun di-cache 30 menit untuk mempercepat login berikutnya.
7. Bootstrap awal hanya memuat user + master dropdown.
8. Daftar pengerjaan dan daftar user dimuat setelah halaman input sudah tampil.
9. Master dropdown di-cache 5 menit dan juga disimpan lokal agar halaman terasa lebih cepat.

SETELAH MENGGANTI Code.gs:
- Apps Script > Deploy > Manage deployments
- Edit deployment Web App
- Version: New version
- Deploy

Tidak perlu menjalankan setupSpreadsheet() lagi jika sheet sudah pernah dibuat.
URL /exec biasanya tetap sama bila Anda mengedit deployment yang sama.
