UPDATE FILLING -> PRESS BALANCE

Perubahan utama:
1. Press membaca availability Filling berdasarkan Nama Produk.
2. Preview Press tidak boleh melebihi Filling tersimpan + Filling preview.
3. Press yang bergantung pada Filling preview harus menunggu Filling disimpan dahulu.
4. Sheet baru "Sisa Press" dibuat/dirapikan otomatis oleh backend.
5. Sisa Press memakai FIFO tanggal Filling paling lama.
6. Sheet Pengerjaan mendapat kolom tanggalAsalPress dan keterangan.
7. Jika tinggalan tanggal sebelumnya dikerjakan hari berikutnya, keterangan otomatis contoh:
   Sisa tinggalan Press tanggal 20-08-2026

Setelah mengganti Code.gs:
- Deploy ulang Web App Apps Script (New version / Manage deployments > Edit > New version).
- Pastikan script.js menunjuk URL /exec deployment yang benar.
- setupSpreadsheet() boleh dijalankan lagi; tidak menghapus data lama dan akan memastikan header/sheet baru tersedia.
