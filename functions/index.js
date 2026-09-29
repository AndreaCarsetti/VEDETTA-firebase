"use strict";

const express = require("express");
const crypto = require("crypto");
const net = require("net");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-Key, X-Enroll-Key, X-Agent-Id, X-Agent-Label, X-Admin-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0, out = [];
  for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, "")) { value = (value << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0); buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac("sha1", secretBuf).update(buf).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return (bin % 1000000).toString().padStart(6, "0");
}
function verifyTotp(code, secretB32, window = 1) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6 || !secretB32) return false;
  const secret = base32Decode(secretB32), counter = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    const a = Buffer.from(hotp(secret, counter + i)), b = Buffer.from(c);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}
function safeEqual(a, b) { const ab = Buffer.from(String(a)), bb = Buffer.from(String(b)); return ab.length === bb.length && crypto.timingSafeEqual(ab, bb); }
function hashPassword(pw, salt) { salt = salt || crypto.randomBytes(16).toString("hex"); return salt + ":" + crypto.scryptSync(String(pw), salt, 32).toString("hex"); }
function verifyPassword(pw, stored) { if (!stored || !stored.includes(":")) return false; const [salt, h] = stored.split(":"); return safeEqual(crypto.scryptSync(String(pw), salt, 32).toString("hex"), h); }
const newKey = () => crypto.randomBytes(24).toString("hex");
const nowIso = () => new Date().toISOString();
const clean = (v, n) => String(v ?? "").slice(0, n);
const bool = v => !!v;

const PERMISSIONS = [
  { key: "view_events", label: "Visualizzare eventi" },
  { key: "manage_rules", label: "Gestire regole & policy" },
  { key: "manage_platforms", label: "Gestire piattaforme/DOM" },
  { key: "view_endpoints", label: "Visualizzare endpoint (NOC)" },
  { key: "manage_endpoints", label: "Gestire endpoint (etichette, rimozione)" },
  { key: "manage_users", label: "Gestire utenti & permessi" },
  { key: "manage_tenant", label: "Gestire l'organizzazione (chiavi)" }
];
const ALL_PERMS = PERMISSIONS.map(p => p.key);
const ROLES = {
  owner: { label: "Proprietario", perms: ALL_PERMS },
  admin: { label: "Amministratore", perms: ALL_PERMS.filter(p => p !== "manage_tenant") },
  analyst: { label: "Analista", perms: ["view_events", "manage_rules", "manage_platforms", "view_endpoints"] },
  viewer: { label: "Sola lettura", perms: ["view_events", "view_endpoints"] }
};
function effectivePerms(user) {
  const base = new Set((ROLES[user.role] || ROLES.viewer).perms);
  let over = user.perms || {};
  if (typeof over === "string") { try { over = JSON.parse(over); } catch { over = {}; } }
  for (const [k, v] of Object.entries(over || {})) v ? base.add(k) : base.delete(k);
  if (user.isSuper) ALL_PERMS.forEach(p => base.add(p));
  return [...base];
}

const DEFAULT_RULES = "## Regola: Upload file (monitoraggio)\n- id: R01\n- tipo: file_upload\n- azione: log\n- severita: bassa\n";
const DEFAULT_PLATFORMS = [
  { domain: "claude.ai", enabled: true, selectors: { prompt: "div[contenteditable='true']" } },
  { domain: "chatgpt.com", enabled: true, selectors: { prompt: "#prompt-textarea, div[contenteditable='true']" } },
  { domain: "gemini.google.com", enabled: true, selectors: { prompt: "div[contenteditable='true']" } }
];

function tenantRef(id) { return db.collection("tenants").doc(String(id)); }
function usersRef(tid) { return tenantRef(tid).collection("users"); }
function eventsRef(tid) { return tenantRef(tid).collection("events"); }
function agentsRef(tid) { return tenantRef(tid).collection("agents"); }
function endpointsRef(tid) { return tenantRef(tid).collection("endpoints"); }
function samplesRef(tid) { return tenantRef(tid).collection("nocSamples"); }
function devicesRef(tid) { return tenantRef(tid).collection("devices"); }
function configRef(tid) { return tenantRef(tid).collection("config").doc("main"); }

