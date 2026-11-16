import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const user = { username: 'u', role: 'superuser', permissions: {} };
function setup() {
  const calls = [], statuses = [];
  const state = { currentUser: user, entries: [], reportEntries: [], apdEntries: [], downtimeEntries: [], spkEntries: [], fillingHistory: {} };
  const c = vm.createContext({
    state, todayStr: () => '2026-11-16', canOpenReports: () => true,
    dashboardDateParts: date => new Date(date + 'T00:00:00'),
    dashboardDateKey: date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    dashboardAddDays: (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n),
    apiGet: async (action, params) => {
      calls.push(params);
      return { ok: true, scoped: true, workspace: true, user, master: {}, entries: [], reportEntries: [], spkEntries: [], apdEntries: [], downtimeEntries: [], remainders: [], users: [] };
    },
    applyBootstrap: data => Object.assign(state, {
      currentUser: data.user || state.currentUser, entries: data.entries, reportEntries: data.reportEntries,
      apdEntries: data.apdEntries, spkEntries: data.spkEntries, downtimeEntries: data.downtimeEntries,
    }),
  });
  vm.runInContext(source.slice(source.indexOf('  let appDataRequestId ='), source.indexOf('  function initDataPeriodLoading(')), c);
  c.appDataParams = view => ({ view, start: '2026-11-16', end: '2026-11-16' });
  c.appDataStatus = (...args) => statuses.push(args);
  return { c, state, calls, statuses };
}

test('seluruh tab memakai satu snapshot awal; kembali ke tab lama tidak memanggil API atau loading', async () => {
  const { c, calls, statuses } = setup();
  await c.loadAppData(true, 'dashboard');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].view, 'workspace');
  assert.equal(calls[0].start, '2026-11-01');
  assert.equal(calls[0].end, '2026-11-30');
  statuses.length = 0;
  for (const view of ['filling', 'press', 'apd', 'spk', 'laporan', 'master', 'dashboard', 'press']) await c.ensureAppData(view);
  assert.equal(calls.length, 1);
  assert.ok(statuses.every(([, loading]) => !loading));
});

