import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { pool, transaction } from './db.js';
import { batchFromReport, buildRemainders, dateText, defaultPermissions, num, permissions, publicUser, requireLevel, requireManage, uuid } from './domain.js';
import { getAdjustments, getApd, getDowntime, getEntries, getMaster, getSettings, getSpk, getUsers } from './repository.js';

const app = express();
const allowedOrigins = String(process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.urlencoded({ extended: false, limit: '12mb' }));
app.use(express.json({ limit: '12mb' }));

const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, ...(await fn(req, res)) }); }
  catch (error) { console.error(error); res.status(error.status || 400).json({ ok: false, message: error.message || 'Terjadi kesalahan.' }); }
};
const input = req => ({ ...req.query, ...req.body });
const jsonParam = (value, fallback = null) => typeof value === 'string' ? JSON.parse(value) : (value ?? fallback);
// Utilities.base64EncodeWebSafe() Apps Script mempertahankan padding "=".
const legacyHash = password => crypto.createHash('sha256').update(String(password), 'utf8').digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

async function sessionUser(req) {
  const token = String(input(req).token || '').trim();
  if (!token) throw new Error('Sesi login tidak ditemukan. Silakan login kembali.');
  const { rows } = await pool.query(`SELECT u.* FROM sessions s JOIN users u ON u.username=s.username WHERE s.token=$1 AND s.expires_at>now() AND u.active=true`, [token]);
  if (!rows[0]) throw new Error('Sesi sudah berakhir. Silakan login kembali.');
  return rows[0];
}

async function appData(user, includeBootstrap) {
  const [entries, adjustments, spkEntries, apdEntries, downtimeEntries, users, settings, master] = await Promise.all([
    getEntries(), getAdjustments(), getSpk(), getApd(), getDowntime(), user.role === 'superuser' ? getUsers() : [], getSettings(), includeBootstrap ? getMaster() : null
  ]);
  return { user:includeBootstrap ? publicUser(user) : undefined, master:master || undefined, entries, reportEntries:undefined, reportEntriesSameAsEntries:true, adjustments, remainders:buildRemainders(entries, adjustments), spkEntries, apdEntries, downtimeEntries, users:users.map(publicUser), settings };
}

async function canonical(category, value) {
  const text = String(value || '').trim();
  const { rows } = await pool.query('SELECT value FROM master_values WHERE category=$1 AND lower(value)=lower($2)', [category, text]);
  if (!rows[0]) throw new Error(`${category} "${text}" tidak tersedia di Master.`);
  return rows[0].value;
}

async function validateEntry(raw) {
  const data = { ...(raw || {}) };
  if (!['filling','press'].includes(data.line)) throw new Error('Line pengerjaan tidak valid.');
  data.operator = await canonical('operator', data.operator);
  data.produk = await canonical('produk', data.produk);
  data.botol = await canonical('botol', data.botol);
  const { rows } = await pool.query('SELECT * FROM spk WHERE batch_no=$1', [String(data.batchNo || '').trim()]);
  const spk = rows[0];
  if (!spk) throw new Error('No Batch SPK wajib tersedia untuk pengerjaan ini.');
  if (spk.produk.toLowerCase() !== data.produk.toLowerCase() || spk.botol.toLowerCase() !== data.botol.toLowerCase()) throw new Error(`Produk atau Botol tidak sesuai dengan No Batch SPK ${spk.batch_no}.`);
  const qtyKardus = num(data.qtyKardus), qtyPerDus = data.line === 'filling' ? num(spk.qty_per_dus) : num(data.qtyBotolPerKardus);
  const qtyPecah = num(data.qtyBotolPecah), qtyBasah = data.line === 'filling' ? num(data.qtyKardusBasah) : 0;
  if ([qtyKardus,qtyPerDus,qtyPecah,qtyBasah].some(x => x < 0)) throw new Error('Qty tidak boleh negatif.');
  return { ...data, qtyKardus, qtyBotolPerKardus:qtyPerDus, qtyBotolPecah:qtyPecah, qtyKardusBasah:qtyBasah, totalQty:qtyKardus * qtyPerDus, batchNo:spk.batch_no };
}

