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
  USER_CACHE_SECONDS: 1800,   // cache akun 30 menit agar login tidak selalu membaca Sheet Users
  MASTER_CACHE_SECONDS: 300,  // cache dropdown 5 menit agar halaman input cepat siap
  WRITE_LOCK_MS: 3000,       // jangan antre sampai 20 detik
  SHEETS: {
    MASTER: 'Master',
    USERS: 'Users',
    SESSIONS: 'Sessions',
    ENTRIES: 'Pengerjaan'
  },
  ENTRY_HEADERS: [
    'id', 'reportId', 'tab', 'tanggal', 'operator', 'produk', 'botol',
    'qtyKardus', 'qtyBotolPerKardus', 'totalQty', 'botolPecahJenis',
    'qtyBotolPecah', 'createdBy', 'createdByName', 'createdAt', 'updatedAt'
  ],
  USER_HEADERS: ['username', 'passwordHash', 'name', 'role', 'active', 'createdAt', 'permissionsJson'],
  SESSION_HEADERS: ['token', 'username', 'expiresAt', 'createdAt']
};

/* =========================================================
   ROLE ACCESS
   - superuser : akses penuh
   - user      : hanya input Filling/Press + data milik sendiri
   Catatan: keamanan utama tetap diperiksa di backend.
   ========================================================= */
const ROLE_ACCESS = {
  superuser: {
    filling: true,
    press: true,
    report: true,
    master: true,
    users: true,
    viewAllEntries: true,
    editOwnEntries: true,
    editAllEntries: true,
    deleteOwnEntries: true,
    deleteAllEntries: true
  },
  user: {
    filling: true,
    press: true,
    report: false,
    master: false,
    users: false,              // selalu false untuk User Biasa
    viewAllEntries: false,
    editOwnEntries: true,
    editAllEntries: false,
    deleteOwnEntries: false,
    deleteAllEntries: false
  }
};

const CUSTOM_PERMISSION_KEYS = [
  'filling', 'press', 'report', 'master', 'viewAllEntries',
  'editOwnEntries', 'editAllEntries', 'deleteOwnEntries', 'deleteAllEntries'
];

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buka Apps Script dari Spreadsheet yang akan digunakan, lalu jalankan lagi setupSpreadsheet().');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  const master = ensureSheet_(ss, APP.SHEETS.MASTER, ['Nama Operator', 'Nama Produk', 'Nama Botol']);
  const users = ensureSheet_(ss, APP.SHEETS.USERS, APP.USER_HEADERS);
  ensureSheet_(ss, APP.SHEETS.SESSIONS, APP.SESSION_HEADERS);
  ensureSheet_(ss, APP.SHEETS.ENTRIES, APP.ENTRY_HEADERS);

  if (master.getLastRow() < 2) {
    master.getRange(2, 1, 3, 3).setValues([
      ['Operator 1', 'Produk 1', 'Botol 30 ml'],
      ['Operator 2', 'Produk 2', 'Botol 50 ml'],
      ['Operator 3', 'Produk 3', 'Botol 100 ml']
    ]);
  }

  if (users.getLastRow() < 2) {
    users.getRange(2, 1, 2, APP.USER_HEADERS.length).setValues([
      ['admin', hashPassword_('admin123'), 'Administrator', 'superuser', true, new Date(), ''],
      ['operator', hashPassword_('operator123'), 'Operator', 'user', true, new Date(), '']
    ]);
  }

  return 'Setup selesai. Demo login: admin / admin123 / Super User.';
}

function doGet(e) {
  try {
    const action = param_(e, 'action');

    if (action === 'ping') {
      return json_({ ok: true, message: 'Apps Script aktif', serverTime: new Date().toISOString() });
    }

    if (action === 'bootstrap') {
      const session = requireSession_(param_(e, 'token'));
      // Bootstrap sengaja ringan agar halaman input cepat siap.
      return json_({
        ok: true,
        user: publicUser_(session.user),
        master: getMaster_()
      });
    }

    if (action === 'appdata') {
      const session = requireSession_(param_(e, 'token'));
      return json_({
        ok: true,
        // Super User melihat semua data. User Biasa hanya menerima data miliknya.
        entries: getEntriesForUser_(session.user),
        users: hasAccess_(session.user, 'users') ? getUsers_() : []
      });
    }

    return json_({ ok: false, message: 'Action GET tidak dikenali.' });
  } catch (err) {
    return jsonError_(err);
  }
}

