import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const start = source.indexOf('      saveBtn.addEventListener("click", async () => {');
const handler = source.slice(start, source.indexOf('\n    const exportButton', start));

function setup(line, failAt = 0) {
  const rows = Array.from({ length: 601 }, (_, i) => ({ id: `id-${i}`, tab: line }));
  const state = { preview: { [line]: rows }, pages: {} };
  const calls = [], saved = [];
  let click;
  const c = vm.createContext({
    state, line, saveBtn: { addEventListener: (_, fn) => { click = fn; } },
    hasUnsavedFillingPreview: () => false, updateSaveButtonState() {},
    entryBatchNo: () => 'batch', enqueueWrite: fn => fn(),
    apiPost: async (action, { data }) => {
      calls.push(data);
      assert.equal(action, 'entry.batchCreate');
      assert.ok(data.length <= 100);
      if (calls.length === failAt) throw Error('connection lost');
      return { savedIds: data.map(row => row.clientRequestId), entries: data };
    },
    upsertEntry: row => saved.push(row), persistPreview() {}, renderPreview() {},
    renderEntries() {}, renderPressBalance() {}, toast() {},
  });
  vm.runInContext(handler.slice(0, handler.lastIndexOf('\n    }')), c);
  return { state, calls, saved, click };
}

for (const line of ['filling', 'press']) {
  test(`${line}: 601 preview rows save in sequential bounded requests`, async () => {
    const c = setup(line);
    await c.click();
    assert.deepEqual(c.calls.map(rows => rows.length), [100, 100, 100, 100, 100, 100, 1]);
    assert.equal(c.state.preview[line].length, 0);
    assert.equal(new Set(c.saved.map(row => row.clientRequestId)).size, 601);
  });

  test(`${line}: failed batch keeps unsaved IDs and retry skips confirmed rows`, async () => {
    const c = setup(line, 2);
    await c.click();
    assert.equal(c.calls.length, 2);
    assert.equal(c.state.preview[line].length, 501);
    assert.equal(c.state.preview[line][0].id, 'id-100');
    await c.click();
    assert.equal(c.calls[2][0].clientRequestId, 'id-100');
    assert.equal(c.state.preview[line].length, 0);
    assert.equal(c.saved.length, 601);
  });
}
