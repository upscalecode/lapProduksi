import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const backend = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');

function setup() {
  const c = vm.createContext({});
  vm.runInContext(backend, c);
  const values = new Map(), cache = new Map(), reads = [];
  let revision = 0;
  Object.assign(c, {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => values.get(k), setProperty: (k, v) => values.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k), put: (k, v) => cache.set(k, v) }) },
    hashPassword_: value => createHash('sha256').update(value).digest('hex'),
    Utilities: { formatDate: () => '2026-11-16', getUuid: () => String(++revision) },
    Session: { getScriptTimeZone: () => 'Asia/Jakarta' },
    getSettings_: () => ({}),
    getUsers_: () => [],
    getDowntimeEntries_: () => [],
    getApdEntries_: () => [],
  });
  const entries = [
    { id: 'old', tab: 'filling', tanggal: '2026-10-01', reportId: 'FILL - 01-01102026', totalQty: 80 },
    { id: 'new', tab: 'filling', tanggal: '2026-11-16', reportId: 'FILL - 01-16112026', totalQty: 20 },
    { id: 'press', tab: 'press', tanggal: '2026-11-16', reportId: 'PRESS - 01-16112026', totalQty: 10 },
  ].map(entry => ({ ...entry, operator: 'O', produk: 'P', botol: 'B', qtyKardus: entry.totalQty / 10, qtyBotolPerKardus: 10, createdBy: 'u', createdAt: '2026-11-16T00:00:00Z' }));
  const rows = [[], ...entries.map(c.entryToRow_)];
  c.entrySheet_ = () => ({
    getLastRow: () => rows.length,
    getRange: (r, col, n, width) => {
      reads.push({ r, col, n, width });
      return { getValues: () => rows.slice(r - 1, r - 1 + n).map(row => row.slice(col - 1, col - 1 + width)) };
    },
  });
  c.getSpkEntries_ = () => [
    { batchNo: '01-01102026', tanggal: '2026-10-01', qty: 100 },
    { batchNo: 'DONE', tanggal: '2026-10-01', qty: 80 },
    { batchNo: '01-16112026', tanggal: '2026-11-16', qty: 100 },
  ];
  c.getPressRemainders_ = overview => c.decoratePressRemainders_([
    { id: 'old', tanggalAsal: '2026-10-01', sisaQty: 80 },
  ], overview, []);
  c.getProductionSummary_ = () => c.buildProductionSummary_();
  const user = { username: 'admin', role: 'superuser', permissions: c.defaultPermissions_('superuser') };
  const request = (view, extra = {}) => c.scopedAppData_(user, { parameter: { view, start: '2026-11-16', end: '2026-11-16', ...extra } });
  return { c, values, cache, reads, entries, user, request };
}

test('Filling hanya mengirim hari pilihan, tetap menghitung Filling lama dan saldo lama', () => {
  const { c, request, reads } = setup();
  c.getApdEntries_ = () => { throw Error('APD tidak dibutuhkan oleh Filling'); };
  const data = request('filling');
  assert.deepEqual(Array.from(data.entries, e => e.id), ['new']);
  assert.equal(data.spkEntries.find(s => s.batchNo === '01-01102026').fillingUsedQty, 80);
  assert.equal(data.spkEntries.find(s => s.batchNo === '01-01102026').fillingCount, 1);
  assert.equal(data.remainders[0].batchNo, '01-01102026');
  assert.equal(data.remainders[0].qtyBotolPerKardus, 10);
  assert.equal(reads.some(r => r.r === 2 && r.n === 3 && r.width === 19), false);
});

test('snapshot dari ringkasan tidak membaca riwayat lengkap atau SPK sumber', () => {
  const { c, request, reads } = setup();
  const summary = c.buildProductionSummary_();
  reads.length = 0;
  c.getProductionSummary_ = () => summary;
  c.productionOverview_ = () => { throw Error('Riwayat lengkap tidak boleh dibaca'); };
  c.getSpkEntries_ = () => { throw Error('SPK sumber tidak boleh dibaca'); };
  c.getPressRemainders_ = () => { throw Error('Saldo sumber tidak boleh dibaca'); };
  const data = request('workspace');
  assert.equal(data.spkEntries.find(s => s.batchNo === '01-01102026').fillingUsedQty, 80);
  assert.deepEqual(Array.from(data.entries, e => e.id), ['new', 'press']);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].r, 3);
  assert.equal(reads[0].n, 2);
});