let bootstrapPromise = null;
async function ensureBootstrap() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const existing = await db.collection("tenants").limit(1).get();
    if (!existing.empty) return;
    const email = String(process.env.VEDETTA_OWNER_EMAIL || "").toLowerCase().trim();
    const password = String(process.env.VEDETTA_OWNER_PASSWORD || "");
    if (!email || !email.includes("@") || password.length < 12) {
      console.warn("VEDETTA bootstrap non eseguito: imposta VEDETTA_OWNER_EMAIL e VEDETTA_OWNER_PASSWORD (>=12 caratteri) nel functions/.env.");
      return;
    }
    const tenant = db.collection("tenants").doc();
    const now = nowIso();
    await tenant.set({ name: "Organizzazione principale", slug: "main", agentKey: newKey(), enrollKey: newKey(), createdAt: now, active: true });
    await configRef(tenant.id).set({ configVersion: 1, mode: "enforce", pollMinutes: 5, rulesMd: DEFAULT_RULES, platforms: DEFAULT_PLATFORMS, updatedAt: now });
    await usersRef(tenant.id).doc().set({ email, name: "Amministratore", pwHash: hashPassword(password), role: "owner", perms: {}, active: true, isSuper: true, totpEnabled: false, createdAt: now, lastLogin: null });
    console.log("VEDETTA bootstrap completato sul progetto Firebase corrente.");
  })().catch(err => { bootstrapPromise = null; throw err; });
  return bootstrapPromise;
}

app.use(async (req, res, next) => {
  try { await ensureBootstrap(); next(); }
  catch (e) { console.error("bootstrap", e); res.status(500).json({ error: "inizializzazione Firebase non riuscita" }); }
});

async function findTenantByKey(field, key) {
  if (!key) return null;
  const snap = await db.collection("tenants").where(field, "==", String(key)).where("active", "==", true).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function getTenant(tid) { const d = await tenantRef(tid).get(); return d.exists ? { id: d.id, ...d.data() } : null; }
async function getUser(tid, uid) { const d = await usersRef(tid).doc(String(uid)).get(); return d.exists ? { id: d.id, ...d.data() } : null; }
async function getConfig(tid) {
  const ref = configRef(tid), snap = await ref.get();
  if (!snap.exists) {
    const data = { configVersion: 1, mode: "enforce", pollMinutes: 5, rulesMd: DEFAULT_RULES, platforms: DEFAULT_PLATFORMS, updatedAt: nowIso() };
    await ref.set(data);
    return data;
  }
  const d = snap.data();
  return { configVersion: Number(d.configVersion || 1), mode: d.mode || "enforce", pollMinutes: Number(d.pollMinutes || 5), rulesMd: d.rulesMd || "", platforms: Array.isArray(d.platforms) ? d.platforms : [] };
}

function sessionSecret() {
  return process.env.VEDETTA_SESSION_SECRET || process.env.GCLOUD_PROJECT || "CHANGE_ME_SESSION_SECRET";
}
function tokenHash(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }
async function newSession(userId, tenantId) {
  const token = crypto.randomBytes(48).toString("base64url");
  await db.collection("sessions").doc(tokenHash(token)).set({ userId: String(userId), tenantId: String(tenantId), expiresAt: Date.now() + 12 * 60 * 60 * 1000, createdAt: nowIso() });
  return token;
}
async function sessionUser(token) {
  if (!token) return null;
  const s = await db.collection("sessions").doc(tokenHash(token)).get();
  if (!s.exists) return null;
  const sd = s.data();
  if (Date.now() > Number(sd.expiresAt || 0)) { await s.ref.delete().catch(() => {}); return null; }
  const u = await getUser(sd.tenantId, sd.userId);
  if (!u || u.active === false) return null;
  return { user: u, tenantId: sd.tenantId };
}
async function authContext(req) { return sessionUser(req.get("X-Admin-Token")); }
function auth(required) {
  return async (req, res, next) => {
    try {
      const ctx = await authContext(req);
      if (!ctx) return res.status(401).json({ error: "sessione non valida" });
      req.ctx = ctx; req.perms = effectivePerms(ctx.user);
      if (required && !req.perms.includes(required)) return res.status(403).json({ error: "permesso mancante: " + required });
      next();
    } catch (e) { console.error(e); res.status(500).json({ error: "errore autenticazione" }); }
  };
}

async function insertEvent(tid, e) {
  const data = {
    ts: String(e.ts || nowIso()), receivedAt: nowIso(), agentId: clean(e.agentId || "sconosciuto", 120), agentLabel: clean(e.agentLabel, 120),
    categoria: clean(e.categoria || "info", 80), piattaforma: clean(e.piattaforma, 120), regola: clean(e.regola, 200),
    azione: clean(e.azione, 80), severita: clean(e.severita, 40), dettaglio: clean(e.dettaglio, 2000), url: clean(e.url, 500)
  };
  await eventsRef(tid).add(data);
  return data;
}

async function tcpCheck(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const start = Date.now(), socket = new net.Socket(); let done = false;
    const finish = (up, error) => { if (done) return; done = true; try { socket.destroy(); } catch {} resolve({ up, latency: Date.now() - start, error: error || null }); };
    socket.setTimeout(timeoutMs); socket.once("connect", () => finish(true, null)); socket.once("timeout", () => finish(false, "timeout")); socket.once("error", e => finish(false, e.code || e.message));
    socket.connect(Number(port), host);
  });
}
async function checkDevice(tid, dev) {
  if (!dev) throw new Error("dispositivo non trovato");
  // Cloud Functions non garantisce il binario ping: per il monitoraggio Firebase usiamo TCP.
  // Per check_method=ping è consentito un port configurato; altrimenti riportiamo non verificabile.
  const result = (dev.check_method === "tcp" || dev.port)
    ? await tcpCheck(dev.host, dev.port || 443, 3000)
    : { up: false, latency: 0, error: "check ping non disponibile in Cloud Functions: configura una porta TCP" };
  const now = nowIso(), ref = devicesRef(tid).doc(dev.id), before = dev.lastTs ? !!dev.lastUp : null;
  await ref.update({ lastTs: now, lastUp: !!result.up, lastLatency: result.latency, lastError: result.error || null, totalChecks: Number(dev.totalChecks || 0) + 1, upChecks: Number(dev.upChecks || 0) + (result.up ? 1 : 0) });
  await ref.collection("checks").add({ ts: now, up: !!result.up, latency: result.latency, error: result.error || null });
  if (before !== null && before !== !!result.up || before === null && !result.up) {
    await insertEvent(tid, { agentId: "device:" + dev.id, agentLabel: dev.name, categoria: "rete", piattaforma: dev.name, regola: result.up ? "Dispositivo tornato online" : "Dispositivo non raggiungibile", azione: result.up ? "log" : "alert", severita: result.up ? "bassa" : "alta", dettaglio: `${dev.host} ${result.up ? "risponde di nuovo" : "non risponde"}${result.error ? " (" + result.error + ")" : ""}.`, url: dev.host });
  }
  if (result.up && result.latency >= Number(dev.critMs || 400)) await insertEvent(tid, { agentId: "device:" + dev.id, agentLabel: dev.name, categoria: "rete", piattaforma: dev.name, regola: "Latenza critica", azione: "alert", severita: "media", dettaglio: `${dev.host}: ${result.latency} ms`, url: dev.host });
  else if (result.up && result.latency >= Number(dev.warnMs || 150)) await insertEvent(tid, { agentId: "device:" + dev.id, agentLabel: dev.name, categoria: "rete", piattaforma: dev.name, regola: "Latenza elevata", azione: "log", severita: "bassa", dettaglio: `${dev.host}: ${result.latency} ms`, url: dev.host });
  return result;
}

