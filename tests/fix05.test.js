'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const admin = 'fix05-admin-key-long-enough';
const device = 'fix05-device-key-long-enough';
const processes = new Map();
function tmp(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smartlocker-fix05-'));
  processes.set(dir,[]);
  t.after(async()=>{
    for(const stop of processes.get(dir)||[]) await stop();
    processes.delete(dir);
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  });
  return dir;
}
function prepare(t){
  const work=tmp(t);
  for(const file of ['db.js','server.js','package.json']) fs.copyFileSync(path.join(root,file),path.join(work,file));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(work,'node_modules'),process.platform==='win32'?'junction':'dir');
  fs.mkdirSync(path.join(work,'public'));
  return work;
}
function dbCommand(work,mode,body){
  return spawnSync(process.execPath,['-e',body],{
    cwd:work,env:{...process.env,SMARTLOCKER_DB_MODE:mode,SMARTLOCKER_DATA_DIR:path.join(work,'data')},encoding:'utf8'
  });
}
function readJson(work){return JSON.parse(fs.readFileSync(path.join(work,'data','smartlocker.json'),'utf8'));}
function hasNativeSqlite(){
  // require() may succeed with a stale native binary; open a real temporary DB.
  try {
    const Database=require('better-sqlite3');
    const db=new Database(':memory:');
    db.prepare('SELECT 1 AS test').get();
    db.close();
    return true;
  } catch(_) { return false; }
}
async function freePort(){
  const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
async function server(t,work,mode='json'){
  const port=await freePort();
  const proc=spawn(process.execPath,['server.js'],{
    cwd:work,env:{...process.env,PORT:String(port),SMARTLOCKER_DB_MODE:mode,SMARTLOCKER_DATA_DIR:path.join(work,'data'),SMARTLOCKER_ADMIN_KEY:admin,SMARTLOCKER_DEVICE_KEY:device},stdio:['ignore','pipe','pipe']
  });
  let logs='';proc.stdout.on('data',v=>logs+=v);proc.stderr.on('data',v=>logs+=v);
  async function stop(){if(proc.exitCode===null&&proc.signalCode===null)await new Promise(r=>{proc.once('close',r);proc.kill();});}
  processes.get(work).push(stop);
  const url='http://127.0.0.1:'+port;
  for(let i=0;i<100;i++){
    if(proc.exitCode!==null)throw Error('Server exited: '+logs);
    try {let r=await fetch(url+'/api/system/info');if(r.ok)return {url,stop,logs:()=>logs};}catch(_){}
    await new Promise(r=>setTimeout(r,60));
  }
  throw Error('Server timeout: '+logs);
}
async function request(url,route,body,headers={}){
  const r=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json()};
}
const event=(id,e,item)=>({compartment_id:id,event:e,door_state:'CLOSED',item_state:item});
async function deposit(url){
  const booked=await request(url,'/api/lockers/book',{compartment_id:1,customer_phone:'0901234567'});
  assert.equal(booked.status,201);
  const otp=booked.data.otp_shipper;
  assert.equal((await request(url,'/api/locker/verify-otp',{otp},{'X-Device-Key':device})).data.status,'SUCCESS');
  assert.equal((await request(url,'/api/locker/update-status',event(1,'ITEM_STORED','DETECTED'),{'X-Device-Key':device})).status,200);
  return booked.data;
}
test('FIX05 JSON: order and locker persist together across restart',t=>{
  const work=prepare(t);
  let r=dbCommand(work,'json',`const d=require('./db');const o=d.createOrder({compartment_id:1,customer_phone:'0901234567',otp_shipper:'112233',otp_student:'445566'});d.transitionOrderAndLocker(o.id,{status:'STORED',stored_at:Date.now()},1,{status:'STORED',item_state:'DETECTED'});`);
  assert.equal(r.status,0,r.stderr);
  const state=readJson(work);
  assert.equal(state.orders[0].status,'STORED');
  assert.equal(state.lockers[0].status,'STORED');
  assert.equal(state.lockers[0].active_order_id,state.orders[0].id);
  r=dbCommand(work,'json',"const d=require('./db');if(d.getLockers()[0].status!=='STORED')process.exit(7)");
  assert.equal(r.status,0,r.stderr);
});
test('FIX05 JSON: failed disk replacement leaves order/locker unchanged',t=>{
  const work=prepare(t);
  const code = `const d=require('./db'),fs=require('node:fs');
    const prior=fs.renameSync;fs.renameSync=()=>{throw Error('injected disk write failure')};
    try { d.createOrder({compartment_id:1,customer_phone:'0901234567',otp_shipper:'112233',otp_student:'445566'}); process.exit(5); }
    catch(e) { if(!e.message.includes('injected')) process.exit(6); }
    finally { fs.renameSync=prior; }
    if(d.getLocker(1).status!=='AVAILABLE'||d.getOrderHistory().length!==0)process.exit(7);`;
  const r=dbCommand(work,'json',code);
  assert.equal(r.status,0,r.stderr);
  const state=readJson(work);
  assert.equal(state.orders.length,0);
  assert.equal(state.lockers[0].status,'AVAILABLE');
});
test('FIX05 JSON: corrupt storage is never silently reset',t=>{
  const work=prepare(t),data=path.join(work,'data');fs.mkdirSync(data);
  const json=path.join(data,'smartlocker.json');fs.writeFileSync(json,'{INVALID ORIGINAL DATA');
  const r=dbCommand(work,'json',"require('./db')");
  assert.notEqual(r.status,0);
  assert.equal(fs.readFileSync(json,'utf8'),'{INVALID ORIGINAL DATA');
});
test('FIX05 auto: two existing stores fail closed without migration',t=>{
  const work=prepare(t),data=path.join(work,'data');fs.mkdirSync(data);
  fs.writeFileSync(path.join(data,'smartlocker.db'),'not a real database');
  fs.writeFileSync(path.join(data,'smartlocker.json'),'{"original":true}');
  const r=dbCommand(work,'auto',"require('./db')");
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Both SQLite and JSON data stores exist/);
  assert.equal(fs.readFileSync(path.join(data,'smartlocker.json'),'utf8'),'{"original":true}');
});
test('FIX05 JSON: rejects inconsistent active order references without overwrite',t=>{
  const work=prepare(t);
  assert.equal(dbCommand(work,'json',"require('./db')").status,0);
  const state=readJson(work);state.lockers[0].status='STORED';
  const file=path.join(work,'data','smartlocker.json');fs.writeFileSync(file,JSON.stringify(state));
  const r=dbCommand(work,'json',"require('./db')");
  assert.notEqual(r.status,0);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).lockers[0].status,'STORED');
});
test('FIX05 native SQLite: transaction and persistence', { skip: !hasNativeSqlite() && 'better-sqlite3 native unavailable; JSON test is not SQLite' }, t=>{
  const work=prepare(t);
  let r=dbCommand(work,'sqlite',"const d=require('./db');const o=d.createOrder({compartment_id:1,customer_phone:'0901234567',otp_shipper:'112233',otp_student:'445566'});d.transitionOrderAndLocker(o.id,{status:'STORED',stored_at:Date.now()},1,{status:'STORED',item_state:'DETECTED'});");
  assert.equal(r.status,0,r.stderr);
  r=dbCommand(work,'sqlite',"const d=require('./db');if(d.getLockers()[0].status!=='STORED'||d.getLockers()[0].active_order.status!=='STORED')process.exit(7)");
  assert.equal(r.status,0,r.stderr);
});
test('FIX05 API: threshold, restart and no automatic release with goods',async t=>{
  const work=prepare(t);
  let s=await server(t,work);
  await deposit(s.url);
  assert.equal((await request(s.url,'/api/simulate/fast-forward',{compartment_id:1,minutes:45},{'X-Admin-Key':admin})).status,200);
  await new Promise(r=>setTimeout(r,5200));
  let l=(await request(s.url,'/api/lockers',undefined,{'X-Admin-Key':admin})).data.lockers[0];
  assert.equal(l.status,'STORED');assert.equal(l.sla.stage,'WARNING');assert.equal(l.active_order.warning_45m_sent,1);
  await s.stop();
  s=await server(t,work);
  l=(await request(s.url,'/api/lockers',undefined,{'X-Admin-Key':admin})).data.lockers[0];
  assert.equal(l.active_order.warning_45m_sent,1);
  assert.equal((await request(s.url,'/api/simulate/fast-forward',{compartment_id:1,minutes:80},{'X-Admin-Key':admin})).status,200);
  await new Promise(r=>setTimeout(r,5200));
  l=(await request(s.url,'/api/lockers',undefined,{'X-Admin-Key':admin})).data.lockers[0];
  assert.equal(l.status,'ABANDONED');assert.equal(l.active_order.status,'ABANDONED');
  assert.equal(l.item_state,'DETECTED');assert.equal(l.active_order_id,l.active_order.id);
  assert.equal((await request(s.url,'/api/lockers/reset',{}, {'X-Admin-Key':admin})).status,409);
  await s.stop();
  s=await server(t,work);
  l=(await request(s.url,'/api/lockers',undefined,{'X-Admin-Key':admin})).data.lockers[0];
  assert.equal(l.status,'ABANDONED');assert.equal(l.item_state,'DETECTED');
});
