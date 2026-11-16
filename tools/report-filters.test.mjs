import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
function setup(line = 'all') {
  const header = { innerHTML: '' }, summary = {};
  const table = { dataset: { laporanFilterLine: line }, __excelFilterState: { filters: new Map(), sort: null }, querySelector: () => header };
  const tbody = { innerHTML: '', closest: () => table };
  const state = { pages: { laporan: 1 }, lastLaporan: { line, rows: [] } };
  const c = vm.createContext({
    state, CONFIG: { PAGE_SIZE: 20 }, LINE_LABEL: { filling: 'Filling', press: 'Press' },
    el: id => id === 'lap-tbody' ? tbody : summary,
    esc: String, entryBatchNo: e => e.reportId,
    laporanQtyPerCartonDisplay: e => String(e.qtyBotolPerKardus), laporanQtyUnit: () => 'Kardus',
    laporanBrokenFilling: e => e.fillingBroken || 0, laporanBrokenPress: e => e.pressBroken || 0,
    kpiReportDisplay: value => value == null ? '—' : `${value}%`, renderPagination() {},
  });
  for (const [start, end] of [
    ['applyExcelDataFilter', 'maybeOpenFillingDowntimeModal'],
    ['laporanMetricColumns', 'updateUniqueLaporanFilter'],
    ['renderLaporanRows', 'laporanQtyUnit'],
  ]) vm.runInContext(source.slice(source.indexOf(`  function ${start}(`), source.indexOf(`  function ${end}(`)), c);
  return { c, state, table, tbody, header, summary };
}
const entry = (index, extra = {}) => ({ reportId: `batch-${index}`, tab: 'press', tanggal: '2026-11-16', operator: 'A', produk: 'P', botol: 'B', qtyBotolPerKardus: 10, qtyKardus: index, totalQty: index * 10, _kpiResult: 80, _kpiWetCarton: 90, _kpiBroken: 95, _kpiApd: 100, ...extra });

test('filter Operator memakai seluruh sumber data sebelum pagination dan kembali ke halaman pertama', () => {
  const { c, state, table, tbody, summary } = setup();
  state.lastLaporan.rows = Array.from({ length: 60 }, (_, index) => entry(index, { operator: index >= 40 ? 'B' : 'A' }));
  state.pages.laporan = 3;
  c.renderLaporanRows();
  table.__excelFilterState.filters.set(3, new Set(['B']));
  table.__excelData.rerender();
  assert.equal(state.pages.laporan, 1);
  assert.match(summary.textContent, /dari 20 entri/);
  assert.match(tbody.innerHTML, /batch-40/);
  assert.doesNotMatch(tbody.innerHTML, /batch-0</);
});

test('kolom pecah dan KPI mengikuti header Semua, Filling, dan Press', () => {
  for (const line of ['all', 'filling', 'press']) {
    const { c, state, table, header, summary } = setup(line);
    const row = entry(1, { fillingBroken: 3, pressBroken: 7 });
    state.lastLaporan.rows = [row];
    c.renderLaporanRows();
    const columns = table.__excelData.columns;
    assert.equal(columns.length, (header.innerHTML.match(/<th>/g) || []).length);
    assert.equal(columns[9](row), line === 'press' ? 7 : 3);
    const metricStart = line === 'all' ? 11 : 10;
    assert.equal(columns[metricStart](row), '80%');
    assert.equal(columns[metricStart + 1](row), line === 'press' ? '95%' : '90%');
    table.__excelFilterState.filters.set(columns.length - 1, new Set(['100%']));
    table.__excelData.rerender();
    assert.match(summary.textContent, /dari 1 entri/);
    table.__excelFilterState.filters.set(columns.length - 1, new Set(['50%']));
    table.__excelData.rerender();
    assert.match(summary.textContent, /dari 0 entri/);
  }
});

test('mengganti susunan kolom menghapus filter dan urutan dari susunan sebelumnya', () => {
  const { c, state, table } = setup();
  state.lastLaporan.rows = [entry(1)];
  table.__excelFilterState.filters.set(14, new Set(['50%']));
  table.__excelFilterState.sort = { index: 14, direction: 'desc' };
  state.lastLaporan.line = 'press';
  c.renderLaporanRows();
  assert.equal(table.__excelFilterState.filters.size, 0);
  assert.equal(table.__excelFilterState.sort, null);
  assert.equal(table.__excelData.columns.length, 13);
});

test('tombol filter dipasang lagi setelah header tabel laporan digambar ulang', () => {
  let observe;
  let table;
  class Element {
    constructor() { this.dataset = {}; this.classList = { add() {}, toggle() {} }; }
    querySelectorAll() { return []; }
    closest() { return table; }
    setAttribute() {}
    addEventListener() {}
  }
  class Header extends Element {
    constructor(text) { super(); this.textContent = text; this.colSpan = 1; }
    querySelector(selector) { return selector === '.excel-filter-btn' ? this.button : null; }
    appendChild(button) { this.button = button; }
  }
  class HTMLTableElement extends Element {}
  table = new HTMLTableElement();
  table.tHead = { rows: [{ cells: [new Header('Operator')] }] };
  table.tBodies = [{ rows: [] }];
  table.__excelData = { rows: [], columns: [] };
  table.querySelectorAll = () => table.tHead.rows[0].cells.flatMap(h => h.button ? [h.button] : []);
  const document = {
    body: new Element(), dataset: {}, getElementById: () => null,
    querySelectorAll: selector => selector === 'table' ? [table] : [],
    createElement: () => new Element(), addEventListener() {},
  };
  document.body.dataset = {};
  const c = vm.createContext({ document, Element, HTMLTableElement, MutationObserver: class { constructor(callback) { observe = callback; } observe() {} } });
  vm.runInContext(source.slice(source.indexOf('  function initExcelTableFilters('), source.indexOf('  async function initAppPage(')), c);
  c.initExcelTableFilters();
  assert.ok(table.tHead.rows[0].cells[0].button);
  const newHeaders = [new Header('Produk'), new Header('KPI APD')];
  table.tHead.rows[0].cells = newHeaders;
  observe([{ addedNodes: newHeaders }]);
  assert.ok(newHeaders.every(header => header.button));
  assert.equal(newHeaders[1].button.dataset.columnIndex, '1');
});
