import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const render = source.slice(source.indexOf('  function renderDashboardAlerts('), source.indexOf('  function renderDashboardPriority('));

function alerts(spks, balances, broken = 0) {
  const wrap = { innerHTML: '' };
  const context = vm.createContext({
    state: { spkEntries: spks }, el: () => wrap,
    todayStr: () => '2026-10-09',
    spkRemainingQty: spk => Math.max(0, spk.qty - (spk.used || 0)),
    dashboardQty: String, dashboardShortDate: String,
    dashboardAgeDays: date => ({ '2026-10-09': 0, '2026-10-08': 1, '2026-10-07': 2, '2026-10-06': 3 })[date] ?? -1,
    dashboardSetText: () => {}, esc: String,
  });
  vm.runInContext(render, context);
  context.renderDashboardAlerts(balances, broken);
  return wrap.innerHTML;
}

test('Filling dan Press tertunda tampil sejak tanggal SPK, dengan sisa parsial', () => {
  const html = alerts([{ batchNo: 'A', tanggal: '2026-10-09', qty: 100, used: 40 }],
    [{ batchNo: 'A', tanggalAsal: '2026-10-09', remaining: 25 }]);
  assert.match(html, /Filling belum selesai.*sisa 60 pcs/);
  assert.match(html, /Press belum selesai.*sisa 25 pcs/);
});

test('SPK selesai dan SPK mendatang tidak memicu alert Filling', () => {
  const html = alerts([
    { batchNo: 'A', tanggal: '2026-10-09', qty: 100, used: 100 },
    { batchNo: 'B', tanggal: '2026-10-10', qty: 100 },
  ], []);
  assert.match(html, /Tidak ada alert produksi/);
});

test('alert merah baru muncul setelah lebih dari 2 hari sejak SPK untuk kedua proses', () => {
  for (const tanggal of ['2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06']) {
    const html = alerts([{ batchNo: 'A', tanggal, qty: 100, used: 40 }],
      [{ batchNo: 'A', tanggalAsal: '2026-10-09', remaining: 25 }]);
    assert.equal((html.match(/dashboard-alert critical/g) || []).length, tanggal === '2026-10-06' ? 2 : 0);
    assert.equal((html.match(/dashboard-alert warning/g) || []).length, tanggal === '2026-10-06' ? 0 : 2);
  }
});

test('tanggal Filling lama tidak membuat Press merah jika SPK belum lebih dari 2 hari', () => {
  const html = alerts([{ batchNo: 'A', tanggal: '2026-10-09', qty: 100, used: 100 }],
    [{ batchNo: 'A', tanggalAsal: '2026-10-06', remaining: 25 }]);
  assert.doesNotMatch(html, /dashboard-alert critical/);
  assert.match(html, /dashboard-alert warning/);
});

test('Press memakai tanggal SPK dan alert kerusakan tetap tampil saat banyak alert', () => {
  const html = alerts([{ batchNo: 'A', tanggal: '2026-10-09', qty: 100 }], [
    { batchNo: 'A', tanggalAsal: '2026-10-10', remaining: 20 },
    { batchNo: 'B', tanggalAsal: '2026-10-07', remaining: 10 },
    { batchNo: 'C', tanggalAsal: '2026-10-07', remaining: 10 },
  ], 3);
  assert.match(html, /Press belum selesai.*sisa 40 pcs/);
  assert.match(html, /Botol pecah Press hari ini: 3 pcs/);
});