app.get("/api/v1/config", async (req, res) => {
  const t = await findTenantByKey("agentKey", req.get("X-Agent-Key")); if (!t) return res.status(401).json({ error: "agent key non valida" });
  res.json(await getConfig(t.id));
});
app.post("/api/v1/events", async (req, res) => {
  const t = await findTenantByKey("agentKey", req.get("X-Agent-Key")); if (!t) return res.status(401).json({ error: "agent key non valida" });
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 499) : [], now = nowIso();
  const agentId = req.get("X-Agent-Id") || "sconosciuto", label = req.get("X-Agent-Label") || "";
  const batch = db.batch();
  for (const e of events) batch.set(eventsRef(t.id).doc(), { ts: String(e.ts || now), receivedAt: now, agentId: clean(agentId, 120), agentLabel: clean(label, 120), categoria: clean(e.categoria || "info", 80), piattaforma: clean(e.piattaforma, 120), regola: clean(e.regola, 200), azione: clean(e.azione, 80), severita: clean(e.severita, 40), dettaglio: clean(e.dettaglio, 2000), url: clean(e.url, 500) });
  batch.set(agentsRef(t.id).doc(String(agentId)), { tenantId: t.id, label: clean(label, 120), lastSeen: now }, { merge: true });
  await batch.commit(); res.json({ ok: true, ingeriti: events.length });
});
app.post("/api/v1/noc", async (req, res) => {
  const t = await findTenantByKey("enrollKey", req.get("X-Enroll-Key")); if (!t) return res.status(401).json({ error: "enroll key non valida" });
  const b = req.body || {}, hostId = clean(b.hostId, 120); if (!hostId) return res.status(400).json({ error: "hostId mancante" });
  const m = b.metrics || {}, num = x => x == null || Number.isNaN(Number(x)) ? null : Number(x), now = nowIso(), ref = endpointsRef(t.id).doc(hostId);
  const existing = await ref.get();
  const data = { tenantId: t.id, hostname: clean(b.hostname, 120), label: clean(b.label, 120), os: clean(b.os, 40), osRelease: clean(b.osRelease, 80), agentVersion: clean(b.agentVersion, 20), lastSeen: now, lastCpu: num(m.cpu), lastMem: num(m.mem), lastDisk: num(m.disk), lastUptime: num(m.uptime), lastProcs: num(m.procs), lastNetUp: num(m.netUp), lastNetDown: num(m.netDown), lastIp: clean(b.ip, 60), lastJson: JSON.stringify(m).slice(0, 4000) };
  if (!existing.exists) data.firstSeen = now;
  await ref.set(data, { merge: true });
  await samplesRef(t.id).add({ hostId, ts: now, cpu: num(m.cpu), mem: num(m.mem), disk: num(m.disk), netUp: num(m.netUp), netDown: num(m.netDown), uptime: num(m.uptime), procs: num(m.procs), load1: num(m.load1) });
  res.json({ ok: true, pollSeconds: 30 });
});

