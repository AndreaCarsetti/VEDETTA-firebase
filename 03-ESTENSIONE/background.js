/**
 * AI Usage Guard v2 — agente della console VEDETTA
 *
 *  - Scarica periodicamente regole, policy e selettori DOM dalla console
 *  - Registra dinamicamente il content script sulle sole piattaforme abilitate
 *    (nuovi domini o nuovi selettori arrivano senza reinstallare l'estensione)
 *  - Accoda gli eventi e li invia in batch; in caso di server irraggiungibile
 *    la coda resta in locale e viene ritrasmessa al ciclo successivo
 */
"use strict";

const DEFAULTS = {
  serverUrl: "http://localhost:8443",
  agentKey: "d633419099f968f8286c3f9dd3de07a3543662b3caa5da79",
  agentLabel: "Postazione Locale",
  mode: "enforce",
  pollMinutes: 5,
  configVersion: 0,
  rulesMd: "",
  platforms: [],
  adblock: { ads: true, analytics: true, heatmaps: true, social: true, malware: true, nsfw: false, custom: "" }
};

const MAX_QUEUE = 3000;

/* ---------------- AdBlock / Anti-Tracker (declarativeNetRequest dinamico) ---------------- */
const ADBLOCK_DOMAINS = {
  ads: ["doubleclick.net", "g.doubleclick.net", "googlesyndication.com", "pagead2.googlesyndication.com", "adservice.google.com", "2mdn.net", "criteo.com", "criteo.net", "taboola.com", "outbrain.com", "adnxs.com", "rubiconproject.com", "pubmatic.com", "adform.net", "amazon-adsystem.com", "moatads.com", "adcolony.com"],
  analytics: ["google-analytics.com", "www.google-analytics.com", "ssl.google-analytics.com", "googletagmanager.com", "analytics.google.com", "stats.g.doubleclick.net", "mixpanel.com", "cdn.segment.com", "api.segment.io", "amplitude.com", "quantserve.com", "scorecardresearch.com"],
  heatmaps: ["hotjar.com", "static.hotjar.com", "script.hotjar.com", "clarity.ms", "mouseflow.com", "fullstory.com", "smartlook.com", "inspectlet.com", "luckyorange.com", "crazyegg.com"],
  social: ["connect.facebook.net", "ads-twitter.com", "static.ads-twitter.com", "snap.licdn.com", "px.ads.linkedin.com", "analytics.tiktok.com", "sc-static.net"],
  malware: ["coinhive.com", "coin-hive.com", "cryptoloot.pro", "crypto-loot.com", "webminepool.com", "cnhv.co", "jsecoin.com"],
  nsfw: []
};
function adblockRules(ab) {
  const rules = []; let id = 1;
  const clean = (dmn) => String(dmn || "").trim().replace(/^\*?\.?/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // categorie ads/tracker: bloccano solo sotto-risorse di TERZE PARTI (non rompono il sito visitato)
  const rtThird = ["script", "image", "xmlhttprequest", "sub_frame", "stylesheet", "ping", "media", "font", "websocket", "object", "csp_report"];
  const addThird = (dmn) => { dmn = clean(dmn); if (!dmn) return; rules.push({ id: id++, priority: 1, action: { type: "block" }, condition: { urlFilter: "||" + dmn + "^", resourceTypes: rtThird, domainType: "thirdParty" } }); };
  // domini PERSONALIZZATI: blocco TOTALE dell'accesso. main_frame → pagina "AdBlock Interceptor"; resto → blocco.
  const rtSub = ["sub_frame", "script", "image", "xmlhttprequest", "stylesheet", "ping", "media", "font", "websocket", "object", "csp_report"];
  const blockedPage = (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL("blocked.html") : "blocked.html";
  const addFull = (dmn) => {
    dmn = clean(dmn); if (!dmn) return;
    rules.push({ id: id++, priority: 2, action: { type: "redirect", redirect: { url: blockedPage + "?d=" + encodeURIComponent(dmn) } }, condition: { urlFilter: "||" + dmn + "^", resourceTypes: ["main_frame"] } });
    rules.push({ id: id++, priority: 2, action: { type: "block" }, condition: { urlFilter: "||" + dmn + "^", resourceTypes: rtSub } });
  };
  ["ads", "analytics", "heatmaps", "social", "malware", "nsfw"].forEach((cat) => { if (ab && ab[cat]) (ADBLOCK_DOMAINS[cat] || []).forEach(addThird); });
  if (ab && ab.custom) String(ab.custom).split(/[\s,;\n]+/).forEach(addFull);
  return rules;
}
async function applyAdblock(ab) {
  try {
    if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const addRules = adblockRules(ab || {});
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules });
    console.log("[VEDETTA] adblock: " + addRules.length + " regole attive");
  } catch (e) { console.warn("[VEDETTA] adblock non applicato:", e); }
}

