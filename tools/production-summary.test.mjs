import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const backend = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
function setup() {
  const c = vm.createContext({ console: { error() {} } });
  vm.runInContext(backend, c);
  const props = new Map(), cells = [['Data JSON v1']];
  let releases = 0, reads = 0;
  const sh = {
    getMaxRows: () => 1000, getLastRow: () => cells.length,
    getRange: (r, col, n) => ({
      getValues: () => cells.slice(r - 1, r - 1 + n),
      setValues: rows => rows.forEach((row, i) => cells[r - 1 + i] = row),
      clearContent: () => cells.splice(r - 1, n),
    }),
  };
  Object.assign(c, {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k), setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => releases++ }) },
    SpreadsheetApp: { flush() {} }, spreadsheet_: () => ({ getSheetByName: () => sh }), ensureSheet_: () => sh,
    productionOverview_: () => { reads++; return [
      { id: 'a', tanggal: '2026-11-01', row: 2, tab: 'filling', reportId: 'FILL - 01-01112026', totalQty: 40 },
      { id: 'b', tanggal: '2026-11-02', row: 3, tab: 'press', reportId: 'PRESS - 01-01112026', totalQty: 10 },
      { id: 'c', tanggal: '2026-11-01', row: 4, tab: 'filling', reportId: 'FILL - 01-01112026', totalQty: 20 },
    ]; },
    getSpkEntries_: () => [{ batchNo: '01-01112026', qty: 100 }],
    getPressRemainders_: () => [{ id: 'a', batchNo: '01-01112026', sisaQty: 30 }],
  });
  return { c, props, cells, reads: () => reads, releases: () => releases };
}

test('ringkasan permanen menyimpan total batch dan rentang tanggal berselang-seling, baca berikutnya tanpa riwayat', () => {
  const { c, props, reads, releases } = setup();
  const first = c.getProductionSummary_();
  assert.equal(first.batches['01-01112026'].qty, 60);
  assert.equal(first.batches['01-01112026'].count, 2);
  assert.equal(first.dates[0].row, 2);
  assert.equal(first.dates[0].endRow, 4);
  assert.equal(props.get('PPR_SUMMARY_DIRTY'), '0');
  const next = c.getProductionSummary_();
  assert.equal(next.remainders[0].sisaQty, 30);
  assert.equal(next.spkEntries[0].qty, 100);
  assert.equal(reads(), 1);
  assert.equal(releases(), 2);
});

test('dirty atau JSON rusak dibangun ulang; ringkasan menyusut tidak meninggalkan data lama', () => {
  const { c, props, cells, reads } = setup();
  c.getProductionSummary_();
  cells[1] = ['rusak'];
  c.getProductionSummary_();
  assert.equal(reads(), 2);
  props.set('PPR_SUMMARY_DIRTY', '1');
  c.productionOverview_ = () => [];
  c.getSpkEntries_ = () => [];
  c.getPressRemainders_ = () => [];
  const empty = c.getProductionSummary_();
  assert.equal(empty.dates.length, 0);
  assert.equal(cells.length, 2);
  assert.equal(c.getProductionSummary_().spkEntries.length, 0);
});

test('transaksi menandai dirty sebelum mutasi, refresh sesudahnya termasuk mutasi parsial yang gagal', () => {
  const { c, props, reads, releases } = setup();
  vm.runInContext('REFRESH_PRODUCTION_SUMMARY_ = true', c);
  assert.throws(() => c.withWriteLock_(() => {
    assert.equal(props.get('PPR_SUMMARY_DIRTY'), '1');
    throw Error('gagal sebagian');
  }), /gagal sebagian/);
  assert.equal(reads(), 1);
  assert.equal(props.get('PPR_SUMMARY_DIRTY'), '0');
  assert.equal(releases(), 1);
});

test('kegagalan refresh tidak mengubah sukses simpan, tetap dirty dan lock dilepas', () => {
  const { c, props, releases } = setup();
  vm.runInContext('REFRESH_PRODUCTION_SUMMARY_ = true', c);
  c.productionOverview_ = () => { throw Error('Sheets gagal'); };
  assert.equal(c.withWriteLock_(() => 'tersimpan'), 'tersimpan');
  assert.equal(props.get('PPR_SUMMARY_DIRTY'), '1');
  assert.throws(() => c.getProductionSummary_(), /Sheets gagal/);
  assert.equal(releases(), 2);
});

test('perubahan produksi dan penutupan/reset ditandai untuk refresh, APD dan login tidak', () => {
  const pattern = backend.match(/REFRESH_PRODUCTION_SUMMARY_ = (\/\^.*\/)[.]test\(action\)/)[1];
  const regex = vm.runInNewContext(pattern);
  for (const action of ['entry.create', 'entry.update', 'entry.delete', 'entry.batchCreate', 'spk.batchDelete', 'spk.update', 'filling.closeBatch', 'press.adjustment.closeBatch', 'maintenance.inputData.clear']) assert.equal(regex.test(action), true, action);
  for (const action of ['login', 'apd.update', 'user.add', 'downtime.upsert']) assert.equal(regex.test(action), false, action);
});