app.get("/api/admin/auth-info", (req, res) => res.json({ ok: true }));
app.post("/api/admin/login", async (req, res) => {
  const em = String(req.body?.email || "").toLowerCase().trim(), password = req.body?.password || "", code = req.body?.code;
  const snap = await db.collectionGroup("users").where("email", "==", em).where("active", "==", true).limit(1).get();
  if (snap.empty) return res.status(401).json({ error: "Credenziali non valide" });
  const d = snap.docs[0], u = { id: d.id, ...d.data() }, tid = d.ref.parent.parent.id;
  if (!verifyPassword(password, u.pwHash)) return res.status(401).json({ error: "Credenziali non valide" });
  if (u.totpEnabled && !verifyTotp(code, u.totpSecret)) return res.status(401).json({ error: "Codice TOTP non valido", totp: true });
  await d.ref.update({ lastLogin: nowIso() });
  res.json({ ok: true, session: await newSession(u.id, tid) });
});
app.post("/api/admin/logout", auth(), async (req, res) => { const t = req.get("X-Admin-Token"); if (t) await db.collection("sessions").doc(tokenHash(t)).delete().catch(() => {}); res.json({ ok: true }); });
app.get("/api/admin/me", auth(), async (req, res) => { const u = req.ctx.user, t = await getTenant(req.ctx.tenantId); res.json({ id: u.id, email: u.email, name: u.name, role: u.role, isSuper: !!u.isSuper, totpEnabled: !!u.totpEnabled, permissions: req.perms, tenant: { id: t.id, name: t.name, slug: t.slug }, roles: ROLES, allPermissions: PERMISSIONS }); });
app.get("/api/admin/totp", auth(), async (req, res) => { const u = req.ctx.user, ref = usersRef(req.ctx.tenantId).doc(u.id); let secret = u.totpSecret; if (!secret) { secret = base32Encode(crypto.randomBytes(20)); await ref.update({ totpSecret: secret }); } const uri = `otpauth://totp/${encodeURIComponent("VEDETTA:" + u.email)}?secret=${secret}&issuer=VEDETTA&algorithm=SHA1&digits=6&period=30`; res.json({ secret, uri, enabled: !!u.totpEnabled }); });
app.post("/api/admin/totp", auth(), async (req, res) => { const ref = usersRef(req.ctx.tenantId).doc(req.ctx.user.id), snap = await ref.get(), u = snap.data(), { code, enable } = req.body || {}; if (enable === false) { await ref.update({ totpEnabled: false }); return res.json({ ok: true, enabled: false }); } if (!u.totpSecret || !verifyTotp(code, u.totpSecret)) return res.status(400).json({ error: "Codice non valido" }); await ref.update({ totpEnabled: true }); res.json({ ok: true, enabled: true }); });
app.get("/api/admin/totp-uri", auth(), async (req, res) => {
  const ref = usersRef(req.ctx.tenantId).doc(req.ctx.user.id);
  const snap = await ref.get();
  const u = snap.data() || {};
  if (!u.totpEnabled && !u.totpSecret) return res.json({ disabled: false, secret: null, uri: null });
  let secret = u.totpSecret;
  if (!secret) { secret = base32Encode(crypto.randomBytes(20)); await ref.update({ totpSecret: secret }); }
  const uri = `otpauth://totp/${encodeURIComponent("VEDETTA:" + u.email)}?secret=${secret}&issuer=VEDETTA&algorithm=SHA1&digits=6&period=30`;
  res.json({ secret, uri, enabled: !!u.totpEnabled });
});

app.post("/api/admin/users/reset-password", auth("manage_users"), async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  const newPassword = String(req.body?.newPassword || "");
  if (newPassword.length < 12) return res.status(400).json({ error: "Password minimo 12 caratteri" });
  const snap = await usersRef(req.ctx.tenantId).where("email", "==", email).limit(1).get();
  if (snap.empty) return res.status(404).json({ error: "utente non trovato" });
  await snap.docs[0].ref.update({ pwHash: hashPassword(newPassword) });
  res.json({ ok: true });
});