test('klik tombol tab memakai data awal tanpa API baru, termasuk tombol kembali browser', async () => {
  const { c, calls } = setup();
  await c.loadAppData(true, 'dashboard');
  const handlers = {}, pushed = [];
  let onClick;
  const views = ['dashboard', 'spk', 'filling', 'press', 'apd', 'laporan', 'master'];
  const tabs = views.map(view => {
    const classes = new Set(view === 'dashboard' ? ['active'] : []);
    const tab = {
      dataset: { view }, hidden: false,
      classList: { contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
      matches: () => false,
    };
    tab.closest = () => tab;
    tab.click = () => onClick({ target: tab, preventDefault() {} });
    return tab;
  });
  const sections = views.map(view => ({ id: 'view-' + view, hidden: view !== 'dashboard' }));
  const tabbar = { addEventListener: (name, handler) => { onClick = handler; } };
  Object.assign(c, {
    el: id => id === 'mainTabbar' ? tabbar : null,
    qsa: selector => selector === '.tab-btn' ? tabs : sections,
    qs: selector => selector === '.tab-btn.active' ? tabs.find(tab => tab.classList.contains('active')) : tabs.find(tab => selector.includes(`"${tab.dataset.view}"`)),
    can: () => true, closePressFormPopup() {}, closeFillingFormPopup() {}, maybeOpenFillingDowntimeModal() {},
    window: { addEventListener: (name, handler) => { handlers[name] = handler; }, location: { hash: '#dashboard' } },
    history: { replaceState() {}, pushState: state => pushed.push(state) },
    toast: message => assert.fail(message),
  });
  vm.runInContext(source.slice(source.indexOf('  function initTabs('), source.indexOf('  function laporanMetricColumns(')), c);
  c.initTabs();
  for (const view of ['filling', 'press', 'apd', 'laporan', 'spk', 'master', 'dashboard']) {
    await tabs.find(tab => tab.dataset.view === view).click();
    assert.equal(sections.find(section => !section.hidden).id, 'view-' + view);
  }
  const historyLength = pushed.length;
  handlers.popstate({ state: { appTab: true, view: 'press' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sections.find(section => !section.hidden).id, 'view-press');
  assert.equal(pushed.length, historyLength);
  assert.equal(calls.length, 1);
});

test('klik tab ketika snapshot awal masih dimuat tidak membuat request kedua', async () => {
  const { c, calls } = setup();
  let resolve;
  c.apiGet = (action, params) => {
    calls.push(params);
    return new Promise(done => { resolve = done; });
  };
  c.startup = c.loadAppData(true, 'dashboard');
  vm.runInContext('initialAppDataPromise = startup.finally(() => { initialAppDataPromise = null; })', c);
  const tab = c.ensureAppData('filling');
  assert.equal(calls.length, 1);
  resolve({ workspace: true, scoped: true, user, master: {}, entries: [], reportEntries: [], spkEntries: [], apdEntries: [], downtimeEntries: [] });
  await tab;
  assert.equal(calls.length, 1);
});

test('riwayat baru diambil sekali tanpa menghapus data periode awal, lalu bisa dibuka lagi tanpa request', async () => {
  const { c, state, calls } = setup();
  await c.loadAppData(true, 'dashboard');
  state.entries = [{ id: 'today', tanggal: '2026-11-16', totalQty: 25 }];
  state.reportEntries = state.entries.slice();
  c.appDataParams = view => ({ view, start: '2024-01-01', end: '2024-01-31' });
  c.apiGet = async (action, params) => {
    calls.push(params);
    const rows = [{ id: 'old', tanggal: '2024-01-15', totalQty: 10 }];
    return { scoped: true, workspace: true, user, entries: rows, reportEntries: rows, apdEntries: [], downtimeEntries: [], spkEntries: [] };
  };
  await c.ensureAppData('laporan');
  assert.deepEqual(Array.from(state.entries, entry => entry.id), ['today', 'old']);
  await c.ensureAppData('laporan');
  c.appDataParams = view => ({ view, start: '2026-11-16', end: '2026-11-16' });
  await c.ensureAppData('filling');
  assert.equal(calls.length, 2);
});

test('penggabungan periode menghapus baris server yang sudah dihapus dan mempertahankan input pending', () => {
  const { c, state } = setup();
  state.entries = [
    { id: 'outside', tanggal: '2026-11-16' },
    { id: 'deleted', tanggal: '2024-01-15' },
    { id: 'updated', tanggal: '2024-01-15', totalQty: 5 },
    { id: 'pending', tanggal: '2024-01-15', _syncState: 'pending' },
  ];
  const data = c.mergeWorkspaceData({ workspace: true, entries: [{ id: 'updated', tanggal: '2024-01-15', totalQty: 10 }], reportEntries: [], apdEntries: [], downtimeEntries: [], spkEntries: [] }, { start: '2024-01-01', end: '2024-01-31' }, false);
  assert.deepEqual(Array.from(data.entries, entry => entry.id), ['outside', 'pending', 'updated']);
  assert.equal(data.entries.at(-1).totalQty, 10);
});

test('mengambil riwayat tidak mengubah sisa kapasitas SPK yang sudah diedit lokal', () => {
  const { c, state } = setup();
  state.entries = [{ id: 'new', tab: 'filling', batchNo: 'A', tanggal: '2026-11-16', totalQty: 25 }];
  state.spkEntries = [{ batchNo: 'A', tanggal: '2026-11-16', fillingUsedQty: 100 }];
  state.fillingHistory = { A: { qty: 80, count: 1 } };
  state.preview = { filling: [] };
  c.entryBatchNo = entry => entry.batchNo;
  c.el = () => null;
  c.window = {};
  for (const name of ['refreshAllDropdowns', 'loadPersistedPreview', 'restoreFormDraft', 'renderPreview', 'renderApdPreview', 'renderApdSavedToday', 'renderEntries', 'renderPressBalance', 'renderSpkToday', 'renderFillingSpkQueue', 'renderFillingDowntimeValidation', 'renderSpkReport', 'renderMasterChips', 'renderUsers', 'renderKpiPressSetting', 'renderKpiFillingSetting', 'renderUserHeader', 'applyAccessControl', 'maybeOpenFillingDowntimeModal', 'renderDashboard']) c[name] = () => {};
  vm.runInContext(source.slice(source.indexOf('  function applyBootstrap('), source.indexOf('  function refreshKpiAfterApdChange(')), c);
  vm.runInContext(source.slice(source.indexOf('  function spkFillingUsedQty('), source.indexOf('  function spkRemainingQty(')), c);
  const data = c.mergeWorkspaceData({
    workspace: true, scoped: true,
    entries: [{ id: 'old', tab: 'filling', batchNo: 'B', tanggal: '2024-01-15', totalQty: 40 }],
    reportEntries: [], apdEntries: [], downtimeEntries: [],
    spkEntries: [{ batchNo: 'B', tanggal: '2024-01-15', fillingUsedQty: 50, fillingCount: 2 }],
  }, { start: '2024-01-01', end: '2024-01-31' }, false);
  c.applyBootstrap(data);
  assert.equal(c.spkFillingUsedQty('A'), 105);
  assert.equal(c.spkFillingUsedQty('B'), 50);
});

test('perubahan hak akses membuang data lama dan cakupan periode lama', async () => {
  const { c, state } = setup();
  await c.loadAppData(true, 'dashboard');
  state.entries = [{ id: 'restricted', tanggal: '2026-11-16' }];
  c.apiGet = async () => ({
    workspace: true, scoped: true,
    user: { username: 'u', role: 'user', permissions: { levels: {} } },
    entries: [], reportEntries: [], spkEntries: [], apdEntries: [], downtimeEntries: [],
  });
  await c.loadAppData(false, 'dashboard');
  assert.equal(state.entries.length, 0);
  assert.equal(c.isAppDataLoaded({ start: '2026-11-01', end: '2026-11-30' }), false);
});

test('snapshot tidak digunakan setelah berganti hari dan error autentikasi tidak memicu fallback', async () => {
  const { c, calls } = setup();
  await c.loadAppData(true, 'dashboard');
  c.todayStr = () => '2026-11-17';
  await c.ensureAppData('filling');
  assert.equal(calls.length, 2);
  let failures = 0;
  c.apiGet = async () => { failures++; throw Object.assign(Error('Sesi sudah berakhir.'), { isApiError: true }); };
  await assert.rejects(c.loadAppData(false, 'filling'), /Sesi sudah berakhir/);
  assert.equal(failures, 1);
});

test('backend versi sebelumnya memakai snapshot lengkap agar perpindahan tab tetap tanpa request', async () => {
  const { c, calls } = setup();
  c.apiGet = async (action, params) => {
    calls.push(params);
    if (params.view) throw Object.assign(Error('Halaman tidak valid.'), { isApiError: true });
    return { user, master: {}, entries: [], reportEntries: [], spkEntries: [], apdEntries: [], downtimeEntries: [] };
  };
  await c.loadAppData(true, 'dashboard');
  await c.ensureAppData('press');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].view, undefined);
});
