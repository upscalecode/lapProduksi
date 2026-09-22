VERSI LOGIN CEPAT — LAPORAN PRODUKSI

Perubahan:
1. Pilihan Role Akses di halaman login dihapus dari tampilan.
2. Role otomatis mengikuti kolom role pada Sheet Users.
3. Halaman login tidak lagi menunggu request ping sebelum tombol Login aktif.
4. Token lama langsung diarahkan ke index.html dan divalidasi di halaman aplikasi.
5. Sesi baru disimpan di Script Properties + CacheService, bukan appendRow ke Sheet Sessions pada setiap login.
6. Data akun di-cache 30 menit untuk mempercepat login berikutnya.
7. Setelah login, profil, master, pengaturan, dan data utama dimuat bersama melalui satu request appdata. Deployment lama tetap didukung dengan fallback bootstrap.
8. Kerangka aplikasi tampil dari profil lokal sambil menunggu data. Kegagalan jaringan menyediakan tombol Coba lagi tanpa menghapus sesi; sesi yang ditolak server tetap diarahkan ke login.
9. Master dropdown di-cache 5 menit dan juga disimpan lokal agar halaman terasa lebih cepat.
10. Struktur Sheet Pengerjaan yang sudah sesuai cukup diperiksa sekali per request tanpa format ulang atau pemindaian migrasi. setupSpreadsheet() tetap dapat menjalankan migrasi lengkap.
11. Target KPI yang lengkap dibaca sekali saat cache kosong. Hak akses dihitung sebelum memfilter baris dan Sheet produksi dilewati bila user tidak memiliki akses terkait.
12. Login dan halaman utama menggunakan URL script yang sama agar cache browser dapat digunakan kembali. Laporan tersembunyi dihitung setelah tab Laporan dibuka.

SETELAH MENGGANTI Code.gs:
- Upload index.html, login.html, dan script.js terbaru ke hosting.
- Apps Script > Deploy > Manage deployments
- Edit deployment Web App
- Version: New version
- Deploy

Tidak perlu menjalankan setupSpreadsheet() lagi jika sheet sudah pernah dibuat.
URL /exec biasanya tetap sama bila Anda mengedit deployment yang sama.