app.post("/api/admin/change-password", auth(), async (req, res) => { const ref = usersRef(req.ctx.tenantId).doc(req.ctx.user.id), u = (await ref.get()).data(), { current, next } = req.body || {}; if (!verifyPassword(current || "", u.pwHash)) return res.status(401).json({ error: "Password attuale errata" }); if (!next || String(next).length < 12) return res.status(400).json({ error: "Minimo 12 caratteri" }); await ref.update({ pwHash: hashPassword(next) }); res.json({ ok: true }); });

app.get("/api/admin/stats", auth("view_events"), async (req, res) => {
  const tid = req.ctx.tenantId, today = new Date().toISOString().slice(0, 10), evSnap = await eventsRef(tid).orderBy("ts", "desc").limit(1000).get(), events = evSnap.docs.map(d => d.data()), todayEvents = events.filter(e => String(e.ts || "").startsWith(today));
  const [agentSnap, epSnap, cfg] = await Promise.all([agentsRef(tid).get(), endpointsRef(tid).get(), getConfig(tid)]);
  const per = {}; todayEvents.forEach(e => { const k = e.piattaforma || ""; per[k] = (per[k] || 0) + 1; });
  res.json({ eventiOggi: todayEvents.length, violazioniOggi: todayEvents.filter(e => e.categoria === "violazione").length, eventiTotali: evSnap.size, agentiTotali: agentSnap.size, endpointTotali: epSnap.size, configVersion: cfg.configVersion, perPiattaforma: Object.entries(per).sort((a,b) => b[1]-a[1]).slice(0,10).map(([piattaforma,n]) => ({ piattaforma, n })) });
});
app.get("/api/admin/events", auth("view_events"), async (req, res) => {
  const q = String(req.query.cerca || "").toLowerCase(), cat = req.query.categoria, sev = req.query.severita, plat = req.query.piattaforma, ag = req.query.agent, limit = Math.min(Number(req.query.limit) || 300, 1000);
  let arr = (await eventsRef(req.ctx.tenantId).orderBy("ts", "desc").limit(1000).get()).docs.map(d => ({ id: d.id, ...d.data() }));
  arr = arr.filter(e => (!cat || e.categoria === cat) && (!sev || e.severita === sev) && (!plat || String(e.piattaforma || "").toLowerCase().includes(String(plat).toLowerCase())) && (!ag || String(e.agentId || "").toLowerCase().includes(String(ag).toLowerCase())) && (!q || String(e.regola || "").toLowerCase().includes(q) || String(e.dettaglio || "").toLowerCase().includes(q))).slice(0, limit);
  res.json(arr);
});
app.get("/api/admin/agents", auth("view_events"), async (req,res) => { const a = (await agentsRef(req.ctx.tenantId).get()).docs.map(d=>({agent_id:d.id,...d.data()})).sort((a,b)=>String(b.lastSeen||"").localeCompare(String(a.lastSeen||""))); res.json(a); });

app.get("/api/admin/endpoints", auth("view_endpoints"), async (req,res) => { const a=(await endpointsRef(req.ctx.tenantId).orderBy("lastSeen","desc").get()).docs.map(d=>({host_id:d.id,hostname:d.data().hostname||"",label:d.data().label||"",os:d.data().os||"",os_release:d.data().osRelease||"",agent_version:d.data().agentVersion||"",first_seen:d.data().firstSeen||"",last_seen:d.data().lastSeen||"",last_cpu:d.data().lastCpu,last_mem:d.data().lastMem,last_disk:d.data().lastDisk,last_uptime:d.data().lastUptime,last_procs:d.data().lastProcs,last_net_up:d.data().lastNetUp,last_net_down:d.data().lastNetDown,last_ip:d.data().lastIp||""})); res.json(a); });
app.get("/api/admin/endpoints/:hostId", auth("view_endpoints"), async (req,res)=>{ const ep=await endpointsRef(req.ctx.tenantId).doc(req.params.hostId).get(); if(!ep.exists)return res.status(404).json({error:"endpoint sconosciuto"}); const hs=(await samplesRef(req.ctx.tenantId).where("hostId","==",req.params.hostId).orderBy("ts","desc").limit(120).get()).docs.map(d=>{const x=d.data();return {ts:x.ts,cpu:x.cpu,mem:x.mem,disk:x.disk,net_up:x.netUp,net_down:x.netDown,procs:x.procs};}).reverse(); const x=ep.data(); res.json({endpoint:{host_id:ep.id,hostname:x.hostname,label:x.label,os:x.os,os_release:x.osRelease,agent_version:x.agentVersion,first_seen:x.firstSeen,last_seen:x.lastSeen,last_cpu:x.lastCpu,last_mem:x.lastMem,last_disk:x.lastDisk,last_uptime:x.lastUptime,last_procs:x.lastProcs,last_net_up:x.lastNetUp,last_net_down:x.lastNetDown,last_ip:x.lastIp,last_json:x.lastJson},history:hs}); });
app.put("/api/admin/endpoints/:hostId", auth("manage_endpoints"), async(req,res)=>{ const ref=endpointsRef(req.ctx.tenantId).doc(req.params.hostId); if(!(await ref.get()).exists)return res.status(404).json({error:"endpoint sconosciuto"}); await ref.update({label:clean(req.body?.label,120)}); res.json({ok:true}); });
app.delete("/api/admin/endpoints/:hostId", auth("manage_endpoints"), async(req,res)=>{ const ref=endpointsRef(req.ctx.tenantId).doc(req.params.hostId); await ref.delete(); const s=await samplesRef(req.ctx.tenantId).where("hostId","==",req.params.hostId).get(); const b=db.batch(); s.docs.forEach(d=>b.delete(d.ref)); await b.commit(); res.json({ok:true}); });

