/**
 * Laporan Produksi — Google Apps Script backend
 * Cocok dengan login.html, index.html, style.css, dan script.js paket ini.
 *
 * CARA AWAL:
 * 1. Pasang script ini pada Apps Script yang terikat ke Spreadsheet.
 * 2. Jalankan setupSpreadsheet() satu kali dari editor Apps Script.
 * 3. Deploy > New deployment > Web app.
 *    Execute as: Me
 *    Who has access: Anyone
 * 4. Salin URL /exec ke CONFIG.WEB_APP_URL pada script.js.
 */

const APP = {
  SESSION_HOURS: 12,
  SESSION_CACHE_SECONDS: 900, // cache cepat untuk request setelah login
  USER_CACHE_SECONDS: 1800, // cache akun 30 menit agar login tidak selalu membaca Sheet Users
  MASTER_CACHE_SECONDS: 300, // cache dropdown 5 menit agar halaman input cepat siap
  SETTINGS_CACHE_SECONDS: 300, // cache setting KPI agar bootstrap/appdata tetap ringan
  WRITE_LOCK_MS: 3000, // jangan antre sampai 20 detik
  SHEETS: {
    MASTER: "Master",
    USERS: "Users",
    SESSIONS: "Sessions",
    ENTRIES: "Pengerjaan",
    PRESS_ADJUSTMENTS: "Penutupan Press",
    PRESS_REMAINDERS: "Sisa Press",
    APD: "APD",
    SPK: "SPK",
    SETTINGS: "Settings",
  },
  ENTRY_HEADERS: [
    "id",
    "reportId",
    "tab",
    "tanggal",
    "operator",
    "produk",
    "botol",
    "qtyKardus",
    "qtyBotolPerKardus",
    "totalQty",
    "botolPecahJenis",
    "qtyBotolPecah",
    "qtyKardusBasah",
    "createdBy",
    "createdAt",
    "updatedAt",
    "updateCount",
    "sisaPressTanggalAsal",
    "keterangan",
  ],
  USER_HEADERS: [
    "username",
    "passwordHash",
    "name",
    "role",
    "active",
    "createdAt",
    "permissionsJson",
  ],
  SESSION_HEADERS: ["token", "username", "expiresAt", "createdAt"],
  PRESS_ADJUSTMENT_HEADERS: [
    "id",
    "tanggal",
    "produk",
    "botol",
    "qtyDitutup",
    "alasan",
    "closedBy",
    "closedByName",
    "createdAt",
    "qtyBotolPerKardus",
    "targetBatchNo",
    "targetTanggalAsal",
  ],
  PRESS_REMAINDER_HEADERS: [
    "id",
    "tanggalAsal",
    "produk",
    "botol",
    "qtyFilling",
    "qtyPressTerpakai",
    "qtyDitutup",
    "sisaQty",
    "status",
    "updatedAt",
  ],
  SETTINGS_HEADERS: ["key", "value", "updatedAt", "updatedBy"],
  // Audit SPK disimpan terpisah dan tidak pernah digabungkan ke updateCount
  // Pengerjaan yang menjadi sumber perhitungan KPI Karyawan.
  SPK_HEADERS: [
    "No Batch",
    "Tanggal",
    "Nama Produk",
    "Botol",
    "Qty",
    "Dibuat Oleh",
    "Dibuat Pada",
    "Di-update Pada",
    "Jumlah Update",
  ],
  APD_HEADERS: [
    "Tanggal",
    "Nama Operator",
    "Masker tidak sesuai",
    "Lengan ditarik ke atas",
    "Sepatu diinjak",
    "Rambut kelihatan",
    "APD tidak diresleting penuh",
    "Memakai aksesoris",
    "Kebersihan Sepatu",
    "Total Poin",
    "Nilai Prosentase APD",
    "Alasan",
    "apdId",
    "createdBy",
    "createdAt",
    "updatedAt",
    "photoFileId",
  ],
};

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss)
    throw new Error(
      "Buka Apps Script dari Spreadsheet yang akan digunakan, lalu jalankan lagi setupSpreadsheet().",
    );

  PropertiesService.getScriptProperties().setProperty(
    "SPREADSHEET_ID",
    ss.getId(),
  );

  const master = ensureSheet_(ss, APP.SHEETS.MASTER, [
    "Nama Operator",
    "Nama Produk",
    "Nama Botol",
  ]);
  const users = ensureSheet_(ss, APP.SHEETS.USERS, APP.USER_HEADERS);
  ensureSheet_(ss, APP.SHEETS.SESSIONS, APP.SESSION_HEADERS);
  ensureEntrySheetSchema_(ss, true);
  ensureSheet_(ss, APP.SHEETS.PRESS_ADJUSTMENTS, APP.PRESS_ADJUSTMENT_HEADERS);
  ensureSheet_(ss, APP.SHEETS.PRESS_REMAINDERS, APP.PRESS_REMAINDER_HEADERS);
  ensureApdSheet_(ss, true);
  ensureSpkSheet_(ss, true);
  ensureSettingsSheet_(ss);

  if (master.getLastRow() < 2) {
    master.getRange(2, 1, 3, 3).setValues([
      ["Operator 1", "Produk 1", "Botol 30 ml"],
      ["Operator 2", "Produk 2", "Botol 50 ml"],
      ["Operator 3", "Produk 3", "Botol 100 ml"],
    ]);
  }
  ensureApdCriteriaMaster_(ss);

  if (users.getLastRow() < 2) {
    users.getRange(2, 1, 2, APP.USER_HEADERS.length).setValues([
      [
        "admin",
        hashPassword_("admin123"),
        "Administrator",
        "superuser",
        true,
        new Date(),
        JSON.stringify(defaultPermissions_("superuser")),
      ],
      [
        "operator",
        hashPassword_("operator123"),
        "Operator",
        "user",
        true,
        new Date(),
        JSON.stringify(defaultPermissions_("user")),
      ],
    ]);
  }

  // Migrasi user lama: isi permissionsJson yang masih kosong tanpa perlu edit manual.
  if (users.getLastRow() >= 2) {
    const userRows = users
      .getRange(2, 1, users.getLastRow() - 1, APP.USER_HEADERS.length)
      .getValues();
    let changed = false;
    userRows.forEach(function (row) {
      const role =
        String(row[3] || "user") === "superuser" ? "superuser" : "user";
      if (!String(row[6] || "").trim()) {
        row[6] = JSON.stringify(defaultPermissions_(role));
        changed = true;
      }
    });
    if (changed)
      users
        .getRange(2, 1, userRows.length, APP.USER_HEADERS.length)
        .setValues(userRows);
  }

  // Bangun saldo sisa dari data Pengerjaan lama agar langsung kompatibel.
  rebuildPressRemainders_();

  return "Setup selesai. Pengerjaan: kolom 13 = qtyKardusBasah, kolom 16 = updatedAt, kolom 17 = updateCount; createdByName dihapus; Sheet Sisa Press, APD, dan Settings aktif; target KPI Filling & Press siap digunakan; saldo Filling → Press sudah dibangun ulang.";
}

function doGet(e) {
  try {
    const action = param_(e, "action");

    if (action === "ping") {
      return json_({
        ok: true,
        message: "Apps Script aktif",
        serverTime: new Date().toISOString(),
      });
    }

    if (action === "bootstrap") {
      const session = requireSession_(param_(e, "token"));
      return json_({
        ok: true,
        user: publicUser_(session.user),
        master: getMaster_(),
        settings: getSettings_(),
      });
    }

    if (action === "apd.photo.get") {
      const session = requireSession_(param_(e, "token"));
      requireLevel_(session.user, "apd", "read");
      return json_({ ok: true, dataUrls: getApdPhotoData_(param_(e, "id")) });
    }

    if (action === "apd.photo.preview") {
      const session = requireSession_(param_(e, "token"));
      requireLevel_(session.user, "apd", "read");
      const file = apdPhotoFile_(param_(e, "photoFileId"));
      if (
        file.getDescription() !==
        "APD bukti; uploadedBy=" + session.user.username
      ) {
        throw new Error("Anda tidak dapat melihat foto preview ini.");
      }
      return json_({
        ok: true,
        dataUrl:
          "data:image/jpeg;base64," +
          Utilities.base64Encode(file.getBlob().getBytes()),
      });
    }

    if (action === "appdata") {
      const session = requireSession_(param_(e, "token"));
      const readDashboard = can_(session.user, "accessDashboard");
      const readFilling = can_(session.user, "accessFilling");
      const readSpk = can_(session.user, "accessSpk");
      const readPress = can_(session.user, "accessPress");
      const readKpi =
        can_(session.user, "accessKpiReport") ||
        canLevel_(session.user, "kpiFilling", "read") ||
        canLevel_(session.user, "kpiPress", "read");
      const readSpkReport = canLevel_(session.user, "spkReport", "read");
      const readReports = can_(session.user, "accessWorkReport") || readKpi;
      const readApd =
        can_(session.user, "accessApd") || readKpi || readDashboard;
      const allEntries =
        readDashboard || readFilling || readPress || readReports
          ? getEntries_()
          : [];
      const featureEntries = allEntries.filter(function (entry) {
        if (readDashboard) return true;
        if (entry.tab === "filling") return readFilling;
        if (entry.tab === "press") return readPress;
        return false;
      });
      // Read menampilkan seluruh data pada bagian yang diizinkan. Hak ubah/hapus
      // tetap diperiksa terpisah menurut pemilik data pada setiap aksi tulis.
      const visibleEntries = featureEntries;
      const reportEntries = allEntries.filter(function (entry) {
        return (
          (entry.tab === "filling" || entry.tab === "press") && readReports
        );
      });
      // Pada Dashboard, entries dan reportEntries berasal dari sumber yang sama.
      // Hindari mengirim salinan kedua agar respons awal lebih kecil.
      const reportEntriesSameAsEntries = readDashboard && readReports;
      const pressAdjustments = readPress ? getPressAdjustments_() : [];
      const includeBootstrap = param_(e, "includeBootstrap") === "1";
      return json_({
        ok: true,
        user: includeBootstrap ? publicUser_(session.user) : undefined,
        master: includeBootstrap ? getMaster_() : undefined,
        entries: visibleEntries,
        reportEntries: reportEntriesSameAsEntries ? undefined : reportEntries,
        reportEntriesSameAsEntries: reportEntriesSameAsEntries,
        adjustments: pressAdjustments,
        remainders: readPress
          ? getPressRemainders_(allEntries, pressAdjustments)
          : [],
        spkEntries:
          readDashboard || readSpk || readFilling || readPress || readSpkReport
            ? getSpkEntries_()
            : [],
        // KPI pada Dashboard/Laporan membutuhkan nilai APD meskipun user tidak membuka tab APD.
        apdEntries: readApd ? getApdEntries_() : [],
        users: session.user.role === "superuser" ? getUsers_() : [],
        settings: getSettings_(),
      });
    }

    return json_({ ok: false, message: "Action GET tidak dikenali." });
  } catch (err) {
    return jsonError_(err);
  }
}

function doPost(e) {
  try {
    const action = param_(e, "action");

    if (action === "login") return handleLogin_(e);

    if (action === "logout") {
      const token = param_(e, "token");
      if (token) deleteSession_(token);
      return json_({ ok: true });
    }

    const session = requireSession_(param_(e, "token"));

    switch (action) {
      case "entry.create":
        return withWriteLock_(function () {
          const payload = parseJsonParam_(e, "data");
          requireLevel_(session.user, payload && payload.line, "write");
          const entry = createEntry_(session.user, payload);
          return json_({
            ok: true,
            entry: entry,
            remainders: getPressRemainders_(),
          });
        });

      case "entry.batchCreate":
        return withWriteLock_(function () {
          const payload = parseJsonParam_(e, "data");
          (Array.isArray(payload) ? payload : []).forEach(function (item) {
            requireLevel_(session.user, item && item.line, "write");
          });
          const result = createEntriesBatch_(session.user, payload);
          return json_({
            ok: true,
            entries: result.entries,
            savedIds: result.savedIds,
            duplicateIds: result.duplicateIds,
            remainders: result.remainders,
          });
        });

      case "entry.update":
        return withWriteLock_(function () {
          const payload = parseJsonParam_(e, "data");
          requireLevel_(session.user, payload && payload.line, "write");
          const entry = updateEntry_(session.user, param_(e, "id"), payload);
          return json_({
            ok: true,
            entry: entry,
            remainders: getPressRemainders_(),
          });
        });

      case "entry.delete":
        return withWriteLock_(function () {
          const deleted = deleteEntry_(session.user, param_(e, "id"));
          return json_({
            ok: true,
            deletedIds: deleted.deletedIds,
            remainders: deleted.remainders,
          });
        });

      case "spk.create":
        requireLevel_(session.user, "spk", "write");
        return withWriteLock_(function () {
          const spk = createSpk_(session.user, parseJsonParam_(e, "data"));
          return json_({ ok: true, spk: spk });
        });

      case "spk.batchCreate":
        requireLevel_(session.user, "spk", "write");
        return withWriteLock_(function () {
          const rows = parseJsonParam_(e, "data");
          if (!Array.isArray(rows) || !rows.length)
            throw new Error("Preview SPK kosong.");
          if (rows.length > 99)
            throw new Error("Maksimal 99 SPK per sekali simpan.");
          const saved = createSpkEntriesBatch_(session.user, rows);
          return json_({ ok: true, saved: saved });
        });

      case "spk.update":
        return withWriteLock_(function () {
          const spk = updateSpk_(
            session.user,
            param_(e, "batchNo"),
            parseJsonParam_(e, "data"),
          );
          return json_({ ok: true, spk: spk });
        });

      case "spk.delete":
        return withWriteLock_(function () {
          deleteSpk_(session.user, param_(e, "batchNo"));
          return json_({ ok: true, deletedBatchNo: param_(e, "batchNo") });
        });

      case "spk.batchDelete":
        return withWriteLock_(function () {
          const batchNos = parseJsonParam_(e, "batchNos");
          const deletedBatchNos = deleteSpkBatch_(session.user, batchNos);
          return json_({ ok: true, deletedBatchNos: deletedBatchNos });
        });

      // Dipertahankan untuk kompatibilitas data/versi lama.
      case "press.adjustment.close":
        requirePressRemainderDelete_(session.user);
        return withWriteLock_(function () {
          const adjustment = closePressRemainder_(
            session.user,
            parseJsonParam_(e, "data"),
          );
          rebuildPressRemainders_();
          return json_({
            ok: true,
            adjustment: adjustment,
            remainders: getPressRemainders_(),
          });
        });

      case "press.adjustment.closeBatch":
        requirePressRemainderDelete_(session.user);
        return withWriteLock_(function () {
          const result = closePressRemaindersBatch_(
            session.user,
            parseJsonParam_(e, "data"),
          );
          return json_({
            ok: true,
            adjustments: result.adjustments,
            remainders: result.remainders,
          });
        });

      case "apd.batchCreate":
        requireLevel_(session.user, "apd", "write");
        return withWriteLock_(function () {
          const result = createApdEntriesBatch_(
            session.user,
            parseJsonParam_(e, "data"),
          );
          return json_({
            ok: true,
            savedCount: result.savedCount,
            newCount: result.newCount,
            duplicateIds: result.duplicateIds,
            savedIds: result.savedIds,
            entries: result.entries,
          });
        });

      case "apd.update":
        requireLevel_(session.user, "apd", "write");
        return withWriteLock_(function () {
          const updated = updateApdEntry_(
            session.user,
            param_(e, "id"),
            parseJsonParam_(e, "data"),
          );
          return json_({ ok: true, entry: updated.entry });
        });

      case "apd.delete":
        requireLevel_(session.user, "apd", "write");
        return withWriteLock_(function () {
          const deleted = deleteApdEntry_(session.user, param_(e, "id"));
          return json_({ ok: true, deletedId: deleted.deletedId });
        });

      case "apd.photo.upload":
        requireLevel_(session.user, "apd", "write");
        return json_({
          ok: true,
          photoFileId: uploadApdPhoto_(session.user, param_(e, "dataUrl")),
        });

      case "apd.photo.discard":
        requireLevel_(session.user, "apd", "write");
        discardApdPhoto_(session.user, param_(e, "photoFileId"));
        return json_({ ok: true });

      case "master.add":
        requireLevel_(session.user, "master", "write");
        return withWriteLock_(function () {
          addMaster_(param_(e, "category"), param_(e, "value"));
          return json_({ ok: true, master: getMaster_() });
        });

      case "master.remove":
        requireLevel_(session.user, "master", "write");
        return withWriteLock_(function () {
          removeMaster_(param_(e, "category"), param_(e, "value"));
          return json_({ ok: true, master: getMaster_() });
        });

      case "settings.kpiTargets.set":
        requireLevel_(session.user, "kpiSettings", "write");
        return withWriteLock_(function () {
          const settings = setKpiOutputTargets_(
            session.user,
            param_(e, "fillingValue"),
            param_(e, "pressValue"),
          );
          return json_({ ok: true, settings: settings });
        });

      case "settings.kpiFilling.set":
        requireLevel_(session.user, "kpiSettings", "write");
        return withWriteLock_(function () {
          const settings = setKpiFillingOutputTarget_(
            session.user,
            param_(e, "value"),
          );
          return json_({ ok: true, settings: settings });
        });

      case "settings.kpiPress.set":
        requireLevel_(session.user, "kpiSettings", "write");
        return withWriteLock_(function () {
          const settings = setKpiPressOutputTarget_(
            session.user,
            param_(e, "value"),
          );
          return json_({ ok: true, settings: settings });
        });

      case "user.add":
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          addUser_(
            param_(e, "name"),
            param_(e, "username"),
            param_(e, "password"),
            param_(e, "role"),
          );
          return json_({ ok: true, users: getUsers_() });
        });

      case "user.permissions.set":
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          setUserPermissions_(
            param_(e, "username"),
            parseJsonParam_(e, "permissions"),
          );
          return json_({ ok: true, users: getUsers_() });
        });

      case "user.password.reset":
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          resetUserPassword_(param_(e, "username"), param_(e, "password"));
          return json_({ ok: true });
        });

      case "user.remove":
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          removeUser_(param_(e, "username"), session.user.username);
          return json_({ ok: true, users: getUsers_() });
        });

      default:
        return json_({ ok: false, message: "Action POST tidak dikenali." });
    }
  } catch (err) {
    return jsonError_(err);
  }
}

function withWriteLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.WRITE_LOCK_MS)) {
    throw new Error(
      "Server sedang menerima input lain. Silakan klik simpan sekali lagi.",
    );
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function handleLogin_(e) {
  const username = param_(e, "username").trim();
  const password = param_(e, "password");

  // Role tidak diminta dari frontend. Hak akses selalu mengikuti Sheet Users.
  if (!username || !password) {
    throw new Error("Username dan password wajib diisi.");
  }

  // findUser_ memakai CacheService sehingga login berulang tidak perlu selalu baca Spreadsheet.
  const user = findUser_(username);
  if (!user || !user.active)
    throw new Error("Akun tidak ditemukan atau tidak aktif.");
  if (user.passwordHash !== hashPassword_(password))
    throw new Error("Password salah.");

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + APP.SESSION_HOURS * 60 * 60 * 1000,
  );

  // Simpan sesi ke Script Properties (lebih ringan daripada appendRow ke Sheet Sessions).
  // Cache tetap dipakai sebagai jalur tercepat untuk request berikutnya.
  persistSession_(token, user, expiresAt, createdAt);
  cacheSession_(token, user, expiresAt);

  return json_({ ok: true, token: token, user: publicUser_(user) });
}

function requireSession_(token) {
  if (!token) throw new Error("Sesi tidak ditemukan. Silakan login kembali.");

  const cached = readCachedSession_(token);
  if (cached) return refreshSessionUser_(cached);

  // Cache miss: baca Script Properties, bukan scan Sheet Sessions.
  const stored = readPersistedSession_(token);
  if (stored) {
    if (new Date(stored.expiresAt).getTime() <= Date.now()) {
      deletePersistedSession_(token);
      throw new Error("Sesi sudah berakhir. Silakan login kembali.");
    }
    cacheSession_(token, stored.user, stored.expiresAt);
    return refreshSessionUser_({ token: token, user: stored.user });
  }

  // Kompatibilitas token versi lama yang masih berada pada Sheet Sessions.
  const sh = sheet_(APP.SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== token) continue;
    const expiresAt =
      values[i][2] instanceof Date ? values[i][2] : new Date(values[i][2]);
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      throw new Error("Sesi sudah berakhir. Silakan login kembali.");
    }
    const user = findUser_(String(values[i][1]));
    if (!user || !user.active) throw new Error("User sesi sudah tidak aktif.");
    persistSession_(token, user, expiresAt, values[i][3] || new Date());
    cacheSession_(token, user, expiresAt);
    return { token: token, user: user };
  }

  throw new Error("Sesi sudah berakhir. Silakan login kembali.");
}

function refreshSessionUser_(session) {
  if (!session || !session.user || !session.user.username)
    throw new Error("Sesi tidak valid. Silakan login kembali.");
  const fresh = findUser_(session.user.username);
  if (!fresh || !fresh.active) throw new Error("User sesi sudah tidak aktif.");
  return { token: session.token, user: fresh };
}

function persistedSessionKey_(token) {
  return "PPR_SESSION_" + String(token);
}

function persistSession_(token, user, expiresAt, createdAt) {
  PropertiesService.getScriptProperties().setProperty(
    persistedSessionKey_(token),
    JSON.stringify({
      token: token,
      expiresAt: new Date(expiresAt).toISOString(),
      createdAt: new Date(createdAt || new Date()).toISOString(),
      user: publicUser_(user),
    }),
  );
}

function readPersistedSession_(token) {
  const raw = PropertiesService.getScriptProperties().getProperty(
    persistedSessionKey_(token),
  );
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    deletePersistedSession_(token);
    return null;
  }
}

function deletePersistedSession_(token) {
  if (token)
    PropertiesService.getScriptProperties().deleteProperty(
      persistedSessionKey_(token),
    );
}

function sessionCacheKey_(token) {
  return "ppr_session_" + String(token);
}

function cacheSession_(token, user, expiresAt) {
  const remainingSeconds = Math.max(
    1,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
  const ttl = Math.min(APP.SESSION_CACHE_SECONDS, remainingSeconds);
  CacheService.getScriptCache().put(
    sessionCacheKey_(token),
    JSON.stringify({
      token: token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: publicUser_(user),
    }),
    ttl,
  );
}

function readCachedSession_(token) {
  const raw = CacheService.getScriptCache().get(sessionCacheKey_(token));
  if (!raw) return null;

  try {
    const data = JSON.parse(raw);
    if (!data.expiresAt || new Date(data.expiresAt).getTime() <= Date.now()) {
      removeCachedSession_(token);
      return null;
    }
    return { token: token, user: data.user };
  } catch (_) {
    removeCachedSession_(token);
    return null;
  }
}

function removeCachedSession_(token) {
  if (token) CacheService.getScriptCache().remove(sessionCacheKey_(token));
}

function purgeExpiredSessions_() {
  const sh = sheet_(APP.SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return;

  const now = Date.now();
  const keep = [APP.SESSION_HEADERS];
  for (let i = 1; i < values.length; i++) {
    const expires =
      values[i][2] instanceof Date
        ? values[i][2].getTime()
        : new Date(values[i][2]).getTime();
    if (expires > now) keep.push(values[i]);
  }

  if (keep.length !== values.length) {
    sh.clearContents();
    sh.getRange(1, 1, keep.length, APP.SESSION_HEADERS.length).setValues(keep);
    styleHeader_(sh, APP.SESSION_HEADERS.length);
  }
}

function deleteSession_(token) {
  removeCachedSession_(token);
  deletePersistedSession_(token);
  // Sheet Sessions hanya dipertahankan untuk kompatibilitas token lama;
  // logout versi baru tidak perlu scan/delete row sehingga lebih cepat.
}

/* ------------------------- APD ------------------------- */
const APD_VARIABLES_ = [
  { key: "maskerTidakSesuai", label: "Masker tidak sesuai", weight: 25 },
  { key: "lenganDitarik", label: "Lengan ditarik ke atas", weight: 20 },
  { key: "sepatuDiinjak", label: "Sepatu diinjak", weight: 10 },
  { key: "rambutKelihatan", label: "Rambut kelihatan", weight: 15 },
  {
    key: "resletingTidakPenuh",
    label: "Tidak diresleting secara penuh",
    weight: 10,
  },
  { key: "memakaiAksesoris", label: "Memakai aksesoris", weight: 20 },
  { key: "kebersihanSepatu", label: "Kebersihan sepatu", weight: 10 },
];
const APD_MAX_POINT_ = 3;
const APD_POINT_CRITERIA_ = {
  maskerTidakSesuai: [
    "DILEPAS",
    "DI DAGU",
    "DI BAWAH HIDUNG",
    "SESUAI STANDARD",
  ],
  lenganDitarik: [
    "DITARIK SAMPAI SIKU",
    "DITARIK SEBAGIAN (DI ATAS PERGELANGAN)",
    "DITARIK SEDIKIT",
    "SESUAI STANDARD",
  ],
  sepatuDiinjak: [
    "DI INJAK SEMUA",
    "BAGIAN BELAKANG SEPATU TERINJAK",
    "SEDIKIT TERINJAK/TIDAK RAPI",
    "SESUAI STANDARD",
  ],
  rambutKelihatan: [
    "PENUTUP KEPALA TIDAK DIPAKAI",
    "RAMBUT TERLIHAT BANYAK",
    "RAMBUT TERLIHAT SEDIKIT",
    "SESUAI STANDARD",
  ],
  resletingTidakPenuh: [
    "TIDAK DIRESLETING SAMA SEKALI",
    "RESLETING NAIK TURUN BERULANG",
    "RESLETING SAMPAI DADA",
    "SESUAI STANDARD",
  ],
  memakaiAksesoris: [
    "MEMAKAI AKSESORIS YANG DILARANG",
    "",
    "",
    "TIDAK PAKAI SAMA SEKALI",
  ],
  kebersihanSepatu: ["KOTOR PARAH", "", "SETENGAH KOTOR", "BERSIH"],
};

function ensureApdCriteriaMaster_(ss) {
  const sh =
    ss.getSheetByName(APP.SHEETS.MASTER) ||
    ensureSheet_(ss, APP.SHEETS.MASTER, [
      "Nama Operator",
      "Nama Produk",
      "Nama Botol",
    ]);
  const firstColumn = 4;
  const columnCount = 6;
  if (sh.getMaxColumns() < firstColumn + columnCount - 1) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      firstColumn + columnCount - 1 - sh.getMaxColumns(),
    );
  }
  const rows = [
    ["APD Key", "Kriteria APD", "Poin 0", "Poin 1", "Poin 2", "Poin 3"],
  ].concat(
    APD_VARIABLES_.map(function (variable) {
      const points = APD_POINT_CRITERIA_[variable.key];
      return [variable.key, variable.label].concat(points);
    }),
  );
  const range = sh.getRange(1, firstColumn, rows.length, columnCount);
  const current = range.getDisplayValues();
  if (JSON.stringify(current) !== JSON.stringify(rows)) range.setValues(rows);
  sh.hideColumns(firstColumn, columnCount);
}

function apdPhotoFolder_() {
  const properties = PropertiesService.getScriptProperties();
  const cachedId = properties.getProperty("APD_PHOTO_FOLDER_ID");
  if (cachedId) {
    try {
      return DriveApp.getFolderById(cachedId);
    } catch (_) {}
  }
  const folder = DriveApp.createFolder("Laporan Produksi - Bukti APD");
  properties.setProperty("APD_PHOTO_FOLDER_ID", folder.getId());
  return folder;
}

// Jalankan sekali dari editor Apps Script sebagai pemilik deployment untuk
// meminta izin Drive dan menyiapkan folder foto APD sebelum web app digunakan.
function authorizeApdPhotoStorage() {
  return "Penyimpanan foto APD siap: " + apdPhotoFolder_().getName();
}

function apdPhotoFile_(id) {
  const fileId = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{20,}$/.test(fileId))
    throw new Error("Foto bukti APD tidak valid.");
  const file = DriveApp.getFileById(fileId);
  const parents = file.getParents();
  const folderId = apdPhotoFolder_().getId();
  let isOwnedFolder = false;
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) isOwnedFolder = true;
  }
  if (!isOwnedFolder) throw new Error("Foto bukti APD tidak ditemukan.");
  return file;
}

function uploadApdPhoto_(user, dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(
    String(dataUrl || ""),
  );
  if (!match) throw new Error("Foto bukti harus berformat JPEG.");
  const bytes = Utilities.base64Decode(match[1]);
  if (!bytes.length || bytes.length > 350000)
    throw new Error("Ukuran foto bukti maksimal 350 KB setelah kompresi.");
  const file = apdPhotoFolder_().createFile(
    Utilities.newBlob(
      bytes,
      "image/jpeg",
      "apd-" + Utilities.getUuid() + ".jpg",
    ),
  );
  file.setDescription("APD bukti; uploadedBy=" + user.username);
  return file.getId();
}

function parseApdPhotoIds_(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.charAt(0) === "[") {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed))
        return parsed.map(String).filter(Boolean).slice(0, 3);
    } catch (_) {}
  }
  return [text];
}

function encodeApdPhotoIds_(ids) {
  const clean = (ids || []).map(String).filter(Boolean);
  return clean.length ? JSON.stringify(clean.slice(0, 3)) : "";
}

function getApdPhotoData_(apdId) {
  const sh = ensureApdSheet_(spreadsheet_());
  const row = findApdRowById_(sh, apdId);
  const ids = parseApdPhotoIds_(sh.getRange(row, 17).getValue());
  if (!ids.length) throw new Error("Data APD ini tidak memiliki foto bukti.");
  return ids.map(function (id) {
    const file = apdPhotoFile_(id);
    return (
      "data:image/jpeg;base64," +
      Utilities.base64Encode(file.getBlob().getBytes())
    );
  });
}

function discardApdPhoto_(user, photoFileId) {
  const file = apdPhotoFile_(photoFileId);
  if (file.getDescription() !== "APD bukti; uploadedBy=" + user.username) {
    throw new Error("Anda tidak dapat menghapus foto bukti ini.");
  }
  const sh = ensureApdSheet_(spreadsheet_());
  const last = sh.getLastRow();
  if (last >= 2) {
    const ids = sh.getRange(2, 17, last - 1, 1).getDisplayValues();
    if (
      ids.some(function (row) {
        return parseApdPhotoIds_(row[0]).indexOf(file.getId()) >= 0;
      })
    ) {
      throw new Error("Foto bukti sudah terhubung dengan data APD.");
    }
  }
  file.setTrashed(true);
}

function normalizeApdPoint_(value, variable, index) {
  const point = Number(value);
  const criteria = APD_POINT_CRITERIA_[variable.key] || [];
  if (
    !isFinite(point) ||
    Math.floor(point) !== point ||
    point < 0 ||
    point > APD_MAX_POINT_ ||
    !criteria[point]
  ) {
    throw new Error(
      "Data APD ke-" +
        (index + 1) +
        ': poin "' +
        variable.label +
        '" harus menggunakan nilai 0 sampai 3 yang tersedia.',
    );
  }
  return point;
}

function buildApdRecord_(raw, index, user, existingPhotoId) {
  const data = raw && typeof raw === "object" ? raw : {};
  const tanggal = String(data.tanggal || "").trim();
  const operator = String(data.operator || "").trim();
  const alasan = String(data.alasan || "").trim();
  const alasanWordCount = alasan
    ? alasan.split(/\s+/).filter(Boolean).length
    : 0;
  const scores =
    data.scores && typeof data.scores === "object" ? data.scores : {};

  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) {
    throw new Error("Data APD ke-" + (index + 1) + ": tanggal tidak valid.");
  }
  if (!operator) {
    throw new Error(
      "Data APD ke-" + (index + 1) + ": nama operator wajib diisi.",
    );
  }
  if (alasanWordCount > 300) {
    throw new Error(
      "Data APD ke-" + (index + 1) + ": alasan / keterangan maksimal 300 kata.",
    );
  }

  let totalPoints = 0;
  let percentage = 0;
  let totalWeight = 0;
  APD_VARIABLES_.forEach(function (variable) {
    const point = normalizeApdPoint_(scores[variable.key], variable, index);
    totalPoints += point;
    percentage += point * (variable.weight / APD_MAX_POINT_);
    totalWeight += variable.weight;
  });
  percentage = (percentage / totalWeight) * 100;

  const requestId = String(data.clientRequestId || "").trim();
  const validRequestId = /^[A-Za-z0-9-]{16,100}$/.test(requestId)
    ? requestId
    : "";
  const photoFileIds = Array.isArray(data.photoFileIds)
    ? data.photoFileIds.map(String).filter(Boolean)
    : parseApdPhotoIds_(data.photoFileId);
  if (photoFileIds.length > 3) throw new Error("Maksimal 3 foto bukti APD.");
  const existingPhotoIds = parseApdPhotoIds_(existingPhotoId);
  photoFileIds.forEach(function (photoFileId) {
    const file = apdPhotoFile_(photoFileId);
    if (
      existingPhotoIds.indexOf(photoFileId) < 0 &&
      file.getDescription() !== "APD bukti; uploadedBy=" + user.username
    ) {
      throw new Error(
        "Data APD ke-" + (index + 1) + ": foto bukti bukan milik user ini.",
      );
    }
  });

  return {
    tanggal: tanggal,
    operator: operator,
    scores: {
      maskerTidakSesuai: Number(scores.maskerTidakSesuai),
      lenganDitarik: Number(scores.lenganDitarik),
      sepatuDiinjak: Number(scores.sepatuDiinjak),
      rambutKelihatan: Number(scores.rambutKelihatan),
      resletingTidakPenuh: Number(scores.resletingTidakPenuh),
      memakaiAksesoris: Number(scores.memakaiAksesoris),
      kebersihanSepatu: Number(scores.kebersihanSepatu),
    },
    percentage: Math.round(percentage * 100) / 100,
    totalPoints: totalPoints,
    alasan: alasan,
    photoFileIds: photoFileIds,
    photoFileId: encodeApdPhotoIds_(photoFileIds),
    clientRequestId: validRequestId,
  };
}

function apdEntryKey_(tanggal, operator) {
  return (
    String(tanggal || "").trim() +
    "||" +
    String(operator || "")
      .trim()
      .toLowerCase()
  );
}

function apdRowToObject_(row, rowNumber) {
  const values = row || [];
  const percentageRaw = values[10];
  let percentage = Number(percentageRaw);
  if (!isFinite(percentage)) {
    percentage = Number(
      String(percentageRaw || "")
        .replace(/\s/g, "")
        .replace(/%$/, "")
        .replace(",", "."),
    );
  }
  return {
    id: String(values[12] || "").trim(),
    rowNumber: rowNumber,
    tanggal: formatDateCell_(values[0]),
    operator: String(values[1] || "").trim(),
    scores: {
      maskerTidakSesuai: number_(values[2]),
      lenganDitarik: number_(values[3]),
      sepatuDiinjak: number_(values[4]),
      rambutKelihatan: number_(values[5]),
      resletingTidakPenuh: number_(values[6]),
      memakaiAksesoris: number_(values[7]),
      kebersihanSepatu: number_(values[8]),
    },
    totalPoints: number_(values[9]),
    percentage: isFinite(percentage) ? percentage : 0,
    alasan: String(values[11] || ""),
    photoFileIds: parseApdPhotoIds_(values[16]),
    photoFileId: String(values[16] || ""),
    createdBy: String(values[13] || ""),
    createdAt: isoCell_(values[14]),
    updatedAt: isoCell_(values[15]),
  };
}

function getApdEntries_() {
  const sh = ensureApdSheet_(spreadsheet_());
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const rows = sh
    .getRange(2, 1, lastRow - 1, APP.APD_HEADERS.length)
    .getValues();
  return apdRowsToEntries_(rows);
}

function apdRowsToEntries_(rows) {
  return rows
    .map(function (row, index) {
      return apdRowToObject_(row, index + 2);
    })
    .sort(function (a, b) {
      return (
        String(b.tanggal || "").localeCompare(String(a.tanggal || "")) ||
        String(b.updatedAt || b.createdAt || "").localeCompare(
          String(a.updatedAt || a.createdAt || ""),
        ) ||
        b.rowNumber - a.rowNumber
      );
    });
}

