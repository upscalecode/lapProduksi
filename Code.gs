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
    ENTRIES: 'Pengerjaan',
    PRESS_ADJUSTMENTS: 'Penutupan Press',
    PRESS_REMAINDERS: 'Sisa Press'
  },
  ENTRY_HEADERS: [
    'id', 'reportId', 'tab', 'tanggal', 'operator', 'produk', 'botol',
    'qtyKardus', 'qtyBotolPerKardus', 'totalQty', 'botolPecahJenis',
    'qtyBotolPecah', 'createdBy', 'createdByName', 'createdAt', 'updatedAt',
    'sisaPressTanggalAsal', 'keterangan'
  ],
  USER_HEADERS: ['username', 'passwordHash', 'name', 'role', 'active', 'createdAt'],
  SESSION_HEADERS: ['token', 'username', 'expiresAt', 'createdAt'],
  PRESS_ADJUSTMENT_HEADERS: ['id', 'tanggal', 'produk', 'botol', 'qtyDitutup', 'alasan', 'closedBy', 'closedByName', 'createdAt'],
  PRESS_REMAINDER_HEADERS: ['id', 'tanggalAsal', 'produk', 'botol', 'qtyFilling', 'qtyPressTerpakai', 'qtyDitutup', 'sisaQty', 'status', 'updatedAt']
};

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buka Apps Script dari Spreadsheet yang akan digunakan, lalu jalankan lagi setupSpreadsheet().');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  const master = ensureSheet_(ss, APP.SHEETS.MASTER, ['Nama Operator', 'Nama Produk', 'Nama Botol']);
  const users = ensureSheet_(ss, APP.SHEETS.USERS, APP.USER_HEADERS);
  ensureSheet_(ss, APP.SHEETS.SESSIONS, APP.SESSION_HEADERS);
  ensureSheet_(ss, APP.SHEETS.ENTRIES, APP.ENTRY_HEADERS);
  ensureSheet_(ss, APP.SHEETS.PRESS_ADJUSTMENTS, APP.PRESS_ADJUSTMENT_HEADERS);
  ensureSheet_(ss, APP.SHEETS.PRESS_REMAINDERS, APP.PRESS_REMAINDER_HEADERS);

  if (master.getLastRow() < 2) {
    master.getRange(2, 1, 3, 3).setValues([
      ['Operator 1', 'Produk 1', 'Botol 30 ml'],
      ['Operator 2', 'Produk 2', 'Botol 50 ml'],
      ['Operator 3', 'Produk 3', 'Botol 100 ml']
    ]);
  }

  if (users.getLastRow() < 2) {
    users.getRange(2, 1, 2, APP.USER_HEADERS.length).setValues([
      ['admin', hashPassword_('admin123'), 'Administrator', 'superuser', true, new Date()],
      ['operator', hashPassword_('operator123'), 'Operator', 'user', true, new Date()]
    ]);
  }

  // Bangun saldo sisa dari data Pengerjaan lama agar langsung kompatibel.
  rebuildPressRemainders_();

  return 'Setup selesai. Sheet Sisa Press aktif dan saldo Filling → Press sudah dibangun ulang.';
}