function deviceOut(id,x){ return {id,name:x.name,host:x.host,type:x.type,check_method:x.check_method,port:x.port||null,interval_sec:x.intervalSec||60,warn_ms:x.warnMs||150,crit_ms:x.critMs||400,enabled:x.enabled!==false,created_at:x.createdAt||"",last_ts:x.lastTs||null,last_up:x.lastUp==null?null:x.lastUp,last_latency:x.lastLatency==null?null:x.lastLatency,last_error:x.lastError||null,up_checks:x.upChecks||0,total_checks:x.totalChecks||0}; }
app.get("/api/admin/devices", auth("view_endpoints"), async(req,res)=>{ const s=await devicesRef(req.ctx.tenantId).get(); res.json(s.docs.map(d=>deviceOut(d.id,d.data())).sort((a,b)=>a.name.localeCompare(b.name))); });
app.post("/api/admin/devices", auth("manage_endpoints"), async(req,res)=>{ const b=req.body||{}, data={name:clean(b.name,120),host:clean(b.host,200),type:clean(b.type||"altro",30),check_method:clean(b.checkMethod||"tcp",10),port:b.port?Number(b.port):null,intervalSec:Math.max(60,Number(b.intervalSec)||60),warnMs:Math.max(1,Number(b.warnMs)||150),critMs:Math.max(1,Number(b.critMs)||400),enabled:b.enabled!==false,createdAt:nowIso(),lastTs:null,lastUp:null,lastLatency:null,lastError:null,upChecks:0,totalChecks:0}; if(!data.name||!data.host)return res.status(400).json({error:"Nome e host richiesti"}); const ref=devicesRef(req.ctx.tenantId).doc(); await ref.set(data); checkDevice(req.ctx.tenantId,{id:ref.id,...data}).catch(()=>{}); res.json({ok:true,device:deviceOut(ref.id,data)}); });
app.put("/api/admin/devices/:id", auth("manage_endpoints"), async(req,res)=>{ const ref=devicesRef(req.ctx.tenantId).doc(req.params.id), s=await ref.get(); if(!s.exists)return res.status(404).json({error:"dispositivo non trovato"}); const old=s.data(),b=req.body||{}, data={name:clean(b.name??old.name,120),host:clean(b.host??old.host,200),type:clean(b.type??old.type,30),check_method:clean(b.checkMethod??old.check_method,10),port:b.port!==undefined?(b.port?Number(b.port):null):old.port,intervalSec:b.intervalSec?Math.max(60,Number(b.intervalSec)):old.intervalSec,warnMs:b.warnMs?Math.max(1,Number(b.warnMs)):old.warnMs,critMs:b.critMs?Math.max(1,Number(b.critMs)):old.critMs,enabled:b.enabled===undefined?old.enabled:!!b.enabled}; await ref.update(data); res.json({ok:true}); });
app.delete("/api/admin/devices/:id", auth("manage_endpoints"), async(req,res)=>{ const ref=devicesRef(req.ctx.tenantId).doc(req.params.id); if(!(await ref.get()).exists)return res.status(404).json({error:"dispositivo non trovato"}); await ref.delete(); res.json({ok:true}); });
app.get("/api/admin/devices/:id/history", auth("view_endpoints"), async(req,res)=>{ const ref=devicesRef(req.ctx.tenantId).doc(req.params.id), s=await ref.get(); if(!s.exists)return res.status(404).json({error:"dispositivo non trovato"}); const h=(await ref.collection("checks").orderBy("ts","desc").limit(200).get()).docs.map(d=>d.data()).reverse(); res.json(h); });
app.post("/api/admin/devices/:id/check-now", auth("manage_endpoints"), async(req,res)=>{ const ref=devicesRef(req.ctx.tenantId).doc(req.params.id), s=await ref.get(); if(!s.exists)return res.status(404).json({error:"dispositivo non trovato"}); try{res.json({ok:true,result:await checkDevice(req.ctx.tenantId,{id:ref.id,...s.data()})});}catch(e){res.status(500).json({error:"check fallito: "+e.message});} });
app.get("/api/admin/noc-stats", auth("view_endpoints"), async(req,res)=>{ const eps=(await endpointsRef(req.ctx.tenantId).get()).docs.map(d=>d.data()), onlineMs=3*60*1000, now=Date.now(); let online=0,cpuSum=0,memSum=0,n=0;const byOs={},alerts=[]; for(const e of eps){if(e.lastSeen&&(now-new Date(e.lastSeen).getTime())<onlineMs)online++;if(e.lastCpu!=null){cpuSum+=e.lastCpu;n++;}if(e.lastMem!=null)memSum+=e.lastMem;byOs[e.os||"?"]=(byOs[e.os||"?"]||0)+1;if(e.lastCpu>90)alerts.push({host:e.label||e.hostname,tipo:"CPU",val:Math.round(e.lastCpu)});if(e.lastDisk>90)alerts.push({host:e.label||e.hostname,tipo:"Disco",val:Math.round(e.lastDisk)});if(e.lastMem>90)alerts.push({host:e.label||e.hostname,tipo:"RAM",val:Math.round(e.lastMem)});}res.json({totali:eps.length,online,offline:eps.length-online,cpuMedia:n?Math.round(cpuSum/n):0,memMedia:n?Math.round(memSum/n):0,perOs:Object.entries(byOs).map(([os,n])=>({os,n})),alerts});});

