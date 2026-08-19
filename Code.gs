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
    PRESS_REMAINDER: 'Sisa Press'
  },
  ENTRY_HEADERS: [
    'id', 'reportId', 'tab', 'tanggal', 'operator', 'produk', 'botol',
    'qtyKardus', 'qtyBotolPerKardus', 'totalQty', 'botolPecahJenis',
    'qtyBotolPecah', 'createdBy', 'createdByName', 'createdAt', 'updatedAt',
    'tanggalAsalPress', 'keterangan'
  ],
  PRESS_REMAINDER_HEADERS: [
    'id', 'sourceFillingId', 'tanggalFilling', 'produk', 'botol',
    'qtyFilling', 'qtyTerpress', 'qtySisa', 'status', 'createdAt', 'updatedAt'
  ],
  USER_HEADERS: ['username', 'passwordHash', 'name', 'role', 'active', 'createdAt'],
  SESSION_HEADERS: ['token', 'username', 'expiresAt', 'createdAt']
};

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Buka Apps Script dari Spreadsheet yang akan digunakan, lalu jalankan lagi setupSpreadsheet().');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  const master = ensureSheet_(ss, APP.SHEETS.MASTER, ['Nama Operator', 'Nama Produk', 'Nama Botol']);
  const users = ensureSheet_(ss, APP.SHEETS.USERS, APP.USER_HEADERS);
  ensureSheet_(ss, APP.SHEETS.SESSIONS, APP.SESSION_HEADERS);
  ensureSheet_(ss, APP.SHEETS.ENTRIES, APP.ENTRY_HEADERS);
  ensureSheet_(ss, APP.SHEETS.PRESS_REMAINDER, APP.PRESS_REMAINDER_HEADERS);

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
      const pressRemainders = rebuildPressRemainders_();
      return json_({
        ok: true,
        entries: getEntries_(),
        pressRemainders: pressRemainders,
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
      case 'entry.create':
        return withWriteLock_(function () {
          const entry = createEntry_(session.user, parseJsonParam_(e, 'data'));
          const pressRemainders = rebuildPressRemainders_();
          const refreshed = findEntryRow_(entry.id);
          return json_({
            ok: true,
            entry: refreshed ? rowToEntry_(refreshed.values) : entry,
            pressRemainders: pressRemainders
          });
        });

      case 'entry.update':
        return withWriteLock_(function () {
          const entry = updateEntry_(session.user, param_(e, 'id'), parseJsonParam_(e, 'data'));
          const pressRemainders = rebuildPressRemainders_();
          const refreshed = findEntryRow_(entry.id);
          return json_({
            ok: true,
            entry: refreshed ? rowToEntry_(refreshed.values) : entry,
            pressRemainders: pressRemainders
          });
        });

      case 'entry.delete':
        requireSuperuser_(session.user);
        return withWriteLock_(function () {
          deleteEntry_(param_(e, 'id'));
          const pressRemainders = rebuildPressRemainders_();
          return json_({ ok: true, pressRemainders: pressRemainders });
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

  if (line === 'press') {
    validatePressAvailability_(data, qtyKardus * qtyBotol);
  }

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
    tanggalAsalPress: '',
    keterangan: ''
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
    tanggalAsalPress: existing.tanggalAsalPress || '',
    keterangan: existing.keterangan || ''
  };

  sheet_(APP.SHEETS.ENTRIES).getRange(found.row, 1, 1, APP.ENTRY_HEADERS.length).setValues([entryToRow_(updated)]);
  return updated;
}

function deleteEntry_(id) {
  const found = findEntryRow_(id);
  if (!found) throw new Error('Data tidak ditemukan.');
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
    e.qtyBotolPecah, e.createdBy, e.createdByName, e.createdAt, e.updatedAt,
    e.tanggalAsalPress || '', e.keterangan || ''
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
    tanggalAsalPress: String(row[16] || ''),
    keterangan: String(row[17] || '')
  };
}


function normalizeProductKey_(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePressAvailability_(data, requestedQty) {
  const qty = number_(requestedQty);
  if (qty <= 0) throw new Error('Qty Press harus lebih dari 0.');

  const productKey = normalizeProductKey_(data.produk);
  const pressDate = String(data.tanggal || '');
  if (!productKey || !pressDate) throw new Error('Produk dan tanggal Press wajib diisi.');

  const entries = getEntries_();
  let fillingQty = 0;
  let pressQty = 0;

  entries.forEach(function (entry) {
    if (normalizeProductKey_(entry.produk) !== productKey) return;
    if (!entry.tanggal || entry.tanggal > pressDate) return;
    if (entry.tab === 'filling') fillingQty += number_(entry.totalQty);
    if (entry.tab === 'press') pressQty += number_(entry.totalQty);
  });

  const available = Math.max(0, fillingQty - pressQty);
  if (qty > available) {
    throw new Error(
      'Qty Press untuk produk "' + String(data.produk) + '" melebihi Filling yang tersedia. ' +
      'Tersedia: ' + available + ' botol, diminta: ' + qty + ' botol.'
    );
  }
}

function rebuildPressRemainders_() {
  ensurePressFeatureSheets_();
  const entries = getEntries_();
  const ordered = entries.slice().sort(function (a, b) {
    const dateCompare = String(a.tanggal || '').localeCompare(String(b.tanggal || ''));
    if (dateCompare !== 0) return dateCompare;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });

  const sourcesByProduct = {};
  const pressNotes = {};

  ordered.forEach(function (entry) {
    const key = normalizeProductKey_(entry.produk);
    if (!key) return;
    if (!sourcesByProduct[key]) sourcesByProduct[key] = [];

    if (entry.tab === 'filling') {
      sourcesByProduct[key].push({
        id: entry.id,
        sourceFillingId: entry.id,
        tanggalFilling: entry.tanggal,
        produk: entry.produk,
        botol: entry.botol,
        qtyFilling: number_(entry.totalQty),
        qtySisa: number_(entry.totalQty),
        createdAt: entry.createdAt || '',
        updatedAt: new Date().toISOString()
      });
      return;
    }

    if (entry.tab !== 'press') return;

    let needed = number_(entry.totalQty);
    const usedDates = [];
    const queue = sourcesByProduct[key];

    for (let i = 0; i < queue.length && needed > 0; i++) {
      const source = queue[i];
      if (source.qtySisa <= 0) continue;
      if (source.tanggalFilling > entry.tanggal) continue;

      const take = Math.min(source.qtySisa, needed);
      if (take <= 0) continue;
      source.qtySisa -= take;
      needed -= take;
      if (usedDates.indexOf(source.tanggalFilling) < 0) usedDates.push(source.tanggalFilling);
    }

    const oldDates = usedDates.filter(function (d) { return d && d < entry.tanggal; });
    let note = '';
    if (oldDates.length) {
      note = 'Sisa tinggalan Press tanggal ' + oldDates.map(formatDateId_).join(', ');
    } else if (usedDates.length) {
      note = 'Press dari Filling tanggal ' + usedDates.map(formatDateId_).join(', ');
    }
    if (needed > 0) {
      note += (note ? ' | ' : '') + 'PERINGATAN: kekurangan referensi Filling ' + needed + ' botol';
    }

    pressNotes[entry.id] = {
      tanggalAsalPress: usedDates.join(', '),
      keterangan: note
    };
  });

  // Update kolom referensi/keterangan pada Sheet Pengerjaan.
  const entrySheet = sheet_(APP.SHEETS.ENTRIES);
  const raw = entrySheet.getDataRange().getValues();
  if (raw.length > 1) {
    const notes = [];
    for (let i = 1; i < raw.length; i++) {
      const id = String(raw[i][0] || '');
      const tab = String(raw[i][2] || '');
      const info = tab === 'press' ? (pressNotes[id] || { tanggalAsalPress: '', keterangan: '' }) : { tanggalAsalPress: '', keterangan: '' };
      notes.push([info.tanggalAsalPress, info.keterangan]);
    }
    entrySheet.getRange(2, 17, notes.length, 2).setValues(notes);
  }

  const remainders = [];
  Object.keys(sourcesByProduct).forEach(function (key) {
    sourcesByProduct[key].forEach(function (source) {
      const qtySisa = Math.max(0, number_(source.qtySisa));
      if (qtySisa <= 0) return;
      const qtyTerpress = Math.max(0, number_(source.qtyFilling) - qtySisa);
      remainders.push({
        id: 'SISA-' + source.sourceFillingId,
        sourceFillingId: source.sourceFillingId,
        tanggalFilling: source.tanggalFilling,
        produk: source.produk,
        botol: source.botol,
        qtyFilling: number_(source.qtyFilling),
        qtyTerpress: qtyTerpress,
        qtySisa: qtySisa,
        status: 'MENUNGGU PRESS',
        createdAt: source.createdAt,
        updatedAt: new Date().toISOString()
      });
    });
  });

  remainders.sort(function (a, b) {
    const dateCompare = String(a.tanggalFilling).localeCompare(String(b.tanggalFilling));
    if (dateCompare !== 0) return dateCompare;
    return String(a.produk).localeCompare(String(b.produk));
  });

  writePressRemainders_(remainders);
  return remainders;
}

function ensurePressFeatureSheets_() {
  const ss = spreadsheet_();
  ensureSheet_(ss, APP.SHEETS.ENTRIES, APP.ENTRY_HEADERS);
  ensureSheet_(ss, APP.SHEETS.PRESS_REMAINDER, APP.PRESS_REMAINDER_HEADERS);
}

function writePressRemainders_(rows) {
  const sh = sheet_(APP.SHEETS.PRESS_REMAINDER);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, APP.PRESS_REMAINDER_HEADERS.length).clearContent();
  if (!rows.length) return;

  const values = rows.map(function (r) {
    return [
      r.id, r.sourceFillingId, r.tanggalFilling, r.produk, r.botol,
      r.qtyFilling, r.qtyTerpress, r.qtySisa, r.status, r.createdAt, r.updatedAt
    ];
  });
  sh.getRange(2, 1, values.length, APP.PRESS_REMAINDER_HEADERS.length).setValues(values);
}

function formatDateId_(dateText) {
  const parts = String(dateText || '').split('-');
  if (parts.length === 3) return parts[2] + '-' + parts[1] + '-' + parts[0];
  return String(dateText || '');
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