/* Log dei blocchi → eventi "adblock" verso la console (dedup per non floodare).
   onRuleMatchedDebug è disponibile solo per estensioni NON pacchettizzate (dev/enterprise). */
const adblockSeen = new Map();
const ADBLOCK_DEDUP_MS = 5 * 60 * 1000;
if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    try {
      const url = info && info.request && info.request.url;
      if (!url) return;
      let host = ""; try { host = new URL(url).hostname; } catch { return; }
      const now = Date.now();
      if (now - (adblockSeen.get(host) || 0) < ADBLOCK_DEDUP_MS) return;
      adblockSeen.set(host, now);
      if (adblockSeen.size > 800) adblockSeen.clear();
      let pageHost = "";
      try { if (info.request.initiator) pageHost = new URL(info.request.initiator).hostname; } catch (e) { /* no initiator */ }
      enqueue({ categoria: "adblock", piattaforma: pageHost || host, url, regola: "AdBlock", azione: "block", severita: "bassa", dettaglio: "Bloccato: " + host });
    } catch (e) { /* non bloccare mai */ }
  });
}

/* ---------------- Identità agente ---------------- */
async function getAgentId() {
  const { agentId } = await chrome.storage.local.get("agentId");
  if (agentId) return agentId;
  const id = "AG-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  await chrome.storage.local.set({ agentId: id });
  return id;
}

/* Codice admin univoco dell'agente: generato una sola volta, riportato alla console
   VEDETTA (heartbeat). Solo chi lo legge dalla console può disabilitare/rimuovere il plugin. */
async function getAdminCode() {
  const { adminCode } = await chrome.storage.local.get("adminCode");
  if (adminCode) return adminCode;
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // niente caratteri ambigui (0/O, 1/I)
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[rnd[i] % chars.length];
  code = code.slice(0, 4) + "-" + code.slice(4);
  await chrome.storage.local.set({ adminCode: code });
  return code;
}
const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
async function checkAdminCode(code) {
  const stored = await getAdminCode();
  return normCode(code) === normCode(stored);
}
async function isDisabled() {
  return (await chrome.storage.local.get("disabled")).disabled === true;
}

/* Disabilita l'agente: rimuove tutte le regole adblock, i content script e le sincronizzazioni.
   Il plugin resta installato ma inerte, in attesa di rimozione. */
async function disableAgent() {
  await chrome.storage.local.set({ disabled: true });
  try {
    const ex = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ex.map((r) => r.id) });
  } catch (e) { /* */ }
  try { await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ["adblock_rules"] }); } catch (e) { /* */ }
  try { await chrome.scripting.unregisterContentScripts({ ids: ["aiguard-monitor"] }); } catch (e) { /* */ }
  try { await chrome.alarms.clear("aiguard-cycle"); } catch (e) { /* */ }
  chrome.action.setBadgeText({ text: "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#8494ad" });
  chrome.action.setTitle({ title: "VEDETTA — agente DISABILITATO (in attesa di rimozione)" });
}

async function cfg() {
  const c = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...c };
}

/* ---------------- Registrazione dinamica dei content script ---------------- */
async function applyPlatforms(platforms) {
  const matches = (platforms || [])
    .filter((p) => p && p.enabled !== false && p.domain)
    .flatMap((p) => [`https://${p.domain}/*`, `https://*.${p.domain}/*`]);

  try {
    const esistenti = await chrome.scripting.getRegisteredContentScripts({ ids: ["aiguard-monitor"] });
    if (esistenti.length) {
      await chrome.scripting.unregisterContentScripts({ ids: ["aiguard-monitor"] });
    }
  } catch (e) {
    /* nessuno script registrato */
  }

  if (!matches.length) return;

  try {
    await chrome.scripting.registerContentScripts([{
      id: "aiguard-monitor",
      matches,
      js: ["rules-parser.js", "content.js"],
      runAt: "document_start",
      allFrames: true,
      persistAcrossSessions: true
    }]);
  } catch (e) {
    console.warn("Registrazione content script non riuscita:", e);
  }
}

