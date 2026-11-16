import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const batch = '01-16112026';
const user = { username: 'u', role: 'superuser', name: 'Operator' };
const payload = { produk: 'P', botol: 'B', produksiDus: 10, qtyPerDus: 10, alasan: 'Kebutuhan produksi harian' };

function setup() {
  const c = vm.createContext({});
  vm.runInContext(source, c);
  const headers = Array.from(vm.runInContext('APP.SPK_HEADERS', c));
  const rows = [headers, [batch, '2026-11-16', 'P', 'B', 10, 10, 100, 'u', '', '', 0, 'normal', 'Alasan lama', 0, '', '', '']];
  const writes = [];
  const sheet = {
    getSheetId: () => 7, getLastRow: () => rows.length,
    getLastColumn: () => Math.max(...rows.map(row => row.length)), getMaxColumns: () => 26,
    setFrozenRows() {},
    appendRow: row => { writes.push(row); rows.push(Array.from(row)); },
    getRange: (r, col, count, width) => ({
      getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[r - 1 + i]?.[col - 1 + j] ?? '')),
      getDisplayValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => String(rows[r - 1 + i]?.[col - 1 + j] ?? ''))),
      setValues: values => {
        assert.equal(values.length, count);
        values.forEach((row, i) => {
          assert.equal(row.length, width);
          rows[r - 1 + i] ??= [];
          row.forEach((value, j) => { rows[r - 1 + i][col - 1 + j] = value; });
        });
        writes.push({ r, col, count, width });
      },
    }),
    deleteColumns: (col, count) => rows.forEach(row => row.splice(col - 1, count)),
  };
  const properties = new Map([['PPR_SPK_SCHEMA_V2_ss_7', '1']]);
  const entries = [{ id: 'saved-filling-0001', tab: 'filling', reportId: 'FILL - ' + batch, tanggal: '2026-11-16', produk: 'P', botol: 'B', operator: 'O', qtyKardus: 4, qtyBotolPerKardus: 10, totalQty: 40, createdBy: 'u' }];
  Object.assign(c, {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) },
    spreadsheet_: () => ({ getId: () => 'ss', getSheetByName: () => sheet }), styleHeader_() {},
    getEntries_: () => entries,
    getMaster_: () => ({ produk: ['P'], botol: ['B'], operator: ['O'] }),
    Session: { getScriptTimeZone: () => 'Asia/Jakarta' },
    Utilities: { formatDate: (date, zone, format) => format === 'ddMMyyyy' ? '16112026' : '2026-11-16', getUuid: () => 'uuid' },
    requireManage_() {}, syncSpkWorkIdentity_() {},
  });
  return { c, rows, entries, writes, sheet, properties };
}

test('alasan SPK tersimpan pada input satuan, batch, edit, dan tidak hilang pada klien lama', () => {
  const { c, rows } = setup();
  const created = c.createSpk_(user, { ...payload });
  assert.equal(created.alasan, payload.alasan);
  assert.equal(rows.at(-1)[12], payload.alasan);
  const saved = c.createSpkEntriesBatch_(user, [{ ...payload, batchNo: '03-16112026', alasan: '=teks operator' }]);
  assert.equal(saved[0].alasan, '=teks operator');
  assert.equal(rows.at(-1)[12], "'=teks operator");
  assert.equal(rows.at(-1).length, 17);
  c.updateSpk_(user, batch, { ...payload, alasan: 'Perubahan kebutuhan' });
  assert.equal(rows[1][12], 'Perubahan kebutuhan');
  const oldPayload = { ...payload }; delete oldPayload.alasan;
  c.updateSpk_(user, batch, oldPayload);
  assert.equal(rows[1][12], 'Perubahan kebutuhan');
  assert.equal(c.getSpkEntries_().find(row => row.batchNo === batch).alasan, 'Perubahan kebutuhan');
  assert.throws(() => c.createSpk_(user, { ...payload, alasan: 'x'.repeat(501) }), /maksimal 500/);
});

