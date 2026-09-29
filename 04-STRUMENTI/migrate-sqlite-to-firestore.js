"use strict";
/*
 * One-time migration from the old VEDETTA SQLite multitenant DB to Firestore.
 * Run with:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/service-account.json VEDETTA_MT_DB=/path/vedetta-mt.db node tools/migrate-sqlite-to-firestore.js
 * Never commit the service-account JSON or the SQLite DB.
 */
const admin = require("firebase-admin");
const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.env.VEDETTA_MT_DB;
if (!dbPath) throw new Error("Imposta VEDETTA_MT_DB=/percorso/vedetta-mt.db");
admin.initializeApp();
const fsdb = admin.firestore();
const sql = new Database(path.resolve(dbPath), { readonly: true });
const batchLimit = 400;
const clean = (x) => x === undefined ? null : x;

async function writeChunks(items, fn) {
  for (let i = 0; i < items.length; i += batchLimit) {
    const b = fsdb.batch();
    for (const item of items.slice(i, i + batchLimit)) fn(b, item);
    await b.commit();
  }
}

(async () => {
  const tenants = sql.prepare("SELECT * FROM tenants ORDER BY id").all();
  const tenantMap = new Map();
  for (const t of tenants) {
    const tid = String(t.slug || t.id);
    tenantMap.set(t.id, tid);
    await fsdb.collection("tenants").doc(tid).set({ name:t.name, slug:t.slug, agentKey:t.agent_key, enrollKey:t.enroll_key, createdAt:t.created_at, active:!!t.active }, {merge:true});
    const kv = sql.prepare("SELECT k,v FROM kv WHERE tenant_id=?").all(t.id);
    const cfg = Object.fromEntries(kv.map(x=>[x.k,x.v]));
    await fsdb.collection("tenants").doc(tid).collection("config").doc("main").set({
      configVersion:Number(cfg.config_version||1), mode:cfg.mode||"enforce", pollMinutes:Number(cfg.poll_minutes||5), rulesMd:cfg.rules_md||"", platforms:JSON.parse(cfg.platforms||"[]"), updatedAt:new Date().toISOString()
    }, {merge:true});
  }
  const users = sql.prepare("SELECT * FROM users").all();
  await writeChunks(users, (b,u)=>{ const tid=tenantMap.get(u.tenant_id); if(!tid)return; b.set(fsdb.collection("tenants").doc(tid).collection("users").doc(String(u.id)), {email:u.email,name:u.name,pwHash:u.pw_hash,role:u.role,perms:JSON.parse(u.perms||"{}"),totpSecret:u.totp_secret||null,totpEnabled:!!u.totp_enabled,isSuper:!!u.is_super,active:!!u.active,createdAt:u.created_at,lastLogin:u.last_login||null}); });
  const agents = sql.prepare("SELECT * FROM agents").all();
  await writeChunks(agents,(b,a)=>{const tid=tenantMap.get(a.tenant_id);if(tid)b.set(fsdb.collection("tenants").doc(tid).collection("agents").doc(String(a.agent_id)),{tenantId:tid,label:a.label||"",firstSeen:a.first_seen||null,lastSeen:a.last_seen||null});});
  const endpoints = sql.prepare("SELECT * FROM endpoints").all();
  await writeChunks(endpoints,(b,e)=>{const tid=tenantMap.get(e.tenant_id);if(tid)b.set(fsdb.collection("tenants").doc(tid).collection("endpoints").doc(String(e.host_id)),{tenantId:tid,hostname:e.hostname||"",label:e.label||"",os:e.os||"",osRelease:e.os_release||"",agentVersion:e.agent_version||"",firstSeen:e.first_seen||null,lastSeen:e.last_seen||null,lastCpu:clean(e.last_cpu),lastMem:clean(e.last_mem),lastDisk:clean(e.last_disk),lastUptime:clean(e.last_uptime),lastProcs:clean(e.last_procs),lastNetUp:clean(e.last_net_up),lastNetDown:clean(e.last_net_down),lastIp:e.last_ip||"",lastJson:e.last_json||""},{merge:true});});
  const events = sql.prepare("SELECT * FROM events ORDER BY id").all();
  await writeChunks(events,(b,e)=>{const tid=tenantMap.get(e.tenant_id);if(tid)b.set(fsdb.collection("tenants").doc(tid).collection("events").doc(),{ts:e.ts,receivedAt:e.received_at,agentId:e.agent_id||"",agentLabel:e.agent_label||"",categoria:e.categoria||"",piattaforma:e.piattaforma||"",regola:e.regola||"",azione:e.azione||"",severita:e.severita||"",dettaglio:e.dettaglio||"",url:e.url||""});});
  const samples = sql.prepare("SELECT * FROM noc_samples ORDER BY id").all();
  await writeChunks(samples,(b,x)=>{const tid=tenantMap.get(x.tenant_id);if(tid)b.set(fsdb.collection("tenants").doc(tid).collection("nocSamples").doc(),{hostId:x.host_id,ts:x.ts,cpu:clean(x.cpu),mem:clean(x.mem),disk:clean(x.disk),netUp:clean(x.net_up),netDown:clean(x.net_down),uptime:clean(x.uptime),procs:clean(x.procs),load1:clean(x.load1)});});
  const devices = sql.prepare("SELECT * FROM devices").all();
  for (const d of devices) { const tid=tenantMap.get(d.tenant_id); if(!tid)continue; await fsdb.collection("tenants").doc(tid).collection("devices").doc(String(d.id)).set({name:d.name,host:d.host,type:d.type,check_method:d.check_method,port:d.port||null,intervalSec:d.interval_sec,warnMs:d.warn_ms,critMs:d.crit_ms,enabled:!!d.enabled,createdAt:d.created_at,lastTs:d.last_ts||null,lastUp:d.last_up==null?null:!!d.last_up,lastLatency:d.last_latency||null,lastError:d.last_error||null,upChecks:d.up_checks||0,totalChecks:d.total_checks||0},{merge:true}); const checks=sql.prepare("SELECT ts,up,latency,error FROM device_checks WHERE device_id=? ORDER BY id").all(d.id); await writeChunks(checks,(b,c)=>b.set(fsdb.collection("tenants").doc(tid).collection("devices").doc(String(d.id)).collection("checks").doc(),c)); }
  console.log("Migrazione completata. Tenant:",tenants.length,"Utenti:",users.length,"Eventi:",events.length,"Endpoint:",endpoints.length,"Campioni:",samples.length,"Dispositivi:",devices.length);
  sql.close();
})().catch(e=>{console.error(e);process.exitCode=1;});
