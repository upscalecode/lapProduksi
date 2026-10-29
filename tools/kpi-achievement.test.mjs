import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const context = vm.createContext({
  esc: String, kpiPressScoreText: String, kpiPressQtyText: String,
  kpiPressRowHtml: () => '',
});
vm.runInContext(
  source.slice(source.indexOf('  function kpiAchievementColorClass('), source.indexOf('  function kpiPressQtyText(')) +
  source.slice(source.indexOf('  function kpiPressEmployeeCardHtml('), source.indexOf('  function renderKpiLaporanCards(')),
  context,
);

test('capaian 100–110% kuning dan di atas 111% hijau saat expand maupun collapse', () => {
  for (const expanded of [false, true]) {
    for (const [totalAchievement, expected] of [
      [99, 'below'], [100, 'yellow'], [100.61, 'yellow'],
      [110, 'yellow'], [110.01, 'above'],
      [111, 'above'], [111.01, 'equal'], [120, 'equal'],
    ]) {
      const html = context.kpiPressEmployeeCardHtml({
        totalAchievement, operator: 'Operator', period: { label: 'Oktober' }, rows: [],
      }, 0, expanded);
      assert.ok(html.includes(`kpi-achievement-card kpi-score-${expected}`));
      assert.ok(html.includes(`aria-expanded="${expanded}"`));
    }
  }
});
