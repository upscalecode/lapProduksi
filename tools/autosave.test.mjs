import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
function setup(levels, online = true) {
  const calls = [], backups = [], buttons = {}, timers = [];
  const state = { currentUser: { username: 'operator', role: 'user', permissions: { levels } }, preview: {}, pages: {} };
  const c = vm.createContext({
    state, navigator: { onLine: online }, console,
    window: { setTimeout: fn => { timers.push(fn); return timers.length; } },
    persistPreview: () => backups.push('preview'), saveFormDraft: line => backups.push(line),
    el: id => buttons[id], qs: selector => buttons[selector],
    runWriteWithRetry: fn => fn(), entryBatchNo: () => 'batch',
    upsertEntry() {}, renderEntries() {}, toast() {},
    renderPreview: line => { buttons[`#view-${line} .f-save-btn`].disabled = !state.preview[line]?.length; },
    renderPressBalance: () => { buttons['#view-press .f-save-btn'].disabled = !!state.preview.filling?.length || !state.preview.press?.length; },
    apiPost: async (action, { data }) => {
      calls.push(data.map(row => row.line));
      await Promise.resolve();
      return { savedIds: data.map(row => row.clientRequestId), entries: [] };
    },
  });
  vm.runInContext('let writeQueue = Promise.resolve();', c);
  vm.runInContext(source.slice(source.indexOf('  function enqueueWrite('), source.indexOf('  function makeClientRequestId(')), c);
  vm.runInContext(source.slice(source.indexOf('  const DEFAULT_USER_PERMISSIONS ='), source.indexOf('  function canManage(')), c);
  vm.runInContext(source.slice(source.indexOf('  function hasUnsavedFillingPreview('), source.indexOf('  function pressQtyUnitMatchesLot(')), c);
  const start = source.indexOf('      saveBtn.addEventListener("click", async () => {');
  const block = source.slice(start, source.indexOf('\n    const exportButton', start));
  const handler = block.slice(0, block.lastIndexOf('\n    }'));
  for (const line of ['filling', 'press']) {
    state.preview[line] = Array.from({ length: 201 }, (_, i) => ({ id: `${line}-${i}`, tab: line }));
    const button = { disabled: line === 'press', addEventListener: (_, fn) => { button.click = () => { if (!button.disabled) fn(); }; } };
    buttons[`#view-${line} .f-save-btn`] = button;
    c.button = button;
    vm.runInContext(`{ const line = '${line}'; const saveBtn = button; ${handler} }`, c);
  }
  vm.runInContext(source.slice(source.indexOf('  let autosaveRunning ='), source.indexOf('  async function preloadAppViews(')), c);
  return { c, state, calls, backups, buttons, timers };
}

test('user biasa izin tulis: seluruh batch Filling selesai sebelum Press pada satu siklus autosave', async () => {
  const { c, state, calls } = setup({ filling: 'write', press: 'write' });
  await c.runAutosave();
  assert.deepEqual(calls.map(rows => [rows[0], rows.length]), [
    ['filling', 100], ['filling', 100], ['filling', 1],
    ['press', 100], ['press', 100], ['press', 1],
  ]);
  assert.equal(state.preview.filling.length, 0);
  assert.equal(state.preview.press.length, 0);
});

test('user baca saja tidak mengirim data, cadangan lokal tetap berjalan', async () => {
  const { c, calls, backups } = setup({ filling: 'read', press: 'read', spk: 'read', apd: 'read' });
  await c.runAutosave();
  assert.equal(calls.length, 0);
  assert.ok(backups.includes('filling') && backups.includes('press'));
});

test('offline tidak mengirim data dan tetap mencadangkan preview', async () => {
  const { c, calls, backups, state } = setup({ filling: 'write', press: 'write' }, false);
  await c.runAutosave();
  assert.equal(calls.length, 0);
  assert.equal(state.preview.filling.length, 201);
  assert.ok(backups.includes('preview'));
});

test('Filling gagal: preview dipertahankan dan Press tidak dikirim', async () => {
  const { c, calls, state } = setup({ filling: 'write', press: 'write' });
  c.apiPost = async () => { calls.push('failed'); throw Error('network'); };
  await c.runAutosave();
  assert.deepEqual(calls, ['failed']);
  assert.equal(state.preview.filling.length, 201);
  assert.equal(state.preview.press.length, 201);
});

test('20 baris belum autosave, baris ke-21 langsung menyimpan tanpa menunggu interval', async () => {
  const { c, state, calls, timers } = setup({ filling: 'write', press: 'write' });
  state.preview.filling.length = 20;
  state.preview.press = [];
  c.schedulePreviewAutosave();
  assert.equal(timers.length, 0);
  state.preview.filling.push({ id: 'row-21', tab: 'filling' });
  c.schedulePreviewAutosave();
  c.schedulePreviewAutosave();
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 21);
  assert.equal(state.preview.filling.length, 0);
});

test('preview gagal tidak menjadwalkan penyimpanan berulang tanpa perubahan jumlah', async () => {
  const { c, timers, calls } = setup({ filling: 'write', press: 'read' });
  c.apiPost = async () => { calls.push('failed'); throw Error('network'); };
  c.schedulePreviewAutosave();
  await timers.shift()();
  c.schedulePreviewAutosave();
  assert.equal(timers.length, 0);
  assert.equal(calls.length, 1);
});

test('ambang preview tidak melewati izin baca saja', () => {
  const { c, timers } = setup({ filling: 'read', press: 'read' });
  c.schedulePreviewAutosave();
  assert.equal(timers.length, 0);
});