/* ---------------- Sincronizzazione con la console ---------------- */
async function syncConfig() {
  if (await isDisabled()) return { ok: false, motivo: "agente disabilitato" };
  const c = await cfg();
  if (!c.serverUrl || !c.agentKey) return { ok: false, motivo: "console non configurata" };

  const id = await getAgentId();
  const adminCode = await getAdminCode();
  try {
    const res = await fetch(c.serverUrl.replace(/\/$/, "") + "/api/v1/config", {
      headers: {
        "X-Agent-Key": c.agentKey,
        "X-Agent-Id": id,
        "X-Agent-Label": c.agentLabel || "",
        "X-Agent-Admin-Code": adminCode
      }
    });
    if (!res.ok) return { ok: false, motivo: "HTTP " + res.status };
    const nuovo = await res.json();

    const cambiate = nuovo.configVersion !== c.configVersion;
    await chrome.storage.local.set({
      mode: nuovo.mode || "enforce",
      pollMinutes: nuovo.pollMinutes || 5,
      rulesMd: nuovo.rulesMd || "",
      platforms: nuovo.platforms || [],
      adblock: nuovo.adblock || DEFAULTS.adblock,
      configVersion: nuovo.configVersion,
      lastSync: new Date().toISOString(),
      lastSyncOk: true
    });

    await applyAdblock(nuovo.adblock || DEFAULTS.adblock);

    if (cambiate) {
      await applyPlatforms(nuovo.platforms);
      await scheduleAlarm(nuovo.pollMinutes || 5);
      // notifica le schede aperte del cambio policy
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: "aiguard_config_updated" }).catch(() => {});
      }
    }
    await updateBadge();
    return { ok: true, configVersion: nuovo.configVersion, aggiornata: cambiate };
  } catch (e) {
    await chrome.storage.local.set({ lastSyncOk: false, lastSyncError: String(e) });
    await updateBadge();
    return { ok: false, motivo: String(e) };
  }
}

/* ---------------- Coda e invio eventi ---------------- */
async function enqueue(evt) {
  const { queue = [] } = await chrome.storage.local.get("queue");
  queue.push({ ts: new Date().toISOString(), ...evt });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  await chrome.storage.local.set({ queue });
  await updateBadge();
  // Invia subito ogni evento al server per una sincronizzazione istantanea
  await flush();
}

async function flush() {
  const c = await cfg();
  const { queue = [] } = await chrome.storage.local.get("queue");
  if (!queue.length) return { ok: true, inviati: 0 };
  if (!c.serverUrl || !c.agentKey) return { ok: false, motivo: "console non configurata" };

  const id = await getAgentId();
  const adminCode = await getAdminCode();
  const batch = queue.slice(0, 500);
  try {
    const res = await fetch(c.serverUrl.replace(/\/$/, "") + "/api/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Key": c.agentKey,
        "X-Agent-Id": id,
        "X-Agent-Label": c.agentLabel || "",
        "X-Agent-Admin-Code": adminCode
      },
      body: JSON.stringify({ events: batch })
    });
    if (!res.ok) return { ok: false, motivo: "HTTP " + res.status };
    const resto = queue.slice(batch.length);
    await chrome.storage.local.set({ queue: resto, lastFlush: new Date().toISOString() });
    await updateBadge();
    return { ok: true, inviati: batch.length };
  } catch (e) {
    return { ok: false, motivo: String(e) };
  }
}

async function updateBadge() {
  const { queue = [], lastSyncOk, serverUrl, lastSync } = await chrome.storage.local.get(["queue", "lastSyncOk", "serverUrl", "lastSync"]);
  const setBadge = (text, color, title) => {
    chrome.action.setBadgeText({ text });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setTitle({ title: "VEDETTA — " + title });
  };
  if (!serverUrl) { setBadge("·", "#8494ad", "Console non configurata"); return; }
  if (lastSyncOk === false) { setBadge("OFF", "#e5484d", "NON collegato alla console"); return; }
  if (lastSyncOk === true) {
    // collegato: indicatore verde sempre visibile (a prescindere dagli eventi AI)
    if (queue.length) { setBadge(String(Math.min(queue.length, 99)), "#5aba93", "Collegato · " + queue.length + " eventi in coda"); }
    else { setBadge("ON", "#4fb583", "Collegato alla console" + (lastSync ? " · ultima sync " + lastSync.replace("T", " ").slice(11, 19) : "")); }
    return;
  }
  setBadge("…", "#8494ad", "In attesa del primo collegamento");
}