function doPost(e) {
  try {
    const action = param_(e, 'action');

    // Login/logout tidak perlu menahan global lock untuk seluruh request.
    if (action === 'login') return handleLogin_(e);

    if (action === 'logout') {
      const token = param_(e, 'token');
      if (token) deleteSession_(token);
      return json_({ ok: true });
    }

    // requireSession_ memakai cache, jadi tambah data tidak membaca sheet Sessions setiap kali.
    const session = requireSession_(param_(e, 'token'));

    switch (action) {
      case 'entry.create': {
        const data = parseJsonParam_(e, 'data');
        requireLineAccess_(session.user, data.line, 'Input data');
        return withWriteLock_(function () {
          return json_({ ok: true, entry: createEntry_(session.user, data) });
        });
      }

      case 'entry.update':
        return withWriteLock_(function () {
          return json_({ ok: true, entry: updateEntry_(session.user, param_(e, 'id'), parseJsonParam_(e, 'data')) });
        });

      case 'entry.delete':
        return withWriteLock_(function () {
          deleteEntryForUser_(session.user, param_(e, 'id'));
          return json_({ ok: true });
        });

      case 'master.add':
        requireAccess_(session.user, 'master', 'Master Data');
        return withWriteLock_(function () {
          addMaster_(param_(e, 'category'), param_(e, 'value'));
          return json_({ ok: true, master: getMaster_() });
        });

      case 'master.remove':
        requireAccess_(session.user, 'master', 'Master Data');
        return withWriteLock_(function () {
          removeMaster_(param_(e, 'category'), param_(e, 'value'));
          return json_({ ok: true, master: getMaster_() });
        });

      case 'user.add':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          addUser_(param_(e, 'name'), param_(e, 'username'), param_(e, 'password'), param_(e, 'role'));
          return json_({ ok: true, users: getUsers_() });
        });

      case 'user.remove':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          removeUser_(param_(e, 'username'), session.user.username);
          return json_({ ok: true, users: getUsers_() });
        });

      case 'user.role':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          updateUserRole_(
            param_(e, 'username'),
            param_(e, 'role'),
            session.user.username
          );
          return json_({ ok: true, users: getUsers_() });
        });

      case 'user.permissions':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          updateUserPermissions_(
            param_(e, 'username'),
            parseJsonParam_(e, 'permissions'),
            session.user.username
          );
          return json_({ ok: true, users: getUsers_() });
        });

      // Semua akun dapat mengganti password miliknya sendiri.
      // Password lama wajib benar sebelum password baru disimpan.
      case 'password.change':
        return withWriteLock_(function () {
          changeOwnPassword_(
            session.user,
            param_(e, 'oldPassword'),
            param_(e, 'newPassword')
          );
          return json_({
            ok: true,
            message: 'Password berhasil diubah. Silakan login kembali.'
          });
        });

      // Hanya Super User yang dapat mereset password akun lain.
      // Endpoint ini tidak membutuhkan password lama target user.
      case 'password.reset':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          resetUserPassword_(
            param_(e, 'username'),
            param_(e, 'newPassword')
          );
          return json_({
            ok: true,
            message: 'Password user berhasil direset.',
            users: getUsers_()
          });
        });

      default:
        return json_({ ok: false, message: 'Action POST tidak dikenali.' });
    }
  } catch (err) {
    return jsonError_(err);
  }
}

function withWriteLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(APP.WRITE_LOCK_MS)) {
    throw new Error('Server sedang menerima input lain. Silakan klik simpan sekali lagi.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function handleLogin_(e) {
  const username = param_(e, 'username').trim();
  const password = param_(e, 'password');

  // Role tidak diminta dari frontend. Hak akses selalu mengikuti Sheet Users.
  if (!username || !password) {
    throw new Error('Username dan password wajib diisi.');
  }

  // findUser_ memakai CacheService sehingga login berulang tidak perlu selalu baca Spreadsheet.
  const user = findUser_(username);
  if (!user || !user.active) throw new Error('Akun tidak ditemukan atau tidak aktif.');
  if (user.passwordHash !== hashPassword_(password)) throw new Error('Password salah.');

  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + APP.SESSION_HOURS * 60 * 60 * 1000);

  // Simpan sesi ke Script Properties (lebih ringan daripada appendRow ke Sheet Sessions).
  // Cache tetap dipakai sebagai jalur tercepat untuk request berikutnya.
  persistSession_(token, user, expiresAt, createdAt);
  cacheSession_(token, user, expiresAt);

  return json_({ ok: true, token: token, user: publicUser_(user) });
}

