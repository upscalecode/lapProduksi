import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();
export const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
export const iso = value => value ? new Date(value).toISOString() : '';
export const dateText = value => value ? new Date(value).toISOString().slice(0, 10) : '';
export const batchFromReport = reportId => {
  const match = /^(?:FILL|PRESS)\s*-\s*(\d{2}-\d{8})$/i.exec(String(reportId || '').trim());
  return match ? match[1] : '';
};

export function defaultPermissions(role) {
  const yes = role === 'superuser';
  const base = {
    accessDashboard: yes, accessFilling: true, accessSpk: true, accessPress: true,
    accessExportFillingCsv: yes, accessExportPressCsv: yes, accessApd: true,
    accessReports: yes, accessWorkReport: yes, accessSpkReport: yes,
    accessKpiReport: yes, accessKpiFillingReport: yes, accessKpiPressReport: yes,
    accessKpiSpvReport: yes, deleteUnpressed: yes, viewAllData: yes,
    editOwn: true, editOthers: yes, deleteOwn: yes, deleteOthers: yes,
    accessMaster: yes, accessKpiSettings: yes
  };
  base.levels = Object.fromEntries([
    'dashboard','spk','filling','press','apd','reports','workReport','spkReport',
    'kpiFilling','kpiPress','kpiSpv','master','kpiSettings'
  ].map(scope => [scope, yes ? 'admin' : ['spk','filling','press','apd'].includes(scope) ? 'write' : 'none']));
  base.management = Object.fromEntries(['spk','filling','press','apd'].map(scope => [scope, { own: true, others: yes }]));
  return base;
}

export function permissions(user) {
  if (user.role === 'superuser') return defaultPermissions('superuser');
  const defaults = defaultPermissions('user');
  const stored = user.permissions && typeof user.permissions === 'object' ? user.permissions : {};
  return { ...defaults, ...stored, levels: { ...defaults.levels, ...(stored.levels || {}) }, management: { ...defaults.management, ...(stored.management || {}) } };
}

export function publicUser(user) {
  return { username: user.username, name: user.name, role: user.role, active: user.active !== false, permissions: permissions(user) };
}

export function requireLevel(user, scope, minimum = 'read') {
  if (user.role === 'superuser') return;
  const rank = { none: 0, read: 1, write: 2, admin: 3 };
  const levels = permissions(user).levels || {};
  if ((rank[levels[scope]] || 0) < (rank[minimum] || 1)) throw new Error(`Anda tidak memiliki akses ${minimum} pada bagian ${scope}.`);
}

export function requireManage(user, scope, createdBy) {
  if (user.role === 'superuser') return;
  requireLevel(user, scope, 'write');
  const owner = createdBy === user.username ? 'own' : 'others';
  if (!permissions(user).management?.[scope]?.[owner]) throw new Error(`Anda tidak memiliki akses mengelola data ${owner === 'own' ? 'sendiri' : 'user lain'} pada bagian ${scope}.`);
}

const key = (produk, botol) => `${String(produk).trim().toLowerCase()}||${String(botol).trim().toLowerCase()}`;
const chronology = (a, b) => String(a.tanggal || a.tanggalAsal).localeCompare(String(b.tanggal || b.tanggalAsal)) || String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));

export function buildRemainders(entries, adjustments) {
  const lots = entries.filter(x => x.tab === 'filling' && num(x.totalQty) > 0).slice().sort(chronology).map(x => ({
    id: x.id, batchNo: batchFromReport(x.reportId), tanggalAsal: x.tanggal, produk: x.produk,
    botol: x.botol, qtyFilling: num(x.totalQty), qtyBotolPerKardus: num(x.qtyBotolPerKardus),
    qtyPressTerpakai: 0, qtyDitutup: 0, remaining: num(x.totalQty), createdAt: x.createdAt
  }));
  const events = [
    ...entries.filter(x => x.tab === 'press' && num(x.totalQty) > 0).map(x => ({ ...x, type: 'press', qty: num(x.totalQty), targetBatchNo: batchFromReport(x.reportId) })),
    ...adjustments.filter(x => num(x.qtyDitutup) > 0).map(x => ({ ...x, type: 'closed', qty: num(x.qtyDitutup) }))
  ].sort(chronology);
  for (const event of events) {
    let needed = event.qty;
    for (const lot of lots) {
      if (!needed) break;
      if (lot.remaining <= 0 || lot.tanggalAsal > event.tanggal || key(lot.produk, lot.botol) !== key(event.produk, event.botol)) continue;
      if (event.targetBatchNo && lot.batchNo !== event.targetBatchNo) continue;
      if (event.targetTanggalAsal && lot.tanggalAsal !== event.targetTanggalAsal) continue;
      const used = Math.min(needed, lot.remaining);
      lot.remaining -= used; needed -= used;
      if (event.type === 'press') lot.qtyPressTerpakai += used; else lot.qtyDitutup += used;
    }
  }
  return lots.filter(x => x.remaining > 0).map(x => ({
    id: x.id, batchNo: x.batchNo, tanggalAsal: x.tanggalAsal, produk: x.produk, botol: x.botol,
    qtyFilling: x.qtyFilling, qtyBotolPerKardus: x.qtyBotolPerKardus,
    qtyPressTerpakai: x.qtyPressTerpakai, qtyDitutup: x.qtyDitutup,
    sisaQty: x.remaining, status: 'MENUNGGU PRESS', updatedAt: new Date().toISOString()
  }));
}
