import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
function setup() {
  const c = vm.createContext({});
  vm.runInContext(source, c);
  const values = new Map();
  const removed = [];
  const props = { getProperty: k => values.get(k) ?? null, setProperty: (k,v) => values.set(k,v), deleteProperty: k => values.delete(k), getProperties: () => Object.fromEntries(values) };
  Object.assign(c, { PropertiesService: {getScriptProperties: () => props}, CacheService: {getScriptCache: () => ({remove:k=>removed.push(k)})} });
  return {c, values, removed};
}
test('five failed logins per normalized username, expiry and successful login', () => {
  const {c, values} = setup(); let matches = false, sessions = 0;
  Object.assign(c, {maybePurgeExpiredSessions_:()=>{}, hashPassword_:s=>s, findUser_:()=>matches?{username:'user',active:true,passwordHash:'correct'}:null, Utilities:{getUuid:()=> 'uuid'}, persistSession_:()=>sessions++, cacheSession_:()=>{}, publicUser_:u=>u, json_:x=>x});
  const request = password => ({parameter:{username:' USER ',password}});
  for(let i=0;i<5;i++) assert.throws(()=>c.handleLogin_(request('wrong')), /Username atau password salah/);
  matches=true;
  assert.throws(()=>c.handleLogin_(request('correct')), /Terlalu banyak/);
  values.set('PPR_LOGIN_ATTEMPT_user',JSON.stringify({count:5,expiresAt:Date.now()-1}));
  assert.equal(c.handleLogin_(request('correct')).ok,true);
  assert.equal(values.has('PPR_LOGIN_ATTEMPT_user'),false);
  assert.equal(sessions,1);
});
test('literal writes preserve data types and escape formula and leading quote', () => {
  const {c} = setup(); const date = new Date();
  const out=c.literalSheetValues_([['=1+1',"'text",'Produk',12,false,date]]);
  assert.equal(out[0][0],"'=1+1"); assert.equal(out[0][1],"''text");
  assert.equal(out[0][2],'Produk'); assert.equal(out[0][3],12);
  assert.equal(out[0][4],false); assert.equal(out[0][5],date);
});
test('logout removes duplicate legacy rows, persisted session and cache', () => {
  const {c,values,removed}=setup(); const rows=[['token'],['target'],['other'],['target']];
  values.set('PPR_SESSION_target','{}');
  c.sheet_=()=>({getDataRange:()=>({getValues:()=>rows}),deleteRow:r=>rows.splice(r-1,1)});
  c.deleteSession_('target');
  assert.deepEqual(rows,[['token'],['other']]);
  assert.equal(values.has('PPR_SESSION_target'),false);
  assert.deepEqual(removed,['ppr_session_target']);
});
test('cleanup removes expired/corrupt sessions and attempts, retaining active sessions', () => {
  const {c,values}=setup();
  values.set('PPR_SESSION_old',JSON.stringify({expiresAt:new Date(Date.now()-1000).toISOString()}));
  values.set('PPR_SESSION_live',JSON.stringify({expiresAt:new Date(Date.now()+60000).toISOString()}));
  values.set('PPR_SESSION_bad','bad');
  values.set('PPR_LOGIN_ATTEMPT_old',JSON.stringify({expiresAt:Date.now()-1}));
  values.set('SPREADSHEET_ID','keep');
  c.sheet_=()=>({getDataRange:()=>({getValues:()=>[['token']]})});
  c.maybePurgeExpiredSessions_();
  assert.equal(values.has('PPR_SESSION_old'),false); assert.equal(values.has('PPR_SESSION_bad'),false);
  assert.equal(values.has('PPR_LOGIN_ATTEMPT_old'),false);assert.equal(values.has('PPR_SESSION_live'),true);
  assert.equal(values.get('SPREADSHEET_ID'),'keep');
  c.sheet_=()=>{throw Error('Cleanup should be throttled');}; c.maybePurgeExpiredSessions_();
});
test('used SPK rejects quantity changes before writing, even unchanged total', () => {
  const {c}=setup(); let writes=0;
  const batch='01-01102026';
  Object.assign(c,{findSpkRow_:()=>({values:[batch,'2026-10-01','P','B',10,10,100,'user','','',0,'normal'],row:2,sheet:{getRange:()=>({setValues:()=>writes++})}}),requireManage_:()=>{},getMaster_:()=>({produk:['P'],botol:['B']}),getEntries_:()=>[{reportId:'PRESS - '+batch}]});
  for(const [produksiDus,qtyPerDus] of [[5,10],[20,5],[20,10]]) assert.throws(()=>c.updateSpk_({username:'user'},batch,{produk:'P',botol:'B',produksiDus,qtyPerDus}),/sudah digunakan/);
  assert.equal(writes,0);
});
test('backend rejects late arrival marked on time before accessing sheet', () => {
  const {c}=setup();
  Object.assign(c,{Utilities:{formatDate:()=> '09:00'},Session:{getScriptTimeZone:()=> 'Asia/Jakarta'},downtimeSheet_:()=>{throw Error('Should not write');}});
  assert.throws(()=>c.upsertDowntimeEntry_({}, {arrivalTimestamp:new Date().toISOString(),alasan:'Tepat Waktu'}),/Pilih alasan keterlambatan/);
});
test('frontend clears on-time reason after arrival becomes late', () => {
  const script=fs.readFileSync(new URL('../script.js',import.meta.url),'utf8');
  const body=script.match(/const syncDowntime = \(\) => \{([\s\S]*?)\r?\n    \};/)[1];
  const option={};
  const ctx={arrival:{value:'08:15'},productionStart:{},productionStartTime:'08:30',minutes:{},reason:{value:'',querySelector:()=>option},note:{},syncNote(){},minutesOfDay:v=>v?Number(v.slice(0,2))*60+Number(v.slice(3)):null};
  const run=()=>vm.runInNewContext('(function(){'+body+'})()',ctx);
  run(); assert.equal(ctx.reason.value,'Tepat Waktu');
  ctx.arrival.value='09:00';run();assert.equal(ctx.reason.value,'');assert.equal(ctx.minutes.value,'30');assert.equal(option.disabled,true);
});