function requireSession_(token) {
  if (!token) throw new Error('Sesi tidak ditemukan. Silakan login kembali.');

  const cached = readCachedSession_(token);
  if (cached) return cached;

  // Cache miss: baca Script Properties, bukan scan Sheet Sessions.
  const stored = readPersistedSession_(token);
  if (stored) {
    if (new Date(stored.expiresAt).getTime() <= Date.now()) {
      deletePersistedSession_(token);
      throw new Error('Sesi sudah berakhir. Silakan login kembali.');
    }
    cacheSession_(token, stored.user, stored.expiresAt);
    return { token: token, user: stored.user };
  }

  // Kompatibilitas token versi lama yang masih berada pada Sheet Sessions.
  const sh = sheet_(APP.SHEETS.SESSIONS);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) !== token) continue;
    const expiresAt = values[i][2] instanceof Date ? values[i][2] : new Date(values[i][2]);
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      throw new Error('Sesi sudah berakhir. Silakan login kembali.');
    }
    const user = findUser_(String(values[i][1]));
    if (!user || !user.active) throw new Error('User sesi sudah tidak aktif.');
    persistSession_(token, user, expiresAt, values[i][3] || new Date());
    cacheSession_(token, user, expiresAt);
    return { token: token, user: user };
  }

  throw new Error('Sesi sudah berakhir. Silakan login kembali.');
}

function persistedSessionKey_(token) {
  return 'PPR_SESSION_' + String(token);
}

function persistSession_(token, user, expiresAt, createdAt) {
  PropertiesService.getScriptProperties().setProperty(
    persistedSessionKey_(token),
    JSON.stringify({
      token: token,
      expiresAt: new Date(expiresAt).toISOString(),
      createdAt: new Date(createdAt || new Date()).toISOString(),
      user: publicUser_(user)
    })
  );
}

function readPersistedSession_(token) {
  const raw = PropertiesService.getScriptProperties().getProperty(persistedSessionKey_(token));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_) {
    deletePersistedSession_(token);
    return null;
  }
}

function deletePersistedSession_(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty(persistedSessionKey_(token));
}

function sessionCacheKey_(token) {
  return 'ppr_session_' + String(token);
}

