# Backend PostgreSQL — Laporan Produksi

Backend ini mempertahankan kontrak `action` yang dipakai frontend lama, sehingga UI dapat diuji tanpa migrasi serentak.

## Menjalankan lokal

1. Buat database PostgreSQL kosong bernama `laporan_produksi`.
2. Salin `.env.example` menjadi `.env`, lalu sesuaikan `DATABASE_URL` dan `CORS_ORIGIN`.
3. Jalankan:

```powershell
npm install
npm run db:init
npm run db:seed-dev
npm start
```

API tersedia di `http://localhost:3000/api`.

Jalankan unit test dengan `npm test`. Saat API sedang hidup, jalankan pengujian database/API nyata dengan `npm run test:e2e`; data transaksi yang dibuat oleh tes akan dibersihkan otomatis.

## Memindahkan data Spreadsheet

Di Google Spreadsheet pilih **File → Download → Microsoft Excel (.xlsx)**, lalu jalankan:

```powershell
npm run db:import -- "C:\path\Laporan Produksi.xlsx"
```

Importer menggunakan `UPSERT`, sehingga aman dijalankan kembali. Lakukan backup database sebelum mengulang import setelah aplikasi PostgreSQL sudah menerima data produksi baru.

Foto APD tidak tertanam di XLSX karena file aslinya berada di Google Drive. Baris APD akan tetap diimpor, tetapi pemindahan file foto perlu dilakukan terpisah melalui Google Drive API.

## Cutover aman

1. Jalankan backend dan import pada database uji.
2. Buka aplikasi dengan konfigurasi `API_MODE: "postgres"` dan `POSTGRES_API_URL` menuju backend.
3. Uji login, simpan/edit/hapus data, SPK, APD, Down Time, Master, user, dan laporan.
4. Bekukan input di Spreadsheet, lakukan import final, lalu arahkan deployment frontend ke PostgreSQL.

Penutupan/hapus Sisa Press dicatat sebagai ledger `press_adjustments`; data Filling tidak dihapus. Saldo dihitung ulang dari ledger Filling, Press, dan penutupan setiap kali data aplikasi dimuat.