function getApdEntriesByDate_(dateText) {
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateText || "").trim())
    ? String(dateText).trim()
    : Utilities.formatDate(
        new Date(),
        Session.getScriptTimeZone() || "Asia/Jakarta",
        "yyyy-MM-dd",
      );
  const sh = ensureApdSheet_(spreadsheet_());
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const rows = sh
    .getRange(2, 1, lastRow - 1, APP.APD_HEADERS.length)
    .getValues();
  return rows
    .map(function (row, index) {
      return apdRowToObject_(row, index + 2);
    })
    .filter(function (item) {
      return item.tanggal === targetDate;
    })
    .sort(function (a, b) {
      return (
        String(b.updatedAt || b.createdAt || "").localeCompare(
          String(a.updatedAt || a.createdAt || ""),
        ) || b.rowNumber - a.rowNumber
      );
    });
}

function findApdRowById_(sh, id) {
  const target = String(id || "").trim();
  if (!target) throw new Error("ID data APD tidak valid.");
  const lastRow = sh.getLastRow();
  if (lastRow < 2) throw new Error("Data APD tidak ditemukan.");
  const ids = sh.getRange(2, 13, lastRow - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "").trim() === target) return i + 2;
  }
  throw new Error(
    "Data APD tidak ditemukan atau sudah berubah. Muat ulang data lalu coba lagi.",
  );
}

function ensureNoApdDuplicate_(sh, tanggal, operator, excludeId) {
  const targetKey = apdEntryKey_(tanggal, operator);
  const exclude = String(excludeId || "").trim();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const values = sh
    .getRange(2, 1, lastRow - 1, APP.APD_HEADERS.length)
    .getValues();
  for (let i = 0; i < values.length; i++) {
    const rowId = String(values[i][12] || "").trim();
    if (exclude && rowId === exclude) continue;
    const rowKey = apdEntryKey_(formatDateCell_(values[i][0]), values[i][1]);
    if (rowKey === targetKey) {
      throw new Error(
        'Operator "' +
          operator +
          '" sudah memiliki data APD pada tanggal ' +
          tanggal +
          ". Gunakan tombol Edit pada data yang sudah tersimpan.",
      );
    }
  }
}

function createApdEntriesBatch_(user, dataList) {
  if (!Array.isArray(dataList) || !dataList.length) {
    throw new Error("Data preview APD yang akan disimpan kosong.");
  }
  if (dataList.length > 200) {
    throw new Error("Maksimal 200 data APD per sekali simpan.");
  }

  const records = dataList.map(function (raw, index) {
    return buildApdRecord_(raw, index, user, "");
  });

  const master = getMaster_();
  records.forEach(function (record) {
    record.operator = canonicalMasterValue_(
      master.operator,
      record.operator,
      "Operator",
    );
  });

  const seenIds = {};
  const seenKeys = {};
  records.forEach(function (record, index) {
    const id = record.clientRequestId;
    if (!id)
      throw new Error(
        "Data APD ke-" + (index + 1) + ": ID preview tidak valid.",
      );
    if (seenIds[id])
      throw new Error("Data APD ke-" + (index + 1) + ": ID preview duplikat.");
    seenIds[id] = true;

    const key = apdEntryKey_(record.tanggal, record.operator);
    if (seenKeys[key]) {
      throw new Error(
        'Operator "' +
          record.operator +
          '" muncul lebih dari sekali pada tanggal yang sama di preview APD.',
      );
    }
    seenKeys[key] = true;
  });

  const sh = ensureApdSheet_(spreadsheet_());
  const lastRow = sh.getLastRow();
  const existingRows =
    lastRow >= 2
      ? sh.getRange(2, 1, lastRow - 1, APP.APD_HEADERS.length).getValues()
      : [];
  const existingIds = {};
  const existingKeys = {};
  existingRows.forEach(function (row) {
    const rowId = String(row[12] || "").trim();
    if (rowId) existingIds[rowId] = true;
    const key = apdEntryKey_(formatDateCell_(row[0]), row[1]);
    if (key !== "||") existingKeys[key] = rowId || true;
  });

  const rowsToWrite = [];
  const savedIds = [];
  const duplicateIds = [];
  const now = new Date().toISOString();

  records.forEach(function (record) {
    const id = record.clientRequestId;
    if (existingIds[id]) {
      savedIds.push(id);
      duplicateIds.push(id);
      return;
    }

    const key = apdEntryKey_(record.tanggal, record.operator);
    if (existingKeys[key]) {
      throw new Error(
        'Operator "' +
          record.operator +
          '" sudah memiliki data APD pada tanggal ' +
          record.tanggal +
          ". Gunakan tombol Edit pada data yang sudah tersimpan.",
      );
    }

    rowsToWrite.push([
      record.tanggal,
      record.operator,
      record.scores.maskerTidakSesuai,
      record.scores.lenganDitarik,
      record.scores.sepatuDiinjak,
      record.scores.rambutKelihatan,
      record.scores.resletingTidakPenuh,
      record.scores.memakaiAksesoris,
      record.scores.kebersihanSepatu,
      record.totalPoints,
      record.percentage,
      record.alasan,
      id,
      user.username,
      now,
      now,
      record.photoFileId,
    ]);
    savedIds.push(id);
    existingIds[id] = true;
    existingKeys[key] = id;
  });

  if (rowsToWrite.length) {
    const startRow = Math.max(lastRow + 1, 2);
    sh.getRange(
      startRow,
      1,
      rowsToWrite.length,
      APP.APD_HEADERS.length,
    ).setValues(rowsToWrite);
  }

  return {
    savedCount: records.length,
    newCount: rowsToWrite.length,
    duplicateIds: duplicateIds,
    savedIds: savedIds,
    entries: rowsToWrite.map(function (row, index) {
      return apdRowToObject_(row, Math.max(lastRow + 1, 2) + index);
    }),
  };
}

function updateApdEntry_(user, id, rawData) {
  const sh = ensureApdSheet_(spreadsheet_());
  const rowNumber = findApdRowById_(sh, id);
  const createdBy = String(sh.getRange(rowNumber, 14).getValue() || "");
  requireManage_(user, "apd", createdBy === user.username ? "own" : "others");
  const existingPhotoId = String(sh.getRange(rowNumber, 17).getValue() || "");
  const record = buildApdRecord_(rawData, 0, user, existingPhotoId);
  record.operator = canonicalMasterValue_(
    getMaster_().operator,
    record.operator,
    "Operator",
  );
  ensureNoApdDuplicate_(sh, record.tanggal, record.operator, id);

  const oldMeta = sh.getRange(rowNumber, 13, 1, 4).getValues()[0];
  const now = new Date().toISOString();
  sh.getRange(rowNumber, 1, 1, APP.APD_HEADERS.length).setValues([
    [
      record.tanggal,
      record.operator,
      record.scores.maskerTidakSesuai,
      record.scores.lenganDitarik,
      record.scores.sepatuDiinjak,
      record.scores.rambutKelihatan,
      record.scores.resletingTidakPenuh,
      record.scores.memakaiAksesoris,
      record.scores.kebersihanSepatu,
      record.totalPoints,
      record.percentage,
      record.alasan,
      String(id),
      String(oldMeta[1] || user.username),
      oldMeta[2] || now,
      now,
      record.photoFileId,
    ],
  ]);

  parseApdPhotoIds_(existingPhotoId).forEach(function (oldId) {
    if (record.photoFileIds.indexOf(oldId) < 0) {
      try {
        apdPhotoFile_(oldId).setTrashed(true);
      } catch (_) {}
    }
  });

  const updatedRow = sh
    .getRange(rowNumber, 1, 1, APP.APD_HEADERS.length)
    .getValues()[0];
  return {
    entry: apdRowToObject_(updatedRow, rowNumber),
  };
}

function deleteApdEntry_(user, id) {
  const sh = ensureApdSheet_(spreadsheet_());
  const rowNumber = findApdRowById_(sh, id);
  const createdBy = String(sh.getRange(rowNumber, 14).getValue() || "");
  requireManage_(user, "apd", createdBy === user.username ? "own" : "others");
  const photoFileIds = parseApdPhotoIds_(sh.getRange(rowNumber, 17).getValue());
  const tanggal = formatDateCell_(sh.getRange(rowNumber, 1).getValue());
  sh.deleteRow(rowNumber);
  photoFileIds.forEach(function (photoFileId) {
    try {
      apdPhotoFile_(photoFileId).setTrashed(true);
    } catch (_) {}
  });
  return {
    deletedId: String(id),
  };
}

/**
 * Simpan banyak data preview dalam satu request / satu lock.
 *
 * Tujuan performa:
 * - Sheet Pengerjaan dibaca sekali.
 * - Semua baris baru ditulis sekali dengan setValues().
 * - Model Filling -> Press dihitung sekali.
 * - Sheet Sisa Press + metadata Press disinkronkan sekali.
 *
 * clientRequestId tetap dipakai sebagai idempotency key. Jika request browser
 * terputus setelah server selesai menulis, klik Simpan lagi tidak membuat duplikat.
 */
function createEntriesBatch_(user, dataList) {
  if (!Array.isArray(dataList) || !dataList.length) {
    throw new Error("Data preview yang akan disimpan kosong.");
  }
  if (dataList.length > 500) {
    throw new Error("Maksimal 500 data per sekali simpan.");
  }

  const sh = entrySheet_();
  const values = sh.getDataRange().getValues();
  const currentEntries = [];
  const existingById = {};

  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    const entry = rowToEntry_(values[i]);
    currentEntries.push(entry);
    existingById[String(entry.id)] = entry;
  }

  // Ambil master sekali saja untuk seluruh batch.
  const master = getMaster_();
  const spkEntries = getSpkEntries_();
  const now = new Date();
  const newEntries = [];
  const resultEntries = [];
  const savedIds = [];
  const duplicateIds = [];
  const seenIds = {};
  const spkByBatchNo = {};
  const fillingQtyByBatchNo = {};
  spkEntries.forEach(function (item) {
    spkByBatchNo[item.batchNo] = item;
  });
  currentEntries.forEach(function (entry) {
    if (entry.tab !== "filling") return;
    const batchNo = String(entry.reportId || "")
      .replace(/^(?:FILL|PRESS)\s*-\s*/i, "")
      .trim();
    fillingQtyByBatchNo[batchNo] =
      number_(fillingQtyByBatchNo[batchNo]) + number_(entry.totalQty);
  });

  dataList.forEach(function (raw, index) {
    const data = raw && typeof raw === "object" ? Object.assign({}, raw) : {};

    if (!data || (data.line !== "filling" && data.line !== "press")) {
      throw new Error(
        "Data ke-" + (index + 1) + ": Line pengerjaan tidak valid.",
      );
    }
    if (!data.operator || !data.produk || !data.botol) {
      throw new Error(
        "Data ke-" + (index + 1) + ": Operator, Produk, dan Botol wajib diisi.",
      );
    }

    // Validasi canonical memakai snapshot master yang sama agar tidak memanggil
    // getMaster_() berulang untuk setiap kolom dan setiap baris.
    data.operator = canonicalMasterValue_(
      master.operator,
      data.operator,
      "Operator",
    );
    data.produk = canonicalMasterValue_(master.produk, data.produk, "Produk");
    data.botol = canonicalMasterValue_(master.botol, data.botol, "Botol");
    data.batchNo = validateSpkBatchForEntry_(data, spkEntries);

    const qtyKardus = Number(data.qtyKardus);
    const qtyBotol = Number(data.qtyBotolPerKardus);
    const qtyPecah = Number(data.qtyBotolPecah || 0);
    const qtyKardusBasah =
      data.line === "filling" ? Number(data.qtyKardusBasah || 0) : 0;
    if (
      !isFinite(qtyKardus) ||
      !isFinite(qtyBotol) ||
      !isFinite(qtyPecah) ||
      !isFinite(qtyKardusBasah)
    ) {
      throw new Error(
        "Data ke-" + (index + 1) + ": Qty harus berupa angka yang valid.",
      );
    }
    if (qtyKardus < 0 || qtyBotol < 0 || qtyPecah < 0 || qtyKardusBasah < 0) {
      throw new Error("Data ke-" + (index + 1) + ": Qty tidak boleh negatif.");
    }
    if (data.line === "filling" && qtyKardusBasah > qtyKardus) {
      throw new Error(
        "Data ke-" +
          (index + 1) +
          ": Qty Kardus Basah tidak boleh lebih besar dari Qty Pengerjaan (Kardus).",
      );
    }
    if (data.line === "press" && qtyKardus * qtyBotol <= 0) {
      throw new Error(
        "Data ke-" +
          (index + 1) +
          ": Total Qty Press harus lebih dari 0 botol.",
      );
    }

    const requestedId = String(data.clientRequestId || "").trim();
    const validRequestedId = /^[A-Za-z0-9-]{16,100}$/.test(requestedId)
      ? requestedId
      : "";
    const id = validRequestedId || Utilities.getUuid();

    if (seenIds[id]) {
      throw new Error(
        "Data ke-" + (index + 1) + ": ID preview duplikat dalam sekali simpan.",
      );
    }
    seenIds[id] = true;

    // Retry aman: bila ID sudah pernah tersimpan oleh user yang sama,
    // anggap sukses dan jangan tulis baris kedua.
    const existing = existingById[id];
    if (existing) {
      if (existing.createdBy !== user.username) {
        throw new Error(
          "Data ke-" +
            (index + 1) +
            ": ID permintaan sudah digunakan oleh user lain.",
        );
      }
      resultEntries.push(existing);
      savedIds.push(id);
      duplicateIds.push(id);
      return;
    }

    if (data.line === "filling") {
      const spk = spkByBatchNo[data.batchNo];
      const requestedQty = qtyKardus * qtyBotol;
      const usedQty = number_(fillingQtyByBatchNo[data.batchNo]);
      if (
        spk &&
        number_(spk.qty) > 0 &&
        usedQty + requestedQty > number_(spk.qty)
      ) {
        throw new Error(
          "Data ke-" +
            (index + 1) +
            ": Qty Filling " +
            requestedQty +
            " pcs melebihi sisa kapasitas SPK " +
            data.batchNo +
            " pada baris ini, yaitu " +
            Math.max(0, number_(spk.qty) - usedQty) +
            " pcs.",
        );
      }
      fillingQtyByBatchNo[data.batchNo] = usedQty + requestedQty;
    }

    const createdAt = new Date(now.getTime() + index);
    const line = data.line === "press" ? "press" : "filling";
    // updateCount dari client hanya merepresentasikan edit yang sudah terjadi
    // saat data masih berada di Preview. Nilainya dipertahankan saat CREATE.
    const previewUpdateCount = Math.max(
      0,
      Math.floor(number_(data.updateCount)),
    );
    const previewUpdatedAt =
      normalizeIsoTimestamp_(data.updatedAt) ||
      (previewUpdateCount > 0 ? createdAt.toISOString() : "");
    const entry = {
      id: id,
      reportId: makeReportId_(line, createdAt, data.batchNo),
      tab: line,
      tanggal: String(data.tanggal),
      operator: String(data.operator).trim(),
      produk: String(data.produk).trim(),
      botol: String(data.botol).trim(),
      qtyKardus: qtyKardus,
      qtyBotolPerKardus: qtyBotol,
      totalQty: qtyKardus * qtyBotol,
      botolPecahJenis: String(data.botol || "").trim(),
      qtyBotolPecah: qtyPecah,
      qtyKardusBasah: qtyKardusBasah,
      createdBy: user.username,
      createdAt: createdAt.toISOString(),
      updatedAt: previewUpdatedAt,
      updateCount: previewUpdateCount,
      sisaPressTanggalAsal: "",
      keterangan: "",
    };

    newEntries.push(entry);
    resultEntries.push(entry);
    savedIds.push(id);
  });

  // Semua baris baru diproyeksikan sekaligus. Ini menjaga validasi Press tetap
  // akurat tetapi tanpa read + rebuild berulang per baris.
  const projectedEntries = currentEntries.concat(newEntries);
  const adjustments = getPressAdjustments_();
  const model = buildPressAllocationModel_(projectedEntries, adjustments);

  const blockingOverflow = newOrWorsenedPressOverflow_(
    model,
    currentEntries,
    adjustments,
    newEntries
      .filter(function (entry) {
        return entry.tab === "press";
      })
      .map(function (entry) {
        return String(entry.id);
      }),
  );
  if (blockingOverflow.length) {
    const newIdMap = {};
    newEntries.forEach(function (entry) {
      newIdMap[String(entry.id)] = true;
    });
    const overflow =
      blockingOverflow.find(function (item) {
        return newIdMap[String(item.id)];
      }) || blockingOverflow[0];

    throw new Error(
      "Qty Press melebihi Qty Filling yang tersedia untuk produk " +
        overflow.produk +
        " pada tanggal " +
        overflow.tanggal +
        ". Kekurangan " +
        number_(overflow.kurang) +
        " botol. Balance dihitung berdasarkan Nama Produk dan FIFO tanggal Filling.",
    );
  }

  // Isi metadata Press langsung dari model sebelum penulisan batch.
  projectedEntries.forEach(function (entry) {
    const meta =
      entry.tab === "press" ? model.pressMeta[String(entry.id)] : null;
    entry.sisaPressTanggalAsal = meta ? meta.tanggalAsal : "";
    entry.keterangan = meta ? meta.keterangan : "";
  });

  if (newEntries.length) {
    const startRow = Math.max(sh.getLastRow() + 1, 2);
    sh.getRange(
      startRow,
      1,
      newEntries.length,
      APP.ENTRY_HEADERS.length,
    ).setValues(newEntries.map(entryToRow_));
  }

  // Satu kali sinkronisasi untuk seluruh batch.
  const remainders = writePressModel_(projectedEntries, model, adjustments);

  return {
    entries: resultEntries,
    savedIds: savedIds,
    duplicateIds: duplicateIds,
    remainders: remainders,
  };
}