function cacheSession_(token, user, expiresAt) {
  const remainingSeconds = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const ttl = Math.min(APP.SESSION_CACHE_SECONDS, remainingSeconds);
  CacheService.getScriptCache().put(
    sessionCacheKey_(token),
    JSON.stringify({
      token: token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: publicUser_(user)
    }),
    ttl
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
    const expires = values[i][2] instanceof Date ? values[i][2].getTime() : new Date(values[i][2]).getTime();
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

function createEntry_(user, data) {
  validateEntry_(data);

  const createdAt = new Date();
  const line = data.line === 'press' ? 'press' : 'filling';

  // clientRequestId membuat optimistic save idempotent. Jika browser timeout
  // lalu user menekan Coba Lagi, baris yang sama tidak dibuat dua kali.
  const requestedId = String(data.clientRequestId || '').trim();
  const validRequestedId = /^[A-Za-z0-9-]{16,100}$/.test(requestedId) ? requestedId : '';

  if (validRequestedId) {
    const existingRow = findEntryRow_(validRequestedId);
    if (existingRow) {
      const existing = rowToEntry_(existingRow.values);
      if (existing.createdBy === user.username) return existing;
      throw new Error('ID permintaan sudah digunakan oleh user lain.');
    }
  }

  const id = validRequestedId || Utilities.getUuid();
  const reportId = makeReportId_(line, createdAt);
  const qtyKardus = number_(data.qtyKardus);
  const qtyBotol = number_(data.qtyBotolPerKardus);
  const qtyPecah = number_(data.qtyBotolPecah);

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
    botolPecahJenis: String(data.botolPecahJenis || '').trim(),
    qtyBotolPecah: qtyPecah,
    createdBy: user.username,
    createdByName: user.name,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString()
  };

  sheet_(APP.SHEETS.ENTRIES).appendRow(entryToRow_(entry));
  return entry;
}

function updateEntry_(user, id, data) {
  if (!id) throw new Error('ID data tidak ditemukan.');
  validateEntry_(data);

  const found = findEntryRow_(id);
  if (!found) throw new Error('Data yang akan di-update tidak ditemukan.');

  const existing = rowToEntry_(found.values);
  const isOwner = sameUsername_(existing.createdBy, user.username);

  requireLineAccess_(user, data.line || existing.tab, 'Update data');

  if (isOwner) {
    requireAccess_(user, 'editOwnEntries', 'Edit data sendiri');
  } else {
    requireAccess_(user, 'editAllEntries', 'Edit data user lain');
  }

  const qtyKardus = number_(data.qtyKardus);
  const qtyBotol = number_(data.qtyBotolPerKardus);
  const updated = {
    id: existing.id,
    reportId: existing.reportId,
    tab: data.line === 'press' ? 'press' : 'filling',
    tanggal: String(data.tanggal),
    operator: String(data.operator).trim(),
    produk: String(data.produk).trim(),
    botol: String(data.botol).trim(),
    qtyKardus: qtyKardus,
    qtyBotolPerKardus: qtyBotol,
    totalQty: qtyKardus * qtyBotol,
    botolPecahJenis: String(data.botolPecahJenis || '').trim(),
    qtyBotolPecah: number_(data.qtyBotolPecah),
    createdBy: existing.createdBy,
    createdByName: existing.createdByName,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString()
  };

  sheet_(APP.SHEETS.ENTRIES).getRange(found.row, 1, 1, APP.ENTRY_HEADERS.length).setValues([entryToRow_(updated)]);
  return updated;
}

function deleteEntryForUser_(user, id) {
  const found = findEntryRow_(id);
  if (!found) throw new Error('Data tidak ditemukan.');

  const existing = rowToEntry_(found.values);
  const isOwner = sameUsername_(existing.createdBy, user.username);

  requireLineAccess_(user, existing.tab, 'Hapus data');
  if (isOwner) {
    requireAccess_(user, 'deleteOwnEntries', 'Hapus data sendiri');
  } else {
    requireAccess_(user, 'deleteAllEntries', 'Hapus data user lain');
  }

  sheet_(APP.SHEETS.ENTRIES).deleteRow(found.row);
}

function getEntries_() {
  const sh = sheet_(APP.SHEETS.ENTRIES);
  const values = sh.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][0]) result.push(rowToEntry_(values[i]));
  }
  return result;
}

function getEntriesForUser_(user) {
  let entries = getEntries_();

  // Sembunyikan line yang tidak diberikan kepada user.
  entries = entries.filter(function (entry) {
    return hasAccess_(user, entry.tab === 'press' ? 'press' : 'filling');
  });

  if (hasAccess_(user, 'viewAllEntries')) return entries;

  return entries.filter(function (entry) {
    return sameUsername_(entry.createdBy, user && user.username);
  });
}

function findEntryRow_(id) {
  const sh = sheet_(APP.SHEETS.ENTRIES);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return { row: i + 1, values: values[i] };
  }
  return null;
}

function entryToRow_(e) {
  return [
    e.id, e.reportId, e.tab, e.tanggal, e.operator, e.produk, e.botol,
    e.qtyKardus, e.qtyBotolPerKardus, e.totalQty, e.botolPecahJenis,
    e.qtyBotolPecah, e.createdBy, e.createdByName, e.createdAt, e.updatedAt
  ];
}

function rowToEntry_(row) {
  return {
    id: String(row[0] || ''),
    reportId: String(row[1] || ''),
    tab: String(row[2] || ''),
    tanggal: formatDateCell_(row[3]),
    operator: String(row[4] || ''),
    produk: String(row[5] || ''),
    botol: String(row[6] || ''),
    qtyKardus: number_(row[7]),
    qtyBotolPerKardus: number_(row[8]),
    totalQty: number_(row[9]),
    botolPecahJenis: String(row[10] || ''),
    qtyBotolPecah: number_(row[11]),
    createdBy: String(row[12] || ''),
    createdByName: String(row[13] || ''),
    createdAt: isoCell_(row[14]),
    updatedAt: isoCell_(row[15])
  };
}

function validateEntry_(data) {
  if (!data) throw new Error('Data pengerjaan kosong.');
  if (!data.operator || !data.produk || !data.botol) throw new Error('Operator, Produk, dan Botol wajib diisi.');
  if (number_(data.qtyKardus) < 0 || number_(data.qtyBotolPerKardus) < 0 || number_(data.qtyBotolPecah) < 0) {
    throw new Error('Qty tidak boleh negatif.');
  }
}

