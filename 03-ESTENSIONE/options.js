"use strict";

const $ = (id) => document.getElementById(id);

async function loadStato() {
  chrome.runtime.sendMessage({ type: "aiguard_status" }, (s) => {
    if (!s) return;
    const dl = $("stato");
    dl.textContent = "";
    const righe = [
      ["Agent ID", s.agentId || "—"],
      ["Postazione", s.agentLabel || "—"],
      ["Console", s.serverUrl || "non configurata"],
      ["Modalità", s.mode || "—"],
      ["Configurazione", "v" + (s.configVersion ?? 0)],
      ["Piattaforme monitorate", String(s.piattaforme ?? 0)],
      ["Eventi in coda", String(s.inCoda ?? 0)],
      ["Ultima sincronizzazione", s.lastSync ? s.lastSync.replace("T", " ").slice(0, 19) : "mai"],
      ["Esito", s.lastSyncOk === false ? "ERRORE: " + (s.lastSyncError || "") : "ok"]
    ];
    for (const [k, v] of righe) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      dl.append(dt, dd);
    }
  });
}

async function init() {
  const c = await chrome.storage.local.get(["serverUrl", "agentKey", "agentLabel"]);
  $("serverUrl").value = c.serverUrl || "http://localhost:8443";
  $("agentKey").value = c.agentKey || "d633419099f968f8286c3f9dd3de07a3543662b3caa5da79";
  $("agentLabel").value = c.agentLabel || "Postazione Locale";
  loadStato();
}
init();

function esito(msg, ok) {
  const s = $("status");
  s.textContent = msg;
  s.className = "status " + (ok ? "ok" : "err");
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    serverUrl: $("serverUrl").value.trim(),
    agentKey: $("agentKey").value.trim(),
    agentLabel: $("agentLabel").value.trim()
  });
  chrome.runtime.sendMessage({ type: "aiguard_sync_now" }, (r) => {
    if (r && r.sync && r.sync.ok) esito("Collegato alla console — configurazione v" + r.sync.configVersion, true);
    else esito("Salvato, ma la console non risponde: " + ((r && r.sync && r.sync.motivo) || "errore"), false);
    loadStato();
  });
});

$("sync").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "aiguard_sync_now" }, (r) => {
    if (r && r.sync && r.sync.ok) esito("Sincronizzazione completata (v" + r.sync.configVersion + ")", true);
    else esito("Sincronizzazione non riuscita: " + ((r && r.sync && r.sync.motivo) || "errore"), false);
    loadStato();
  });
});