/* ---------------- Pianificazione e Sincronizzazione ---------------- */
async function scheduleAlarm(minutes) {
  await chrome.alarms.clear("aiguard-cycle");
  chrome.alarms.create("aiguard-cycle", { periodInMinutes: Math.max(1, Number(minutes) || 5) });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "aiguard-cycle") return;
  if (await isDisabled()) return;
  await syncConfig();
  await flush();
});

// Sincronizzazione automatica al cambio di scheda
chrome.tabs.onActivated?.addListener(async () => {
  if (await isDisabled()) return;
  await syncConfig();
});

chrome.runtime.onInstalled.addListener(async () => {
  const c = await cfg();
  await scheduleAlarm(c.pollMinutes);
  await applyAdblock(c.adblock);
  await syncConfig();
  await applyPlatforms((await cfg()).platforms);
});

chrome.runtime.onStartup.addListener(async () => {
  if (await isDisabled()) { await disableAgent(); return; }
  const c = await cfg();
  await scheduleAlarm(c.pollMinutes);
  await applyAdblock(c.adblock);
  await applyPlatforms(c.platforms);
  await syncConfig();
  await flush();
});

/* ---------------- Registrazione accessi ---------------- */
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  if (await isDisabled()) return;
  const c = await cfg();
  let host;
  try { host = new URL(d.url).hostname; } catch { return; }
  const monitorata = (c.platforms || []).some(
    (p) => p.enabled !== false && (host === p.domain || host.endsWith("." + p.domain))
  );
  if (!monitorata) return;
  await syncConfig();
  await enqueue({
    categoria: "accesso",
    piattaforma: host,
    url: d.url,
    dettaglio: "Accesso alla piattaforma AI"
  });
});

/* ---------------- Messaggi ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "aiguard_event":
        await enqueue({
          categoria: msg.categoria || "violazione",
          piattaforma: msg.piattaforma,
          url: msg.url,
          regola: msg.regola,
          azione: msg.azione,
          severita: msg.severita,
          dettaglio: msg.dettaglio
        });
        if (msg.categoria === "violazione" && msg.severita === "alta") {
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon128.png",
            title: "Policy aziendale AI",
            message: `${msg.regola || ""}: ${msg.dettaglio || ""}`.slice(0, 180)
          }, () => void chrome.runtime.lastError);
        }
        sendResponse({ ok: true });
        break;

      case "aiguard_get_config": {
        const c = await cfg();
        sendResponse({
          mode: c.mode,
          rulesMd: c.rulesMd,
          platforms: c.platforms,
          configVersion: c.configVersion
        });
        break;
      }

      case "aiguard_sync_now": {
        const r1 = await syncConfig();
        const r2 = await flush();
        sendResponse({ sync: r1, flush: r2 });
        break;
      }

      case "aiguard_disable": {
        if (!(await checkAdminCode(msg.code))) { sendResponse({ ok: false, motivo: "Codice admin errato" }); break; }
        await disableAgent();
        sendResponse({ ok: true });
        break;
      }

      case "aiguard_uninstall": {
        if (!(await checkAdminCode(msg.code))) { sendResponse({ ok: false, motivo: "Codice admin errato" }); break; }
        try { chrome.management.uninstallSelf({ showConfirmDialog: true }); } catch (e) { /* */ }
        sendResponse({ ok: true });
        break;
      }

      case "aiguard_status": {
        const c = await cfg();
        const { queue = [], lastSync, lastSyncOk, lastSyncError, agentId, disabled } = await chrome.storage.local.get(
          ["queue", "lastSync", "lastSyncOk", "lastSyncError", "agentId", "disabled"]
        );
        // diagnostica adblock: quante regole di blocco sono effettivamente attive
        let adblockStatic = false, adblockDynamic = 0;
        try {
          const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
          adblockStatic = enabled.includes("adblock_rules");
          const dyn = await chrome.declarativeNetRequest.getDynamicRules();
          adblockDynamic = dyn.length;
        } catch (e) { /* permesso non concesso finché non ricarichi l'estensione */ }
        sendResponse({
          agentId: agentId || (await getAgentId()),
          agentLabel: c.agentLabel,
          serverUrl: c.serverUrl,
          mode: c.mode,
          configVersion: c.configVersion,
          piattaforme: (c.platforms || []).filter((p) => p.enabled !== false).length,
          inCoda: queue.length,
          adblockStatic, adblockDynamic,
          disabled: disabled === true,
          lastSync, lastSyncOk, lastSyncError
        });
        break;
      }
    }
  })();
  return true;
});

updateBadge();