function makeReportId_(line, date) {
  const tz = Session.getScriptTimeZone() || 'Asia/Jakarta';
  const stamp = Utilities.formatDate(date, tz, 'yyyyMMdd-HHmmss');
  const prefix = line === 'press' ? 'PRS' : 'FIL';
  return prefix + '-' + stamp + '-' + Utilities.getUuid().slice(0, 4).toUpperCase();
}

const MASTER_CACHE_KEY_ = 'ppr_master_cache_v1';

function getMaster_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(MASTER_CACHE_KEY_);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  const sh = sheet_(APP.SHEETS.MASTER);
  const lastRow = Math.max(sh.getLastRow(), 1);
  const values = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 3).getDisplayValues() : [];
  const operator = unique_(values.map(r => r[0]));
  const produk = unique_(values.map(r => r[1]));
  const botol = unique_(values.map(r => r[2]));
  const result = { operator: operator, produk: produk, botol: botol, botolpecah: botol.slice() };
  cache.put(MASTER_CACHE_KEY_, JSON.stringify(result), APP.MASTER_CACHE_SECONDS);
  return result;
}

function invalidateMasterCache_() {
  CacheService.getScriptCache().remove(MASTER_CACHE_KEY_);
}

function addMaster_(category, value) {
  value = String(value || '').trim();
  if (!value) throw new Error('Nilai master tidak boleh kosong.');
  const col = masterColumn_(category);
  const current = getMasterColumn_(col);
  if (current.map(v => v.toLowerCase()).indexOf(value.toLowerCase()) >= 0) throw new Error('Data master sudah ada.');
  current.push(value);
  writeMasterColumn_(col, current);
  invalidateMasterCache_();
}

function removeMaster_(category, value) {
  const col = masterColumn_(category);
  const target = String(value || '').trim().toLowerCase();
  const current = getMasterColumn_(col).filter(v => v.toLowerCase() !== target);
  writeMasterColumn_(col, current);
  invalidateMasterCache_();
}

function masterColumn_(category) {
  const map = { operator: 1, produk: 2, botol: 3 };
  if (!map[category]) throw new Error('Kategori master tidak valid.');
  return map[category];
}

function getMasterColumn_(col) {
  const sh = sheet_(APP.SHEETS.MASTER);
  if (sh.getLastRow() < 2) return [];
  return unique_(sh.getRange(2, col, sh.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]));
}

function writeMasterColumn_(col, values) {
  const sh = sheet_(APP.SHEETS.MASTER);
  const rowsToClear = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, col, rowsToClear, 1).clearContent();
  if (values.length) sh.getRange(2, col, values.length, 1).setValues(values.map(v => [v]));
}

function addUser_(name, username, password, role) {
  name = String(name || '').trim();
  username = String(username || '').trim();
  password = String(password || '');
  role = normalizeRole_(role);

  if (!name || !username || !password) throw new Error('Nama, username, dan password wajib diisi.');
  if (findUser_(username)) throw new Error('Username sudah digunakan.');

  sheet_(APP.SHEETS.USERS).appendRow([username, hashPassword_(password), name, role, true, new Date(), '']);
  invalidateUsersCache_();
}

/* =========================================================
   PASSWORD MANAGEMENT
   ========================================================= */

function validateNewPassword_(password) {
  password = String(password || '');
  if (!password) throw new Error('Password baru wajib diisi.');
  if (password.length < 6) throw new Error('Password baru minimal 6 karakter.');
  if (password.length > 100) throw new Error('Password baru terlalu panjang. Maksimal 100 karakter.');
  return password;
}

/**
 * Ganti password akun yang sedang login.
 * Berlaku untuk User Biasa maupun Super User.
 * Password lama wajib cocok.
 */
