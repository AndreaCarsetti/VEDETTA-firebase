"use strict";

function render(s) {
  if (s.disabled) {
    document.getElementById("dot").className = "dot ko";
    document.getElementById("statoTxt").textContent = "⛔ Agente disabilitato — in attesa di rimozione";
  } else {
    const connesso = s.serverUrl && s.lastSyncOk === true;
    document.getElementById("dot").className = "dot" + (connesso ? "" : (s.lastSyncOk === false ? " ko" : " wait"));
    document.getElementById("statoTxt").textContent = !s.serverUrl
      ? "Console non configurata"
      : connesso ? "🟢 Collegato alla console · " + (s.mode || "enforce")
        : (s.lastSyncOk === false ? "🔴 Non collegato — verifica URL e Agent Key" : "🟡 In collegamento…");
  }

  const dl = document.getElementById("info");
  dl.textContent = "";
  const righe = [
    ["Postazione", s.agentLabel || s.agentId || "—"],
    ["Config", "v" + (s.configVersion ?? 0)],
    ["Piattaforme", String(s.piattaforme ?? 0)],
    ["In coda", String(s.inCoda ?? 0)],
    ["AdBlock", (s.adblockStatic ? "🟢 attivo" : "🔴 spento") + (s.adblockDynamic ? " (+" + s.adblockDynamic + " custom)" : "")],
    ["Ultima sync", s.lastSync ? s.lastSync.replace("T", " ").slice(11, 19) : "mai"]
  ];
  for (const [k, v] of righe) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    dl.append(dt, dd);
  }
}

chrome.runtime.sendMessage({ type: "aiguard_status" }, (s) => s && render(s));

document.getElementById("sync").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "aiguard_sync_now" }, () => {
    chrome.runtime.sendMessage({ type: "aiguard_status" }, (s) => s && render(s));
  });
});
document.getElementById("opt").addEventListener("click", () => chrome.runtime.openOptionsPage());

function esc(s) { const d = document.createElement("div"); d.textContent = String(s); return d.innerHTML; }

function renderSec(r) {
  const out = document.getElementById("secOut");
  if (!r || r.ok === false) {
    out.className = "muted";
    out.textContent = "Analisi non disponibile su questa pagina (es. scheda di sistema).";
    return;
  }
  const rilievi = [];
  if (!r.https) rilievi.push("HTTP non cifrato");
  if (r.mixed) rilievi.push(r.mixed + " risorse contenuto misto");
  if (r.pw) rilievi.push(r.pw + " campo password");
  if (!r.cspMeta) rilievi.push("nessun meta-CSP");
  const pill = r.https && !r.mixed
    ? '<span class="pill ok">HTTPS</span>'
    : '<span class="pill warn">' + (r.https ? "HTTPS · contenuto misto" : "HTTP INSICURO") + "</span>";
  const c = r.cls || { AI: [], tracker: [], "terza-parte": [] };
  const items = [];
  if (c.AI.length) items.push("<li><b>AI/SaaS:</b> " + esc(c.AI.join(", ")) + "</li>");
  if (c.tracker.length) items.push("<li><b>Tracker:</b> " + esc(c.tracker.join(", ")) + "</li>");
  if (c["terza-parte"].length) items.push("<li><b>Terze parti (" + c["terza-parte"].length + "):</b> " + esc(c["terza-parte"].slice(0, 12).join(", ")) + "</li>");
  out.className = "";
  out.innerHTML = pill +
    (rilievi.length ? '<div style="margin-top:6px">' + esc(rilievi.join(" · ")) + "</div>" : '<div style="margin-top:6px" class="muted">Nessun rilievo</div>') +
    (items.length ? "<ul>" + items.join("") + "</ul>" : '<div class="muted" style="margin-top:6px">Nessun dominio di terze parti.</div>');
}

/* ---- Gestione agente: disabilita / rimuovi (protetto da codice admin) ---- */
const adminMsg = document.getElementById("adminMsg");
function setAdminMsg(text, ok) {
  adminMsg.textContent = text;
  adminMsg.className = ok ? "ok" : "err";
}
document.getElementById("adminDisable").addEventListener("click", () => {
  const code = document.getElementById("adminCode").value.trim();
  if (!code) { setAdminMsg("Inserisci il codice admin.", false); return; }
  setAdminMsg("Verifica…", true);
  chrome.runtime.sendMessage({ type: "aiguard_disable", code }, (r) => {
    if (r && r.ok) {
      setAdminMsg("✅ Agente disabilitato. Ora puoi eliminarlo.", true);
      chrome.runtime.sendMessage({ type: "aiguard_status" }, (s) => s && render(s));
    } else setAdminMsg("❌ " + ((r && r.motivo) || "Operazione non riuscita"), false);
  });
});
document.getElementById("adminRemove").addEventListener("click", () => {
  const code = document.getElementById("adminCode").value.trim();
  if (!code) { setAdminMsg("Inserisci il codice admin.", false); return; }
  if (!confirm("Rimuovere definitivamente l'agente VEDETTA da questo browser?")) return;
  setAdminMsg("Verifica…", true);
  chrome.runtime.sendMessage({ type: "aiguard_uninstall", code }, (r) => {
    if (r && r.ok) setAdminMsg("Rimozione in corso… conferma nella finestra di Chrome.", true);
    else setAdminMsg("❌ " + ((r && r.motivo) || "Operazione non riuscita"), false);
  });
});

document.getElementById("secBtn").addEventListener("click", () => {
  document.getElementById("secOut").textContent = "Analisi in corso…";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) { renderSec({ ok: false }); return; }
    chrome.tabs.sendMessage(tab.id, { type: "aiguard_page_security" }, (resp) => {
      if (chrome.runtime.lastError) { renderSec({ ok: false }); return; }
      renderSec(resp);
    });
  });
});