async function insertEntry(client, user, data) {
  const id = String(data.clientRequestId || data.id || uuid());
  const now = new Date().toISOString();
  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(String(data.tanggal || '')) ? data.tanggal : now.slice(0,10);
  const reportId = `${data.line === 'press' ? 'PRESS' : 'FILL'} - ${data.batchNo}`;
  await client.query(`INSERT INTO entries(id,report_id,tab,tanggal,operator,produk,botol,qty_kardus,qty_botol_per_kardus,total_qty,botol_pecah_jenis,qty_botol_pecah,qty_kardus_basah,created_by,created_at,updated_at,update_count,sisa_press_tanggal_asal,keterangan) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(id) DO NOTHING`, [id,reportId,data.line,tanggal,data.operator,data.produk,data.botol,data.qtyKardus,data.qtyBotolPerKardus,data.totalQty,data.botolPecahJenis || data.botol || '',data.qtyBotolPecah,data.qtyKardusBasah,user.username,now,data.updatedAt || null,num(data.updateCount),data.sisaPressTanggalAsal || '',data.keterangan || '']);
  return id;
}

app.all('/api', wrap(async req => {
  const p = input(req), action = String(p.action || '');
  if (action === 'ping') return { message:'PostgreSQL API aktif', serverTime:new Date().toISOString() };
  if (action === 'login') {
    const username = String(p.username || '').trim().toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(username)=$1 AND active=true', [username]);
    const user = rows[0];
    const valid = user && (user.password_scheme === 'bcrypt' ? await bcrypt.compare(String(p.password || ''), user.password_hash) : safeEqual(legacyHash(p.password), user.password_hash));
    if (!valid) throw new Error('Username atau password salah.');
    if (user.password_scheme !== 'bcrypt') await pool.query("UPDATE users SET password_hash=$1,password_scheme='bcrypt' WHERE username=$2", [await bcrypt.hash(String(p.password), 12), user.username]);
    const token = crypto.randomBytes(32).toString('base64url');
    const hours = Math.max(1, Number(process.env.SESSION_HOURS) || 12);
    await pool.query('INSERT INTO sessions(token,username,expires_at) VALUES($1,$2,now()+($3 * interval \'1 hour\'))', [token,user.username,hours]);
    return { token, user:publicUser(user) };
  }
  const user = await sessionUser(req);
  if (action === 'logout') { await pool.query('DELETE FROM sessions WHERE token=$1',[p.token]); return {}; }
  if (action === 'bootstrap') return { user:publicUser(user), master:await getMaster(), settings:await getSettings() };
  if (action === 'appdata') return appData(user, String(p.includeBootstrap) === '1');

  if (action === 'entry.create' || action === 'entry.batchCreate') {
    const list = action.endsWith('batchCreate') ? jsonParam(p.data, []) : [jsonParam(p.data, {})];
    const validated = [];
    for (const item of list) { requireLevel(user,item.line,'write'); validated.push(await validateEntry(item)); }
    const savedIds = await transaction(async client => { const ids=[]; for (const data of validated) ids.push(await insertEntry(client,user,data)); return ids; });
    const entries = await getEntries(), adjustments = await getAdjustments();
    const saved = entries.filter(x => savedIds.includes(x.id));
    return action.endsWith('batchCreate') ? { entries:saved, savedIds, duplicateIds:[], remainders:buildRemainders(entries,adjustments) } : { entry:saved[0], remainders:buildRemainders(entries,adjustments) };
  }
  if (action === 'entry.update') {
    const data = await validateEntry(jsonParam(p.data,{})); requireLevel(user,data.line,'write');
    const { rows } = await pool.query('SELECT * FROM entries WHERE id=$1',[p.id]); if (!rows[0]) throw new Error('Data tidak ditemukan.'); requireManage(user,rows[0].tab,rows[0].created_by);
    await pool.query(`UPDATE entries SET report_id=$2,tab=$3,tanggal=$4,operator=$5,produk=$6,botol=$7,qty_kardus=$8,qty_botol_per_kardus=$9,total_qty=$10,botol_pecah_jenis=$11,qty_botol_pecah=$12,qty_kardus_basah=$13,updated_at=now(),update_count=update_count+1 WHERE id=$1`,[p.id,`${data.line==='press'?'PRESS':'FILL'} - ${data.batchNo}`,data.line,data.tanggal || new Date().toISOString().slice(0,10),data.operator,data.produk,data.botol,data.qtyKardus,data.qtyBotolPerKardus,data.totalQty,data.botolPecahJenis || data.botol,data.qtyBotolPecah,data.qtyKardusBasah]);
    const entries=await getEntries(), adjustments=await getAdjustments(); return { entry:entries.find(x=>x.id===p.id), remainders:buildRemainders(entries,adjustments) };
  }
  if (action === 'entry.delete') {
    const { rows }=await pool.query('SELECT * FROM entries WHERE id=$1',[p.id]); if(!rows[0]) throw new Error('Data tidak ditemukan.'); requireManage(user,rows[0].tab,rows[0].created_by);
    await pool.query('DELETE FROM entries WHERE id=$1',[p.id]); const entries=await getEntries(); return { deletedIds:[p.id], remainders:buildRemainders(entries,await getAdjustments()) };
  }

  if (action === 'press.adjustment.close' || action === 'press.adjustment.closeBatch') {
    const canClose = user.role === 'superuser' || permissions(user).levels?.press === 'admin' || (permissions(user).levels?.press !== 'none' && permissions(user).deleteUnpressed === true);
    if (!canClose) throw new Error('Anda tidak memiliki izin "Hapus Sisa Press".');
    const payload=jsonParam(p.data,{}), reason=String(payload.alasan||'').trim();
    if(!reason) throw new Error('Alasan penutupan sisa wajib diisi.');
    const targets=action.endsWith('closeBatch')?(Array.isArray(payload.rows)?payload.rows:[]):[payload];
    if(!targets.length||targets.length>100) throw new Error('Jumlah sisa Press yang dipilih tidak valid.');
    const entries=await getEntries(), current=buildRemainders(entries,await getAdjustments()), staged=[];
    for(const target of targets){const found=current.find(row=>String(row.produk).toLowerCase()===String(target.produk).trim().toLowerCase()&&String(row.botol).toLowerCase()===String(target.botol).trim().toLowerCase()&&String(row.batchNo||'')===String(target.targetBatchNo||'')&&String(row.tanggalAsal||'')===String(target.targetTanggalAsal||''));if(!found)throw new Error('Data sisa Press tidak ditemukan atau sudah berubah. Muat ulang data.');staged.push({id:uuid(),tanggal:new Date().toISOString().slice(0,10),produk:found.produk,botol:found.botol,qtyDitutup:found.sisaQty,alasan:reason,closedBy:user.username,closedByName:user.name,createdAt:new Date().toISOString(),qtyBotolPerKardus:found.qtyBotolPerKardus,targetBatchNo:found.batchNo||'',targetTanggalAsal:found.tanggalAsal||''});}
    await transaction(async client=>{for(const a of staged)await client.query('INSERT INTO press_adjustments(id,tanggal,produk,botol,qty_ditutup,alasan,closed_by,closed_by_name,created_at,qty_botol_per_kardus,target_batch_no,target_tanggal_asal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[a.id,a.tanggal,a.produk,a.botol,a.qtyDitutup,a.alasan,a.closedBy,a.closedByName,a.createdAt,a.qtyBotolPerKardus,a.targetBatchNo,a.targetTanggalAsal]);});
    const remainders=buildRemainders(entries,await getAdjustments());
    return action.endsWith('closeBatch')?{adjustments:staged,remainders}:{adjustment:staged[0],remainders};
  }

  if (action === 'spk.create' || action === 'spk.batchCreate') {
    requireLevel(user,'spk','write'); const list=action.endsWith('batchCreate')?jsonParam(p.data,[]):[jsonParam(p.data,{})]; const saved=[];
    await transaction(async client => { for (const raw of list) { const produk=await canonical('produk',raw.produk), botol=await canonical('botol',raw.botol), dus=Math.floor(num(raw.produksiDus)), per=Math.floor(num(raw.qtyPerDus)); if(dus<=0||per<=0) throw new Error('Produksi dan Qty/Dus harus lebih dari 0.'); const today=new Date().toISOString().slice(0,10); let batch=String(raw.batchNo||''); if(!batch){const {rows}=await client.query("SELECT batch_no FROM spk WHERE tanggal=$1 ORDER BY batch_no DESC LIMIT 1",[today]); const next=(Number(rows[0]?.batch_no?.slice(0,2))||0)+1; batch=`${String(next).padStart(2,'0')}-${today.slice(8,10)}${today.slice(5,7)}${today.slice(0,4)}`;} await client.query('INSERT INTO spk(batch_no,tanggal,produk,botol,produksi_dus,qty_per_dus,qty,created_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[batch,today,produk,botol,dus,per,dus*per,user.username,raw.status||'normal']); saved.push(batch); }});
    const items=(await getSpk()).filter(x=>saved.includes(x.batchNo)); return action.endsWith('batchCreate')?{saved:items}:{spk:items[0]};
  }
  if (action === 'spk.update') { const data=jsonParam(p.data,{}), {rows}=await pool.query('SELECT * FROM spk WHERE batch_no=$1',[p.batchNo]); if(!rows[0])throw new Error('SPK tidak ditemukan.'); requireManage(user,'spk',rows[0].created_by); const used=await pool.query('SELECT 1 FROM entries WHERE report_id LIKE $1 LIMIT 1',[`% - ${p.batchNo}`]); if(used.rowCount)throw new Error('SPK sudah digunakan sehingga tidak dapat diubah.'); const produk=await canonical('produk',data.produk),botol=await canonical('botol',data.botol),dus=Math.floor(num(data.produksiDus)),per=Math.floor(num(data.qtyPerDus)); await pool.query('UPDATE spk SET produk=$2,botol=$3,produksi_dus=$4,qty_per_dus=$5,qty=$6,updated_at=now(),update_count=update_count+1 WHERE batch_no=$1',[p.batchNo,produk,botol,dus,per,dus*per]); return {spk:(await getSpk()).find(x=>x.batchNo===p.batchNo)}; }
  if (action === 'spk.delete' || action === 'spk.batchDelete') { const batches=action.endsWith('batchDelete')?jsonParam(p.batchNos,[]):[p.batchNo]; for(const batch of batches){const {rows}=await pool.query('SELECT * FROM spk WHERE batch_no=$1',[batch]);if(!rows[0])throw new Error(`SPK ${batch} tidak ditemukan.`);requireManage(user,'spk',rows[0].created_by);const used=await pool.query('SELECT 1 FROM entries WHERE report_id LIKE $1 LIMIT 1',[`% - ${batch}`]);if(used.rowCount)throw new Error(`SPK ${batch} sudah digunakan.`);} await pool.query('DELETE FROM spk WHERE batch_no=ANY($1)',[batches]); return action.endsWith('batchDelete')?{deletedBatchNos:batches}:{deletedBatchNo:p.batchNo}; }

  if (action === 'master.add' || action === 'master.remove') { requireLevel(user,'master','write'); const category=String(p.category), value=String(p.value||'').trim(); if(action.endsWith('add')) await pool.query('INSERT INTO master_values(category,value,position) VALUES($1,$2,(SELECT COALESCE(max(position),0)+1 FROM master_values WHERE category=$1)) ON CONFLICT DO NOTHING',[category,value]); else await pool.query('DELETE FROM master_values WHERE category=$1 AND lower(value)=lower($2)',[category,value]); return {master:await getMaster()}; }
  if (action === 'settings.kpiTargets.set') { requireLevel(user,'kpiSettings','write'); for(const [key,value] of [['kpiFillingOutputTargetMonthly',p.fillingValue],['kpiPressOutputTargetMonthly',p.pressValue]]){const n=Math.round(num(value));if(n<=0)throw new Error('Target KPI harus lebih dari 0.');await pool.query('INSERT INTO settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=now(),updated_by=$3',[key,JSON.stringify(n),user.username]);} return {settings:await getSettings()}; }
  if (action === 'downtime.upsert') { requireLevel(user,'filling','write'); const d=jsonParam(p.data,{}),arrival=new Date(d.arrivalTimestamp),start=String(d.productionStartTime||'');if(!/^\d{2}:\d{2}$/.test(start)||Number.isNaN(arrival.getTime()))throw new Error('Waktu Down Time tidak valid.');const [h,m]=start.split(':').map(Number),down=arrival.getHours()*60+arrival.getMinutes()-(h*60+m),tanggal=arrival.toISOString().slice(0,10);await pool.query(`INSERT INTO downtime_entries(tanggal,production_start_time,arrival_timestamp,down_time,alasan,keterangan,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tanggal) DO UPDATE SET production_start_time=$2,arrival_timestamp=$3,down_time=$4,alasan=$5,keterangan=$6,updated_by=$7,updated_at=now()`,[tanggal,start,arrival,down,d.alasan || (down<=0?'Tepat Waktu':''),d.keterangan||'',user.username]);const all=await getDowntime();return {entry:all.find(x=>x.tanggal===tanggal),downtimeEntries:all}; }

  if (action === 'apd.photo.upload') { requireLevel(user,'apd','write'); const match=/^data:([^;]+);base64,(.+)$/.exec(String(p.dataUrl||''));if(!match)throw new Error('Format foto tidak valid.');const data=Buffer.from(match[2],'base64'),limit=Number(process.env.APD_MAX_PHOTO_BYTES)||5242880;if(data.length>limit)throw new Error('Ukuran foto terlalu besar.');const id=uuid();await pool.query('INSERT INTO apd_photos(id,uploaded_by,mime_type,data) VALUES($1,$2,$3,$4)',[id,user.username,match[1],data]);return {photoFileId:id}; }
  if (action === 'apd.photo.preview') { const {rows}=await pool.query('SELECT * FROM apd_photos WHERE id=$1',[p.photoFileId]);if(!rows[0])throw new Error('Foto tidak ditemukan.');return {dataUrl:`data:${rows[0].mime_type};base64,${rows[0].data.toString('base64')}`}; }
  if (action === 'apd.photo.get') { const {rows}=await pool.query('SELECT mime_type,data FROM apd_photos WHERE apd_id=$1 ORDER BY created_at',[p.id]);return {dataUrls:rows.map(x=>`data:${x.mime_type};base64,${x.data.toString('base64')}`)}; }
  if (action === 'apd.photo.discard') { await pool.query('DELETE FROM apd_photos WHERE id=$1 AND apd_id IS NULL AND uploaded_by=$2',[p.photoFileId,user.username]);return {}; }
  if (action === 'apd.batchCreate') { requireLevel(user,'apd','write');const list=jsonParam(p.data,[]),saved=[];await transaction(async client=>{for(const d of list){const id=String(d.clientRequestId||d.id||uuid()),scores=d.scores||{},total=Object.values(scores).reduce((a,v)=>a+num(v),0),percentage=num(d.percentage);await client.query('INSERT INTO apd_entries(id,tanggal,operator,scores,total_points,percentage,alasan,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',[id,d.tanggal,d.operator,JSON.stringify(scores),num(d.totalPoints)||total,percentage,d.alasan||'',user.username]);const photos=d.photoFileIds||[];await client.query('UPDATE apd_photos SET apd_id=$1 WHERE id=ANY($2) AND uploaded_by=$3',[id,photos,user.username]);saved.push(id);}});return {savedCount:list.length,newCount:saved.length,duplicateIds:[],savedIds:saved,entries:(await getApd()).filter(x=>saved.includes(x.id))}; }
  if (action === 'apd.update') { requireLevel(user,'apd','write');const d=jsonParam(p.data,{}),{rows}=await pool.query('SELECT * FROM apd_entries WHERE id=$1',[p.id]);if(!rows[0])throw new Error('Data APD tidak ditemukan.');requireManage(user,'apd',rows[0].created_by);const scores=d.scores||{};await pool.query('UPDATE apd_entries SET tanggal=$2,operator=$3,scores=$4,total_points=$5,percentage=$6,alasan=$7,updated_at=now() WHERE id=$1',[p.id,d.tanggal,d.operator,JSON.stringify(scores),num(d.totalPoints),num(d.percentage),d.alasan||'']);await pool.query('UPDATE apd_photos SET apd_id=$1 WHERE id=ANY($2)',[p.id,d.photoFileIds||[]]);return {entry:(await getApd()).find(x=>x.id===p.id)}; }
  if (action === 'apd.delete') { const {rows}=await pool.query('SELECT * FROM apd_entries WHERE id=$1',[p.id]);if(!rows[0])throw new Error('Data APD tidak ditemukan.');requireManage(user,'apd',rows[0].created_by);await pool.query('DELETE FROM apd_entries WHERE id=$1',[p.id]);return {deletedId:p.id}; }

  if (action === 'user.add' || action === 'user.permissions.set' || action === 'user.password.reset' || action === 'user.remove') { if(user.role!=='superuser')throw new Error('Aksi ini hanya dapat dilakukan Super User.');const username=String(p.username||'').trim().toLowerCase();if(action==='user.add'){await pool.query("INSERT INTO users(username,password_hash,password_scheme,name,role,permissions) VALUES($1,$2,'bcrypt',$3,$4,$5)",[username,await bcrypt.hash(String(p.password),12),String(p.name||username),p.role==='superuser'?'superuser':'user',JSON.stringify(defaultPermissions(p.role))]);}else if(action==='user.permissions.set'){await pool.query('UPDATE users SET permissions=$2 WHERE username=$1',[username,JSON.stringify(jsonParam(p.permissions,{}))]);}else if(action==='user.password.reset'){await pool.query("UPDATE users SET password_hash=$2,password_scheme='bcrypt' WHERE username=$1",[username,await bcrypt.hash(String(p.password),12)]);}else{if(username===user.username)throw new Error('Akun yang sedang dipakai tidak dapat dihapus.');await pool.query('DELETE FROM users WHERE username=$1',[username]);}return action==='user.password.reset'?{}:{users:(await getUsers()).map(publicUser)}; }
  if (action === 'maintenance.inputData.clear') { if(user.role!=='superuser'||p.confirmation!=='HAPUS SEMUA DATA')throw new Error('Konfirmasi penghapusan data tidak valid.');for(const table of ['apd_photos','apd_entries','downtime_entries','press_adjustments','deleted_entry_audits','entries','spk'])await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);return {result:{clearedAt:new Date().toISOString()}}; }
  throw new Error(`Action tidak dikenali: ${action}`);
}));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`PostgreSQL API berjalan di http://localhost:${port}/api`));