function doGet(e) {
  try {
    const action = param_(e, 'action');

    if (action === 'ping') {
      return json_({ ok: true, message: 'Apps Script aktif', serverTime: new Date().toISOString() });
    }

    if (action === 'bootstrap') {
      const session = requireSession_(param_(e, 'token'));
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
        entries: getEntries_(),
        adjustments: getPressAdjustments_(),
        remainders: getPressRemainders_(),
        users: session.user.role === 'superuser' ? getUsers_() : []
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

    if (action === 'login') return handleLogin_(e);

    if (action === 'logout') {
      const token = param_(e, 'token');
      if (token) deleteSession_(token);
      return json_({ ok: true });
    }

    const session = requireSession_(param_(e, 'token'));

    switch (action) {
      case 'entry.create':
        return withWriteLock_(function () {
          const entry = createEntry_(session.user, parseJsonParam_(e, 'data'));
          return json_({ ok: true, entry: entry, remainders: getPressRemainders_() });
        });

      case 'entry.update':
        return withWriteLock_(function () {
          const entry = updateEntry_(session.user, param_(e, 'id'), parseJsonParam_(e, 'data'));
          return json_({ ok: true, entry: entry, remainders: getPressRemainders_() });
        });

      case 'entry.delete':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          deleteEntry_(param_(e, 'id'));
          return json_({ ok: true, remainders: getPressRemainders_() });
        });

      // Dipertahankan untuk kompatibilitas data/versi lama.
      case 'press.adjustment.close':
        return withWriteLock_(function () {
          const adjustment = closePressRemainder_(session.user, parseJsonParam_(e, 'data'));
          rebuildPressRemainders_();
          return json_({ ok: true, adjustment: adjustment, remainders: getPressRemainders_() });
        });

      case 'master.add':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          addMaster_(param_(e, 'category'), param_(e, 'value'));
          return json_({ ok: true, master: getMaster_() });
        });

      case 'master.remove':
        requireSuperuser_(session.user);
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
    updatedAt: createdAt.toISOString(),
    sisaPressTanggalAsal: '',
    keterangan: ''
  };

  // Balance Press dihitung berdasarkan Nama Produk dan tidak boleh memakai Filling tanggal setelah Press.
  assertProjectedBalance_([entry], '');

  entrySheet_().appendRow(entryToRow_(entry));
  rebuildPressRemainders_();

  const saved = findEntryRow_(id);
  return saved ? rowToEntry_(saved.values) : entry;
}

function updateEntry_(user, id, data) {
  if (!id) throw new Error('ID data tidak ditemukan.');
  validateEntry_(data);

  const found = findEntryRow_(id);
  if (!found) throw new Error('Data yang akan di-update tidak ditemukan.');

  const existing = rowToEntry_(found.values);
  if (user.role !== 'superuser' && existing.createdBy !== user.username) {
    throw new Error('Anda tidak memiliki izin mengubah data milik user lain.');
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
    updatedAt: new Date().toISOString(),
    sisaPressTanggalAsal: '',
    keterangan: ''
  };

  assertProjectedBalance_([existing, updated], existing.id);

  entrySheet_().getRange(found.row, 1, 1, APP.ENTRY_HEADERS.length).setValues([entryToRow_(updated)]);
  rebuildPressRemainders_();

  const saved = findEntryRow_(id);
  return saved ? rowToEntry_(saved.values) : updated;
}

function deleteEntry_(id) {
  const found = findEntryRow_(id);
  if (!found) throw new Error('Data tidak ditemukan.');

  const existing = rowToEntry_(found.values);

  // Simulasikan kondisi setelah baris dihapus. Filling tidak boleh dihapus
  // bila menyebabkan Qty Press historis menjadi lebih besar daripada Filling.
  assertProjectedBalance_([existing], existing.id);

  entrySheet_().deleteRow(found.row);
  rebuildPressRemainders_();
}

function getEntries_() {
  const sh = entrySheet_();
  const values = sh.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][0]) result.push(rowToEntry_(values[i]));
  }
  return result;
}

function findEntryRow_(id) {
  const sh = entrySheet_();
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
    e.qtyBotolPecah, e.createdBy, e.createdByName, e.createdAt, e.updatedAt,
    e.sisaPressTanggalAsal || '', e.keterangan || ''
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
    updatedAt: isoCell_(row[15]),
    sisaPressTanggalAsal: String(row[16] || ''),
    keterangan: String(row[17] || '')
  };
}