function createEntry_(user, data) {
  validateEntry_(data);

  const createdAt = new Date();
  const line = data.line === "press" ? "press" : "filling";

  const requestedId = String(data.clientRequestId || "").trim();
  const validRequestedId = /^[A-Za-z0-9-]{16,100}$/.test(requestedId)
    ? requestedId
    : "";

  if (validRequestedId) {
    const existingRow = findEntryRow_(validRequestedId);
    if (existingRow) {
      const existing = rowToEntry_(existingRow.values);
      if (existing.createdBy === user.username) return existing;
      throw new Error("ID permintaan sudah digunakan oleh user lain.");
    }
  }

  const id = validRequestedId || Utilities.getUuid();
  const reportId = makeReportId_(line, createdAt, data.batchNo);
  const qtyKardus = number_(data.qtyKardus);
  const qtyBotol = number_(data.qtyBotolPerKardus);
  const qtyPecah = number_(data.qtyBotolPecah);
  const qtyKardusBasah = line === "filling" ? number_(data.qtyKardusBasah) : 0;
  const previewUpdateCount = Math.max(0, Math.floor(number_(data.updateCount)));
  const previewUpdatedAt =
    normalizeIsoTimestamp_(data.updatedAt) ||
    (previewUpdateCount > 0 ? createdAt.toISOString() : "");

  const entry = {
    id: id,
    reportId: reportId,
    tab: line,
    tanggal: String(data.tanggal),
    operator: String(data.operator).trim(),
    produk: String(data.produk).trim(),
    botol: String(data.botol).trim(),
    qtyKardus: qtyKardus,
    qtyBotolPerKardus: qtyBotol,
    totalQty: qtyKardus * qtyBotol,
    botolPecahJenis: String(data.botolPecahJenis || "").trim(),
    qtyBotolPecah: qtyPecah,
    qtyKardusBasah: qtyKardusBasah,
    createdBy: user.username,
    createdAt: createdAt.toISOString(),
    updatedAt: previewUpdatedAt,
    updateCount: previewUpdateCount,
    sisaPressTanggalAsal: "",
    keterangan: "",
  };

  // Balance Press dihitung berdasarkan Nama Produk dan tidak boleh memakai Filling tanggal setelah Press.
  assertProjectedBalance_([entry], "");

  entrySheet_().appendRow(entryToRow_(entry));
  rebuildPressRemainders_();

  const saved = findEntryRow_(id);
  return saved ? rowToEntry_(saved.values) : entry;
}

function updateEntry_(user, id, data) {
  if (!id) throw new Error("ID data tidak ditemukan.");
  validateEntry_(data, id);

  const found = findEntryRow_(id);
  if (!found) throw new Error("Data yang akan di-update tidak ditemukan.");

  const existing = rowToEntry_(found.values);
  const isOwn = existing.createdBy === user.username;
  requireManage_(user, existing.tab, isOwn ? "own" : "others");
  requireLevel_(user, data.line === "press" ? "press" : "filling", "write");

  const qtyKardus = number_(data.qtyKardus);
  const qtyBotol = number_(data.qtyBotolPerKardus);
  const updatedLine = data.line === "press" ? "press" : "filling";
  const qtyKardusBasah =
    updatedLine === "filling" ? number_(data.qtyKardusBasah) : 0;

  // Audit perubahan data Pengerjaan:
  // - updatedAt hanya menyimpan timestamp perubahan terakhir
  // - updateCount menyimpan berapa kali data tersimpan pernah di-update
  // - fallback parseEntryUpdateAudit_ menjaga kompatibilitas data versi lama
  //   yang pernah menyimpan "timestamp | Perubahan ke-X" di updatedAt.
  const legacyAudit = parseEntryUpdateAudit_(existing.updatedAt);
  const previousUpdateCount = Math.max(
    number_(existing.updateCount),
    legacyAudit.count,
  );
  const nextUpdateCount = previousUpdateCount + 1;
  const updatedAtValue = new Date().toISOString();

  const updated = {
    id: existing.id,
    reportId: data.batchNo
      ? makeReportId_(updatedLine, new Date(), data.batchNo)
      : existing.reportId,
    tab: updatedLine,
    tanggal: String(data.tanggal),
    operator: String(data.operator).trim(),
    produk: String(data.produk).trim(),
    botol: String(data.botol).trim(),
    qtyKardus: qtyKardus,
    qtyBotolPerKardus: qtyBotol,
    totalQty: qtyKardus * qtyBotol,
    botolPecahJenis: String(data.botolPecahJenis || "").trim(),
    qtyBotolPecah: number_(data.qtyBotolPecah),
    qtyKardusBasah: qtyKardusBasah,
    createdBy: existing.createdBy,
    createdAt: existing.createdAt,
    updatedAt: updatedAtValue,
    updateCount: nextUpdateCount,
    sisaPressTanggalAsal: "",
    keterangan: "",
  };

  assertProjectedBalance_([existing, updated], existing.id);

  entrySheet_()
    .getRange(found.row, 1, 1, APP.ENTRY_HEADERS.length)
    .setValues([entryToRow_(updated)]);
  rebuildPressRemainders_();

  const saved = findEntryRow_(id);
  return saved ? rowToEntry_(saved.values) : updated;
}

function deleteEntry_(user, id) {
  const sh = entrySheet_();
  const values = sh.getDataRange().getValues();
  const currentEntries = [];
  let found = null;
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    const entry = rowToEntry_(values[i]);
    currentEntries.push(entry);
    if (String(entry.id) === String(id))
      found = { row: i + 1, values: values[i], entry: entry };
  }
  if (!found) throw new Error("Data tidak ditemukan.");

  const existing = found.entry;
  const isOwn = existing.createdBy === user.username;
  requireManage_(user, existing.tab, isOwn ? "own" : "others");

  const deletedIds = [String(existing.id)];
  const adjustments = getPressAdjustments_();
  const currentModel = buildPressAllocationModel_(currentEntries, adjustments);

  // Filling tidak boleh dihapus setelah dipakai sedikit ataupun seluruhnya oleh
  // Press. Press harus dihapus lebih dahulu agar jumlahnya kembali ke saldo
  // pengerjaan yang belum di-press.
  if (existing.tab === "filling") {
    const batchNo = reportBatchNo_(existing.reportId);
    const relatedPress = currentEntries.filter(function (entry) {
      if (entry.tab !== "press") return false;
      const allocation = currentModel.pressMeta[String(entry.id)] || {};
      const consumesFilling =
        (allocation.consumedLotIds || []).indexOf(String(existing.id)) >= 0;
      const hasSameBatch =
        batchNo && reportBatchNo_(entry.reportId) === batchNo;
      return consumesFilling || hasSameBatch;
    });
    if (relatedPress.length) {
      throw new Error(
        "Data Filling tidak dapat dihapus karena sudah dilakukan Press, baik sebagian maupun seluruh qty. " +
          "Hapus data Press terkait terlebih dahulu agar qty kembali ke pengerjaan belum di-press.",
      );
    }
  }

  const projectedEntries = currentEntries.filter(function (entry) {
    return String(entry.id) !== String(existing.id);
  });
  const projectedModel = buildPressAllocationModel_(
    projectedEntries,
    adjustments,
  );
  if (existing.tab === "filling") {
    const blocking = newOrWorsenedPressOverflow_(
      projectedModel,
      currentEntries,
      adjustments,
      [],
    );
    if (blocking.length) {
      throw new Error(
        "Data Filling tidak dapat dihapus karena saldo sudah digunakan pada riwayat Press/penutupan.",
      );
    }
  }

  sh.deleteRow(found.row);
  // Snapshot proyeksi yang sama langsung dipakai untuk menulis saldo baru.
  const remainders = writePressModel_(
    projectedEntries,
    projectedModel,
    adjustments,
  );
  return { deletedIds: deletedIds, remainders: remainders };
}

function reportBatchNo_(reportId) {
  const match = /^(?:FILL|PRESS)\s*-\s*(\d{2}-\d{8})$/i.exec(
    String(reportId || "").trim(),
  );
  return match ? match[1] : "";
}

function getEntries_() {
  const sh = entrySheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh
    .getRange(2, 1, lastRow - 1, APP.ENTRY_HEADERS.length)
    .getValues();
  const result = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i][0]) result.push(rowToEntry_(values[i]));
  }
  return result;
}

function findEntryRow_(id) {
  const sh = entrySheet_();
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id))
      return { row: i + 1, values: values[i] };
  }
  return null;
}

function entryToRow_(e) {
  return [
    e.id,
    e.reportId,
    e.tab,
    e.tanggal,
    e.operator,
    e.produk,
    e.botol,
    e.qtyKardus,
    e.qtyBotolPerKardus,
    e.totalQty,
    e.botolPecahJenis,
    e.qtyBotolPecah,
    number_(e.qtyKardusBasah),
    e.createdBy,
    e.createdAt,
    e.updatedAt,
    Math.max(0, Math.floor(number_(e.updateCount))),
    e.sisaPressTanggalAsal || "",
    e.keterangan || "",
  ];
}

function rowToEntry_(row) {
  return {
    id: String(row[0] || ""),
    reportId: String(row[1] || ""),
    tab: String(row[2] || ""),
    tanggal: formatDateCell_(row[3]),
    operator: String(row[4] || ""),
    produk: String(row[5] || ""),
    botol: String(row[6] || ""),
    qtyKardus: number_(row[7]),
    qtyBotolPerKardus: number_(row[8]),
    totalQty: number_(row[9]),
    botolPecahJenis: String(row[10] || ""),
    qtyBotolPecah: number_(row[11]),
    qtyKardusBasah: number_(row[12]),
    createdBy: String(row[13] || ""),
    createdAt: isoCell_(row[14]),
    updatedAt: parseEntryUpdateAudit_(row[15]).timestamp,
    updateCount: Math.max(
      number_(row[16]),
      parseEntryUpdateAudit_(row[15]).count,
    ),
    sisaPressTanggalAsal: String(row[17] || ""),
    keterangan: String(row[18] || ""),
  };
}

function validateEntry_(data, excludeEntryId) {
  if (!data) throw new Error("Data pengerjaan kosong.");
  if (data.line !== "filling" && data.line !== "press")
    throw new Error("Line pengerjaan tidak valid.");
  if (!data.operator || !data.produk || !data.botol)
    throw new Error("Operator, Produk, dan Botol wajib diisi.");

  // Jangan percaya input browser. Semua nilai wajib benar-benar ada di sheet Master.
  data.operator = canonicalMasterValue_(
    getMaster_().operator,
    data.operator,
    "Operator",
  );
  data.produk = canonicalMasterValue_(
    getMaster_().produk,
    data.produk,
    "Produk",
  );
  data.botol = canonicalMasterValue_(getMaster_().botol, data.botol, "Botol");
  data.batchNo = validateSpkBatchForEntry_(data);

  const qtyKardusRaw = Number(data.qtyKardus);
  const qtyBotolRaw = Number(data.qtyBotolPerKardus);
  const qtyPecahRaw = Number(data.qtyBotolPecah || 0);
  const qtyKardusBasahRaw =
    data.line === "filling" ? Number(data.qtyKardusBasah || 0) : 0;
  if (
    !isFinite(qtyKardusRaw) ||
    !isFinite(qtyBotolRaw) ||
    !isFinite(qtyPecahRaw) ||
    !isFinite(qtyKardusBasahRaw)
  ) {
    throw new Error("Qty harus berupa angka yang valid.");
  }
  if (
    qtyKardusRaw < 0 ||
    qtyBotolRaw < 0 ||
    qtyPecahRaw < 0 ||
    qtyKardusBasahRaw < 0
  ) {
    throw new Error("Qty tidak boleh negatif.");
  }
  if (data.line === "filling" && qtyKardusBasahRaw > qtyKardusRaw) {
    throw new Error(
      "Qty Kardus Basah tidak boleh lebih besar dari Qty Pengerjaan (Kardus).",
    );
  }
  if (data.line === "press" && qtyKardusRaw * qtyBotolRaw <= 0) {
    throw new Error("Total Qty Press harus lebih dari 0 botol.");
  }
  if (data.line === "filling") {
    assertSpkFillingQty_(data, excludeEntryId);
  }

  // Jenis botol pecah selalu mengikuti botol yang sedang dikerjakan.
  data.botolPecahJenis = data.botol;
  // Qty Kardus Basah hanya digunakan pada Filling.
  data.qtyKardusBasah = data.line === "filling" ? qtyKardusBasahRaw : 0;
}

function assertSpkFillingQty_(data, excludeEntryId) {
  const batchNo = String(data.batchNo || "").trim();
  const spk = getSpkEntries_().find(function (item) {
    return item.batchNo === batchNo;
  });
  if (!spk || number_(spk.qty) <= 0) return; // kompatibilitas SPK lama tanpa Qty
  const requested = Number(data.qtyKardus) * Number(data.qtyBotolPerKardus);
  const used = getEntries_()
    .filter(function (entry) {
      return (
        entry.tab === "filling" &&
        reportBatchNo_(entry.reportId) === batchNo &&
        String(entry.id || "") !== String(excludeEntryId || "")
      );
    })
    .reduce(function (total, entry) {
      return total + number_(entry.totalQty);
    }, 0);
  if (used + requested > number_(spk.qty)) {
    throw new Error(
      "Qty Filling " +
        requested +
        " pcs melebihi sisa kapasitas SPK " +
        batchNo +
        " pada baris ini, yaitu " +
        Math.max(0, number_(spk.qty) - used) +
        " pcs.",
    );
  }
}

function canonicalMasterValue_(list, value, label) {
  const target = String(value || "")
    .trim()
    .toLowerCase();
  const values = (list || [])
    .map(function (item) {
      return String(item || "").trim();
    })
    .filter(String);
  for (let i = 0; i < values.length; i++) {
    if (values[i].toLowerCase() === target) return values[i];
  }
  throw new Error(
    label +
      ' "' +
      String(value || "").trim() +
      '" tidak tersedia di data Master.',
  );
}

function balanceKey_(produk, botol) {
  return (
    String(produk || "")
      .trim()
      .toLowerCase() +
    "||" +
    String(botol || "")
      .trim()
      .toLowerCase()
  );
}

function productKey_(produk) {
  return String(produk || "")
    .trim()
    .toLowerCase();
}

let ENTRY_READY_SHEET_ = null;

function ensureEntrySheetSchema_(ss, forceSetup) {
  if (ENTRY_READY_SHEET_ && !forceSetup) return ENTRY_READY_SHEET_;
  let sh = ss.getSheetByName(APP.SHEETS.ENTRIES);
  if (!sh) {
    sh = ss.insertSheet(APP.SHEETS.ENTRIES);
  }

  function readHeaders_() {
    const width = Math.max(
      APP.ENTRY_HEADERS.length,
      Math.min(sh.getLastColumn() || APP.ENTRY_HEADERS.length, 40),
    );
    if (sh.getMaxColumns() < width) {
      sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    }
    return sh
      .getRange(1, 1, 1, width)
      .getDisplayValues()[0]
      .map(function (value) {
        return String(value || "").trim();
      });
  }

  // 1) Pastikan qtyKardusBasah benar-benar menjadi kolom M / ke-13.
  //    Schema lama menaruh createdBy langsung sesudah qtyBotolPecah.
  let headers = readHeaders_();
  if (
    !forceSetup &&
    APP.ENTRY_HEADERS.every(function (header, index) {
      return headers[index] === header;
    }) &&
    headers.indexOf("createdByName") < 0
  ) {
    ENTRY_READY_SHEET_ = sh;
    return sh;
  }
  const qtyPecahIndex = headers.indexOf("qtyBotolPecah"); // zero-based
  const qtyBasahIndex = headers.indexOf("qtyKardusBasah");

  if (qtyPecahIndex !== 11) {
    if (sh.getLastRow() > 1) {
      throw new Error(
        "Struktur Sheet Pengerjaan tidak sesuai. qtyBotolPecah harus berada di kolom 12, tetapi ditemukan di kolom " +
          (qtyPecahIndex >= 0 ? qtyPecahIndex + 1 : "tidak ditemukan") +
          ".",
      );
    }
  }

  if (qtyBasahIndex < 0) {
    // Sisipkan tepat setelah qtyBotolPecah agar data metadata lama ikut bergeser aman.
    sh.insertColumnAfter(12);
  } else if (qtyBasahIndex !== 12) {
    throw new Error(
      "Struktur Sheet Pengerjaan tidak sesuai. qtyKardusBasah harus berada di kolom 13, tetapi ditemukan di kolom " +
        (qtyBasahIndex + 1) +
        ".",
    );
  }

  // 2) Created By dan Created By Name duplikat. Pertahankan createdBy karena dipakai
  //    untuk permission edit/hapus, isi createdBy yang kosong dari createdByName,
  //    lalu hapus kolom createdByName secara fisik.
  headers = readHeaders_();
  const createdByIndex = headers.indexOf("createdBy");
  const createdByNameIndex = headers.indexOf("createdByName");

  if (createdByNameIndex >= 0) {
    if (createdByIndex >= 0 && sh.getLastRow() > 1) {
      const rowCount = sh.getLastRow() - 1;
      const createdByValues = sh
        .getRange(2, createdByIndex + 1, rowCount, 1)
        .getValues();
      const createdByNameValues = sh
        .getRange(2, createdByNameIndex + 1, rowCount, 1)
        .getValues();
      let needsWrite = false;
      for (let i = 0; i < rowCount; i++) {
        if (
          !String(createdByValues[i][0] || "").trim() &&
          String(createdByNameValues[i][0] || "").trim()
        ) {
          createdByValues[i][0] = createdByNameValues[i][0];
          needsWrite = true;
        }
      }
      if (needsWrite) {
        sh.getRange(2, createdByIndex + 1, rowCount, 1).setValues(
          createdByValues,
        );
      }
    }
    sh.deleteColumn(createdByNameIndex + 1);
  }

  // 3) Validasi posisi final yang dipakai backend/frontend.
  headers = readHeaders_();
  const expectedPrefix = [
    "id",
    "reportId",
    "tab",
    "tanggal",
    "operator",
    "produk",
    "botol",
    "qtyKardus",
    "qtyBotolPerKardus",
    "totalQty",
    "botolPecahJenis",
    "qtyBotolPecah",
    "qtyKardusBasah",
    "createdBy",
  ];
  for (let i = 0; i < expectedPrefix.length; i++) {
    const actual = String(headers[i] || "");
    const expected = expectedPrefix[i];
    if (actual && actual !== expected && sh.getLastRow() > 1) {
      throw new Error(
        "Struktur Sheet Pengerjaan tidak sesuai pada kolom " +
          (i + 1) +
          '. Seharusnya "' +
          expected +
          '", saat ini "' +
          actual +
          '".',
      );
    }
  }

  // 4) Tambahkan kolom updateCount tepat setelah updatedAt.
  //    Migrasi aman: kolom lama sisaPressTanggalAsal dan keterangan digeser ke kanan.
  headers = readHeaders_();
  const updatedAtIndex = headers.indexOf("updatedAt");
  const updateCountIndex = headers.indexOf("updateCount");

  if (updatedAtIndex >= 0 && updatedAtIndex !== 15 && sh.getLastRow() > 1) {
    throw new Error(
      "Struktur Sheet Pengerjaan tidak sesuai. updatedAt harus berada di kolom 16, tetapi ditemukan di kolom " +
        (updatedAtIndex + 1) +
        ".",
    );
  }

  if (updateCountIndex < 0) {
    if (sh.getLastRow() > 1) {
      // Sisipkan kolom Q / ke-17 agar kolom histori setelah updatedAt tidak tertimpa.
      sh.insertColumnAfter(16);
    }
  } else if (updateCountIndex !== 16 && sh.getLastRow() > 1) {
    throw new Error(
      "Struktur Sheet Pengerjaan tidak sesuai. updateCount harus berada di kolom 17, tetapi ditemukan di kolom " +
        (updateCountIndex + 1) +
        ".",
    );
  }

  // 5) Tetapkan header resmi. Posisi final:
  //    13 qtyKardusBasah | 14 createdBy | 15 createdAt | 16 updatedAt |
  //    17 updateCount | 18 sisaPressTanggalAsal | 19 keterangan.
  if (sh.getMaxColumns() < APP.ENTRY_HEADERS.length) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      APP.ENTRY_HEADERS.length - sh.getMaxColumns(),
    );
  }
  sh.getRange(1, 1, 1, APP.ENTRY_HEADERS.length).setValues([APP.ENTRY_HEADERS]);
  styleHeader_(sh, APP.ENTRY_HEADERS.length);
  sh.setFrozenRows(1);

  // 6) Migrasikan format audit lama:
  //    "timestamp | Perubahan ke-X" -> updatedAt=timestamp, updateCount=X.
  if (sh.getLastRow() > 1) {
    const rowCount = sh.getLastRow() - 1;
    const auditValues = sh.getRange(2, 16, rowCount, 2).getValues();
    let auditChanged = false;

    for (let i = 0; i < auditValues.length; i++) {
      const audit = parseEntryUpdateAudit_(auditValues[i][0]);
      const currentCount = Math.max(0, Math.floor(number_(auditValues[i][1])));
      const migratedCount = Math.max(currentCount, audit.count);

      if (String(auditValues[i][0] || "") !== audit.timestamp) {
        auditValues[i][0] = audit.timestamp;
        auditChanged = true;
      }
      if (currentCount !== migratedCount || auditValues[i][1] === "") {
        auditValues[i][1] = migratedCount;
        auditChanged = true;
      }
    }

    if (auditChanged) {
      sh.getRange(2, 16, rowCount, 2).setValues(auditValues);
    }
  }

  // Sel kosong qtyKardusBasah tetap dibaca sebagai 0 oleh rowToEntry_().
  ENTRY_READY_SHEET_ = sh;
  return sh;
}