function changeOwnPassword_(user, oldPassword, newPassword) {
  if (!user || !user.username) throw new Error('Sesi user tidak valid.');

  oldPassword = String(oldPassword || '');
  newPassword = validateNewPassword_(newPassword);

  if (!oldPassword) throw new Error('Password lama wajib diisi.');

  const current = findUser_(user.username);
  if (!current || !current.active) throw new Error('Akun tidak ditemukan atau tidak aktif.');

  if (current.passwordHash !== hashPassword_(oldPassword)) {
    throw new Error('Password lama salah.');
  }

  if (current.passwordHash === hashPassword_(newPassword)) {
    throw new Error('Password baru harus berbeda dari password lama.');
  }

  setUserPasswordHash_(current.username, hashPassword_(newPassword));

  // Semua sesi akun ini dihapus, termasuk sesi yang sedang dipakai,
  // sehingga user wajib login kembali dengan password baru.
  removeSessionsForUser_(current.username);
  return true;
}

/**
 * Reset password user oleh Super User.
 * Tidak membutuhkan password lama target user.
 */
function resetUserPassword_(username, newPassword) {
  username = String(username || '').trim();
  newPassword = validateNewPassword_(newPassword);

  if (!username) throw new Error('Username wajib diisi.');

  const target = findUser_(username);
  if (!target) throw new Error('User tidak ditemukan.');

  setUserPasswordHash_(target.username, hashPassword_(newPassword));
  removeSessionsForUser_(target.username);
  return true;
}

/**
 * Menulis hash password ke kolom B Sheet Users.
 */
function setUserPasswordHash_(username, passwordHash) {
  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (!sameUsername_(values[i][0], username)) continue;

    // Kolom B = passwordHash
    sh.getRange(i + 1, 2).setValue(passwordHash);
    invalidateUsersCache_();
    return;
  }

  throw new Error('User tidak ditemukan.');
}

/**
 * OPTIONAL — dipakai hanya bila ingin reset password langsung
 * dari Apps Script Editor tanpa UI.
 *
 * Contoh:
 *   setPasswordFromEditor('admin', 'AdminBaru123');
 *   setPasswordFromEditor('hana', 'HanaBaru123');
 *
 * Setelah berhasil, hapus pemanggilan test dari editor bila ada.
 */
function setPasswordFromEditor(username, newPassword) {
  resetUserPassword_(username, newPassword);
  return 'Password untuk "' + String(username) + '" berhasil diubah.';
}

function removeUser_(username, currentUsername) {
  if (username === currentUsername) throw new Error('User yang sedang login tidak dapat menghapus dirinya sendiri.');

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
  throw new Error('User tidak ditemukan.');
}

function updateUserRole_(username, role, currentUsername) {
  username = String(username || '').trim();
  role = normalizeRole_(role);

  if (!username) throw new Error('Username tidak ditemukan.');
  if (username === String(currentUsername || '').trim()) {
    throw new Error('Role akun yang sedang login tidak dapat diubah dari sini.');
  }

  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() !== username.toLowerCase()) continue;

    // Kolom D = role.
    sh.getRange(i + 1, 4).setValue(role);
    invalidateUsersCache_();

    // Paksa user yang diubah untuk login ulang agar role baru langsung berlaku.
    removeSessionsForUser_(String(values[i][0]));
    return;
  }

  throw new Error('User tidak ditemukan.');
}


function updateUserPermissions_(username, permissions, currentUsername) {
  username = String(username || '').trim();
  if (!username) throw new Error('Username tidak ditemukan.');

  if (sameUsername_(username, currentUsername)) {
    throw new Error('Hak akses akun Super User yang sedang login tidak diubah dari editor ini.');
  }

  const targetUser = findUser_(username);
  if (!targetUser) throw new Error('User tidak ditemukan.');
  if (normalizeRole_(targetUser.role) === 'superuser') {
    throw new Error('Super User selalu memiliki akses penuh. Custom akses hanya untuk User Biasa.');
  }

  const clean = {};
  CUSTOM_PERMISSION_KEYS.forEach(function (key) {
    clean[key] = permissions && permissions[key] === true;
  });

  // Kelola User tidak pernah dapat diberikan ke User Biasa.
  clean.users = false;

  const sh = sheet_(APP.SHEETS.USERS);
  const values = sh.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (!sameUsername_(values[i][0], username)) continue;

    // Kolom G = permissionsJson.
    sh.getRange(i + 1, 7).setValue(JSON.stringify(clean));
    invalidateUsersCache_();
    removeSessionsForUser_(String(values[i][0]));
    return;
  }

  throw new Error('User tidak ditemukan.');
}