function validateEntry_(data) {
  if (!data) throw new Error('Data pengerjaan kosong.');
  if (data.line !== 'filling' && data.line !== 'press') throw new Error('Line pengerjaan tidak valid.');
  if (!data.operator || !data.produk || !data.botol) throw new Error('Operator, Produk, dan Botol wajib diisi.');

  // Jangan percaya input browser. Semua nilai wajib benar-benar ada di sheet Master.
  data.operator = canonicalMasterValue_(getMaster_().operator, data.operator, 'Operator');
  data.produk = canonicalMasterValue_(getMaster_().produk, data.produk, 'Produk');
  data.botol = canonicalMasterValue_(getMaster_().botol, data.botol, 'Botol');

  const qtyKardusRaw = Number(data.qtyKardus);
  const qtyBotolRaw = Number(data.qtyBotolPerKardus);
  const qtyPecahRaw = Number(data.qtyBotolPecah || 0);
  if (!isFinite(qtyKardusRaw) || !isFinite(qtyBotolRaw) || !isFinite(qtyPecahRaw)) {
    throw new Error('Qty harus berupa angka yang valid.');
  }
  if (qtyKardusRaw < 0 || qtyBotolRaw < 0 || qtyPecahRaw < 0) {
    throw new Error('Qty tidak boleh negatif.');
  }
  if (data.line === 'press' && qtyKardusRaw * qtyBotolRaw <= 0) {
    throw new Error('Total Qty Press harus lebih dari 0 botol.');
  }

  // Jenis botol pecah selalu mengikuti botol yang sedang dikerjakan.
  data.botolPecahJenis = data.botol;
}

function canonicalMasterValue_(list, value, label) {
  const target = String(value || '').trim().toLowerCase();
  const values = (list || []).map(function (item) { return String(item || '').trim(); }).filter(String);
  for (let i = 0; i < values.length; i++) {
    if (values[i].toLowerCase() === target) return values[i];
  }
  throw new Error(label + ' "' + String(value || '').trim() + '" tidak tersedia di data Master.');
}

function balanceKey_(produk, botol) {
  return String(produk || '').trim().toLowerCase() + '||' + String(botol || '').trim().toLowerCase();
}

function productKey_(produk) {
  return String(produk || '').trim().toLowerCase();
}

function entrySheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(APP.SHEETS.ENTRIES);
  if (!sh || sh.getMaxColumns() < APP.ENTRY_HEADERS.length) {
    sh = ensureSheet_(ss, APP.SHEETS.ENTRIES, APP.ENTRY_HEADERS);
  } else {
    // Pastikan header tambahan untuk versi baru terpasang tanpa menggeser data lama.
    sh.getRange(1, 1, 1, APP.ENTRY_HEADERS.length).setValues([APP.ENTRY_HEADERS]);
  }
  return sh;
}

function pressRemainderSheet_(createIfMissing) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(APP.SHEETS.PRESS_REMAINDERS);
  if (!sh && createIfMissing) {
    sh = ensureSheet_(ss, APP.SHEETS.PRESS_REMAINDERS, APP.PRESS_REMAINDER_HEADERS);
  }
  return sh || null;
}

