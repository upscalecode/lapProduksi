import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

test('import SPK menyamakan typo dekat dengan Master tanpa menggabungkan nama berbeda', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8'), context);
  const match = (master, value) =>
    vm.runInContext(
      `approximateImportedMasterValue_(${JSON.stringify(master)}, ${JSON.stringify(value)})`,
      context,
    );
  assert.equal(match(['Chanel'], 'Channel'), 'Chanel');
  assert.equal(match(['Jolibliss Scandalove'], 'Jolibliss Scandalouse'), 'Jolibliss Scandalove');
  assert.equal(match(['Jolibliss Wild Berry'], 'Jolibliss Pink Berry'), '');
  assert.equal(match(['Botol 30 ml'], 'Botol 50 ml'), '');
});

test('update identitas SPK menyinkronkan Filling, Press dan penutupan hanya pada batch terkait', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8'), context);
  const batch = '01-01102026';
  const entry = (line, batchNo, broken = 'Lama') => {
    const row = Array(19).fill('');
    Object.assign(row, { 1: `${line === 'press' ? 'PRESS' : 'FILL'} - ${batchNo}`, 2: line, 5: 'Produk Lama', 6: 'Lama', 7: 10, 8: 10, 9: 100, 10: broken, 16: 2 });
    return row;
  };
  const sheet = rows => ({
    rows,
    getLastRow: () => rows.length + 1,
    getRange: (r, c, n, width) => ({
      getValues: () => rows.slice(r - 2, r - 2 + n).map(row => row.slice(c - 1, c - 1 + width)),
      setValues: values => values.forEach((row, i) => row.forEach((value, j) => { rows[r - 2 + i][c - 1 + j] = value; })),
    }),
  });
  const entries = sheet([entry('filling', batch), entry('press', batch, 'Jenis Khusus'), entry('filling', '02-01102026')]);
  const adjustment = () => { const row = Array(12).fill(''); row[2] = 'Produk Lama'; row[3] = 'Lama'; row[4] = 20; row[10] = batch; return row; };
  const active = sheet([adjustment()]), archive = sheet([adjustment()]);
  let rebuilt = 0;
  Object.assign(context, { entrySheet_: () => entries, pressAdjustmentSheet_: () => active, pressAdjustmentArchiveSheet_: () => archive, rebuildPressRemainders_: () => { rebuilt++; } });
  context.syncSpkWorkIdentity_(batch, 'Produk Baru', 'Baru', '2026-10-04T00:00:00Z');
  for (const row of entries.rows.slice(0, 2)) {
    assert.equal(row[5], 'Produk Baru');
    assert.equal(row[6], 'Baru');
    assert.equal(row[9], 100);
    assert.equal(row[16], 3);
  }
  assert.equal(entries.rows[0][10], 'Baru');
  assert.equal(entries.rows[1][10], 'Jenis Khusus');
  assert.equal(entries.rows[2][5], 'Produk Lama');
  for (const s of [active, archive]) assert.deepEqual(s.rows[0].slice(2, 5), ['Produk Baru', 'Baru', 20]);
  assert.equal(rebuilt, 1);
  context.syncSpkWorkIdentity_(batch, 'Produk Baru', 'Baru', '2026-10-04T01:00:00Z');
  assert.equal(entries.rows[0][16], 3);
});

test('penghapusan SPK ditolak jika dipakai di Filling, Press, atau keduanya', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8'), context);
  const batch = '01-01102026';
  let deleted = false;
  const found = {
    values: [batch, '', '', '', 1, 1, 1, 'admin'],
    row: 2,
    sheet: { deleteRow: () => { deleted = true; } },
  };
  Object.assign(context, {
    findSpkRow_: () => found,
    requireManage_: () => {},
    getEntries_: () => [],
  });

  for (const entries of [
    [{ reportId: `FILL - ${batch}` }],
    [{ reportId: `PRESS - ${batch}` }],
    [{ reportId: `FILL - ${batch}` }, { reportId: `PRESS - ${batch}` }],
  ]) {
    context.getEntries_ = () => entries;
    assert.throws(
      () => context.deleteSpk_({ username: 'admin' }, batch),
      /sudah digunakan pada data Filling\/Press sehingga tidak dapat dihapus/,
    );
    assert.equal(deleted, false);
  }

  context.getEntries_ = () => [{ reportId: 'FILL - 02-01102026' }];
  context.deleteSpk_({ username: 'admin' }, batch);
  assert.equal(deleted, true);
});

test('SPK yang sudah dipakai tetap dapat diperbarui, sedangkan penghapusannya ditolak', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8'), context);
  const batch = '01-01102026';
  const values = [batch, '2026-10-01', 'Lama', 'Lama', 10, 10, 100, 'admin', '', '', 0, 'normal'];
  let saved, synced, managed = 0;
  Object.assign(context, {
    findSpkRow_: () => ({ values, row: 2, sheet: { getRange: () => ({ setValues: rows => { saved = rows[0]; } }), deleteRow: () => { throw Error('Should not delete'); } } }),
    requireManage_: () => { managed++; },
    getMaster_: () => ({ produk: ['Baru'], botol: ['Botol Baru'] }),
    canonicalMasterValue_: (list, value) => value,
    formatDateCell_: value => value,
    isoCell_: value => value,
    getEntries_: () => [{ reportId: `FILL - ${batch}` }, { reportId: `PRESS - ${batch}` }],
    syncSpkWorkIdentity_: (...args) => { synced = args; },
  });
  const result = context.updateSpk_({ username: 'admin' }, batch, { produk: 'Baru', botol: 'Botol Baru', produksiDus: 10, qtyPerDus: 10 });
  assert.equal(result.produk, 'Baru');
  assert.equal(result.updateCount, 1);
  assert.equal(saved[0], 'Baru');
  assert.deepEqual(synced.slice(0, 3), [batch, 'Baru', 'Botol Baru']);
  assert.equal(managed, 1);
  assert.throws(() => context.deleteSpk_({ username: 'admin' }, batch), /tidak dapat dihapus/);
});