function entrySheet_() {
  return ensureEntrySheetSchema_(spreadsheet_());
}

function pressRemainderSheet_(createIfMissing) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(APP.SHEETS.PRESS_REMAINDERS);
  if (!sh && createIfMissing) {
    sh = ensureSheet_(
      ss,
      APP.SHEETS.PRESS_REMAINDERS,
      APP.PRESS_REMAINDER_HEADERS,
    );
  }
  return sh || null;
}

function compareWorkChronology_(a, b) {
  const byDate = String(a.tanggal || a.tanggalAsal || "").localeCompare(
    String(b.tanggal || b.tanggalAsal || ""),
  );
  if (byDate) return byDate;
  const byCreated = String(a.createdAt || "").localeCompare(
    String(b.createdAt || ""),
  );
  if (byCreated) return byCreated;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function formatTanggalIndonesia_(dateText) {
  const text = String(dateText || "");
  const parts = text.split("-");
  if (parts.length !== 3) return text;
  const months = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember",
  ];
  const month = months[Number(parts[1]) - 1];
  if (!month) return text;
  return Number(parts[2]) + " " + month + " " + parts[0];
}

function buildPressAllocationModel_(entries, adjustments) {
  const fillingLots = (entries || [])
    .filter(function (entry) {
      return entry.tab === "filling" && number_(entry.totalQty) > 0;
    })
    .slice()
    .sort(compareWorkChronology_)
    .map(function (entry) {
      return {
        id: String(entry.id),
        batchNo: reportBatchNo_(entry.reportId),
        tanggalAsal: String(entry.tanggal || ""),
        produk: String(entry.produk || "").trim(),
        botol: String(entry.botol || "").trim(),
        qtyFilling: number_(entry.totalQty),
        qtyBotolPerKardus: number_(entry.qtyBotolPerKardus),
        qtyPressTerpakai: 0,
        qtyDitutup: 0,
        remaining: number_(entry.totalQty),
        createdAt: String(entry.createdAt || ""),
      };
    });

  const lotsByProduct = {};
  fillingLots.forEach(function (lot) {
    const key = productKey_(lot.produk);
    if (!lotsByProduct[key]) lotsByProduct[key] = [];
    lotsByProduct[key].push(lot);
  });

  const events = [];
  (entries || []).forEach(function (entry) {
    if (entry.tab !== "press" || number_(entry.totalQty) <= 0) return;
    events.push({
      type: "press",
      id: String(entry.id),
      tanggal: String(entry.tanggal || ""),
      produk: String(entry.produk || "").trim(),
      botol: String(entry.botol || "").trim(),
      qtyBotolPerKardus: number_(entry.qtyBotolPerKardus),
      targetBatchNo: reportBatchNo_(entry.reportId),
      qty: number_(entry.totalQty),
      createdAt: String(entry.createdAt || ""),
    });
  });
  (adjustments || []).forEach(function (adjustment) {
    if (number_(adjustment.qtyDitutup) <= 0) return;
    events.push({
      type: "closed",
      id: String(adjustment.id),
      tanggal: String(adjustment.tanggal || ""),
      produk: String(adjustment.produk || "").trim(),
      botol: String(adjustment.botol || "").trim(),
      qtyBotolPerKardus: number_(adjustment.qtyBotolPerKardus),
      qty: number_(adjustment.qtyDitutup),
      targetBatchNo: String(adjustment.targetBatchNo || ""),
      targetTanggalAsal: String(adjustment.targetTanggalAsal || ""),
      createdAt: String(adjustment.createdAt || ""),
    });
  });

  events.sort(compareWorkChronology_);

  const pressMeta = {};
  const overflow = [];

  events.forEach(function (event) {
    let needed = number_(event.qty);
    const lots = lotsByProduct[productKey_(event.produk)] || [];
    const consumed = [];

    for (let i = 0; i < lots.length && needed > 0; i++) {
      const lot = lots[i];
      // Press tanggal 20 tidak boleh memakai Filling tanggal 21.
      if (lot.tanggalAsal && event.tanggal && lot.tanggalAsal > event.tanggal)
        continue;
      if (lot.remaining <= 0) continue;
      // Setiap Press dan penutupan sisa hanya memakai kombinasi pada baris asal.
      if (
        balanceKey_(lot.produk, lot.botol) !==
        balanceKey_(event.produk, event.botol)
      )
        continue;
      if (
        !event.targetBatchNo &&
        event.qtyBotolPerKardus > 0 &&
        lot.qtyBotolPerKardus !== event.qtyBotolPerKardus
      )
        continue;
      if (
        event.type === "press" &&
        event.targetBatchNo &&
        lot.batchNo !== event.targetBatchNo
      )
        continue;
      if (
        event.type === "closed" &&
        event.targetTanggalAsal &&
        (lot.tanggalAsal !== event.targetTanggalAsal ||
          (event.targetBatchNo
            ? lot.batchNo !== event.targetBatchNo
            : Boolean(lot.batchNo)))
      )
        continue;

      const used = Math.min(needed, lot.remaining);
      lot.remaining -= used;
      needed -= used;

      if (event.type === "press") {
        lot.qtyPressTerpakai += used;
        consumed.push({
          tanggalAsal: lot.tanggalAsal,
          qty: used,
          lotId: lot.id,
        });
      } else {
        lot.qtyDitutup += used;
      }
    }

    if (event.type === "press") {
      const carryDates = unique_(
        consumed
          .filter(function (item) {
            return item.tanggalAsal && item.tanggalAsal < event.tanggal;
          })
          .map(function (item) {
            return item.tanggalAsal;
          }),
      );

      pressMeta[event.id] = {
        tanggalAsal: carryDates.join(", "),
        consumedLotIds: unique_(
          consumed.map(function (item) {
            return item.lotId;
          }),
        ),
        keterangan: carryDates.length
          ? "Sisa tinggalan Press tanggal " +
            carryDates.map(formatTanggalIndonesia_).join(", ")
          : "",
      };
    }

    if (needed > 0) {
      overflow.push({
        id: event.id,
        type: event.type,
        tanggal: event.tanggal,
        produk: event.produk,
        botol: event.botol || "",
        kurang: needed,
      });
    }
  });

  const remainders = fillingLots
    .filter(function (lot) {
      return lot.remaining > 0;
    })
    .map(function (lot) {
      return {
        id: lot.id,
        batchNo: lot.batchNo,
        tanggalAsal: lot.tanggalAsal,
        produk: lot.produk,
        botol: lot.botol,
        qtyFilling: lot.qtyFilling,
        qtyBotolPerKardus: lot.qtyBotolPerKardus,
        qtyPressTerpakai: lot.qtyPressTerpakai,
        qtyDitutup: lot.qtyDitutup,
        sisaQty: lot.remaining,
        status: "MENUNGGU PRESS",
        updatedAt: new Date().toISOString(),
      };
    });

  return {
    remainders: remainders,
    pressMeta: pressMeta,
    overflow: overflow,
    fillingLots: fillingLots,
  };
}

function decoratePressRemainders_(remainders, entries, adjustments) {
  const rows = Array.isArray(remainders) ? remainders : [];
  const model = buildPressAllocationModel_(entries || [], adjustments || []);
  const lotsById = {};
  // Data Pengerjaan hanya dipakai untuk melengkapi Qty Botol/Kardus karena kolom
  // tersebut belum tersimpan di sheet Sisa Press. Nilai Qty Filling, Sudah Press,
  // dan Sisa tetap dibaca langsung dari setiap baris sheet Sisa Press.
  model.fillingLots.forEach(function (lot) {
    lotsById[lot.id] = lot;
  });
  return rows.map(function (item) {
    const lot = lotsById[String(item.id)];
    const perKardus = lot
      ? lot.qtyBotolPerKardus
      : number_(item.qtyBotolPerKardus);
    return Object.assign({}, item, {
      qtyBotolPerKardus: perKardus,
    });
  });
}

function writePressModel_(entries, model, adjustments) {
  const sh = pressRemainderSheet_(true);

  if (sh.getLastRow() > 1) {
    sh.getRange(
      2,
      1,
      sh.getLastRow() - 1,
      APP.PRESS_REMAINDER_HEADERS.length,
    ).clearContent();
  }

  if (model.remainders.length) {
    const rows = model.remainders.map(function (item) {
      return [
        item.id,
        item.tanggalAsal,
        item.produk,
        item.botol,
        item.qtyFilling,
        item.qtyPressTerpakai,
        item.qtyDitutup,
        item.sisaQty,
        item.status,
        item.updatedAt,
      ];
    });
    sh.getRange(
      2,
      1,
      rows.length,
      APP.PRESS_REMAINDER_HEADERS.length,
    ).setValues(rows);
  }

  // Metadata Press ditulis satu kali secara batch. Tidak perlu membaca ulang
  // Sheet Pengerjaan karena daftar entries sudah tersedia di memori.
  const entrySh = entrySheet_();
  if (entries && entries.length) {
    const noteRows = entries.map(function (entry) {
      const meta =
        entry.tab === "press" ? model.pressMeta[String(entry.id)] : null;
      return [meta ? meta.tanggalAsal : "", meta ? meta.keterangan : ""];
    });
    entrySh.getRange(2, 18, noteRows.length, 2).setValues(noteRows);
  }

  return decoratePressRemainders_(model.remainders, entries, adjustments || []);
}

function rebuildPressRemainders_() {
  const entries = getEntries_();
  const adjustments = getPressAdjustments_();
  const model = buildPressAllocationModel_(entries, adjustments);
  return writePressModel_(entries, model, adjustments);
}

function getPressRemainders_(entriesInput, adjustmentsInput) {
  let sh = pressRemainderSheet_(false);

  // Migrasi otomatis untuk deployment lama yang belum memiliki Sheet Sisa Press.
  if (!sh) return rebuildPressRemainders_();

  const values = sh.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    result.push({
      id: String(values[i][0] || ""),
      tanggalAsal: formatDateCell_(values[i][1]),
      produk: String(values[i][2] || ""),
      botol: String(values[i][3] || ""),
      qtyFilling: number_(values[i][4]),
      qtyPressTerpakai: number_(values[i][5]),
      qtyDitutup: number_(values[i][6]),
      sisaQty: number_(values[i][7]),
      status: String(values[i][8] || ""),
      updatedAt: isoCell_(values[i][9]),
    });
  }

  // Bila baru migrasi dan sheet masih kosong sementara data Filling lama ada, bangun sekali.
  if (!result.length) {
    const entriesForCheck = Array.isArray(entriesInput)
      ? entriesInput
      : getEntries_();
    const hasFilling = entriesForCheck.some(function (entry) {
      return entry.tab === "filling" && number_(entry.totalQty) > 0;
    });
    if (hasFilling) return rebuildPressRemainders_();
  }

  const entries = Array.isArray(entriesInput) ? entriesInput : getEntries_();
  const adjustments = Array.isArray(adjustmentsInput)
    ? adjustmentsInput
    : getPressAdjustments_();
  return decoratePressRemainders_(result, entries, adjustments);
}

/**
 * Memastikan saldo Press tidak pernah melampaui Filling.
 * candidates dipakai untuk menentukan kombinasi Produk+Botol yang terdampak.
 * existingId dilewati dari data sheet, lalu candidate terakhir (jika berbeda)
 * diproyeksikan sebagai nilai baru.
 */
function newOrWorsenedPressOverflow_(
  model,
  currentEntries,
  adjustments,
  strictPressIds,
) {
  if (!model.overflow.length) return [];
  const baseline = buildPressAllocationModel_(currentEntries, adjustments);
  const previous = {};
  baseline.overflow.forEach(function (item) {
    previous[item.type + "|" + item.id] = number_(item.kurang);
  });
  // Saldo historis yang sudah kurang tidak boleh menghalangi Filling baru.
  // Kekurangan baru/bertambah tetap ditolak, begitu pula Press yang sedang disimpan.
  return model.overflow.filter(function (item) {
    return (
      (item.type === "press" &&
        (strictPressIds || []).indexOf(String(item.id)) >= 0) ||
      number_(item.kurang) > (previous[item.type + "|" + item.id] || 0)
    );
  });
}

function assertProjectedBalance_(candidates, existingId) {
  const currentEntries = getEntries_();
  let entries = currentEntries.filter(function (entry) {
    return !existingId || String(entry.id) !== String(existingId);
  });

  const projected = (candidates || []).length
    ? candidates[candidates.length - 1]
    : null;

  // CREATE: masukkan candidate.
  // UPDATE: existing dibuang lalu versi updated dimasukkan.
  // DELETE: candidates hanya berisi existing, sehingga tidak dimasukkan lagi.
  if (projected && (!existingId || (candidates || []).length > 1)) {
    entries.push(projected);
  }

  const adjustments = getPressAdjustments_();
  const model = buildPressAllocationModel_(entries, adjustments);
  const blockingOverflow = newOrWorsenedPressOverflow_(
    model,
    currentEntries,
    adjustments,
    projected && projected.tab === "press" ? [String(projected.id)] : [],
  );
  if (!blockingOverflow.length) return;

  const overflow =
    projected && projected.tab === "press"
      ? blockingOverflow.find(function (item) {
          return String(item.id) === String(projected.id);
        }) || blockingOverflow[0]
      : blockingOverflow[0];

  throw new Error(
    "Qty Press melebihi Qty Filling yang tersedia untuk " +
      overflow.produk +
      " / " +
      overflow.botol +
      " pada tanggal " +
      overflow.tanggal +
      ". Kekurangan " +
      number_(overflow.kurang) +
      " botol. Saldo dihitung berdasarkan Produk, Botol, Qty Botol per Kardus, dan FIFO tanggal Filling.",
  );
}

function pressAdjustmentSheet_(createIfMissing) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(APP.SHEETS.PRESS_ADJUSTMENTS);
  if (!sh && createIfMissing) {
    sh = ensureSheet_(
      ss,
      APP.SHEETS.PRESS_ADJUSTMENTS,
      APP.PRESS_ADJUSTMENT_HEADERS,
    );
  }
  if (sh && createIfMissing) {
    const requiredColumns = APP.PRESS_ADJUSTMENT_HEADERS.length;
    if (sh.getMaxColumns() < requiredColumns) {
      sh.insertColumnsAfter(
        sh.getMaxColumns(),
        requiredColumns - sh.getMaxColumns(),
      );
    }
    sh.getRange(1, 1, 1, requiredColumns).setValues([
      APP.PRESS_ADJUSTMENT_HEADERS,
    ]);
  }
  return sh || null;
}

function getPressAdjustments_() {
  const sh = pressAdjustmentSheet_(false);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    result.push({
      id: String(values[i][0] || ""),
      tanggal: formatDateCell_(values[i][1]),
      produk: String(values[i][2] || ""),
      botol: String(values[i][3] || ""),
      qtyDitutup: number_(values[i][4]),
      alasan: String(values[i][5] || ""),
      closedBy: String(values[i][6] || ""),
      closedByName: String(values[i][7] || ""),
      createdAt: isoCell_(values[i][8]),
      qtyBotolPerKardus: number_(values[i][9]),
      targetBatchNo: String(values[i][10] || ""),
      targetTanggalAsal: formatDateCell_(values[i][11]),
    });
  }
  return result;
}

