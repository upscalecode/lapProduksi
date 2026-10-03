import { pool } from './db.js';
import { dateText, iso, num } from './domain.js';

const q = (sql, params) => pool.query(sql, params);

export async function getMaster() {
  const { rows } = await q('SELECT category, value FROM master_values ORDER BY category, position, value');
  const result = { operator: [], produk: [], botol: [], botolpecah: [], apdCriteria: [] };
  for (const row of rows) (result[row.category] ||= []).push(row.value);
  if (!result.botolpecah.length) result.botolpecah = [...result.botol];
  return result;
}

export async function getSettings() {
  const { rows } = await q('SELECT key, value FROM settings');
  const out = { kpiFillingOutputTargetMonthly: 150000, kpiPressOutputTargetMonthly: 70000 };
  for (const row of rows) out[row.key] = typeof row.value === 'number' ? row.value : Number(row.value);
  return out;
}

export async function getEntries() {
  const { rows } = await q('SELECT * FROM entries ORDER BY tanggal, created_at, id');
  return rows.map(r => ({ id:r.id, reportId:r.report_id, tab:r.tab, tanggal:dateText(r.tanggal), operator:r.operator, produk:r.produk, botol:r.botol, qtyKardus:num(r.qty_kardus), qtyBotolPerKardus:num(r.qty_botol_per_kardus), totalQty:num(r.total_qty), botolPecahJenis:r.botol_pecah_jenis, qtyBotolPecah:num(r.qty_botol_pecah), qtyKardusBasah:num(r.qty_kardus_basah), createdBy:r.created_by || '', createdAt:iso(r.created_at), updatedAt:iso(r.updated_at), updateCount:r.update_count, sisaPressTanggalAsal:r.sisa_press_tanggal_asal, keterangan:r.keterangan }));
}

export async function getSpk() {
  const { rows } = await q('SELECT * FROM spk ORDER BY tanggal, created_at, batch_no');
  return rows.map(r => ({ batchNo:r.batch_no, tanggal:dateText(r.tanggal), produk:r.produk, botol:r.botol, produksiDus:num(r.produksi_dus), qtyPerDus:num(r.qty_per_dus), qty:num(r.qty), createdBy:r.created_by || '', createdAt:iso(r.created_at), updatedAt:iso(r.updated_at), updateCount:r.update_count, status:r.status }));
}

export async function getAdjustments() {
  const { rows } = await q('SELECT * FROM press_adjustments WHERE archived=false ORDER BY tanggal, created_at');
  return rows.map(r => ({ id:r.id, tanggal:dateText(r.tanggal), produk:r.produk, botol:r.botol, qtyDitutup:num(r.qty_ditutup), alasan:r.alasan, closedBy:r.closed_by, closedByName:r.closed_by_name, createdAt:iso(r.created_at), qtyBotolPerKardus:num(r.qty_botol_per_kardus), targetBatchNo:r.target_batch_no, targetTanggalAsal:r.target_tanggal_asal }));
}

export async function getApd() {
  const { rows } = await q(`SELECT a.*, COALESCE(array_agg(p.id) FILTER (WHERE p.id IS NOT NULL), '{}') photo_ids FROM apd_entries a LEFT JOIN apd_photos p ON p.apd_id=a.id GROUP BY a.id ORDER BY a.tanggal DESC, a.updated_at DESC NULLS LAST`);
  return rows.map(r => ({ id:r.id, tanggal:dateText(r.tanggal), operator:r.operator, scores:r.scores || {}, totalPoints:num(r.total_points), percentage:num(r.percentage), alasan:r.alasan, photoFileIds:r.photo_ids, photoFileId:JSON.stringify(r.photo_ids), createdBy:r.created_by || '', createdAt:iso(r.created_at), updatedAt:iso(r.updated_at) }));
}

export async function getDowntime() {
  const { rows } = await q('SELECT * FROM downtime_entries ORDER BY arrival_timestamp DESC');
  return rows.map(r => ({ productionStartTime:String(r.production_start_time).slice(0,5), timestamp:iso(r.arrival_timestamp), tanggal:dateText(r.tanggal), downTime:num(r.down_time), alasan:r.alasan, keterangan:r.keterangan }));
}

export async function getUsers() {
  const { rows } = await q('SELECT username,name,role,active,permissions FROM users ORDER BY username');
  return rows;
}