function compareWorkChronology_(a, b) {
  const byDate = String(a.tanggal || a.tanggalAsal || '').localeCompare(String(b.tanggal || b.tanggalAsal || ''));
  if (byDate) return byDate;
  const byCreated = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  if (byCreated) return byCreated;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function formatTanggalIndonesia_(dateText) {
  const text = String(dateText || '');
  const parts = text.split('-');
  if (parts.length !== 3) return text;
  const months = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const month = months[Number(parts[1]) - 1];
  if (!month) return text;
  return Number(parts[2]) + ' ' + month + ' ' + parts[0];
}

function buildPressAllocationModel_(entries, adjustments) {
  const fillingLots = (entries || [])
    .filter(function (entry) { return entry.tab === 'filling' && number_(entry.totalQty) > 0; })
    .slice()
    .sort(compareWorkChronology_)
    .map(function (entry) {
      return {
        id: String(entry.id),
        tanggalAsal: String(entry.tanggal || ''),
        produk: String(entry.produk || '').trim(),
        botol: String(entry.botol || '').trim(),
        qtyFilling: number_(entry.totalQty),
        qtyPressTerpakai: 0,
        qtyDitutup: 0,
        remaining: number_(entry.totalQty),
        createdAt: String(entry.createdAt || '')
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
    if (entry.tab !== 'press' || number_(entry.totalQty) <= 0) return;
    events.push({
      type: 'press',
      id: String(entry.id),
      tanggal: String(entry.tanggal || ''),
      produk: String(entry.produk || '').trim(),
      qty: number_(entry.totalQty),
      createdAt: String(entry.createdAt || '')
    });
  });
  (adjustments || []).forEach(function (adjustment) {
    if (number_(adjustment.qtyDitutup) <= 0) return;
    events.push({
      type: 'closed',
      id: String(adjustment.id),
      tanggal: String(adjustment.tanggal || ''),
      produk: String(adjustment.produk || '').trim(),
      botol: String(adjustment.botol || '').trim(),
      qty: number_(adjustment.qtyDitutup),
      createdAt: String(adjustment.createdAt || '')
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
      if (lot.tanggalAsal && event.tanggal && lot.tanggalAsal > event.tanggal) continue;
      if (lot.remaining <= 0) continue;
      // Hapus/Tutup Sisa harus hanya mengurangi kombinasi Produk + Botol yang dipilih.
      // Proses Press biasa tetap mempertahankan logika lama: alokasi FIFO berdasarkan Nama Produk.
      if (event.type === 'closed' && balanceKey_(lot.produk, lot.botol) !== balanceKey_(event.produk, event.botol)) continue;

      const used = Math.min(needed, lot.remaining);
      lot.remaining -= used;
      needed -= used;

      if (event.type === 'press') {
        lot.qtyPressTerpakai += used;
        consumed.push({ tanggalAsal: lot.tanggalAsal, qty: used, lotId: lot.id });
      } else {
        lot.qtyDitutup += used;
      }
    }

    if (event.type === 'press') {
      const carryDates = unique_(consumed
        .filter(function (item) { return item.tanggalAsal && item.tanggalAsal < event.tanggal; })
        .map(function (item) { return item.tanggalAsal; }));

      pressMeta[event.id] = {
        tanggalAsal: carryDates.join(', '),
        keterangan: carryDates.length
          ? 'Sisa tinggalan Press tanggal ' + carryDates.map(formatTanggalIndonesia_).join(', ')
          : ''
      };
    }

    if (needed > 0) {
      overflow.push({
        id: event.id,
        type: event.type,
        tanggal: event.tanggal,
        produk: event.produk,
        botol: event.botol || '',
        kurang: needed
      });
    }
  });

  const remainders = fillingLots
    .filter(function (lot) { return lot.remaining > 0; })
    .map(function (lot) {
      return {
        id: lot.id,
        tanggalAsal: lot.tanggalAsal,
        produk: lot.produk,
        botol: lot.botol,
        qtyFilling: lot.qtyFilling,
        qtyPressTerpakai: lot.qtyPressTerpakai,
        qtyDitutup: lot.qtyDitutup,
        sisaQty: lot.remaining,
        status: 'MENUNGGU PRESS',
        updatedAt: new Date().toISOString()
      };
    });

  return { remainders: remainders, pressMeta: pressMeta, overflow: overflow };
}

function rebuildPressRemainders_() {
  const entries = getEntries_();
  const model = buildPressAllocationModel_(entries, getPressAdjustments_());
  const sh = pressRemainderSheet_(true);

  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, APP.PRESS_REMAINDER_HEADERS.length).clearContent();
  }

  if (model.remainders.length) {
    const rows = model.remainders.map(function (item) {
      return [
        item.id, item.tanggalAsal, item.produk, item.botol,
        item.qtyFilling, item.qtyPressTerpakai, item.qtyDitutup,
        item.sisaQty, item.status, item.updatedAt
      ];
    });
    sh.getRange(2, 1, rows.length, APP.PRESS_REMAINDER_HEADERS.length).setValues(rows);
  }

  // Update dua kolom terakhir Sheet Pengerjaan secara batch.
  // Filling dikosongkan; Press akan memperoleh keterangan bila memakai sisa hari sebelumnya.
  const entrySh = entrySheet_();
  if (entrySh.getLastRow() > 1) {
    const idsAndTabs = entrySh.getRange(2, 1, entrySh.getLastRow() - 1, 3).getValues();
    const noteRows = idsAndTabs.map(function (row) {
      const id = String(row[0] || '');
      const tab = String(row[2] || '');
      const meta = tab === 'press' ? model.pressMeta[id] : null;
      return [meta ? meta.tanggalAsal : '', meta ? meta.keterangan : ''];
    });
    entrySh.getRange(2, 17, noteRows.length, 2).setValues(noteRows);
  }

  return model.remainders;
}

function getPressRemainders_() {
  let sh = pressRemainderSheet_(false);

  // Migrasi otomatis untuk deployment lama yang belum memiliki Sheet Sisa Press.
  if (!sh) return rebuildPressRemainders_();

  const values = sh.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    result.push({
      id: String(values[i][0] || ''),
      tanggalAsal: formatDateCell_(values[i][1]),
      produk: String(values[i][2] || ''),
      botol: String(values[i][3] || ''),
      qtyFilling: number_(values[i][4]),
      qtyPressTerpakai: number_(values[i][5]),
      qtyDitutup: number_(values[i][6]),
      sisaQty: number_(values[i][7]),
      status: String(values[i][8] || ''),
      updatedAt: isoCell_(values[i][9])
    });
  }

  // Bila baru migrasi dan sheet masih kosong sementara data Filling lama ada, bangun sekali.
  if (!result.length) {
    const hasFilling = getEntries_().some(function (entry) {
      return entry.tab === 'filling' && number_(entry.totalQty) > 0;
    });
    if (hasFilling) return rebuildPressRemainders_();
  }

  return result;
}