test('laporan historis diambil sesuai periode dan setting tidak membaca produksi', () => {
  const { request, reads, c } = setup();
  const data = request('laporan', { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(Array.from(data.reportEntries, e => e.id), ['old']);
  assert.equal(data.entries.length, 0);
  reads.length = 0;
  c.productionOverview_ = () => { throw Error('Setting tidak perlu riwayat'); };
  c.getApdEntries_ = () => { throw Error('Setting tidak perlu APD'); };
  request('master');
  assert.equal(reads.length, 0);
});

test('tanggal berselang-seling tetap dibaca sekali dan tanggal di luar periode tidak terkirim', () => {
  const { c } = setup();
  let calls = 0;
  const rows = Array.from({ length: 20 }, (_, index) => ({
    id: String(index), tanggal: index % 2 ? '2026-10-01' : '2026-11-16', row: index + 2,
  }));
  c.rowToEntry_ = row => row;
  c.entrySheet_ = () => ({ getRange: (start, col, count) => {
    calls++;
    return { getValues: () => rows.slice(start - 2, start - 2 + count) };
  } });
  const result = c.entriesInPeriod_(rows, '2026-11-16', '2026-11-16');
  assert.equal(calls, 1);
  assert.equal(result.length, 10);
  assert.ok(result.every(entry => entry.tanggal === '2026-11-16'));
});

test('SPK yang sudah dimigrasi tidak memindai atau menulis ulang format ketika dibaca', () => {
  const { c, values } = setup();
  const headers = vm.runInContext('APP.SPK_HEADERS', c);
  let writes = 0, repairs = 0;
  const sh = {
    getSheetId: () => 7, getLastColumn: () => headers.length, getMaxColumns: () => headers.length,
    getRange: () => ({ getDisplayValues: () => [headers], setValues: () => writes++ }),
    setFrozenRows: () => writes++,
  };
  const ss = { getId: () => 'ss', getSheetByName: () => sh };
  c.repairLegacySpkRows_ = () => repairs++;
  c.removeEmptyDuplicateSpkColumns_ = () => {};
  c.styleHeader_ = () => writes++;
  c.ensureSpkSheet_(ss);
  assert.equal(repairs, 1);
  assert.equal(values.get('PPR_SPK_SCHEMA_V2_ss_7'), '1');
  vm.runInContext('SPK_READY_SHEET_ = null', c);
  const initial = writes;
  c.ensureSpkSheet_(ss);
  assert.equal(writes, initial);
  assert.equal(repairs, 1);
  c.ensureSpkSheet_(ss, true);
  assert.equal(repairs, 2);
});

test('cache dibagi per pengguna dan hak akses, dibatalkan sesudah penulisan', () => {
  const { request, c, reads } = setup();
  request('filling');
  const initial = reads.length;
  request('filling');
  assert.equal(reads.length, initial);
  c.invalidateAppData_();
  request('filling');
  assert.ok(reads.length > initial);
  const restricted = { username: 'admin', role: 'user', permissions: { levels: { filling: 'none' } } };
  const data = c.scopedAppData_(restricted, { parameter: { view: 'filling', start: '2026-11-16', end: '2026-11-16' } });
  assert.equal(data.entries.length, 0);
  assert.equal(data.spkEntries.length, 0);
});

test('snapshot awal menyediakan seluruh tab sesuai hak akses tanpa menggandakan data laporan', () => {
  const { c, request } = setup();
  const data = request('workspace');
  assert.equal(data.workspace, true);
  assert.deepEqual(Array.from(data.entries, entry => entry.id), ['new', 'press']);
  assert.equal(data.reportEntriesSameAsEntries, true);
  assert.equal(data.reportEntries, undefined);
  assert.ok(data.spkEntries.length);
  assert.ok(data.remainders.length);
  const permissions = c.defaultPermissions_('user');
  permissions.levels = { filling: 'read' };
  const restricted = { username: 'limited', role: 'user', permissions };
  const limited = c.scopedAppData_(restricted, { parameter: { view: 'workspace', start: '2026-11-16', end: '2026-11-16' } });
  assert.deepEqual(Array.from(limited.entries, entry => entry.tab), ['filling']);
  assert.equal(limited.reportEntries.length, 0);
  assert.equal(limited.apdEntries.length, 0);
  assert.equal(limited.users.length, 0);
});

test('dekorasi saldo tidak menghitung ulang seluruh alokasi Press', () => {
  const { c } = setup();
  c.buildPressAllocationModel_ = () => { throw Error('Tidak perlu menghitung ulang'); };
  const result = c.decoratePressRemainders_([{ id: 'f', sisaQty: 25 }], [{ id: 'f', tab: 'filling', totalQty: 100, qtyBotolPerKardus: 10, reportId: 'FILL - 01-01102026' }], []);
  assert.equal(result[0].batchNo, '01-01102026');
  assert.equal(result[0].sisaQty, 25);
});

test('cache tidak menyimpan respons melebihi batas, penulisan gagal tetap membatalkan cache dan melepas lock', () => {
  const { c, cache, values } = setup();
  c.cachedAppRead_('large', () => ({ text: 'x'.repeat(100000) }));
  assert.equal(cache.size, 0);
  let released = 0, before, during;
  c.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) };
  vm.runInContext('INVALIDATE_APP_DATA_ = true', c);
  assert.throws(() => c.withWriteLock_(() => {
    before = values.get('PPR_DATA_REVISION');
    c.cachedAppRead_('during-write', () => ({ partial: true }));
    during = values.get('PPR_DATA_REVISION');
    throw Error('Simulasi gagal tulis');
  }), /Simulasi gagal tulis/);
  assert.ok(before);
  assert.notEqual(values.get('PPR_DATA_REVISION'), during);
  assert.equal(released, 1);
  assert.equal(c.cachedAppRead_('during-write', () => ({ partial: false })).partial, false);
});