function removeSessionsForUser_(username) {
  const target = String(username || '');
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('PPR_SESSION_') !== 0) return;
    try {
      const data = JSON.parse(all[key]);
      if (data.user && String(data.user.username) === target) {
        const token = key.substring('PPR_SESSION_'.length);
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


const USERS_CACHE_KEY_ = 'ppr_users_cache_v2';

function readUsersRaw_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(USERS_CACHE_KEY_);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
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
      role: normalizeRole_(values[i][3]),
      active: bool_(values[i][4]),
      customPermissions: parsePermissionsCell_(values[i][6])
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
  const target = String(username || '').trim().toLowerCase();
  const users = readUsersRaw_();
  for (let i = 0; i < users.length; i++) {
    if (String(users[i].username).trim().toLowerCase() === target) return users[i];
  }
  return null;
}

function normalizeRole_(role) {
  const value = String(role || 'user').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return value === 'superuser' ? 'superuser' : 'user';
}

function permissionsForRole_(role) {
  const base = ROLE_ACCESS[normalizeRole_(role)] || ROLE_ACCESS.user;
  return Object.assign({}, base);
}

function permissionsForUser_(user) {
  if (!user) return {};

  const role = normalizeRole_(user.role);
  const permissions = permissionsForRole_(role);

  // Super User selalu full access dan tidak memakai custom permission.
  if (role === 'superuser') return permissions;

  // Raw user dari Sheet memakai customPermissions.
  // User yang sudah berada di Session memakai permissions (hasil efektif saat login).
  const custom = user.customPermissions || user.permissions || {};
  CUSTOM_PERMISSION_KEYS.forEach(function (key) {
    if (typeof custom[key] === 'boolean') permissions[key] = custom[key];
  });

  // Guardrail: User Biasa tidak boleh mengelola akun/hak akses.
  permissions.users = false;
  return permissions;
}

function hasAccess_(user, permission) {
  if (!user) return false;
  return permissionsForUser_(user)[permission] === true;
}

function publicUser_(user) {
  const role = normalizeRole_(user && user.role);
  const permissions = permissionsForUser_(user);
  return {
    username: user.username,
    name: user.name,
    role: role,
    active: user.active !== false,
    dataScope: permissions.viewAllEntries ? 'all' : 'own',
    permissions: permissions
  };
}

function requireAccess_(user, permission, label) {
  if (!hasAccess_(user, permission)) {
    throw new Error((label || 'Aksi') + ' tidak diizinkan untuk akun ini.');
  }
}

function requireLineAccess_(user, line, label) {
  const key = String(line || '').toLowerCase() === 'press' ? 'press' : 'filling';
  requireAccess_(user, key, label || ('Akses ' + key));
}

function requireSuperuser_(user) {
  if (!user || normalizeRole_(user.role) !== 'superuser') {
    throw new Error('Aksi ini hanya dapat dilakukan Super User.');
  }
}

function parsePermissionsCell_(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function sameUsername_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function hashPassword_(password) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(password), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest);
}

let SPREADSHEET_CACHE_ = null;

function spreadsheet_() {
  if (SPREADSHEET_CACHE_) return SPREADSHEET_CACHE_;

  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    SPREADSHEET_CACHE_ = SpreadsheetApp.openById(id);
    return SPREADSHEET_CACHE_;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Spreadsheet belum dikonfigurasi. Jalankan setupSpreadsheet() sekali.');
  SPREADSHEET_CACHE_ = active;
  return SPREADSHEET_CACHE_;
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" belum ada. Jalankan setupSpreadsheet() sekali.');
  return sh;
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh, headers.length);
  sh.setFrozenRows(1);
  return sh;
}

function styleHeader_(sh, width) {
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#DDEAF2');
}

function param_(e, name) {
  return e && e.parameter && e.parameter[name] != null ? String(e.parameter[name]) : '';
}

function parseJsonParam_(e, name) {
  const raw = param_(e, name);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch (_) { throw new Error('Format data JSON pada parameter "' + name + '" tidak valid.'); }
}

function number_(value) {
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

function bool_(value) {
  if (value === true) return true;
  const text = String(value || '').toLowerCase();
  return text === 'true' || text === '1' || text === 'yes' || text === 'aktif';
}

function unique_(values) {
  const seen = {};
  const result = [];
  values.forEach(function (value) {
    value = String(value || '').trim();
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
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd');
  return String(value || '');
}

function isoCell_(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || '');
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function jsonError_(err) {
  const message = err && err.message ? err.message : String(err || 'Terjadi kesalahan.');
  return json_({ ok: false, message: message });
}