/**
 * Memastikan saldo Press tidak pernah melampaui Filling.
 * candidates dipakai untuk menentukan kombinasi Produk+Botol yang terdampak.
 * existingId dilewati dari data sheet, lalu candidate terakhir (jika berbeda)
 * diproyeksikan sebagai nilai baru.
 */
function assertProjectedBalance_(candidates, existingId) {
  let entries = getEntries_().filter(function (entry) {
    return !existingId || String(entry.id) !== String(existingId);
  });

  const projected = (candidates || []).length ? candidates[candidates.length - 1] : null;

  // CREATE: masukkan candidate.
  // UPDATE: existing dibuang lalu versi updated dimasukkan.
  // DELETE: candidates hanya berisi existing, sehingga tidak dimasukkan lagi.
  if (projected && (!existingId || (candidates || []).length > 1)) {
    entries.push(projected);
  }

  const model = buildPressAllocationModel_(entries, getPressAdjustments_());
  if (!model.overflow.length) return;

  const overflow = projected && projected.tab === 'press'
    ? model.overflow.find(function (item) { return String(item.id) === String(projected.id); }) || model.overflow[0]
    : model.overflow[0];

  throw new Error(
    'Qty Press melebihi Qty Filling yang tersedia untuk produk ' + overflow.produk +
    ' pada tanggal ' + overflow.tanggal + '. Kekurangan ' +
    number_(overflow.kurang) + ' botol. Balance dihitung berdasarkan Nama Produk dan FIFO tanggal Filling.'
  );
}