test('APD periode memakai nomor baris asli dan menyaring tanggal di antara baris tidak berurutan', () => {
  const { c } = setup();
  const reads = [];
  const dates = ['2026-10-01', '2026-11-16', '2026-09-01', '2026-11-16'];
  const rows = [[], ...dates.map((date, index) => {
    const row = Array(17).fill('');
    row[0] = date; row[1] = `O${index}`; row[12] = `apd-${index}`;
    return row;
  })];
  c.spreadsheet_ = () => ({});
  c.ensureApdSheet_ = () => ({ getLastRow: () => rows.length, getRange: (r, col, n, width) => {
    reads.push({ r, n, width });
    return { getValues: () => rows.slice(r - 1, r - 1 + n).map(row => row.slice(col - 1, col - 1 + width)) };
  } });
  // Gunakan implementasi asli, bukan stub setup.
  vm.runInContext(backend.slice(backend.indexOf('function getApdEntries_('), backend.indexOf('function apdRowsToEntries_(')), c);
  const result = c.getApdEntries_('2026-11-16', '2026-11-16');
  assert.deepEqual(Array.from(result, e => e.rowNumber).sort(), [3, 5]);
  assert.equal(reads[1].r, 3);
  assert.equal(c.getApdEntries_('2020-01-01', '2020-01-31').length, 0);
  assert.equal(c.getApdEntries_().length, 4);
});

test('login tidak menjalankan cleanup, pemasangan trigger cleanup idempoten', () => {
  const { c } = setup();
  let cleanup = 0, installed = 0;
  c.maybePurgeExpiredSessions_ = () => { throw Error('Cleanup tidak boleh di login'); };
  c.findUser_ = () => null;
  assert.throws(() => c.handleLogin_({ parameter: { username: 'u', password: 'wrong' } }), /Username atau password salah/);
  c.cleanupExpiredSessions = () => cleanup++;
  c.ScriptApp = {
    getProjectTriggers: () => installed ? [{ getHandlerFunction: () => 'cleanupExpiredSessions' }] : [],
    newTrigger: handler => {
      assert.equal(handler, 'cleanupExpiredSessions');
      return { timeBased: () => ({ everyHours: n => { assert.equal(n, 1); return { create: () => installed++ }; } }) };
    },
  };
  c.setupPerformanceMaintenance();
  c.setupPerformanceMaintenance();
  assert.equal(installed, 1);
  assert.equal(cleanup, 2);
});

