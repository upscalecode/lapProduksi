UPDATE FILLING -> PRESS (19 Agustus 2026)

Perubahan:
1. Search/autocomplete Nama Operator, Nama Produk, Nama Botol tetap dipertahankan.
2. Press membaca Filling yang masih berada di Preview.
3. Balance Press dihitung berdasarkan Nama Produk, bukan kombinasi Produk + Botol.
4. Sisa Press diproses FIFO berdasarkan tanggal Filling tertua.
5. Sheet baru "Sisa Press" dibuat otomatis dengan tanggal asal, produk, botol, qty filling, qty sudah press, sisa qty, dan status.
6. Sheet "Pengerjaan" ditambah kolom di paling kanan:
   - sisaPressTanggalAsal
   - keterangan
7. Jika sisa tanggal 20 dikerjakan tanggal 21, keterangan Press menjadi:
   "Sisa tinggalan Press tanggal 20 Agustus 2026".

Pemasangan:
- Ganti Code.gs, script.js, style.css, dan index.html dengan file paket ini.
- Jalankan setupSpreadsheet() sekali dari Apps Script (direkomendasikan untuk migrasi langsung).
- Deploy ulang Web App / buat New deployment jika URL deployment Anda memerlukan versi baru.
- Pastikan script.js menggunakan URL /exec deployment yang benar.

Catatan:
- Press dapat MEMBACA dan divalidasi terhadap Filling yang masih Preview.
- Jika Press hendak disimpan ke Spreadsheet sedangkan sumber Filling-nya masih hanya Preview dan belum tersimpan, simpan Filling terlebih dahulu agar validasi backend memiliki sumber Filling resmi.