app.get("/api/admin/config", auth("view_events"), async(req,res)=>res.json(await getConfig(req.ctx.tenantId)));
app.put("/api/admin/config", auth("manage_rules"), async(req,res)=>{const ref=configRef(req.ctx.tenantId),c=await getConfig(req.ctx.tenantId),b=req.body||{},v=Number(c.configVersion||1)+1;const data={configVersion:v,mode:["enforce","test","monitor","block"].includes(b.mode)?b.mode:c.mode,rulesMd:typeof b.rulesMd==="string"?b.rulesMd:c.rulesMd,platforms:Array.isArray(b.platforms)?b.platforms:c.platforms,pollMinutes:b.pollMinutes?Math.max(1,Number(b.pollMinutes)):c.pollMinutes,updatedAt:nowIso()};await ref.set(data,{merge:true});res.json({ok:true,configVersion:v});});
app.get("/api/admin/tenant-keys", auth("manage_tenant"), async(req,res)=>{const t=await getTenant(req.ctx.tenantId);res.json({agent_key:t.agentKey,enroll_key:t.enrollKey,slug:t.slug,name:t.name});});

function publicUser(u){return{id:u.id,email:u.email,name:u.name,role:u.role,active:!!u.active,isSuper:!!u.isSuper,totpEnabled:!!u.totpEnabled,permissions:effectivePerms(u),overrides:u.perms||{},lastLogin:u.lastLogin||null};}
app.get("/api/admin/users", auth("manage_users"), async(req,res)=>{const s=await usersRef(req.ctx.tenantId).get();res.json({users:s.docs.map(d=>publicUser({id:d.id,...d.data()})),roles:ROLES,allPermissions:PERMISSIONS});});
app.post("/api/admin/users", auth("manage_users"), async(req,res)=>{const b=req.body||{},em=String(b.email||"").toLowerCase().trim();if(!em||!em.includes("@"))return res.status(400).json({error:"Email non valida"});if(!b.password||String(b.password).length<12)return res.status(400).json({error:"Password minimo 12 caratteri"});if(!ROLES[b.role])return res.status(400).json({error:"Ruolo non valido"});const exists=await db.collectionGroup("users").where("email","==",em).limit(1).get();if(!exists.empty)return res.status(409).json({error:"Email già registrata"});const ref=usersRef(req.ctx.tenantId).doc();await ref.set({email:em,name:clean(b.name,80),pwHash:hashPassword(b.password),role:b.role,perms:b.overrides||{},active:true,isSuper:false,totpEnabled:false,createdAt:nowIso(),lastLogin:null});res.json({ok:true,id:ref.id});});
app.put("/api/admin/users/:id", auth("manage_users"), async(req,res)=>{const ref=usersRef(req.ctx.tenantId).doc(req.params.id),s=await ref.get();if(!s.exists)return res.status(404).json({error:"utente sconosciuto"});const u=s.data(),b=req.body||{};if(u.isSuper&&b.active===false)return res.status(400).json({error:"Non puoi disattivare il super-admin"});if(b.role&&!ROLES[b.role])return res.status(400).json({error:"Ruolo non valido"});const data={};if(b.name!==undefined)data.name=clean(b.name,80);if(b.role)data.role=b.role;if(b.overrides!==undefined)data.perms=b.overrides;if(b.active!==undefined)data.active=!!b.active;if(b.password){if(String(b.password).length<12)return res.status(400).json({error:"Password minimo 12 caratteri"});data.pwHash=hashPassword(b.password);}await ref.update(data);res.json({ok:true});});
app.delete("/api/admin/users/:id", auth("manage_users"), async(req,res)=>{const ref=usersRef(req.ctx.tenantId).doc(req.params.id),s=await ref.get();if(!s.exists)return res.status(404).json({error:"utente sconosciuto"});const u=s.data();if(u.isSuper)return res.status(400).json({error:"Non puoi eliminare il super-admin"});if(req.params.id===req.ctx.user.id)return res.status(400).json({error:"Non puoi eliminare te stesso"});await ref.delete();res.json({ok:true});});