test('penutupan mencatat sisa aktual, alasan, operator dan waktu tanpa menghapus SPK atau saldo Press', () => {
  const { c, rows, entries, writes } = setup();
  c.buildPressAllocationModel_ = () => { throw Error('Penutupan Filling tidak mengubah alokasi Press'); };
  const originalEntries = JSON.stringify(entries);
  const saved = c.closeFillingRemaindersBatch_(user, { batchNos: [batch], alasan: 'Bahan baku tidak tersedia' });
  assert.equal(saved[0].fillingClosedQty, 60);
  assert.equal(saved[0].fillingClosedBy, 'u');
  assert.ok(saved[0].fillingClosedAt);
  assert.equal(rows[1][14], 'Bahan baku tidak tersedia');
  assert.equal(rows[1][12], 'Alasan lama');
  assert.equal(rows[1][6], 100);
  assert.equal(rows.length, 2);
  assert.equal(JSON.stringify(entries), originalEntries);
  const writeCount = writes.length;
  c.closeFillingRemaindersBatch_(user, { batchNos: [batch, batch], alasan: 'Alasan ulang berbeda' });
  assert.equal(writes.length, writeCount);
  assert.equal(rows[1][14], 'Bahan baku tidak tersedia');
});

test('penutupan massal memvalidasi seluruh target sebelum menulis dan menolak alasan pendek', () => {
  const { c, rows, writes } = setup();
  assert.throws(() => c.closeFillingRemaindersBatch_(user, { batchNos: [batch, 'tidak-ada'], alasan: 'Batal produksi' }), /tidak ditemukan/);
  assert.equal(writes.length, 0);
  assert.equal(rows[1][16], '');
  for (const alasan of ['', 'abc', 'x'.repeat(501)])
    assert.throws(() => c.closeFillingRemaindersBatch_(user, { batchNos: [batch], alasan }), /5–500/);
  assert.throws(() => c.closeFillingRemaindersBatch_(user, { batchNos: [], alasan: 'Batal produksi' }), /1–100/);
});

test('penutupan massal menyimpan sisa setiap SPK dengan satu penulisan metadata', () => {
  const { c, rows, entries, writes } = setup();
  const other = '02-16112026';
  rows.push([other, ...rows[1].slice(1)]);
  entries.push({ ...entries[0], id: 'other-entry', reportId: 'FILL - ' + other, totalQty: 25 });
  const result = c.closeFillingRemaindersBatch_(user, { batchNos: [batch, other], alasan: 'Produksi dibatalkan' });
  assert.deepEqual(Array.from(result, row => row.fillingClosedQty), [60, 75]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].col, 14);
  assert.equal(writes[0].width, 4);
  assert.equal(rows[2][12], 'Alasan lama');
});

