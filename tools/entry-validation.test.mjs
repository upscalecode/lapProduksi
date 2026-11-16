import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
function setup() {
  const c = vm.createContext({});
  vm.runInContext(source, c);
  Object.assign(c, {
    getMaster_: () => ({ operator: ['O'], produk: ['P'], botol: ['B'] }),
    getSpkEntries_: () => [{ batchNo: '01-16112026', produk: 'P', botol: 'B', qty: 100, qtyPerDus: 10 }],
    getEntries_: () => [],
  });
  return c;
}
const payload = {
  line: 'filling', operator: 'O', produk: 'P', botol: 'B',
  batchNo: '01-16112026', qtyKardus: 10, qtyBotolPerKardus: 10,
  tanggal: '2026-11-16', clientRequestId: 'request-1234567890',
};

test('retry Filling penuh mengembalikan data tersimpan tanpa menulis ulang', () => {
  const c = setup();
  const existing = { id: payload.clientRequestId, tab: 'filling', reportId: 'FILL - ' + payload.batchNo, totalQty: 100, createdBy: 'u' };
  c.getEntries_ = () => [existing];
  c.findEntryRow_ = () => ({ values: [] });
  c.rowToEntry_ = () => existing;
  c.entrySheet_ = () => { throw Error('Tidak boleh menulis ulang'); };
  assert.equal(c.createEntry_({ username: 'u' }, { ...payload }), existing);
  assert.throws(() => c.createEntry_({ username: 'other' }, { ...payload }), /user lain/);
  c.findEntryRow_ = () => null;
  assert.throws(() => c.createEntry_({ username: 'u' }, { ...payload }), /melebihi sisa kapasitas/);
});

test('tanggal tidak valid ditolak sebelum create, update, dan batch menulis data', () => {
  const c = setup();
  c.findEntryRow_ = () => null;
  c.entrySheet_ = () => ({ getDataRange: () => ({ getValues: () => [[]] }) });
  c.availableDeletedEntryAudits_ = () => [];
  const invalidDates = [undefined, '', '2026-99-99', '2026-02-29', '2026-04-31', '2026-2-01', '2026-11-16T00:00:00Z', 20261116];
  for (const tanggal of invalidDates) {
    const data = { ...payload, tanggal };
    assert.throws(() => c.createEntry_({ username: 'u' }, { ...data }), /Tanggal pengerjaan tidak valid/);
    assert.throws(() => c.updateEntry_({ username: 'u' }, 'existing', { ...data }), /Tanggal pengerjaan tidak valid/);
    assert.throws(() => c.createEntriesBatch_({ username: 'u' }, [{ ...payload }, data]), /Tanggal pengerjaan tidak valid/);
  }
  for (const tanggal of ['2026-11-16', '2024-02-29', '2026-02-28']) {
    assert.doesNotThrow(() => c.validateEntry_({ ...payload, tanggal }));
  }
  assert.throws(() => c.createEntry_({ username: 'u' }, null), /Data pengerjaan kosong/);
});
