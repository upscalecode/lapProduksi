UPDATE FILLING & PRESS
1. index.html:
   - Operator, Produk, Botol menjadi autocomplete search dari Master.
   - Filter Operator Filling/Press menjadi search.
2. script.js:
   - exact-match validation master.
   - tabel saldo Filling -> Press lintas tanggal.
   - Press tidak boleh melebihi sisa Filling.
3. Code.gs:
   - validasi master di server.
   - validasi balance Filling/Press di server.

CARA PASANG
- Ganti index.html dan script.js pada project web Anda.
- Ganti Code.gs di Apps Script.
- Deploy ulang Apps Script sebagai Web App (New deployment / Manage deployments -> edit deployment).
- Pastikan URL /exec di CONFIG.WEB_APP_URL tetap sesuai deployment Anda.
- style.css, login.html, gambar/logo, dan file lain tetap gunakan file project Anda yang sekarang.
