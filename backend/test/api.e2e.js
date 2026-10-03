import 'dotenv/config';
import assert from 'node:assert/strict';

const base = process.env.E2E_API_URL || `http://localhost:${process.env.PORT || 3000}/api`;
const call = async (action, payload = {}, token = '') => {
  const body = new URLSearchParams({ action, ...payload });
  if (token) body.set('token', token);
  const response = await fetch(base, { method:'POST', body });
  const data = await response.json();
  assert.equal(data.ok, true, `${action}: ${data.message || response.status}`);
  return data;
};

const ping = await call('ping');
assert.match(ping.message, /PostgreSQL/);
const login = await call('login', { username:process.env.DEV_ADMIN_USERNAME, password:process.env.DEV_ADMIN_PASSWORD });
assert.ok(login.token);
const token = login.token;
for (const [category,value] of [['operator','Operator E2E'],['produk','Produk E2E'],['botol','Botol E2E']]) await call('master.add',{category,value},token);
const spk = await call('spk.batchCreate',{data:JSON.stringify([{produk:'Produk E2E',botol:'Botol E2E',produksiDus:10,qtyPerDus:12}])},token);
assert.equal(spk.saved[0].qty,120);
const batchNo=spk.saved[0].batchNo;
const entry = await call('entry.batchCreate',{data:JSON.stringify([{clientRequestId:'e2e-filling-1',line:'filling',tanggal:new Date().toISOString().slice(0,10),operator:'Operator E2E',produk:'Produk E2E',botol:'Botol E2E',batchNo,qtyKardus:5,qtyBotolPerKardus:12,qtyBotolPecah:0,qtyKardusBasah:0}])},token);
assert.equal(entry.entries[0].totalQty,60);
assert.equal(entry.remainders[0].sisaQty,60);
const data = await call('appdata',{includeBootstrap:'1'},token);
assert.ok(data.entries.some(item=>item.id==='e2e-filling-1'));
await call('maintenance.inputData.clear',{confirmation:'HAPUS SEMUA DATA'},token);
await call('logout',{},token);
console.log('E2E API PostgreSQL lulus: ping, login, master, SPK, entry, saldo, appdata, cleanup, logout.');
