UPDATE: TUTUP SISA PRESS + ALASAN WAJIB

Perubahan:
1. Tabel "Sisa Pengerjaan yang Menunggu Press" memiliki tombol:
   - Gunakan
   - Tutup Sisa
2. Saat Tutup Sisa diklik, user WAJIB mengisi alasan minimal 5 karakter.
3. Jika masih ada Preview Press untuk Produk/Botol tersebut, Tutup Sisa dinonaktifkan.
   Simpan atau hapus preview dahulu agar saldo yang ditutup adalah saldo aktual.
4. Penutupan TIDAK menghapus histori Filling atau Press.
5. Sistem mencatat audit ke sheet "Penutupan Press":
   id, tanggal, produk, botol, qtyDitutup, alasan, closedBy, closedByName, createdAt.
6. Balance menjadi:
   Total Filling - Total Press tersimpan - Qty Ditutup - Preview Press = Sisa Qty.
7. Backend ikut menghitung Qty Ditutup ketika memvalidasi Press, sehingga Qty Press tidak bisa
   melewati saldo meskipun request dimanipulasi dari luar halaman.

PEMASANGAN:
- Ganti index.html dan script.js di hosting/web Anda.
- Ganti Code.gs di Google Apps Script.
- Deploy ulang Web App Apps Script (Manage deployments > Edit/New version > Deploy).
- Sheet "Penutupan Press" akan dibuat otomatis saat penutupan pertama dilakukan.
  Anda juga boleh menjalankan setupSpreadsheet() satu kali untuk membuat sheet tersebut lebih awal.


UPDATE HISTORIS MASTER:
- Tombol Tutup Sisa tetap dapat digunakan untuk Produk/Botol yang sudah dihapus dari Master.
- Backend memvalidasi penutupan terhadap data Filling historis, bukan Master aktif.
- Tombol Gunakan dinonaktifkan bila Produk/Botol sudah tidak ada di Master, karena input Press baru tetap wajib menggunakan Master aktif.
- Jika ingin melanjutkan pengerjaan Press untuk item lama, tambahkan kembali Produk/Botol tersebut ke Master.