test('periode frontend mengambil pilihan historis tanpa memperluas sampai hari ini', () => {
  const controls = new Map();
  let subview = 'hasil';
  const c = vm.createContext({
    state: { spk: { date: '2026-10-01' } },
    todayStr: () => '2026-11-16', el: id => controls.get(id),
    qs: () => ({ dataset: { laporanView: subview } }),
    dashboardDateParts: s => s ? new Date(s + 'T00:00:00Z') : null,
    dashboardDateKey: d => d.toISOString().slice(0, 10),
    dashboardAddDays: (d, n) => new Date(d.getTime() + n * 86400000),
    kpiReportPeriodFromInputs: () => ({ start: new Date('2024-02-01'), end: new Date('2024-02-29') }),
    kpiPressMonthPeriod: () => ({ start: new Date('2026-11-01'), end: new Date('2026-11-30') }),
  });
  vm.runInContext(frontend.slice(frontend.indexOf('  function appDataParams('), frontend.indexOf('  function appDataStatus(')), c);
  let params = c.appDataParams('laporan');
  assert.equal(params.start, '2024-02-01');
  assert.equal(params.end, '2024-02-29');
  subview = 'kpi';
  params = c.appDataParams('laporan');
  assert.equal(params.start, '2026-11-01');
  assert.equal(params.end, '2026-11-30');
  assert.equal(c.appDataParams('spk').end, '2026-10-01');
});

test('jumlah Filling tetap akurat saat hanya data hari ini yang dimuat, termasuk edit dan hapus lokal', () => {
  const c = vm.createContext({
    state: { fillingHistory: { OLD: { qty: 80 } }, entries: [{ id: 'new', tab: 'filling', batchNo: 'OLD', totalQty: 20 }], preview: { filling: [] } },
    entryBatchNo: entry => entry.batchNo,
  });
  vm.runInContext(frontend.slice(frontend.indexOf('  function spkFillingUsedQty('), frontend.indexOf('  function spkRemainingQty(')), c);
  assert.equal(c.spkFillingUsedQty('OLD'), 100);
  assert.equal(c.spkFillingUsedQty('OLD', 'new'), 80);
  vm.runInContext("state.entries[0].totalQty = 15", c);
  assert.equal(c.spkFillingUsedQty('OLD'), 95);
  vm.runInContext('state.entries = []', c);
  assert.equal(c.spkFillingUsedQty('OLD'), 80);
});

test('respons frontend yang terlambat tidak menimpa halaman terbaru dan kegagalan menyediakan retry', async () => {
  const pending = [], applied = [], status = [];
  const c = vm.createContext({
    apiGet: (action, params) => new Promise((resolve, reject) => pending.push({ params, resolve, reject })),
    applyBootstrap: data => applied.push(data), canOpenReports: () => false,
    todayStr: () => '2026-11-16',
    document: {},
  });
  vm.runInContext(frontend.slice(frontend.indexOf('  let appDataRequestId ='), frontend.indexOf('  function initDataPeriodLoading(')), c);
  c.appDataParams = view => ({ view, start: '2026-11-16', end: '2026-11-16' });
  c.appDataStatus = (...args) => status.push(args);
  const first = c.loadAppData(false, 'filling');
  const second = c.loadAppData(false, 'press');
  pending[1].resolve({ ok: true, reportEntries: [], page: 'press' });
  await second;
  pending[0].resolve({ ok: true, reportEntries: [], page: 'filling' });
  await first;
  assert.deepEqual(applied.map(data => data.page), ['press']);
  const failed = c.loadAppData(false, 'apd');
  pending[2].reject(Error('offline'));
  await assert.rejects(failed, /offline/);
  assert.match(status.at(-1)[2], /Gagal memuat data: offline/);
});