function pressBalanceForKey_(produk, botol) {
  const key = balanceKey_(produk, botol);
  const entries = getEntries_();
  const adjustments = getPressAdjustments_();
  const model = buildPressAllocationModel_(entries, adjustments);

  let filling = 0;
  let closed = 0;
  let remaining = 0;

  entries.forEach(function (entry) {
    if (
      entry.tab === "filling" &&
      balanceKey_(entry.produk, entry.botol) === key
    ) {
      filling += number_(entry.totalQty);
    }
  });

  adjustments.forEach(function (adjustment) {
    if (balanceKey_(adjustment.produk, adjustment.botol) === key) {
      closed += number_(adjustment.qtyDitutup);
    }
  });

  model.remainders.forEach(function (item) {
    if (balanceKey_(item.produk, item.botol) === key) {
      remaining += number_(item.sisaQty);
    }
  });

  // Nilai Press untuk pasangan ini diturunkan dari alokasi FIFO aktual,
  // bukan dari botol yang dipilih pada form Press (karena logika lama Press berbasis Nama Produk).
  const press = Math.max(0, filling - closed - remaining);
  return {
    filling: filling,
    press: press,
    closed: closed,
    remaining: remaining,
  };
}

function historicalPressBalancePair_(produkInput, botolInput, entriesInput) {
  const produkRaw = String(produkInput || "").trim();
  const botolRaw = String(botolInput || "").trim();
  if (!produkRaw || !botolRaw) {
    throw new Error("Produk dan Botol untuk penutupan sisa Press wajib diisi.");
  }

  const key = balanceKey_(produkRaw, botolRaw);
  const entries = Array.isArray(entriesInput) ? entriesInput : getEntries_();

  // Penutupan adalah tindakan atas saldo historis, jadi referensi yang sah
  // adalah data Filling yang memang pernah tersimpan — bukan Master saat ini.
  // Ini memungkinkan produk/botol lama tetap ditutup setelah dihapus dari Master,
  // tetapi mencegah request membuat penutupan untuk kombinasi fiktif.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (
      entry.tab === "filling" &&
      balanceKey_(entry.produk, entry.botol) === key
    ) {
      return {
        produk: String(entry.produk || "").trim(),
        botol: String(entry.botol || "").trim(),
      };
    }
  }

  throw new Error(
    "Data Filling historis untuk " +
      produkRaw +
      " / " +
      botolRaw +
      " tidak ditemukan.",
  );
}

function buildPressRemainderClosure_(user, data, entries, adjustments) {
  if (!data) throw new Error("Data penutupan sisa Press kosong.");

  // Penutupan tetap menerima produk/botol historis yang sudah tidak ada di Master.
  const historicalPair = historicalPressBalancePair_(
    data.produk,
    data.botol,
    entries,
  );
  const produk = historicalPair.produk;
  const botol = historicalPair.botol;
  const alasan = String(data.alasan || "").trim();
  if (alasan.length < 5)
    throw new Error("Alasan Tutup Sisa wajib diisi minimal 5 karakter.");
  if (alasan.length > 500)
    throw new Error("Alasan Tutup Sisa maksimal 500 karakter.");

  const perKardus = Number(data.qtyBotolPerKardus);
  if (!isFinite(perKardus) || perKardus <= 0)
    throw new Error("Qty Botol per Kardus untuk penutupan wajib diisi.");
  const targetBatchNo = String(data.targetBatchNo || "").trim();
  const targetTanggalAsal = String(data.targetTanggalAsal || "").trim();
  if (targetBatchNo && !targetTanggalAsal) {
    throw new Error("Tanggal Asal wajib diisi untuk target No Batch.");
  }

  const model = buildPressAllocationModel_(entries, adjustments);
  const remaining = model.remainders
    .filter(function (item) {
      return (
        balanceKey_(item.produk, item.botol) === balanceKey_(produk, botol) &&
        item.qtyBotolPerKardus === perKardus &&
        (!targetTanggalAsal ||
          (item.tanggalAsal === targetTanggalAsal &&
            (targetBatchNo ? item.batchNo === targetBatchNo : !item.batchNo)))
      );
    })
    .reduce(function (sum, item) {
      return sum + number_(item.sisaQty);
    }, 0);
  if (remaining <= 0) {
    const targetLabel = targetTanggalAsal
      ? " pada " +
        (targetBatchNo ? "No Batch " + targetBatchNo : "data tanpa No Batch") +
        " tanggal " +
        targetTanggalAsal
      : "";
    throw new Error(
      "Sisa Press untuk " +
        produk +
        " / " +
        botol +
        targetLabel +
        " sudah tidak tersedia.",
    );
  }

  const now = new Date();
  return {
    id: Utilities.getUuid(),
    tanggal: Utilities.formatDate(
      now,
      Session.getScriptTimeZone() || "Asia/Jakarta",
      "yyyy-MM-dd",
    ),
    produk: produk,
    botol: botol,
    qtyDitutup: remaining,
    qtyBotolPerKardus: perKardus,
    targetBatchNo: targetBatchNo,
    targetTanggalAsal: targetTanggalAsal,
    alasan: alasan,
    closedBy: user.username,
    closedByName: user.name,
    createdAt: now.toISOString(),
  };
}

function pressAdjustmentToRow_(adjustment) {
  return [
    adjustment.id,
    adjustment.tanggal,
    adjustment.produk,
    adjustment.botol,
    adjustment.qtyDitutup,
    adjustment.alasan,
    adjustment.closedBy,
    adjustment.closedByName,
    adjustment.createdAt,
    adjustment.qtyBotolPerKardus,
    adjustment.targetBatchNo || "",
    adjustment.targetTanggalAsal || "",
  ];
}

function appendPressAdjustments_(adjustments) {
  if (!adjustments.length) return;
  const sh = pressAdjustmentSheet_(true);
  const startRow = Math.max(sh.getLastRow() + 1, 2);
  sh.getRange(
    startRow,
    1,
    adjustments.length,
    APP.PRESS_ADJUSTMENT_HEADERS.length,
  ).setValues(adjustments.map(pressAdjustmentToRow_));
}

function closePressRemainder_(user, data) {
  const entries = getEntries_();
  const adjustment = buildPressRemainderClosure_(
    user,
    data,
    entries,
    getPressAdjustments_(),
  );
  appendPressAdjustments_([adjustment]);
  return adjustment;
}

function closePressRemaindersBatch_(user, data) {
  data = data && typeof data === "object" ? data : {};
  const targets = Array.isArray(data.rows) ? data.rows : [];
  if (!targets.length)
    throw new Error("Pilih minimal satu sisa Press untuk dihapus.");
  if (targets.length > 100)
    throw new Error("Maksimal 100 sisa Press per sekali penghapusan.");

  const entries = getEntries_();
  const adjustments = getPressAdjustments_();
  const staged = [];
  targets.forEach(function (target) {
    const targetBatchNo = String((target && target.targetBatchNo) || "").trim();
    const targetTanggalAsal = String(
      (target && target.targetTanggalAsal) || "",
    ).trim();
    if (!targetTanggalAsal) {
      throw new Error("Setiap sisa Press harus memiliki Tanggal Asal.");
    }
    const duplicate = staged.some(function (item) {
      return (
        item.targetBatchNo === targetBatchNo &&
        item.targetTanggalAsal === targetTanggalAsal &&
        balanceKey_(item.produk, item.botol) ===
          balanceKey_(target.produk, target.botol) &&
        number_(item.qtyBotolPerKardus) === number_(target.qtyBotolPerKardus)
      );
    });
    if (duplicate)
      throw new Error("Sisa Press yang sama dipilih lebih dari satu kali.");
    staged.push(
      buildPressRemainderClosure_(
        user,
        Object.assign({}, target, {
          alasan: data.alasan,
          targetBatchNo: targetBatchNo,
          targetTanggalAsal: targetTanggalAsal,
        }),
        entries,
        adjustments.concat(staged),
      ),
    );
  });

  appendPressAdjustments_(staged);
  return {
    adjustments: staged,
    remainders: rebuildPressRemainders_(),
  };
}

let SPK_READY_SHEET_ = null;

function isSpkDateLike_(value) {
  if (value instanceof Date) return !isNaN(value.getTime());
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(text);
}

/**
 * Memperbaiki baris SPK yang telanjur memakai susunan delapan kolom lama,
 * tetapi header-nya sudah berubah ke skema baru yang mempunyai kolom Qty.
 * Perbaikan dilakukan per baris supaya data baru yang sudah benar tidak ikut
 * bergeser ketika sheet berisi campuran data lama dan baru.
 */
function repairLegacySpkRows_(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const width = APP.SPK_HEADERS.length;
  const range = sh.getRange(2, 1, lastRow - 1, width);
  const rows = range.getValues();
  const repairedRows = [];

  rows.forEach(function (row, index) {
    const hasBatch = String(row[0] || "").trim();
    const qtyContainsCreator = String(row[4] || "").trim();
    const columnFContainsCreatedAt = isSpkDateLike_(row[5]);
    const currentUpdateColumnEmpty = String(row[8] || "").trim() === "";

    if (
      !hasBatch ||
      !qtyContainsCreator ||
      !columnFContainsCreatedAt ||
      !currentUpdateColumnEmpty
    )
      return;

    repairedRows.push({
      rowNumber: index + 2,
      values: [
        row[0],
        row[1],
        row[2],
        row[3],
        "",
        row[4],
        row[5],
        row[6],
        row[7],
      ],
    });
  });

  const groups = [];
  repairedRows.forEach(function (item) {
    const group = groups[groups.length - 1];
    if (group && item.rowNumber === group.startRow + group.values.length) {
      group.values.push(item.values);
    } else {
      groups.push({ startRow: item.rowNumber, values: [item.values] });
    }
  });
  groups.forEach(function (group) {
    sh.getRange(group.startRow, 1, group.values.length, width).setValues(
      group.values,
    );
  });
}

/** Hapus kolom sisa migrasi hanya jika header duplikat dan tidak berisi data. */
function removeEmptyDuplicateSpkColumns_(sh) {
  const firstExtraColumn = APP.SPK_HEADERS.length + 1;
  const lastUsedColumn = sh.getLastColumn();
  if (lastUsedColumn < firstExtraColumn) return;

  const extraWidth = lastUsedColumn - APP.SPK_HEADERS.length;
  const lastRow = Math.max(1, sh.getLastRow());
  const extraValues = sh
    .getRange(1, firstExtraColumn, lastRow, extraWidth)
    .getDisplayValues();
  const duplicateHeader = APP.SPK_HEADERS[APP.SPK_HEADERS.length - 1];
  const removable = extraValues.every(function (row, rowIndex) {
    return row.every(function (value) {
      const text = String(value || "").trim();
      return rowIndex === 0 ? !text || text === duplicateHeader : !text;
    });
  });

  if (removable) sh.deleteColumns(firstExtraColumn, extraWidth);
}

function ensureSpkSheet_(ss, forceSetup) {
  if (SPK_READY_SHEET_ && !forceSetup) return SPK_READY_SHEET_;
  let sh = ss.getSheetByName(APP.SHEETS.SPK);
  if (!sh) sh = ss.insertSheet(APP.SHEETS.SPK);

  const oldHeaders = [
    "No Batch",
    "Tanggal",
    "Nama Produk",
    "Botol",
    "Dibuat Oleh",
    "Dibuat Pada",
    "Di-update Pada",
    "Jumlah Update",
  ];
  const readWidth = Math.max(APP.SPK_HEADERS.length, sh.getLastColumn() || 1);
  if (sh.getMaxColumns() < readWidth) {
    sh.insertColumnsAfter(sh.getMaxColumns(), readWidth - sh.getMaxColumns());
  }
  const headers = sh
    .getRange(1, 1, 1, readWidth)
    .getDisplayValues()[0]
    .map(function (value) {
      return String(value || "").trim();
    });
  const isOldSchema = oldHeaders.every(function (header, index) {
    return headers[index] === header;
  });

  // Migrasi aman: sisipkan Qty setelah Botol agar data audit lama bergeser,
  // bukan tertimpa oleh header baru.
  if (isOldSchema) sh.insertColumnAfter(4);
  if (sh.getMaxColumns() < APP.SPK_HEADERS.length) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      APP.SPK_HEADERS.length - sh.getMaxColumns(),
    );
  }
  sh.getRange(1, 1, 1, APP.SPK_HEADERS.length).setValues([APP.SPK_HEADERS]);
  if (!isOldSchema) repairLegacySpkRows_(sh);
  removeEmptyDuplicateSpkColumns_(sh);
  styleHeader_(sh, APP.SPK_HEADERS.length);
  sh.setFrozenRows(1);
  SPK_READY_SHEET_ = sh;
  return sh;
}

function getSpkEntries_() {
  const sh = ensureSpkSheet_(spreadsheet_());
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh
    .getRange(2, 1, lastRow - 1, APP.SPK_HEADERS.length)
    .getValues()
    .filter(function (row) {
      return String(row[0] || "").trim();
    })
    .map(function (row) {
      return {
        batchNo: String(row[0] || "").trim(),
        tanggal: formatDateCell_(row[1]),
        produk: String(row[2] || "").trim(),
        botol: String(row[3] || "").trim(),
        qty: Math.max(0, number_(row[4])),
        createdBy: String(row[5] || "").trim(),
        createdAt: isoCell_(row[6]),
        updatedAt: isoCell_(row[7]),
        updateCount: Math.max(0, Math.floor(number_(row[8]))),
      };
    });
}

