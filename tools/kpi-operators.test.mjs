import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const context = vm.createContext({
  state: { reportEntries: [] },
  dashboardDateInPeriod: (date, period) => date.startsWith(period),
});
for (const [start, end] of [
  ['kpiOperatorKey', 'kpiOperatorIdentityKey'],
  ['normalizeKpiType', 'kpiTypeLabel'],
  ['kpiOperatorsForPeriod', 'shiftKpiCountedUpdates'],
]) {
  vm.runInContext(source.slice(source.indexOf(`  function ${start}(`), source.indexOf(`  function ${end}(`)), context);
}
const entry = (operator, tab, extra = {}) => ({ operator, tab, tanggal: '2026-10-01', ...extra });
const operators = type => Array.from(context.kpiOperatorsForPeriod('2026-10', type));

test('operator Filling yang membantu Press hanya tampil di KPI Filling', () => {
  context.state.reportEntries = [
    entry('Budi Santoso', 'filling'), entry(' BUDI  SANTOSO ', 'press'),
    entry('Ani', 'press'), entry('Ani', 'press'),
  ];
  assert.deepEqual(operators('filling'), ['Budi Santoso']);
  assert.deepEqual(operators('press'), ['Ani']);
});

test('Filling di luar periode atau belum tersimpan tidak mengecualikan operator Press', () => {
  context.state.reportEntries = [
    entry('Ani', 'press'), entry('Ani', 'filling', { tanggal: '2026-09-01' }),
    entry('Budi', 'press'), entry('Budi', 'filling', { _syncState: 'pending' }),
    entry('', 'press'), null,
  ];
  assert.deepEqual(operators('press'), ['Ani', 'Budi']);
  assert.deepEqual(operators('filling'), []);
});

test('daftar gabungan Shift dan SPV tetap mencakup kedua bagian', () => {
  context.state.reportEntries = [entry('Ani', 'filling'), entry('Ani', 'press'), entry('Budi', 'press')];
  assert.deepEqual(operators('shift'), ['Ani', 'Budi']);
  assert.deepEqual(operators('spv'), ['Ani', 'Budi']);
});