app.get("/api/admin/events.csv", auth("view_events"), async (req, res) => {
  const snap = await eventsRef(req.ctx.tenantId).orderBy("ts", "desc").limit(5000).get();
  const cols = ["ts","receivedAt","agentId","agentLabel","categoria","piattaforma","regola","azione","severita","dettaglio","url"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(",")];
  for (const d of snap.docs) { const x=d.data(); lines.push(cols.map(c=>esc(x[c])).join(",")); }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=vedetta-events.csv");
  res.send("\ufeff" + lines.join("\n"));
});

app.get("/api/admin/tenants", auth(), async(req,res)=>{if(!req.ctx.user.isSuper)return res.status(403).json({error:"solo super-admin"});const s=await db.collection("tenants").orderBy("createdAt","asc").get();const out=[];for(const d of s.docs){const [us,ep]=await Promise.all([usersRef(d.id).get(),endpointsRef(d.id).get()]);const x=d.data();out.push({id:d.id,name:x.name,slug:x.slug,active:x.active,created_at:x.createdAt,users:us.size,endpoints:ep.size});}res.json(out);});
app.delete("/api/admin/tenants/:id", auth(), async (req, res) => {
  if (!req.ctx.user.isSuper) return res.status(403).json({ error: "solo super-admin" });
  if (req.params.id === req.ctx.tenantId) return res.status(400).json({ error: "Non puoi eliminare il tenant corrente" });
  const ref = tenantRef(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: "tenant non trovato" });
  await db.recursiveDelete(ref);
  res.json({ ok: true });
});

app.post("/api/admin/tenants", auth(), async(req,res)=>{if(!req.ctx.user.isSuper)return res.status(403).json({error:"solo super-admin"});const b=req.body||{},sl=String(b.slug||"").toLowerCase().replace(/[^a-z0-9-]/g,"").slice(0,40);if(!b.name||!sl)return res.status(400).json({error:"Nome e slug richiesti"});if(b.ownerEmail&&(!b.ownerPassword||String(b.ownerPassword).length<12))return res.status(400).json({error:"Password owner minimo 12 caratteri"});const ex=await db.collection("tenants").where("slug","==",sl).limit(1).get();if(!ex.empty)return res.status(409).json({error:"Slug già in uso"});const ref=db.collection("tenants").doc(),data={name:clean(b.name,120),slug:sl,agentKey:newKey(),enrollKey:newKey(),createdAt:nowIso(),active:true};await ref.set(data);await configRef(ref.id).set({configVersion:1,mode:"enforce",pollMinutes:5,rulesMd:DEFAULT_RULES,platforms:DEFAULT_PLATFORMS,updatedAt:nowIso()});if(b.ownerEmail){const em=String(b.ownerEmail).toLowerCase().trim();const ur=usersRef(ref.id).doc();await ur.set({email:em,name:"Owner",pwHash:hashPassword(b.ownerPassword),role:"owner",perms:{},active:true,isSuper:false,totpEnabled:false,createdAt:nowIso(),lastLogin:null});}res.json({ok:true,id:ref.id});});

app.get("/api/health", (req,res)=>res.json({ok:true,service:"vedetta-api",storage:"firestore"}));

exports.api = onRequest({ region: "europe-west1", memory: "512MiB", timeoutSeconds: 60, minInstances: 0, maxInstances: 20 }, app);

exports.deviceChecks = onSchedule({ schedule: "every 1 minutes", timeZone: "Europe/Rome", region: "europe-west1", memory: "512MiB", timeoutSeconds: 60 }, async () => {
  const tenants = await db.collection("tenants").where("active", "==", true).get();
  for (const t of tenants.docs) {
    const devs = await devicesRef(t.id).where("enabled", "==", true).get();
    const now = Date.now();
    for (const d of devs.docs) {
      const x = d.data(), last = x.lastTs ? new Date(x.lastTs).getTime() : 0, interval = Math.max(60, Number(x.intervalSec || 60));
      if (now - last >= interval * 1000) { try { await checkDevice(t.id, { id: d.id, ...x }); } catch (e) { console.error("device check", t.id, d.id, e.message); } }
    }
  }
});