function createSpk_(user, data) {
  data = data && typeof data === "object" ? data : {};
  const master = getMaster_();
  const produk = canonicalMasterValue_(master.produk, data.produk, "Produk");
  const botol = canonicalMasterValue_(master.botol, data.botol, "Botol");
  const qty = Math.max(0, number_(data.qty));
  if (qty <= 0) throw new Error("Qty SPK harus lebih dari 0 pcs.");
  const now = new Date();
  const tz = Session.getScriptTimeZone() || "Asia/Jakarta";
  const tanggal = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  const dateStamp = Utilities.formatDate(now, tz, "ddMMyyyy");
  const entries = getSpkEntries_();
  const todayEntries = entries.filter(function (item) {
    return item.tanggal === tanggal;
  });
  if (todayEntries.length >= 99)
    throw new Error("Nomor urut SPK hari ini sudah mencapai 99.");
  const nextNumber =
    todayEntries.reduce(function (max, item) {
      const match = /^(\d{2})-\d{8}$/.exec(item.batchNo);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0) + 1;
  const batchNo = String(nextNumber).padStart(2, "0") + "-" + dateStamp;
  const previewUpdateCount = Math.max(0, Math.floor(number_(data.updateCount)));
  const previewUpdatedAt =
    normalizeIsoTimestamp_(data.updatedAt) ||
    (previewUpdateCount > 0 ? now.toISOString() : "");
  const row = [
    batchNo,
    tanggal,
    produk,
    botol,
    qty,
    user.username,
    now.toISOString(),
    previewUpdatedAt,
    previewUpdateCount,
  ];
  ensureSpkSheet_(spreadsheet_()).appendRow(row);
  return {
    batchNo: batchNo,
    tanggal: tanggal,
    produk: produk,
    botol: botol,
    qty: qty,
    createdBy: user.username,
    createdAt: now.toISOString(),
    updatedAt: previewUpdatedAt,
    updateCount: previewUpdateCount,
  };
}

/** Simpan seluruh preview SPK dengan satu kali baca dan satu kali tulis. */
function createSpkEntriesBatch_(user, dataList) {
  if (!Array.isArray(dataList) || !dataList.length)
    throw new Error("Preview SPK kosong.");
  if (dataList.length > 99)
    throw new Error("Maksimal 99 SPK per sekali simpan.");

  // Produk hasil import SPK boleh langsung menjadi Master Produk. Hanya baris
  // yang ditandai imported oleh alur import yang memperoleh perilaku ini;
  // input manual tetap wajib memilih produk yang sudah terdaftar.
  const importedProducts = unique_(
    dataList
      .filter(function (data) {
        return data && data.imported === true;
      })
      .map(function (data) {
        return String(data.produk || "").trim();
      })
      .filter(String),
  );
  let currentMaster = getMaster_();
  importedProducts.forEach(function (produk) {
    const exists = currentMaster.produk.some(function (value) {
      return String(value).toLowerCase() === produk.toLowerCase();
    });
    if (!exists) {
      addMaster_("produk", produk);
      currentMaster.produk.push(produk);
    }
  });
  const importedBottles = unique_(
    dataList
      .filter(function (data) {
        return data && data.imported === true;
      })
      .map(function (data) {
        return String(data.botol || "").trim();
      })
      .filter(String),
  );
  importedBottles.forEach(function (botol) {
    const exists = currentMaster.botol.some(function (value) {
      return String(value).toLowerCase() === botol.toLowerCase();
    });
    if (!exists) {
      addMaster_("botol", botol);
      currentMaster.botol.push(botol);
    }
  });
  const master = getMaster_();
  const sh = ensureSpkSheet_(spreadsheet_());
  const entries = getSpkEntries_();
  const now = new Date();
  const nowIso = now.toISOString();
  const tz = Session.getScriptTimeZone() || "Asia/Jakarta";
  const tanggal = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  const dateStamp = Utilities.formatDate(now, tz, "ddMMyyyy");
  const todayEntries = entries.filter(function (item) {
    return item.tanggal === tanggal;
  });
  if (todayEntries.length + dataList.length > 99) {
    throw new Error("Jumlah SPK hari ini akan melebihi batas 99.");
  }

  let nextNumber =
    todayEntries.reduce(function (max, item) {
      const match = /^(\d{2})-\d{8}$/.exec(item.batchNo);
      return Math.max(max, match ? Number(match[1]) : 0);
    }, 0) + 1;
  const usedBatchNos = {};
  entries.forEach(function (item) {
    usedBatchNos[String(item.batchNo)] = true;
  });
  const saved = [];
  const rows = dataList.map(function (data) {
    data = data && typeof data === "object" ? data : {};
    const produk = canonicalMasterValue_(master.produk, data.produk, "Produk");
    const botol = canonicalMasterValue_(master.botol, data.botol, "Botol");
    const qty = Math.max(0, number_(data.qty));
    if (qty <= 0) throw new Error("Qty SPK harus lebih dari 0 pcs.");
    const suppliedBatchNo = String(data.batchNo || "").trim();
    const batchNo =
      suppliedBatchNo ||
      String(nextNumber++).padStart(2, "0") + "-" + dateStamp;
    if (usedBatchNos[batchNo])
      throw new Error('No Batch SPK "' + batchNo + '" sudah tersedia.');
    usedBatchNos[batchNo] = true;
    const updateCount = Math.max(0, Math.floor(number_(data.updateCount)));
    const updatedAt =
      normalizeIsoTimestamp_(data.updatedAt) || (updateCount > 0 ? nowIso : "");
    const item = {
      batchNo: batchNo,
      tanggal: tanggal,
      produk: produk,
      botol: botol,
      qty: qty,
      createdBy: user.username,
      createdAt: nowIso,
      updatedAt: updatedAt,
      updateCount: updateCount,
    };
    saved.push(item);
    return [
      item.batchNo,
      item.tanggal,
      item.produk,
      item.botol,
      item.qty,
      item.createdBy,
      item.createdAt,
      item.updatedAt,
      item.updateCount,
    ];
  });
  sh.getRange(
    Math.max(2, sh.getLastRow() + 1),
    1,
    rows.length,
    APP.SPK_HEADERS.length,
  ).setValues(rows);
  return saved;
}

function findSpkRow_(batchNo) {
  const target = String(batchNo || "").trim();
  if (!target) return null;
  const sh = ensureSpkSheet_(spreadsheet_());
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const values = sh
    .getRange(2, 1, lastRow - 1, APP.SPK_HEADERS.length)
    .getValues();
  for (let i = 0; i < values.length; i += 1) {
    if (String(values[i][0] || "").trim() === target)
      return { sheet: sh, row: i + 2, values: values[i] };
  }
  return null;
}

function assertSpkUnused_(batchNo) {
  const suffix = " - " + String(batchNo || "").trim();
  const used = getEntries_().some(function (entry) {
    return String(entry.reportId || "").endsWith(suffix);
  });
  if (used)
    throw new Error(
      "SPK " +
        batchNo +
        " sudah digunakan pada data Filling/Press sehingga tidak dapat diubah atau dihapus.",
    );
}

function updateSpk_(user, batchNo, data) {
  const found = findSpkRow_(batchNo);
  if (!found) throw new Error("SPK yang akan di-update tidak ditemukan.");
  const createdBy = String(found.values[5] || "").trim();
  requireManage_(user, "spk", createdBy === user.username ? "own" : "others");
  assertSpkUnused_(batchNo);
  data = data && typeof data === "object" ? data : {};
  const master = getMaster_();
  const produk = canonicalMasterValue_(master.produk, data.produk, "Produk");
  const botol = canonicalMasterValue_(master.botol, data.botol, "Botol");
  const qty = Math.max(0, number_(data.qty));
  if (qty <= 0) throw new Error("Qty SPK harus lebih dari 0 pcs.");
  const updatedAt = new Date().toISOString();
  const updateCount = Math.max(0, Math.floor(number_(found.values[8]))) + 1;
  found.sheet
    .getRange(found.row, 3, 1, 7)
    .setValues([
      [
        produk,
        botol,
        qty,
        found.values[5],
        found.values[6],
        updatedAt,
        updateCount,
      ],
    ]);
  return {
    batchNo: String(found.values[0] || "").trim(),
    tanggal: formatDateCell_(found.values[1]),
    produk: produk,
    botol: botol,
    qty: qty,
    createdBy: createdBy,
    createdAt: isoCell_(found.values[6]),
    updatedAt: updatedAt,
    updateCount: updateCount,
  };
}

function deleteSpk_(user, batchNo) {
  const found = findSpkRow_(batchNo);
  if (!found) throw new Error("SPK yang akan dihapus tidak ditemukan.");
  const createdBy = String(found.values[5] || "").trim();
  requireManage_(user, "spk", createdBy === user.username ? "own" : "others");
  assertSpkUnused_(batchNo);
  found.sheet.deleteRow(found.row);
}

function deleteSpkBatch_(user, batchNos) {
  if (!Array.isArray(batchNos) || !batchNos.length) {
    throw new Error("Tidak ada SPK yang dipilih.");
  }
  if (batchNos.length > 100)
    throw new Error("Maksimal 100 SPK per penghapusan.");
  const uniqueBatchNos = unique_(
    batchNos
      .map(function (value) {
        return String(value || "").trim();
      })
      .filter(String),
  );
  const foundRows = uniqueBatchNos.map(function (batchNo) {
    const found = findSpkRow_(batchNo);
    if (!found) throw new Error("SPK " + batchNo + " tidak ditemukan.");
    const createdBy = String(found.values[5] || "").trim();
    requireManage_(user, "spk", createdBy === user.username ? "own" : "others");
    assertSpkUnused_(batchNo);
    return { batchNo: batchNo, sheet: found.sheet, row: found.row };
  });
  foundRows
    .sort(function (a, b) {
      return b.row - a.row;
    })
    .forEach(function (item) {
      item.sheet.deleteRow(item.row);
    });
  return uniqueBatchNos;
}

function validateSpkBatchForEntry_(data, spkEntries) {
  const batchNo = String((data && data.batchNo) || "").trim();
  if (!batchNo)
    throw new Error(
      "No Batch SPK wajib tersedia untuk pengerjaan ini. Input SPK terlebih dahulu.",
    );
  const entries = Array.isArray(spkEntries) ? spkEntries : getSpkEntries_();
  const spk = entries.find(function (item) {
    return item.batchNo === batchNo;
  });
  if (!spk) throw new Error('No Batch SPK "' + batchNo + '" tidak ditemukan.');
  if (
    String(spk.produk).toLowerCase() !==
      String(data.produk || "")
        .trim()
        .toLowerCase() ||
    String(spk.botol).toLowerCase() !==
      String(data.botol || "")
        .trim()
        .toLowerCase()
  ) {
    throw new Error(
      "Produk atau Botol tidak sesuai dengan No Batch SPK " + batchNo + ".",
    );
  }
  return spk.batchNo;
}

function makeReportId_(line, date, batchNo) {
  if (String(batchNo || "").trim()) {
    return (line === "press" ? "PRESS - " : "FILL - ") + String(batchNo).trim();
  }
  const tz = Session.getScriptTimeZone() || "Asia/Jakarta";
  const stamp = Utilities.formatDate(date, tz, "yyyyMMdd-HHmmss");
  const prefix = line === "press" ? "PRS" : "FIL";
  return (
    prefix + "-" + stamp + "-" + Utilities.getUuid().slice(0, 4).toUpperCase()
  );
}

/* ------------------------- SETTINGS / KPI ------------------------- */
const SETTINGS_CACHE_KEY_ = "ppr_settings_cache_v2";
const KPI_FILLING_OUTPUT_TARGET_KEY_ = "kpiFillingOutputTargetMonthly";
const KPI_FILLING_OUTPUT_TARGET_DEFAULT_ = 150000;
const KPI_PRESS_OUTPUT_TARGET_KEY_ = "kpiPressOutputTargetMonthly";
const KPI_PRESS_OUTPUT_TARGET_DEFAULT_ = 70000;

function ensureSettingsSheet_(ss) {
  const sh = ensureSheet_(ss, APP.SHEETS.SETTINGS, APP.SETTINGS_HEADERS);
  const lastRow = sh.getLastRow();
  const existingKeys = {};

  if (lastRow >= 2) {
    const keys = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    keys.forEach(function (row) {
      const key = String(row[0] || "").trim();
      if (key) existingKeys[key] = true;
    });
  }

  let changed = false;
  if (!existingKeys[KPI_FILLING_OUTPUT_TARGET_KEY_]) {
    sh.appendRow([
      KPI_FILLING_OUTPUT_TARGET_KEY_,
      KPI_FILLING_OUTPUT_TARGET_DEFAULT_,
      new Date(),
      "setup",
    ]);
    changed = true;
  }

  if (!existingKeys[KPI_PRESS_OUTPUT_TARGET_KEY_]) {
    sh.appendRow([
      KPI_PRESS_OUTPUT_TARGET_KEY_,
      KPI_PRESS_OUTPUT_TARGET_DEFAULT_,
      new Date(),
      "setup",
    ]);
    changed = true;
  }

  if (changed) invalidateSettingsCache_();
  return sh;
}

function normalizeKpiFillingOutputTarget_(value) {
  const target = Math.round(Number(value));
  if (!isFinite(target) || target <= 0) {
    throw new Error("Target Output KPI Filling / Bulan harus lebih dari 0.");
  }
  return target;
}

function normalizeKpiPressOutputTarget_(value) {
  const target = Math.round(Number(value));
  if (!isFinite(target) || target <= 0) {
    throw new Error("Target Output KPI Press / Bulan harus lebih dari 0.");
  }
  return target;
}

function getSettings_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SETTINGS_CACHE_KEY_);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (
        parsed &&
        parsed.kpiFillingOutputTargetMonthly &&
        parsed.kpiPressOutputTargetMonthly
      ) {
        return parsed;
      }
    } catch (_) {}
  }

  const ss = spreadsheet_();
  let sh = ss.getSheetByName(APP.SHEETS.SETTINGS);
  let lastRow = sh ? sh.getLastRow() : 0;
  let rows =
    sh && lastRow >= 2 && sh.getMaxColumns() >= APP.SETTINGS_HEADERS.length
      ? sh.getRange(2, 1, lastRow - 1, APP.SETTINGS_HEADERS.length).getValues()
      : [];
  const keys = rows.map(function (row) {
    return String(row[0] || "").trim();
  });
  if (
    keys.indexOf(KPI_FILLING_OUTPUT_TARGET_KEY_) < 0 ||
    keys.indexOf(KPI_PRESS_OUTPUT_TARGET_KEY_) < 0
  ) {
    // Jalankan migrasi hanya jika salah satu target belum tersedia.
    sh = ensureSettingsSheet_(ss);
    lastRow = sh.getLastRow();
    rows =
      lastRow >= 2
        ? sh
            .getRange(2, 1, lastRow - 1, APP.SETTINGS_HEADERS.length)
            .getValues()
        : [];
  }

  let fillingOutputTarget = KPI_FILLING_OUTPUT_TARGET_DEFAULT_;
  let pressOutputTarget = KPI_PRESS_OUTPUT_TARGET_DEFAULT_;
  if (lastRow >= 2) {
    rows.forEach(function (row) {
      const key = String(row[0] || "").trim();
      const candidate = Number(row[1]);
      if (!isFinite(candidate) || candidate <= 0) return;

      if (key === KPI_FILLING_OUTPUT_TARGET_KEY_) {
        fillingOutputTarget = Math.round(candidate);
      } else if (key === KPI_PRESS_OUTPUT_TARGET_KEY_) {
        pressOutputTarget = Math.round(candidate);
      }
    });
  }

  const result = {
    kpiFillingOutputTargetMonthly: fillingOutputTarget,
    kpiPressOutputTargetMonthly: pressOutputTarget,
  };
  cache.put(
    SETTINGS_CACHE_KEY_,
    JSON.stringify(result),
    APP.SETTINGS_CACHE_SECONDS,
  );
  return result;
}

function invalidateSettingsCache_() {
  CacheService.getScriptCache().remove(SETTINGS_CACHE_KEY_);
  // Bersihkan juga cache versi lama agar migrasi setting langsung terbaca.
  CacheService.getScriptCache().remove("ppr_settings_cache_v1");
}

function setKpiSettingValue_(user, key, target) {
  const ss = spreadsheet_();
  const sh = ensureSettingsSheet_(ss);
  const now = new Date();
  const updatedBy = user && user.username ? user.username : "";
  const lastRow = sh.getLastRow();
  let rowNumber = 0;

  if (lastRow >= 2) {
    const keys = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || "").trim() === key) {
        rowNumber = i + 2;
        break;
      }
    }
  }

  const row = [key, target, now, updatedBy];
  if (rowNumber)
    sh.getRange(rowNumber, 1, 1, APP.SETTINGS_HEADERS.length).setValues([row]);
  else sh.appendRow(row);

  invalidateSettingsCache_();
  return getSettings_();
}

function setKpiFillingOutputTarget_(user, value) {
  const target = normalizeKpiFillingOutputTarget_(value);
  return setKpiSettingValue_(user, KPI_FILLING_OUTPUT_TARGET_KEY_, target);
}

function setKpiPressOutputTarget_(user, value) {
  const target = normalizeKpiPressOutputTarget_(value);
  return setKpiSettingValue_(user, KPI_PRESS_OUTPUT_TARGET_KEY_, target);
}

function setKpiOutputTargets_(user, fillingValue, pressValue) {
  // Validasi dua target terlebih dahulu supaya penyimpanan dilakukan sebagai
  // satu aksi dan tidak ada kondisi salah satu target sudah berubah sementara
  // target lainnya gagal divalidasi.
  const fillingTarget = normalizeKpiFillingOutputTarget_(fillingValue);
  const pressTarget = normalizeKpiPressOutputTarget_(pressValue);

  const ss = spreadsheet_();
  const sh = ensureSettingsSheet_(ss);
  const now = new Date();
  const updatedBy = user && user.username ? user.username : "";
  const lastRow = sh.getLastRow();
  const rowByKey = {};

  if (lastRow >= 2) {
    const keys = sh.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    keys.forEach(function (row, index) {
      const key = String(row[0] || "").trim();
      if (key) rowByKey[key] = index + 2;
    });
  }

  function writeTarget(key, target) {
    const row = [key, target, now, updatedBy];
    const rowNumber = rowByKey[key] || 0;
    if (rowNumber) {
      sh.getRange(rowNumber, 1, 1, APP.SETTINGS_HEADERS.length).setValues([
        row,
      ]);
    } else {
      sh.appendRow(row);
      rowByKey[key] = sh.getLastRow();
    }
  }

  writeTarget(KPI_FILLING_OUTPUT_TARGET_KEY_, fillingTarget);
  writeTarget(KPI_PRESS_OUTPUT_TARGET_KEY_, pressTarget);

  invalidateSettingsCache_();
  return getSettings_();
}

const MASTER_CACHE_KEY_ = "ppr_master_cache_v1";

function getMaster_() {
  ensureApdCriteriaMaster_(spreadsheet_());
  const cache = CacheService.getScriptCache();
  const cached = cache.get(MASTER_CACHE_KEY_);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (_) {}
  }

  const sh = sheet_(APP.SHEETS.MASTER);
  const lastRow = Math.max(sh.getLastRow(), 1);
  const values =
    lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 3).getDisplayValues() : [];
  const operator = unique_(values.map((r) => r[0]));
  const produk = unique_(values.map((r) => r[1]));
  const botol = unique_(values.map((r) => r[2]));
  const result = {
    operator: operator,
    produk: produk,
    botol: botol,
    botolpecah: botol.slice(),
  };
  cache.put(
    MASTER_CACHE_KEY_,
    JSON.stringify(result),
    APP.MASTER_CACHE_SECONDS,
  );
  return result;
}

function invalidateMasterCache_() {
  CacheService.getScriptCache().remove(MASTER_CACHE_KEY_);
}

function addMaster_(category, value) {
  value = String(value || "").trim();
  if (!value) throw new Error("Nilai master tidak boleh kosong.");
  const col = masterColumn_(category);
  const current = getMasterColumn_(col);
  if (current.map((v) => v.toLowerCase()).indexOf(value.toLowerCase()) >= 0)
    throw new Error("Data master sudah ada.");
  current.push(value);
  writeMasterColumn_(col, current);
  invalidateMasterCache_();
}

function removeMaster_(category, value) {
  const col = masterColumn_(category);
  const target = String(value || "")
    .trim()
    .toLowerCase();
  const current = getMasterColumn_(col).filter(
    (v) => v.toLowerCase() !== target,
  );
  writeMasterColumn_(col, current);
  invalidateMasterCache_();
}

function masterColumn_(category) {
  const map = { operator: 1, produk: 2, botol: 3 };
  if (!map[category]) throw new Error("Kategori master tidak valid.");
  return map[category];
}

function getMasterColumn_(col) {
  const sh = sheet_(APP.SHEETS.MASTER);
  if (sh.getLastRow() < 2) return [];
  return unique_(
    sh
      .getRange(2, col, sh.getLastRow() - 1, 1)
      .getDisplayValues()
      .map((r) => r[0]),
  );
}

function writeMasterColumn_(col, values) {
  const sh = sheet_(APP.SHEETS.MASTER);
  const rowsToClear = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, col, rowsToClear, 1).clearContent();
  if (values.length)
    sh.getRange(2, col, values.length, 1).setValues(values.map((v) => [v]));
}

function addUser_(name, username, password, role) {
  name = String(name || "").trim();
  username = String(username || "").trim();
  password = String(password || "");
  role = role === "superuser" ? "superuser" : "user";

  if (!name || !username || !password)
    throw new Error("Nama, username, dan password wajib diisi.");
  if (findUser_(username)) throw new Error("Username sudah digunakan.");

  const permissions = defaultPermissions_(role);
  if (role === "user")
    permissions.levels = {
      dashboard: "none",
      spk: "write",
      filling: "write",
      press: "write",
      apd: "write",
      reports: "none",
      workReport: "none",
      spkReport: "none",
      kpiFilling: "none",
      kpiPress: "none",
      master: "none",
      kpiSettings: "none",
    };
  sheet_(APP.SHEETS.USERS).appendRow([
    username,
    hashPassword_(password),
    name,
    role,
    true,
    new Date(),
    JSON.stringify(permissions),
  ]);
  invalidateUsersCache_();
}

function setUserPermissions_(username, permissions) {
  const target = String(username || "").trim();
  if (!target) throw new Error("Username tidak valid.");

  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== target) continue;
    const role =
      String(values[i][3] || "user") === "superuser" ? "superuser" : "user";
    if (role === "superuser")
      throw new Error(
        "Super User selalu memiliki akses penuh dan tidak memerlukan pengaturan custom.",
      );
    const normalized = normalizePermissions_("user", permissions || {});
    sh.getRange(i + 1, 7).setValue(JSON.stringify(normalized));
    invalidateUsersCache_();
    return;
  }
  throw new Error("User tidak ditemukan.");
}

