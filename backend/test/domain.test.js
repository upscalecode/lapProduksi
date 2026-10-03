import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRemainders, defaultPermissions } from '../src/domain.js';

test('saldo press dialokasikan ke lot yang tepat', () => {
  const entries = [
    { id:'f1', reportId:'FILL - 01-01102026', tab:'filling', tanggal:'2026-10-01', produk:'A', botol:'30 ml', totalQty:100, qtyBotolPerKardus:10, createdAt:'2026-10-01T01:00:00Z' },
    { id:'p1', reportId:'PRESS - 01-01102026', tab:'press', tanggal:'2026-10-02', produk:'A', botol:'30 ml', totalQty:40, createdAt:'2026-10-02T01:00:00Z' }
  ];
  const result = buildRemainders(entries, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].qtyPressTerpakai, 40);
  assert.equal(result[0].sisaQty, 60);
});

test('ledger penutupan menghabiskan sisa tanpa menghapus filling', () => {
  const entries = [{ id:'f1', reportId:'FILL - 01-01102026', tab:'filling', tanggal:'2026-10-01', produk:'A', botol:'30 ml', totalQty:100, qtyBotolPerKardus:10, createdAt:'2026-10-01T01:00:00Z' }];
  const adjustments = [{ id:'a1', type:'closed', tanggal:'2026-10-02', produk:'A', botol:'30 ml', qtyDitutup:100, targetBatchNo:'01-01102026', targetTanggalAsal:'2026-10-01', createdAt:'2026-10-02T01:00:00Z' }];
  assert.deepEqual(buildRemainders(entries, adjustments), []);
});

test('izin user biasa tidak memperoleh akses admin', () => {
  const value = defaultPermissions('user');
  assert.equal(value.levels.filling, 'write');
  assert.equal(value.levels.master, 'none');
  assert.equal(value.management.filling.others, false);
});