test('endpoint penutupan memakai sesi dan write lock yang sama dengan penutupan Press', () => {
  const { c } = setup();
  let acquired = 0, released = 0;
  c.requireSession_ = token => { assert.equal(token, 'token'); return { user }; };
  c.json_ = result => result;
  c.LockService = { getScriptLock: () => ({ tryLock: () => { acquired++; return true; }, releaseLock: () => released++ }) };
  const result = c.doPost({ parameter: { token: 'token', action: 'filling.closeBatch', data: JSON.stringify({ batchNos: [batch], alasan: 'Produksi dibatalkan' }) } });
  assert.equal(result.ok, true);
  assert.equal(result.spkEntries[0].fillingClosedQty, 60);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

test('izin penutupan Filling diperiksa backend', () => {
  const { c, writes } = setup();
  const permissions = c.defaultPermissions_('user');
  permissions.levels = { filling: 'read' };
  permissions.deleteUnpressed = false;
  const limited = { username: 'operator', role: 'user', permissions };
  assert.throws(() => c.closeFillingRemaindersBatch_(limited, { batchNos: [batch], alasan: 'Batal produksi' }), /tidak memiliki izin/);
  assert.equal(writes.length, 0);
  permissions.deleteUnpressed = true;
  assert.equal(c.closeFillingRemaindersBatch_(limited, { batchNos: [batch], alasan: 'Batal produksi' })[0].fillingClosedBy, 'operator');
});

test('SPK tertutup menolak Filling baru dan perubahan Qty, tetapi riwayat tetap dapat dikoreksi tanpa mengubah Qty', () => {
  const { c, rows } = setup();
  c.closeFillingRemaindersBatch_(user, { batchNos: [batch], alasan: 'Batal produksi' });
  const data = { line: 'filling', batchNo: batch, qtyKardus: 4, qtyBotolPerKardus: 10 };
  assert.throws(() => c.assertSpkFillingQty_({ ...data }), /sudah ditutup/);
  assert.doesNotThrow(() => c.assertSpkFillingQty_({ ...data }, 'saved-filling-0001'));
  assert.throws(() => c.assertSpkFillingQty_({ ...data, qtyKardus: 3 }, 'saved-filling-0001'), /sudah ditutup/);
  assert.throws(() => c.assertSpkFillingQty_({ ...data, qtyKardus: 5 }, 'saved-filling-0001'), /sudah ditutup/);
  assert.throws(() => c.deleteSpk_(user, batch), /sudah ditutup/);
  assert.throws(() => c.updateSpk_(user, batch, { ...payload, produksiDus: 20 }), /sudah ditutup|sudah digunakan/);
  c.updateSpk_(user, batch, { ...payload, alasan: 'Koreksi catatan SPK' });
  assert.ok(rows[1][16]);
  assert.equal(rows[1][12], 'Koreksi catatan SPK');
});

test('jalur batch Filling juga menolak penambahan untuk SPK yang ditutup', () => {
  const { c, entries } = setup();
  c.closeFillingRemaindersBatch_(user, { batchNos: [batch], alasan: 'Batal produksi' });
  const entryRows = [[], ...entries.map(c.entryToRow_)];
  c.entrySheet_ = () => ({ getDataRange: () => ({ getValues: () => entryRows }) });
  c.availableDeletedEntryAudits_ = () => [];
  const data = { line: 'filling', batchNo: batch, tanggal: '2026-11-16', operator: 'O', produk: 'P', botol: 'B', qtyKardus: 1, qtyBotolPerKardus: 10, clientRequestId: 'new-filling-0000001' };
  assert.throws(() => c.createEntriesBatch_(user, [data]), /sudah ditutup/);
});

test('migrasi menambah kolom di akhir dan mempertahankan data lama, kolom asing tidak ditimpa', () => {
  const { c, rows } = setup();
  rows[0] = rows[0].slice(0, 12);
  rows[1] = rows[1].slice(0, 12);
  const original = rows[1].slice();
  c.getSpkEntries_();
  assert.equal(rows[0].length, 17);
  assert.deepEqual(rows[1].slice(0, 12), original);
  const other = setup();
  other.rows[0][12] = 'Catatan khusus milik pengguna';
  assert.throws(() => other.c.getSpkEntries_(), /Kolom tambahan SPK tidak dikenali/);
  assert.equal(other.writes.length, 0);
});

test('perbaikan baris warisan mengisi lebar kolom yang benar', () => {
  const { c, rows } = setup();
  rows[1] = [batch, '2026-11-16', 'P', 'B', '', '', 'u', '2026-11-16T00:00:00Z', '', 0, '', 'normal'];
  c.repairLegacySpkRows_(c.spreadsheet_().getSheetByName());
  assert.equal(rows[1].length, 17);
  assert.equal(rows[1][7], 'u');
  assert.equal(rows[1][11], 'normal');
});

test('frontend menutup sisa tanpa menghapus data produksi atau saldo Press, preview harus disimpan dahulu', async () => {
  const state = { spkEntries: [{ batchNo: batch, produk: 'P', botol: 'B', qty: 100, qtyPerDus: 10 }], entries: [], preview: { filling: [] }, remainders: [{ id: 'saldo-press', sisaQty: 40 }] };
  const actions = [], selected = new Set([batch]);
  let dialog;
  const c = vm.createContext({
    state, selectedFillingSpkRows: selected,
    canDeleteFillingRemainder: () => true, spkFillingUsedQty: () => 40,
    entryBatchNo: e => e.batchNo,
    askClosePressReason: async (rows, line) => { dialog = { rows, line }; return 'Batal produksi'; },
    enqueueWrite: fn => fn(), apiPost: async (action, data) => {
      actions.push(action);
      return { spkEntries: [{ ...state.spkEntries[0], fillingClosedAt: '2026-11-16T00:00:00Z', fillingClosedQty: 60 }] };
    },
    renderFillingSpkQueue() {}, renderSpkToday() {}, renderSpkReport() {}, renderDashboard() {}, toast() {},
  });
  vm.runInContext(frontend.slice(frontend.indexOf('  function spkRemainingQty('), frontend.indexOf('  function nextSpkBatchNo(')), c);
  vm.runInContext(frontend.slice(frontend.indexOf('  async function closeFillingSpks('), frontend.indexOf('  function spkStatusBadge(')), c);
  const button = { disabled: false, textContent: 'Hapus' };
  state.preview.filling = [{ batchNo: batch, totalQty: 10 }];
  await c.closeFillingSpks([batch], button);
  assert.equal(actions.length, 0);
  state.preview.filling = [];
  await c.closeFillingSpks([batch], button);
  assert.equal(dialog.line, 'filling');
  assert.equal(dialog.rows[0].remaining, 60);
  assert.equal(actions[0], 'filling.closeBatch');
  assert.equal(state.spkEntries.length, 1);
  assert.equal(c.spkRemainingQty(state.spkEntries[0]), 0);
  assert.equal(state.remainders[0].sisaQty, 40);
  assert.equal(button.disabled, false);
});