function resetUserPassword_(username, password) {
  const target = String(username || "").trim();
  const nextPassword = String(password || "");
  if (!target) throw new Error("Username tidak valid.");
  if (nextPassword.length < 8)
    throw new Error("Password baru minimal 8 karakter.");

  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== target) continue;
    sh.getRange(i + 1, 2).setValue(hashPassword_(nextPassword));
    invalidateUsersCache_();
    removeSessionsForUser_(target);
    return;
  }
  throw new Error("User tidak ditemukan.");
}

function removeUser_(username, currentUsername) {
  if (username === currentUsername)
    throw new Error(
      "User yang sedang login tidak dapat menghapus dirinya sendiri.",
    );

  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === String(username)) {
      sh.deleteRow(i + 1);
      invalidateUsersCache_();
      removeSessionsForUser_(username);
      return;
    }
  }
  throw new Error("User tidak ditemukan.");
}

function removeSessionsForUser_(username) {
  const target = String(username || "");
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf("PPR_SESSION_") !== 0) return;
    try {
      const data = JSON.parse(all[key]);
      if (data.user && String(data.user.username) === target) {
        const token = key.substring("PPR_SESSION_".length);
        removeCachedSession_(token);
        props.deleteProperty(key);
      }
    } catch (_) {}
  });

  // Bersihkan juga sesi versi lama jika masih ada.
  const sh = sheet_(APP.SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][1]) === target) sh.deleteRow(i + 1);
  }
}

const USERS_CACHE_KEY_ = "ppr_users_cache_v1";

function readUsersRaw_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(USERS_CACHE_KEY_);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (_) {}
  }

  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    users.push({
      username: String(values[i][0]),
      passwordHash: String(values[i][1]),
      name: String(values[i][2] || values[i][0]),
      role: String(values[i][3] || "user"),
      active: bool_(values[i][4]),
      permissions: normalizePermissions_(
        String(values[i][3] || "user"),
        values[i][6],
      ),
    });
  }

  cache.put(USERS_CACHE_KEY_, JSON.stringify(users), APP.USER_CACHE_SECONDS);
  return users;
}

function invalidateUsersCache_() {
  CacheService.getScriptCache().remove(USERS_CACHE_KEY_);
}

function getUsers_() {
  return readUsersRaw_().map(publicUser_);
}

function findUser_(username) {
  const target = String(username || "")
    .trim()
    .toLowerCase();
  const users = readUsersRaw_();
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].username).trim().toLowerCase() === target)
      return users[i];
  }
  return null;
}

function defaultPermissions_(role) {
  if (role === "superuser") {
    return {
      accessDashboard: true,
      accessFilling: true,
      accessSpk: true,
      accessPress: true,
      accessExportFillingCsv: true,
      accessExportPressCsv: true,
      accessApd: true,
      accessReports: true,
      accessWorkReport: true,
      accessSpkReport: true,
      accessKpiReport: true,
      accessKpiFillingReport: true,
      accessKpiPressReport: true,
      deleteUnpressed: true,
      viewAllData: true,
      editOwn: true,
      editOthers: true,
      deleteOwn: true,
      deleteOthers: true,
      accessMaster: true,
      accessKpiSettings: true,
    };
  }
  return {
    accessDashboard: false,
    accessFilling: true,
    accessSpk: true,
    accessPress: true,
    accessExportFillingCsv: false,
    accessExportPressCsv: false,
    accessApd: true,
    accessReports: false,
    accessWorkReport: false,
    accessSpkReport: false,
    accessKpiReport: false,
    accessKpiFillingReport: false,
    accessKpiPressReport: false,
    deleteUnpressed: false,
    viewAllData: false,
    editOwn: true,
    editOthers: false,
    deleteOwn: false,
    deleteOthers: false,
    accessMaster: false,
    accessKpiSettings: false,
  };
}

function normalizePermissions_(role, raw) {
  if (role === "superuser") return defaultPermissions_("superuser");
  const defaults = defaultPermissions_("user");
  let parsed = {};
  if (raw && typeof raw === "object") parsed = raw;
  else if (String(raw || "").trim()) {
    try {
      parsed = JSON.parse(String(raw));
    } catch (_) {
      parsed = {};
    }
  }
  // User lama dengan izin gabungan tetap mendapat akses yang sama.
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessWorkReport"))
    parsed.accessWorkReport = parsed.accessReports === true;
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessSpk"))
    parsed.accessSpk = parsed.accessFilling === true;
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessSpkReport"))
    parsed.accessSpkReport = parsed.accessReports === true;
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessKpiReport"))
    parsed.accessKpiReport = parsed.accessReports === true;
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessKpiFillingReport"))
    parsed.accessKpiFillingReport = parsed.accessReports === true;
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessKpiPressReport"))
    parsed.accessKpiPressReport = parsed.accessReports === true;
  if (!Object.prototype.hasOwnProperty.call(parsed, "accessKpiSettings"))
    parsed.accessKpiSettings = parsed.accessMaster === true;
  Object.keys(defaults).forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(parsed, key))
      defaults[key] = parsed[key] === true;
  });
  if (parsed.levels && typeof parsed.levels === "object") {
    defaults.accessReports = false;
    defaults.accessKpiReport = false;
  }
  const scopes = {
    dashboard: "accessDashboard",
    spk: "accessSpk",
    filling: "accessFilling",
    press: "accessPress",
    apd: "accessApd",
    reports: "accessReports",
    workReport: "accessWorkReport",
    spkReport: "accessSpkReport",
    kpiFilling: "accessKpiFillingReport",
    kpiPress: "accessKpiPressReport",
    master: "accessMaster",
    kpiSettings: "accessKpiSettings",
  };
  const levels = {};
  const hasLevels = parsed.levels && typeof parsed.levels === "object";
  Object.keys(scopes).forEach(function (scope) {
    const explicit =
      hasLevels &&
      scope === "reports" &&
      !Object.prototype.hasOwnProperty.call(parsed.levels, "reports")
        ? ["workReport", "spkReport", "kpiFilling", "kpiPress"].some(
            function (child) {
              return (
                ["read", "write", "admin"].indexOf(parsed.levels[child]) >= 0
              );
            },
          )
          ? "read"
          : "none"
        : hasLevels && parsed.levels[scope];
    if (hasLevels) {
      levels[scope] =
        ["none", "read", "write", "admin"].indexOf(explicit) >= 0
          ? explicit
          : "none";
      defaults[scopes[scope]] = levels[scope] !== "none";
    } else {
      const allowed =
        scope === "reports"
          ? defaults.accessReports ||
            defaults.accessWorkReport ||
            defaults.accessSpkReport ||
            defaults.accessKpiReport ||
            defaults.accessKpiFillingReport ||
            defaults.accessKpiPressReport
          : defaults[scopes[scope]] ||
            (scope.indexOf("kpi") === 0 && defaults.accessKpiReport);
      levels[scope] = !allowed
        ? "none"
        : scope === "reports" && defaults.accessReports
          ? "admin"
          : (scope === "spk" || scope === "filling" || scope === "press") &&
              defaults.viewAllData &&
              defaults.editOthers &&
              defaults.deleteOthers
            ? "admin"
            : scope === "apd"
              ? "admin"
              : scope === "spk" ||
                  scope === "filling" ||
                  scope === "press" ||
                  scope === "master" ||
                  scope === "kpiSettings"
                ? "write"
                : defaults.viewAllData
                  ? "admin"
                  : "read";
    }
  });
  if (hasLevels) {
    const parent = levels.reports;
    ["workReport", "spkReport", "kpiFilling", "kpiPress"].forEach(
      function (scope) {
        defaults[scopes[scope]] =
          parent === "admin" || (parent !== "none" && levels[scope] !== "none");
      },
    );
  }
  defaults.management = {};
  ["spk", "filling", "press", "apd"].forEach(function (scope) {
    const admin = levels[scope] === "admin";
    const write = levels[scope] === "write";
    const selected = parsed.management && parsed.management[scope];
    defaults.management[scope] = {
      own:
        admin ||
        (write &&
          (selected && typeof selected.own === "boolean"
            ? selected.own
            : hasLevels
              ? true
              : defaults.editOwn || defaults.deleteOwn)),
      others:
        admin ||
        (write &&
          (selected && typeof selected.others === "boolean"
            ? selected.others
            : hasLevels
              ? false
              : defaults.editOthers || defaults.deleteOthers)),
    };
  });
  defaults.levels = levels;
  return defaults;
}

function canLevel_(user, scope, minimum) {
  if (!user) return false;
  if (user.role === "superuser") return true;
  const levels = normalizePermissions_(
    user.role,
    user.permissions || user.permissionsJson || "",
  ).levels;
  const rank = { none: 0, read: 1, write: 2, admin: 3 };
  if (
    ["workReport", "spkReport", "kpiFilling", "kpiPress"].indexOf(scope) >= 0
  ) {
    if (levels.reports === "admin") return true;
    if (levels.reports === "none") return false;
  }
  return (rank[levels[scope]] || 0) >= (rank[minimum] || 1);
}

function requireLevel_(user, scope, minimum) {
  if (!canLevel_(user, scope, minimum))
    throw new Error(
      "Anda tidak memiliki akses " + minimum + " pada bagian " + scope + ".",
    );
}

function canManage_(user, scope, owner) {
  if (!canLevel_(user, scope, "write")) return false;
  const permissions = normalizePermissions_(
    user.role,
    user.permissions || user.permissionsJson || "",
  );
  return (
    user.role === "superuser" ||
    Boolean(
      permissions.management[scope] &&
      permissions.management[scope][owner] === true,
    )
  );
}

function requireManage_(user, scope, owner) {
  if (!canManage_(user, scope, owner))
    throw new Error(
      "Anda tidak memiliki akses mengelola data " +
        (owner === "own" ? "sendiri" : "user lain") +
        " pada bagian " +
        scope +
        ".",
    );
}

function can_(user, permission) {
  if (!user) return false;
  if (user.role === "superuser") return true;
  const permissions = normalizePermissions_(
    user.role,
    user.permissions || user.permissionsJson || "",
  );
  return permissions[permission] === true;
}

function requirePermission_(user, permission, message) {
  if (!can_(user, permission))
    throw new Error(message || "Anda tidak memiliki hak akses untuk aksi ini.");
}

function requirePressRemainderDelete_(user) {
  if (canLevel_(user, "press", "admin")) return;
  requireLevel_(user, "press", "read");
  requirePermission_(
    user,
    "deleteUnpressed",
    'Anda tidak memiliki izin "Hapus Sisa Press".',
  );
}

function requireLineAccess_(user, line) {
  if (line === "filling")
    return requirePermission_(
      user,
      "accessFilling",
      "Anda tidak memiliki akses Filling.",
    );
  if (line === "press")
    return requirePermission_(
      user,
      "accessPress",
      "Anda tidak memiliki akses Press.",
    );
  throw new Error("Line pengerjaan tidak valid.");
}

function publicUser_(user) {
  return {
    username: user.username,
    name: user.name,
    role: user.role,
    active: user.active !== false,
    permissions: normalizePermissions_(
      user.role,
      user.permissions || user.permissionsJson || "",
    ),
  };
}

function requireSuperuser_(user) {
  if (!user || user.role !== "superuser")
    throw new Error("Aksi ini hanya dapat dilakukan Super User.");
}

function hashPassword_(password) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(password),
    Utilities.Charset.UTF_8,
  );
  return Utilities.base64EncodeWebSafe(digest);
}

let SPREADSHEET_CACHE_ = null;

function spreadsheet_() {
  if (SPREADSHEET_CACHE_) return SPREADSHEET_CACHE_;

  const id =
    PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (id) {
    SPREADSHEET_CACHE_ = SpreadsheetApp.openById(id);
    return SPREADSHEET_CACHE_;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active)
    throw new Error(
      "Spreadsheet belum dikonfigurasi. Jalankan setupSpreadsheet() sekali.",
    );
  SPREADSHEET_CACHE_ = active;
  return SPREADSHEET_CACHE_;
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh)
    throw new Error(
      'Sheet "' + name + '" belum ada. Jalankan setupSpreadsheet() sekali.',
    );
  return sh;
}

// Cache hanya selama satu request; data penilaian tetap dibaca dari Sheet.
let APD_READY_SHEET_ = null;

function ensureApdSheet_(ss, forceSetup) {
  if (APD_READY_SHEET_ && !forceSetup) return APD_READY_SHEET_;
  let sh = ss.getSheetByName(APP.SHEETS.APD);
  if (!sh) sh = ss.insertSheet(APP.SHEETS.APD);
  if (sh.getMaxColumns() < APP.APD_HEADERS.length) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      APP.APD_HEADERS.length - sh.getMaxColumns(),
    );
  }
  const currentHeaders = sh
    .getRange(1, 1, 1, APP.APD_HEADERS.length)
    .getDisplayValues()[0]
    .map(function (value) {
      return String(value || "").trim();
    });
  if (
    !forceSetup &&
    APP.APD_HEADERS.every(function (header, index) {
      return currentHeaders[index] === header;
    })
  ) {
    APD_READY_SHEET_ = sh;
    return sh;
  }

  // Migrasi aman dari struktur lama:
  // A Tanggal | B Nama Operator | C Nilai Prosentase APD | D Alasan
  // menjadi struktur baru dengan kolom indikator dan total di antara B dan persentase.
  // Dengan insertColumnsAfter(2, 8), data lama C-D bergeser ke K-L.
  const oldSchema =
    currentHeaders[0] === "Tanggal" &&
    currentHeaders[1] === "Nama Operator" &&
    currentHeaders[2] === "Nilai Prosentase APD" &&
    currentHeaders[3] === "Alasan" &&
    !currentHeaders.slice(4).some(Boolean);

  if (oldSchema) {
    sh.insertColumnsAfter(2, 8);
  } else {
    const scoreHeader = currentHeaders[8];
    const lastHeader = currentHeaders[16];
    if (scoreHeader === "Total Poin" && lastHeader === "Kebersihan Sepatu") {
      // Versi sebelumnya menyimpan Kebersihan Sepatu di Q. Pindahkan kolom
      // beserta nilainya ke I, tepat setelah Memakai aksesoris di H.
      sh.moveColumns(sh.getRange("Q1"), 9);
    } else if (scoreHeader === "Total Poin") {
      // Versi enam indikator belum memiliki kolom Kebersihan Sepatu.
      sh.insertColumnAfter(8);
    }
  }

  if (sh.getMaxColumns() < APP.APD_HEADERS.length) {
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      APP.APD_HEADERS.length - sh.getMaxColumns(),
    );
  }
  sh.getRange(1, 1, 1, APP.APD_HEADERS.length).setValues([APP.APD_HEADERS]);
  styleHeader_(sh, APP.APD_HEADERS.length);
  sh.setFrozenRows(1);

  // Kolom M:Q adalah metadata teknis, termasuk ID foto bukti.
  try {
    sh.hideColumns(13, 5);
  } catch (_) {}

  // Migrasi data APD lama: beri ID stabil tanpa mengubah nilai penilaian.
  const lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    const visibleRows = sh.getRange(2, 1, lastRow - 1, 12).getValues();
    const metadata = sh.getRange(2, 13, lastRow - 1, 4).getValues();
    let metadataChanged = false;
    for (let i = 0; i < metadata.length; i++) {
      const hasVisibleData = visibleRows[i].some(function (value) {
        return String(value || "").trim() !== "";
      });
      if (!hasVisibleData) continue;
      if (!String(metadata[i][0] || "").trim()) {
        metadata[i][0] = "legacy-" + Utilities.getUuid();
        metadataChanged = true;
      }
    }
    if (metadataChanged)
      sh.getRange(2, 13, metadata.length, 4).setValues(metadata);
  }

  APD_READY_SHEET_ = sh;
  return sh;
}

// Jalankan dari editor Apps Script setelah memperbarui Code.gs untuk
// menempatkan Kebersihan Sepatu di kolom I sebelum deployment baru.
function migrateApdColumnOrder() {
  const sh = ensureApdSheet_(spreadsheet_(), true);
  SpreadsheetApp.flush();
  return (
    "Urutan kolom APD siap: " +
    sh.getRange(1, 8, 1, 3).getDisplayValues()[0].join(" | ")
  );
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < headers.length)
    sh.insertColumnsAfter(
      sh.getMaxColumns(),
      headers.length - sh.getMaxColumns(),
    );
  const existingHeaders = sh
    .getRange(1, 1, 1, headers.length)
    .getDisplayValues()[0];
  if (
    headers.every(function (header, index) {
      return String(existingHeaders[index] || "").trim() === header;
    })
  )
    return sh;
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh, headers.length);
  sh.setFrozenRows(1);
  return sh;
}

function styleHeader_(sh, width) {
  sh.getRange(1, 1, 1, width).setFontWeight("bold").setBackground("#DDEAF2");
}

function param_(e, name) {
  return e && e.parameter && e.parameter[name] != null
    ? String(e.parameter[name])
    : "";
}

function parseJsonParam_(e, name) {
  const raw = param_(e, name);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    throw new Error(
      'Format data JSON pada parameter "' + name + '" tidak valid.',
    );
  }
}

function number_(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

function bool_(value) {
  if (value === true) return true;
  const text = String(value || "").toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "aktif";
}

function unique_(values) {
  const seen = {};
  const result = [];
  values.forEach(function (value) {
    value = String(value || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (!seen[key]) {
      seen[key] = true;
      result.push(value);
    }
  });
  return result;
}

function formatDateCell_(value) {
  if (value instanceof Date)
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone() || "Asia/Jakarta",
      "yyyy-MM-dd",
    );
  return String(value || "");
}

function parseEntryUpdateAudit_(value) {
  const text =
    value instanceof Date ? value.toISOString() : String(value || "").trim();
  if (!text) return { timestamp: "", count: 0 };

  // Format baru: 2026-09-19T02:45:12.123Z | Perubahan ke-3
  const match = text.match(/^(.*?)\s*\|\s*Perubahan\s+ke-(\d+)\s*$/i);
  if (match) {
    return {
      timestamp: String(match[1] || "").trim(),
      count: Math.max(0, Number(match[2]) || 0),
    };
  }

  // Kompatibilitas data lama: timestamp lama belum mempunyai counter.
  return { timestamp: text, count: 0 };
}

function normalizeIsoTimestamp_(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function isoCell_(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "");
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function jsonError_(err) {
  const message =
    err && err.message ? err.message : String(err || "Terjadi kesalahan.");
  return json_({ ok: false, message: message });
}