function pressAdjustmentSheet_(createIfMissing) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(APP.SHEETS.PRESS_ADJUSTMENTS);
  if (!sh && createIfMissing) {
    sh = ensureSheet_(ss, APP.SHEETS.PRESS_ADJUSTMENTS, APP.PRESS_ADJUSTMENT_HEADERS);
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
      id: String(values[i][0] || ''),
      tanggal: formatDateCell_(values[i][1]),
      produk: String(values[i][2] || ''),
      botol: String(values[i][3] || ''),
      qtyDitutup: number_(values[i][4]),
      alasan: String(values[i][5] || ''),
      closedBy: String(values[i][6] || ''),
      closedByName: String(values[i][7] || ''),
      createdAt: isoCell_(values[i][8])
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
    if (entry.tab === 'filling' && balanceKey_(entry.produk, entry.botol) === key) {
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
  return { filling: filling, press: press, closed: closed, remaining: remaining };
}

function historicalPressBalancePair_(produkInput, botolInput) {
  const produkRaw = String(produkInput || '').trim();
  const botolRaw = String(botolInput || '').trim();
  if (!produkRaw || !botolRaw) {
    throw new Error('Produk dan Botol untuk penutupan sisa Press wajib diisi.');
  }

  const key = balanceKey_(produkRaw, botolRaw);
  const entries = getEntries_();

  // Penutupan adalah tindakan atas saldo historis, jadi referensi yang sah
  // adalah data Filling yang memang pernah tersimpan — bukan Master saat ini.
  // Ini memungkinkan produk/botol lama tetap ditutup setelah dihapus dari Master,
  // tetapi mencegah request membuat penutupan untuk kombinasi fiktif.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.tab === 'filling' && balanceKey_(entry.produk, entry.botol) === key) {
      return {
        produk: String(entry.produk || '').trim(),
        botol: String(entry.botol || '').trim()
      };
    }
  }

  throw new Error('Data Filling historis untuk ' + produkRaw + ' / ' + botolRaw + ' tidak ditemukan.');
}

function closePressRemainder_(user, data) {
  if (!data) throw new Error('Data penutupan sisa Press kosong.');

  // JANGAN validasi ke Master di sini. Master hanya membatasi INPUT BARU.
  // Tutup Sisa harus tetap dapat memproses saldo historis yang produknya
  // sudah dihapus dari Master.
  const historicalPair = historicalPressBalancePair_(data.produk, data.botol);
  const produk = historicalPair.produk;
  const botol = historicalPair.botol;
  const alasan = String(data.alasan || '').trim();
  if (alasan.length < 5) throw new Error('Alasan Tutup Sisa wajib diisi minimal 5 karakter.');
  if (alasan.length > 500) throw new Error('Alasan Tutup Sisa maksimal 500 karakter.');

  const balance = pressBalanceForKey_(produk, botol);
  if (balance.remaining <= 0) {
    throw new Error('Sisa Press untuk ' + produk + ' / ' + botol + ' sudah tidak tersedia.');
  }

  const now = new Date();
  const adjustment = {
    id: Utilities.getUuid(),
    tanggal: Utilities.formatDate(now, Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd'),
    produk: produk,
    botol: botol,
    qtyDitutup: balance.remaining,
    alasan: alasan,
    closedBy: user.username,
    closedByName: user.name,
    createdAt: now.toISOString()
  };

  const sh = pressAdjustmentSheet_(true);
  sh.appendRow([
    adjustment.id, adjustment.tanggal, adjustment.produk, adjustment.botol,
    adjustment.qtyDitutup, adjustment.alasan, adjustment.closedBy,
    adjustment.closedByName, adjustment.createdAt
  ]);
  return adjustment;
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
  role = role === 'superuser' ? 'superuser' : 'user';

  if (!name || !username || !password) throw new Error('Nama, username, dan password wajib diisi.');
  if (findUser_(username)) throw new Error('Username sudah digunakan.');

  sheet_(APP.SHEETS.USERS).appendRow([username, hashPassword_(password), name, role, true, new Date()]);
  invalidateUsersCache_();
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


const USERS_CACHE_KEY_ = 'ppr_users_cache_v1';

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
      role: String(values[i][3] || 'user'),
      active: bool_(values[i][4])
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

function publicUser_(user) {
  return { username: user.username, name: user.name, role: user.role, active: user.active !== false };
}

function requireSuperuser_(user) {
  if (!user || user.role !== 'superuser') throw new Error('Aksi ini hanya dapat dilakukan Super User.');
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
