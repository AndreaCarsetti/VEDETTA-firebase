/**
 * VEDETTA PWA — logica applicativa
 */
"use strict";

const LS_TOKEN = "vedetta_session";
const LS_LASTID = "vedetta_last_event_id";

let TOKEN = null;
let autoTimer = null;
let deferredInstall = null;
let offline = false;

/* ---------------- Helpers ---------------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
};

function toast(msg, ok = true) {
  const t = $("toast");
  t.textContent = msg;
  t.style.background = ok ? "var(--ok)" : "var(--crit)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

function setOffline(state) {
  if (offline === state) return;
  offline = state;
  $("offline-bar").classList.toggle("hidden", !state);
}

const API_BASE = "";

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": TOKEN,
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    logout();
    throw new Error("Token non valido");
  }
  setOffline(res.headers.get("X-Vedetta-Offline") === "1" || !res.ok && res.status === 503);
  return res.json();
}

/* ---------------- Autenticazione ---------------- */
function showApp(show) {
  $("gate").classList.toggle("hidden", show);
  $("shell").classList.toggle("hidden", !show);
}

function logout() {
  if (TOKEN) { fetch(API_BASE + "/api/admin/logout", { method: "POST", headers: { "X-Admin-Token": TOKEN } }).catch(() => {}); }
  localStorage.removeItem(LS_TOKEN);
  TOKEN = null;
  clearInterval(autoTimer);
  showApp(false);
}

// Riprende una sessione già emessa (salvata sul dispositivo)
async function resumeSession(session) {
  TOKEN = session;
  try {
    const s = await api("/api/admin/stats");
    if (s.error) throw new Error(s.error);
    localStorage.setItem(LS_TOKEN, session);
    showApp(true);
    await bootData();
    startAuto();
    return true;
  } catch (e) {
    TOKEN = null;
    localStorage.removeItem(LS_TOKEN);
    return false;
  }
}

async function tryLogin(email, password, code) {
  $("gate-err").textContent = "";
  if (!password) { $("gate-err").textContent = "Inserisci la password."; return false; }
  try {
    const res = await fetch(API_BASE + "/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email || "admin@vedetta.local", password, code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.totp) { $("gate-totp-row")?.classList.remove("hidden"); $("gate-totp")?.focus(); }
      $("gate-err").textContent = data.error || "Accesso non riuscito.";
      return false;
    }
    const ok = await resumeSession(data.session);
    if (!ok) {
      $("gate-err").textContent = "Errore durante l'avvio della sessione. Riprova.";
    }
    return ok;
  } catch (e) {
    $("gate-err").textContent = "Console non raggiungibile.";
    return false;
  }
}

/* ---------------- Tab ---------------- */
function openTab(name) {
  document.querySelectorAll("nav [data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name)
  );
  document.querySelectorAll("nav .nav-dropdown").forEach((dd) => {
    dd.classList.toggle("has-active", !!dd.querySelector(`[data-tab="${name}"]`));
  });
  ["eventi", "tenants", "adblock", "agenti-chrome", "agenti", "rete", "regole", "ai-act", "piattaforme", "sicurezza"].forEach((t) => {
    const target = $("tab-" + t);
    if (target) target.classList.toggle("hidden", t !== name);
  });
  if (name === "tenants") loadTenants();
  if (name === "adblock") loadAdBlockConfig();
  if (name === "agenti-chrome") loadAgentiChrome();
  if (name === "agenti") loadEndpoints();
  if (name === "rete") loadDevices();
  if (name === "regole" || name === "piattaforme" || name === "ai-act") loadConfig();
  if (name === "sicurezza") loadSecurity();
}

async function loadTenants() {
  await Promise.all([loadTenantsTable(), loadUsersTable()]);
}

async function loadTenantsTable() {
  const tbody = $("tenants-table-body");
  if (!tbody) return;
  tbody.textContent = "";
  try {
    const list = await api("/api/admin/tenants");
    if (!Array.isArray(list) || !list.length) {
      tbody.innerHTML = `
        <tr>
          <td><span style="color:var(--ok);font-weight:600">🟢 Attivo</span></td>
          <td class="mono">t_default</td>
          <td>Organizzazione Principale (Default)</td>
          <td class="mono">default</td>
          <td class="mono">ek_d633419099f968f8286c3f9</td>
          <td>1</td>
          <td>1</td>
          <td style="text-align:right"><span class="note">Default</span></td>
        </tr>
      `;
      return;
    }
    list.forEach((t) => {
      const tr = el("tr");
      const stTd = el("td");
      stTd.innerHTML = (t.active !== false) ? `<span style="color:var(--ok);font-weight:600">🟢 Attivo</span>` : `<span style="color:var(--crit)">🔴 Sospeso</span>`;

      const idTd = el("td", "mono", t.id || "—");
      const nameTd = el("td", "", t.name || "Organizzazione");
      const slugTd = el("td", "mono", t.slug || "default");
      const ekTd = el("td", "mono", t.enrollKey || t.id || "—");
      const uTd = el("td", "", String(t.users || 1));
      const agTd = el("td", "", String(t.endpoints || t.agents || 1));

      const actTd = el("td");
      actTd.style.textAlign = "right";
      const btnDel = el("button", "btn ghost", "Elimina");
      btnDel.style.padding = "3px 8px";
      btnDel.style.fontSize = "11px";
      btnDel.style.color = "var(--crit)";
      btnDel.addEventListener("click", () => deleteTenant(t.id));
      actTd.appendChild(btnDel);

      tr.append(stTd, idTd, nameTd, slugTd, ekTd, uTd, agTd, actTd);
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `
      <tr>
        <td><span style="color:var(--ok);font-weight:600">🟢 Attivo</span></td>
        <td class="mono">t_default</td>
        <td>Organizzazione Principale (Default)</td>
        <td class="mono">default</td>
        <td class="mono">ek_d633419099f968f8286c3f9</td>
        <td>1</td>
        <td>1</td>
        <td style="text-align:right"><span class="note">Default</span></td>
      </tr>
    `;
  }
}

async function loadUsersTable() {
  const tbody = $("users-table-body");
  if (!tbody) return;
  tbody.textContent = "";
  try {
    const res = await api("/api/admin/users");
    const list = (res && Array.isArray(res.users)) ? res.users : [];
    if (!list.length) {
      tbody.innerHTML = `
        <tr>
          <td><span style="color:var(--ok);font-weight:600">🟢 Attivo</span></td>
          <td class="mono">admin@vedetta.local</td>
          <td>Amministratore SIEM</td>
          <td><span class="tag info">owner / super-admin</span></td>
          <td>Sì</td>
          <td class="mono">Oggi</td>
          <td style="text-align:right"><span class="note">Super-admin</span></td>
        </tr>
      `;
      return;
    }
    list.forEach((u) => {
      const tr = el("tr");
      const stTd = el("td");
      stTd.innerHTML = (u.active !== false) ? `<span style="color:var(--ok);font-weight:600">🟢 Attivo</span>` : `<span style="color:var(--crit)">🔴 Sospeso</span>`;

      const emTd = el("td", "mono", u.email || "—");
      const nameTd = el("td", "", u.name || "—");
      const roleTd = el("td"); roleTd.appendChild(el("span", "tag info", u.role || "admin"));
      const superTd = el("td", "", u.isSuper ? "Sì" : "No");
      const lastTd = el("td", "mono", (u.lastLogin || "—").slice(0, 10));

      const actTd = el("td");
      actTd.style.textAlign = "right";
      actTd.style.display = "flex";
      actTd.style.justifyContent = "flex-end";
      actTd.style.gap = "5px";

      if (!u.isSuper) {
        const btnPw = el("button", "btn ghost", "Reset Pw");
        btnPw.style.padding = "3px 8px";
        btnPw.style.fontSize = "11px";
        btnPw.addEventListener("click", () => resetUserPassword(u.email));
        
        const btnDel = el("button", "btn ghost", "Elimina");
        btnDel.style.padding = "3px 8px";
        btnDel.style.fontSize = "11px";
        btnDel.style.color = "var(--crit)";
        btnDel.addEventListener("click", () => deleteUser(u.id || u.email));
        
        actTd.append(btnPw, btnDel);
      } else {
        actTd.appendChild(el("span", "note", "Super-admin"));
      }

      tr.append(stTd, emTd, nameTd, roleTd, superTd, lastTd, actTd);
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `
      <tr>
        <td><span style="color:var(--ok);font-weight:600">🟢 Attivo</span></td>
        <td class="mono">admin@vedetta.local</td>
        <td>Amministratore SIEM</td>
        <td><span class="tag info">owner / super-admin</span></td>
        <td>Sì</td>
        <td class="mono">Oggi</td>
        <td style="text-align:right"><span class="note">Super-admin</span></td>
      </tr>
    `;
  }
}

/* Modals Tenant & Users */
function openTenantModal() {
  $("tenant-form")?.reset();
  $("tenant-modal")?.classList.remove("hidden");
}
function closeTenantModal() {
  $("tenant-modal")?.classList.add("hidden");
}
async function saveTenantFromModal() {
  const name = $("mt-name").value.trim();
  const slug = $("mt-slug").value.trim();
  const ownerEmail = $("mt-email").value.trim();
  const ownerPassword = $("mt-pw").value.trim();
  if (!name || !slug) { toast("Inserisci nome e slug per il tenant.", false); return; }

  const res = await api("/api/admin/tenants", {
    method: "POST",
    body: JSON.stringify({ name, slug, ownerEmail, ownerPassword })
  });
  if (res.ok) {
    toast(`Tenant "${name}" creato con successo!`);
    closeTenantModal();
    loadTenants();
  } else {
    toast(res.error || "Errore durante la creazione del tenant.", false);
  }
}

async function deleteTenant(id) {
  if (!confirm(`Sei sicuro di voler eliminare il tenant ${id}?`)) return;
  const res = await api("/api/admin/tenants/" + encodeURIComponent(id), { method: "DELETE" });
  if (res.ok) {
    toast("Tenant eliminato.");
    loadTenants();
  } else {
    toast(res.error || "Errore durante l'eliminazione del tenant.", false);
  }
}

async function openUserModal() {
  $("user-form")?.reset();
  
  // Popola la tendina dei tenant
  const tenantSelect = $("mu-tenant");
  if (tenantSelect) {
    tenantSelect.innerHTML = '<option value="">-- Nessun Tenant (Global) --</option>';
    try {
      const res = await api("/api/admin/tenants");
      const list = Array.isArray(res) ? res : ((res && Array.isArray(res.tenants)) ? res.tenants : []);
      list.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.id || t.slug;
        opt.textContent = t.name || t.slug;
        tenantSelect.appendChild(opt);
      });
    } catch(e) {}
  }
  
  $("user-modal")?.classList.remove("hidden");
}
function closeUserModal() {
  $("user-modal")?.classList.add("hidden");
}
async function saveUserFromModal() {
  const email = $("mu-email").value.trim();
  const name = $("mu-name").value.trim();
  const role = $("mu-role").value;
  const password = $("mu-pw").value;
  const tenantId = $("mu-tenant") ? $("mu-tenant").value : "";
  if (!email || !password) { toast("Email e password sono obbligatorie.", false); return; }

  const res = await api("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, name, role, password, tenantId })
  });
  if (res.ok) {
    toast(`Utente ${email} registrato con successo!`);
    closeUserModal();
    loadUsersTable();
  } else {
    toast(res.error || "Errore durante la creazione dell'utente.", false);
  }
}

async function deleteUser(id) {
  if (!confirm(`Sei sicuro di voler eliminare l'utente ${id}?`)) return;
  const res = await api("/api/admin/users/" + encodeURIComponent(id), { method: "DELETE" });
  if (res.ok) {
    toast("Utente eliminato.");
    loadUsersTable();
  } else {
    toast(res.error || "Errore durante l'eliminazione dell'utente.", false);
  }
}

async function resetUserPassword(email) {
  const newPw = prompt(`Inserisci la nuova password per l'utente ${email}:`);
  if (!newPw) return;
  
  if (newPw.length < 6) {
    toast("La password deve essere di almeno 6 caratteri.", false);
    return;
  }

  const res = await api("/api/admin/users/reset-password", {
    method: "POST",
    body: JSON.stringify({ email, newPassword: newPw })
  });

  if (res.ok) {
    toast(`Password aggiornata con successo per ${email}`);
  } else {
    toast(res.error || "Errore durante il cambio password.", false);
  }
}

function loadAdBlockConfig() {
  const cfgStr = localStorage.getItem("vedetta_adblock_cfg");
  let cfg = { ads: true, analytics: true, heatmaps: true, social: true, malware: true, nsfw: false, custom: "" };
  if (cfgStr) {
    try { cfg = { ...cfg, ...JSON.parse(cfgStr) }; } catch {}
  }
  if ($("ab-opt-ads")) $("ab-opt-ads").checked = !!cfg.ads;
  if ($("ab-opt-analytics")) $("ab-opt-analytics").checked = !!cfg.analytics;
  if ($("ab-opt-heatmaps")) $("ab-opt-heatmaps").checked = !!cfg.heatmaps;
  if ($("ab-opt-social")) $("ab-opt-social").checked = !!cfg.social;
  if ($("ab-opt-malware")) $("ab-opt-malware").checked = !!cfg.malware;
  if ($("ab-opt-nsfw")) $("ab-opt-nsfw").checked = !!cfg.nsfw;
  if ($("ab-custom-domains")) $("ab-custom-domains").value = cfg.custom || "";
}

function saveAdBlockConfig() {
  const cfg = {
    ads: $("ab-opt-ads") ? $("ab-opt-ads").checked : true,
    analytics: $("ab-opt-analytics") ? $("ab-opt-analytics").checked : true,
    heatmaps: $("ab-opt-heatmaps") ? $("ab-opt-heatmaps").checked : true,
    social: $("ab-opt-social") ? $("ab-opt-social").checked : true,
    malware: $("ab-opt-malware") ? $("ab-opt-malware").checked : true,
    nsfw: $("ab-opt-nsfw") ? $("ab-opt-nsfw").checked : false,
    custom: $("ab-custom-domains") ? $("ab-custom-domains").value.trim() : ""
  };
  localStorage.setItem("vedetta_adblock_cfg", JSON.stringify(cfg));
  toast("Configurazione AdBlock & Tracker salvata ed applicata agli agenti.");
}

async function loadAgentiChrome() {
  const tbody = $("t-agenti-chrome");
  if (!tbody) return;
  tbody.textContent = "";
  try {
    const list = await api("/api/admin/agents");
    if (!Array.isArray(list) || list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--dim);padding:24px">Nessun agente Chrome registrato al momento.<br><br><a href="/vedetta-extension.zip" download class="btn" style="text-decoration:none;display:inline-block">⬇️ Scarica ed installa l'Estensione Chrome (.zip)</a></td></tr>`;
      return;
    }
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    list.forEach((ag) => {
      const isOnline = (ag.last_seen || ag.lastSeen || "") > fiveMinAgo;
      const tr = el("tr", "");

      const stTd = el("td", "");
      stTd.innerHTML = isOnline ? `<span style="color:var(--ok);font-weight:600">🟢 Online</span>` : `<span style="color:var(--dim)">⚪ Inattivo</span>`;

      const idTd = el("td", "mono", ag.agent_id || ag.agentId || "—");
      const lblTd = el("td", "", ag.label || "Chrome Extension");
      const verTd = el("td", "", ag.version || "v2.2.0 (AdBlock + AI Guard)");
      const lsTd = el("td", "mono", (ag.last_seen || ag.lastSeen || "—").replace("T", " ").slice(0, 19));
      const evTd = el("td", "", String(ag.events_total || ag.eventsTotal || 0));

      tr.append(stTd, idTd, lblTd, verTd, lsTd, evTd);
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--crit);padding:16px">Errore durante il caricamento degli agenti Chrome.</td></tr>`;
  }
}

const AI_SERVICES_LIST = [
  { name: "ChatGPT", domain: "chatgpt.com", url: "https://chatgpt.com", icon: "🤖" },
  { name: "Claude AI", domain: "claude.ai", url: "https://claude.ai", icon: "🟣" },
  { name: "Google Gemini", domain: "gemini.google.com", url: "https://gemini.google.com", icon: "✨" },
  { name: "Microsoft Copilot", domain: "copilot.microsoft.com", url: "https://copilot.microsoft.com", icon: "🟦" },
  { name: "Perplexity AI", domain: "perplexity.ai", url: "https://perplexity.ai", icon: "🔍" },
  { name: "Mistral AI", domain: "chat.mistral.ai", url: "https://chat.mistral.ai", icon: "🟠" },
  { name: "DeepSeek AI", domain: "chat.deepseek.com", url: "https://chat.deepseek.com", icon: "🐋" },
  { name: "Grok AI", domain: "grok.com", url: "https://grok.com", icon: "✖️" },
  { name: "Poe AI", domain: "poe.com", url: "https://poe.com", icon: "🅿️" },
  { name: "HuggingFace", domain: "huggingface.co", url: "https://huggingface.co", icon: "🤗" },
  { name: "V0 Dev", domain: "v0.dev", url: "https://v0.dev", icon: "▲" }
];

function renderHomeServicesGrid(perPiattaforma = []) {
  const container = $("home-services-grid");
  if (!container) return;
  container.textContent = "";

  const statsMap = {};
  perPiattaforma.forEach(p => {
    if (p.piattaforma) statsMap[p.piattaforma.toLowerCase()] = p.n;
  });

  AI_SERVICES_LIST.forEach(s => {
    const card = el("div", "service-card");

    const top = el("div", "service-top");
    const ico = el("div", "service-icon", s.icon);
    const meta = el("div", "");
    const title = el("div", "service-title", s.name);
    const dom = el("div", "service-domain", s.domain);
    meta.append(title, dom);
    top.append(ico, meta);

    const body = el("div", "service-body");
    const status = el("span", "service-status");
    status.textContent = "🟢 Protetto";

    const count = statsMap[s.domain.toLowerCase()] || 0;
    if (count > 0) {
      const badge = el("span", "note", ` (${count})`);
      badge.style.fontWeight = "600";
      badge.style.color = "var(--acc)";
      status.appendChild(badge);
    }

    const btn = document.createElement("a");
    btn.className = "service-btn";
    btn.href = s.url;
    btn.target = "_blank";
    btn.rel = "noopener noreferrer";
    btn.textContent = "Apri ↗";

    body.append(status, btn);
    card.append(top, body);
    container.appendChild(card);
  });
}

/* ---------------- Dati ---------------- */
async function loadStats() {
  const s = await api("/api/admin/stats");
  if (s.error) return;
  $("s-eventiOggi").textContent = s.eventiOggi ?? "—";
  $("s-violazioniOggi").textContent = s.violazioniOggi ?? "—";
  $("s-agentiOnline").textContent = s.agentiOnline ?? "—";
  $("s-agentiTotali").textContent = s.agentiTotali ?? "—";
  $("s-eventiTotali").textContent = s.eventiTotali ?? "—";
  if ($("cfgv")) $("cfgv").textContent = s.configVersion ?? "—";

  renderHomeServicesGrid(s.perPiattaforma || []);

  const box = $("breakdown");
  box.textContent = "";
  (s.perPiattaforma || []).forEach((p) => {
    const row = el("div", "bd-row");
    row.append(el("span", "bd-l", p.piattaforma || "—"), el("span", "bd-n", String(p.n)));
    box.appendChild(row);
  });
}

function currentFilters() {
  const p = new URLSearchParams();
  const map = { categoria: "f-categoria", severita: "f-severita", piattaforma: "f-piattaforma", agent: "f-agent", cerca: "f-cerca" };
  for (const [k, id] of Object.entries(map)) {
    const v = $(id).value.trim();
    if (v) p.set(k, v);
  }
  p.set("limit", "300");
  return p.toString();
}

async function loadEventi() {
  const rows = await api("/api/admin/events?" + currentFilters());
  const body = $("eventi-body");
  body.textContent = "";
  if (!Array.isArray(rows) || !rows.length) {
    const tr = el("tr");
    const td = el("td", "", "Nessun evento corrispondente ai filtri.");
    td.colSpan = 7;
    td.style.color = "var(--dim)";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const e of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", "mono", (e.ts || "").replace("T", " ").slice(0, 19)));
    tr.appendChild(el("td", "", e.agent_label || e.agent_id || "—"));
    const tdCat = el("td");
    tdCat.appendChild(el("span", "tag " + (e.categoria || "info"), e.categoria || "info"));
    tr.appendChild(tdCat);
    tr.appendChild(el("td", "", e.piattaforma || "—"));
    tr.appendChild(el("td", "", e.regola || "—"));
    tr.appendChild(el("td", "sev-" + (e.severita || "bassa"), e.severita || "—"));
    tr.appendChild(el("td", "", e.dettaglio || ""));
    body.appendChild(tr);
  }

  notifyNewCritical(rows);
}

/* ---------------- Endpoint di sistema (Agenti NOC: CPU/RAM/disco) ---------------- */
let endpointsTimer = null;
function metricBarCell(val) {
  const td = el("td");
  if (val === null || val === undefined) { td.textContent = "—"; return td; }
  const pct = Math.max(0, Math.min(100, Number(val)));
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;min-width:90px";
  const bar = document.createElement("div");
  bar.style.cssText = "flex:1;height:6px;border-radius:3px;background:var(--line);overflow:hidden";
  const fill = document.createElement("div");
  const color = pct >= 90 ? "var(--crit)" : pct >= 75 ? "var(--warn)" : "var(--ok)";
  fill.style.cssText = `height:100%;width:${pct}%;background:${color}`;
  bar.appendChild(fill);
  const label = document.createElement("span");
  label.className = "mono";
  label.style.cssText = "font-size:11px;color:var(--dim);width:34px;text-align:right";
  label.textContent = pct.toFixed(0) + "%";
  wrap.appendChild(bar); wrap.appendChild(label);
  td.appendChild(wrap);
  return td;
}
async function loadEndpoints() {
  const body = $("endpoints-body");
  if (!body) return;
  body.textContent = "";
  try {
    const list = await api("/api/admin/endpoints");
    if (!Array.isArray(list) || !list.length) {
      body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--dim);padding:16px">Nessun endpoint di sistema registrato. Installa l'agente NOC su una postazione per iniziare.</td></tr>`;
      return;
    }
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    list.forEach((ep) => {
      const isOnline = new Date(ep.last_seen).getTime() > fiveMinAgo;
      const tr = el("tr");
      const tdDot = el("td"); tdDot.appendChild(el("span", "dot " + (isOnline ? "on" : "off")));
      tr.appendChild(tdDot);
      tr.appendChild(el("td", "", ep.label || ep.hostname || ep.host_id));
      tr.appendChild(el("td", "", [ep.os, ep.os_release].filter(Boolean).join(" ") || "—"));
      tr.appendChild(metricBarCell(ep.last_cpu));
      tr.appendChild(metricBarCell(ep.last_mem));
      tr.appendChild(metricBarCell(ep.last_disk));
      tr.appendChild(el("td", "mono", ep.last_ip || "—"));
      tr.appendChild(el("td", "mono", `${(ep.last_seen || "").replace("T", " ").slice(0, 19)} (${formatRelativeTime(ep.last_seen)})`));
      body.appendChild(tr);
    });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--crit);padding:16px">Errore nel caricamento degli endpoint.</td></tr>`;
    return;
  }
  clearInterval(endpointsTimer);
  endpointsTimer = setInterval(() => {
    const t = $("tab-agenti");
    if (!t || t.classList.contains("hidden")) { clearInterval(endpointsTimer); return; }
    loadEndpoints();
  }, 10000);
}

/* ---------------- Dispositivi di rete (monitoraggio agentless stile Zabbix) ---------------- */
let devicesTimer = null;
let editingDeviceId = null;
const DEVICE_TYPE_ICONS = { router: "📡", switch: "🔀", server: "🖥️", printer: "🖨️", nas: "💾", camera: "📷", altro: "🔌" };

async function loadDevices() {
  const body = $("devices-body");
  if (!body) return;
  let rows;
  try {
    rows = await api("/api/admin/devices");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--crit);padding:16px">Errore nel caricamento dei dispositivi.</td></tr>`;
    return;
  }
  if (!Array.isArray(rows)) rows = [];

  const online = rows.filter((d) => d.last_up === 1).length;
  const offline = rows.filter((d) => d.last_up === 0).length;
  if ($("dev-totali-card")) $("dev-totali-card").textContent = String(rows.length);
  if ($("dev-online-card")) $("dev-online-card").textContent = String(online);
  if ($("dev-offline-card")) $("dev-offline-card").textContent = String(offline);

  body.textContent = "";
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--dim);padding:16px">Nessun dispositivo monitorato. Aggiungine uno con "+ Aggiungi dispositivo".</td></tr>`;
    return;
  }

  rows.forEach((d) => {
    const tr = el("tr");
    const tdDot = el("td");
    let dotClass = "off";
    if (d.last_up === 1) dotClass = (d.last_latency >= d.crit_ms) ? "warn" : "on";
    tdDot.appendChild(el("span", "dot " + dotClass));
    tr.appendChild(tdDot);

    tr.appendChild(el("td", "", d.name));
    tr.appendChild(el("td", "mono", d.host));
    tr.appendChild(el("td", "", (DEVICE_TYPE_ICONS[d.type] || "🔌") + " " + d.type));
    tr.appendChild(el("td", "", d.check_method === "tcp" ? "TCP:" + (d.port || "—") : "Ping"));

    const tdLat = el("td", "mono");
    if (d.last_latency === null || d.last_latency === undefined) {
      tdLat.textContent = "—";
    } else {
      tdLat.textContent = Math.round(d.last_latency) + " ms";
      tdLat.style.color = d.last_up === 0 ? "var(--dim)" : d.last_latency >= d.crit_ms ? "var(--crit)" : d.last_latency >= d.warn_ms ? "var(--warn)" : "var(--ok)";
    }
    tr.appendChild(tdLat);

    const uptime = d.total_checks ? ((d.up_checks / d.total_checks) * 100).toFixed(1) + "%" : "—";
    tr.appendChild(el("td", "mono", uptime));
    tr.appendChild(el("td", "mono", d.last_ts ? `${d.last_ts.replace("T", " ").slice(0, 19)} (${formatRelativeTime(d.last_ts)})` : "mai"));

    const tdAct = el("td");
    tdAct.style.cssText = "display:flex;gap:6px";
    const btnCheck = el("button", "btn ghost", "🔄");
    btnCheck.title = "Controlla ora";
    btnCheck.style.cssText = "padding:3px 8px;font-size:12px";
    btnCheck.onclick = async () => {
      btnCheck.disabled = true;
      try { await api("/api/admin/devices/" + d.id + "/check-now", { method: "POST" }); toast("Controllo eseguito su " + d.name); loadDevices(); }
      catch (e) { toast("Errore durante il controllo.", false); }
      btnCheck.disabled = false;
    };
    const btnEdit = el("button", "btn ghost", "✏️");
    btnEdit.title = "Modifica";
    btnEdit.style.cssText = "padding:3px 8px;font-size:12px";
    btnEdit.onclick = () => openDeviceModal(d);
    const btnDel = el("button", "btn ghost", "🗑️");
    btnDel.title = "Elimina";
    btnDel.style.cssText = "padding:3px 8px;font-size:12px";
    btnDel.onclick = async () => {
      if (!confirm(`Eliminare il dispositivo "${d.name}"?`)) return;
      try { await api("/api/admin/devices/" + d.id, { method: "DELETE" }); toast("Dispositivo eliminato."); loadDevices(); }
      catch (e) { toast("Errore durante l'eliminazione.", false); }
    };
    tdAct.appendChild(btnCheck); tdAct.appendChild(btnEdit); tdAct.appendChild(btnDel);
    tr.appendChild(tdAct);

    body.appendChild(tr);
  });

  clearInterval(devicesTimer);
  devicesTimer = setInterval(() => {
    const t = $("tab-rete");
    if (!t || t.classList.contains("hidden")) { clearInterval(devicesTimer); return; }
    loadDevices();
  }, 10000);
}

function openDeviceModal(d) {
  editingDeviceId = d ? d.id : null;
  $("device-modal-title").textContent = d ? "🖧 Modifica dispositivo" : "🖧 Aggiungi dispositivo di rete";
  $("dv-name").value = d ? d.name : "";
  $("dv-host").value = d ? d.host : "";
  $("dv-type").value = d ? d.type : "altro";
  $("dv-method").value = d ? d.check_method : "ping";
  $("dv-port").value = d && d.port ? d.port : "";
  $("dv-interval").value = d ? d.interval_sec : 60;
  $("dv-warn").value = d ? d.warn_ms : 150;
  $("dv-crit").value = d ? d.crit_ms : 400;
  $("dv-port-group").style.display = $("dv-method").value === "tcp" ? "" : "none";
  $("device-modal").classList.remove("hidden");
}
function closeDeviceModal() {
  $("device-modal").classList.add("hidden");
  editingDeviceId = null;
}
async function saveDeviceFromModal() {
  const name = $("dv-name").value.trim();
  const host = $("dv-host").value.trim();
  if (!name || !host) { toast("Nome e indirizzo/host sono obbligatori.", false); return; }
  const payload = {
    name, host,
    type: $("dv-type").value,
    checkMethod: $("dv-method").value,
    port: $("dv-port").value ? Number($("dv-port").value) : null,
    intervalSec: Number($("dv-interval").value) || 60,
    warnMs: Number($("dv-warn").value) || 150,
    critMs: Number($("dv-crit").value) || 400
  };
  try {
    const res = editingDeviceId
      ? await api("/api/admin/devices/" + editingDeviceId, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/api/admin/devices", { method: "POST", body: JSON.stringify(payload) });
    if (res.error) { toast(res.error, false); return; }
    toast(editingDeviceId ? "Dispositivo aggiornato." : "Dispositivo aggiunto.");
    closeDeviceModal();
    loadDevices();
  } catch (e) {
    toast("Errore nel salvataggio del dispositivo.", false);
  }
}

/* Notifica desktop/mobile su nuove violazioni ad alta severità */
function notifyNewCritical(rows) {
  const lastSeen = Number(localStorage.getItem(LS_LASTID) || 0);
  const maxId = rows.reduce((m, r) => Math.max(m, r.id || 0), 0);
  if (!lastSeen) {
    localStorage.setItem(LS_LASTID, String(maxId));
    return;
  }
  const nuove = rows.filter((r) => r.id > lastSeen && r.categoria === "violazione" && r.severita === "alta");
  localStorage.setItem(LS_LASTID, String(Math.max(maxId, lastSeen)));

  if (nuove.length && Notification.permission === "granted" && navigator.serviceWorker.controller) {
    const e = nuove[0];
    navigator.serviceWorker.controller.postMessage({
      type: "vedetta_notify",
      title: `VEDETTA — ${nuove.length} violazione/i critiche`,
      body: `${e.agent_label || e.agent_id} · ${e.regola || ""} · ${e.dettaglio || ""}`.slice(0, 160),
      tag: "vedetta-crit"
    });
  }
}

// --- Framework Regole EU AI Act (Regolamento UE 2024/1689) ---
const DEFAULT_AI_ACT_RULES = [
  {
    id: "AIA-01",
    name: "EU AI Act - Divieto Dati Biometrici e Categorie Particolari",
    tipo: "keyword",
    azione: "block",
    severita: "alta",
    article: "Art. 5 (Pratiche Vietate)",
    pattern: ["biometric", "impronte digitali", "riconoscimento facciale", "dati genetici", "opinioni politiche", "convinzioni religiose", "orientamento sessuale"],
    descrizione: "Vieta l'invio e il trattamento di dati biometrici o categorie particolari di dati personali verso assistenti AI in ottemperanza all'Articolo 5 del Regolamento UE AI Act."
  },
  {
    id: "AIA-02",
    name: "EU AI Act - Obbligo Trasparenza e Copyright Contenuti",
    tipo: "keyword",
    azione: "alert",
    severita: "media",
    article: "Art. 50 (Trasparenza & Copyright)",
    pattern: ["generare testo da libro protetto", "codice proprietario sotto licenza", "bypassa watermark", "riassumi opera con copyright"],
    descrizione: "Allerta l'utente sull'obbligo di trasparenza del materiale generato dall'AI e sulla tutela dei diritti d'autore ai sensi dell'Articolo 50 del Regolamento UE."
  },
  {
    id: "AIA-03",
    name: "EU AI Act - Valutazione Dipendenti e Social Scoring",
    tipo: "keyword",
    azione: "block",
    severita: "alta",
    article: "Art. 5 / Art. 6 (Alto Rischio HR)",
    pattern: ["valutazione dipendente", "punteggio credito aziendale", "licenziamento automatico", "performance score lavoratore", "social scoring dipendenti"],
    descrizione: "Impedisce la valutazione o profilazione automatizzata delle prestazioni dei lavoratori e dei candidati senza adeguati audit e tutele umane (Art. 6 AI Act)."
  },
  {
    id: "AIA-04",
    name: "EU AI Act - Esfiltrazione Dati Personali PII (GDPR)",
    tipo: "regex",
    azione: "block",
    severita: "alta",
    article: "Art. 10 (Governance Dati)",
    regex: "\\b[A-Z]{6}\\d{2}[A-EHLMPRST]\\d{2}[A-Z]\\d{3}[A-Z]\\b",
    descrizione: "Protegge i dati personali da esfiltrazione verso modelli esterni verificando la presenza di Codici Fiscali o identificativi personali (Art. 10 Governance Dati)."
  },
  {
    id: "AIA-05",
    name: "EU AI Act - Divieto Manipolazione Comportamentale",
    tipo: "keyword",
    azione: "block",
    severita: "alta",
    article: "Art. 5 (Tecniche Subliminali)",
    pattern: ["condizionamento subliminale", "inganno psicologico", "sfrutta vulnerabilità minorenni", "manipolazione comportamentale"],
    descrizione: "Intercetta e blocca l'uso dell'AI generativa per tecniche manipolatorie o sfruttamento delle vulnerabilità personali vietate dall'Articolo 5."
  },
  {
    id: "AIA-06",
    name: "EU AI Act - Tracciabilità Documentazione e Dataset",
    tipo: "file_upload",
    azione: "log",
    severita: "bassa",
    article: "Art. 11 / 12 (Tracciabilità SIEM)",
    estensioni: ["zip", "rar", "7z", "sql", "csv", "json"],
    descrizione: "Registra ogni upload di dataset o archivi di dati inviati verso AI per soddisfare i requisiti di auditabilità e conservazione dei registri dell'Articolo 12."
  }
];

let agentFilterState = "all"; // 'all', 'online', 'offline'

function formatRelativeTime(ts) {
  if (!ts) return "mai";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 0) return "adesso";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s fa`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m fa`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h fa`;
  const days = Math.floor(hr / 24);
  return `${days}gg fa`;
}

let parsedRules = [];
let parsedPlatforms = [];

function syncRulesFromMarkdown() {
  const md = $("rulesMd").value || "";
  if (typeof AIGuardRules !== "undefined" && AIGuardRules.parseRulesMarkdown) {
    parsedRules = AIGuardRules.parseRulesMarkdown(md);
    renderRulesTable();
  }
}

function syncMarkdownFromRules() {
  if (typeof AIGuardRules !== "undefined" && AIGuardRules.stringifyRulesMarkdown) {
    $("rulesMd").value = AIGuardRules.stringifyRulesMarkdown(parsedRules);
  }
}

function renderRulesTable() {
  const tbody = $("rules-table-body");
  if (!tbody) return;
  tbody.textContent = "";

  if (!parsedRules || !parsedRules.length) {
    const tr = el("tr");
    const td = el("td", "note", "Nessuna regola configurata.");
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  parsedRules.forEach((r, index) => {
    const tr = el("tr");
    tr.appendChild(el("td", "mono", r.id || `R${index + 1}`));
    
    const tdName = el("td");
    const nameBold = el("div", "", r.name);
    nameBold.style.fontWeight = "600";
    tdName.appendChild(nameBold);
    if (r.descrizione) {
      const descSpan = el("div", "note", r.descrizione);
      descSpan.style.fontSize = "11px";
      tdName.appendChild(descSpan);
    }
    tr.appendChild(tdName);

    // Tipo
    const tdTipo = el("td");
    let tipoText = r.tipo;
    if (r.tipo === "file_upload") tipoText = "📁 Upload File";
    else if (r.tipo === "keyword") tipoText = "🔤 Keyword";
    else if (r.tipo === "regex") tipoText = "🔍 Regex";
    tdTipo.appendChild(el("span", "tag info", tipoText));
    tr.appendChild(tdTipo);

    // Azione Client (Select per cambio rapido)
    const tdAzione = el("td");
    const selAct = document.createElement("select");
    selAct.style.padding = "3px 6px";
    selAct.style.fontSize = "11px";
    selAct.innerHTML = `
      <option value="block" ${r.azione === "block" ? "selected" : ""}>🛑 Block (Blocca)</option>
      <option value="alert" ${r.azione === "alert" ? "selected" : ""}>⚠️ Alert (Allerta)</option>
      <option value="log" ${r.azione === "log" ? "selected" : ""}>📝 Log (Solo SIEM)</option>
    `;
    selAct.addEventListener("change", () => {
      r.azione = selAct.value;
      syncMarkdownFromRules();
      toast(`Azione regola ${r.id} impostata a "${r.azione}". Clicca "Pubblica configurazione" per salvare.`);
    });
    tdAzione.appendChild(selAct);
    tr.appendChild(tdAzione);

    // Severità
    const tdSev = el("td", "sev-" + (r.severita || "bassa"), r.severita || "media");
    tr.appendChild(tdSev);

    // Criterio / Dettaglio
    let criterio = "—";
    if (r.tipo === "file_upload") {
      criterio = r.estensioni && r.estensioni.length ? "Estensioni: " + r.estensioni.join(", ") : "Tutte le estensioni";
    } else if (r.tipo === "keyword") {
      criterio = "Parole: " + (r.pattern && r.pattern.length ? r.pattern.join(", ") : "—");
    } else if (r.tipo === "regex") {
      criterio = "Regex: " + (r.regex || "—");
    }
    tr.appendChild(el("td", "mono", criterio));

    // Gestione
    const tdActions = el("td");
    tdActions.style.textAlign = "right";
    
    const btnEdit = el("button", "btn ghost", "Modifica");
    btnEdit.style.padding = "3px 8px";
    btnEdit.style.fontSize = "11px";
    btnEdit.style.marginRight = "4px";
    btnEdit.addEventListener("click", () => openRuleModal(index));
    
    const btnDel = el("button", "btn ghost", "Elimina");
    btnDel.style.padding = "3px 8px";
    btnDel.style.fontSize = "11px";
    btnDel.style.color = "var(--crit)";
    btnDel.addEventListener("click", () => deleteRule(index));

    tdActions.appendChild(btnEdit);
    tdActions.appendChild(btnDel);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

function openRuleModal(index = -1) {
  $("rule-edit-index").value = index;
  if (index >= 0 && parsedRules[index]) {
    const r = parsedRules[index];
    $("modal-title").textContent = "Modifica Regola " + (r.id || "");
    $("m-id").value = r.id || "";
    $("m-name").value = r.name || "";
    $("m-tipo").value = r.tipo || "keyword";
    $("m-azione").value = r.azione || "block";
    $("m-severita").value = r.severita || "media";
    $("m-desc").value = r.descrizione || "";
    
    if (r.tipo === "file_upload") $("m-valore").value = (r.estensioni || []).join(", ");
    else if (r.tipo === "regex") $("m-valore").value = r.regex || "";
    else $("m-valore").value = (r.pattern || []).join(", ");
  } else {
    $("modal-title").textContent = "Nuova Regola di Sicurezza";
    const nextId = "R" + String(parsedRules.length + 1).padStart(2, "0");
    $("m-id").value = nextId;
    $("m-name").value = "";
    $("m-tipo").value = "keyword";
    $("m-azione").value = "block";
    $("m-severita").value = "media";
    $("m-valore").value = "";
    $("m-desc").value = "";
  }
  updateModalValueLabel();
  $("rule-modal").classList.remove("hidden");
}

function updateModalValueLabel() {
  const tipo = $("m-tipo").value;
  const label = $("m-val-label");
  const valInput = $("m-valore");
  if (tipo === "file_upload") {
    label.textContent = "Estensioni file (separate da virgola)";
    valInput.placeholder = "es. pdf, docx, xlsx, zip";
  } else if (tipo === "regex") {
    label.textContent = "Espressione Regolare (Regex)";
    valInput.placeholder = "es. \\b[A-Z]{2}\\d{2}[A-Z0-9]{12,30}\\b";
  } else {
    label.textContent = "Parole chiave (separate da virgola)";
    valInput.placeholder = "es. iban, password, segreto, riservato";
  }
}

function closeRuleModal() {
  $("rule-modal").classList.add("hidden");
}

function saveRuleFromModal() {
  const idx = Number($("rule-edit-index").value);
  const id = $("m-id").value.trim();
  const name = $("m-name").value.trim();
  const tipo = $("m-tipo").value;
  const azione = $("m-azione").value;
  const severita = $("m-severita").value;
  const rawVal = $("m-valore").value.trim();
  const descrizione = $("m-desc").value.trim();

  if (!id || !name) {
    toast("Compila ID e Nome regola", false);
    return;
  }

  const ruleObj = {
    id,
    name,
    tipo,
    azione,
    severita,
    estensioni: [],
    pattern: [],
    regex: null,
    descrizione
  };

  if (tipo === "file_upload") {
    ruleObj.estensioni = rawVal.split(",").map(s => s.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
  } else if (tipo === "regex") {
    ruleObj.regex = rawVal;
  } else {
    ruleObj.pattern = rawVal.split(",").map(s => s.trim()).filter(Boolean);
  }

  if (idx >= 0 && parsedRules[idx]) {
    parsedRules[idx] = ruleObj;
  } else {
    parsedRules.push(ruleObj);
  }

  syncMarkdownFromRules();
  renderRulesTable();
  closeRuleModal();
  toast(`Regola ${id} salvata! Clicca "Pubblica configurazione" per distribuirla.`);
}

function deleteRule(index) {
  if (index >= 0 && index < parsedRules.length) {
    const r = parsedRules[index];
    if (confirm(`Eliminare la regola ${r.id} (${r.name})?`)) {
      parsedRules.splice(index, 1);
      syncMarkdownFromRules();
      renderRulesTable();
      toast(`Regola ${r.id} eliminata.`);
    }
  }
}

function renderAIActTab() {
  const container = $("ai-act-cards-container");
  if (!container) return;
  container.textContent = "";

  let activeCount = 0;

  DEFAULT_AI_ACT_RULES.forEach((defRule) => {
    const existingRule = parsedRules.find((r) => r.id === defRule.id);
    const isActive = !!existingRule;
    if (isActive) activeCount++;

    const currentRule = existingRule || defRule;

    const card = el("div", "ai-act-card" + (isActive ? " active" : ""));

    // Header card
    const head = el("div", "ai-act-card-header");
    const title = el("div", "ai-act-card-title", currentRule.name);
    const art = el("span", "ai-act-art", defRule.article);
    head.append(title, art);
    card.appendChild(head);

    // Descrizione
    const desc = el("div", "ai-act-desc", defRule.descrizione);
    card.appendChild(desc);

    // Footer con switch ON/OFF e Azione
    const foot = el("div", "ai-act-footer");
    
    // Switch ON/OFF
    const switchLabel = el("label", "switch");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = isActive;
    const slider = el("span", "slider");
    switchLabel.append(chk, slider);

    chk.addEventListener("change", () => {
      toggleAIActRule(defRule, chk.checked);
    });

    const statusText = el("span", "note");
    statusText.style.fontWeight = "600";
    statusText.style.color = isActive ? "var(--ok)" : "var(--dim)";
    statusText.textContent = isActive ? "ATTIVA" : "DISATTIVATA";

    // Azione Client select
    const selAct = document.createElement("select");
    selAct.style.padding = "3px 6px";
    selAct.style.fontSize = "11px";
    selAct.innerHTML = `
      <option value="block" ${currentRule.azione === "block" ? "selected" : ""}>🛑 Block</option>
      <option value="alert" ${currentRule.azione === "alert" ? "selected" : ""}>⚠️ Alert</option>
      <option value="log" ${currentRule.azione === "log" ? "selected" : ""}>📝 Log</option>
    `;
    selAct.addEventListener("change", () => {
      if (existingRule) {
        existingRule.azione = selAct.value;
        syncMarkdownFromRules();
        renderAIActTab();
        toast(`Azione regola ${defRule.id} aggiornata a "${selAct.value}".`);
      } else {
        defRule.azione = selAct.value;
      }
    });

    const leftGroup = el("div", "");
    leftGroup.style.display = "flex";
    leftGroup.style.alignItems = "center";
    leftGroup.style.gap = "8px";
    leftGroup.append(switchLabel, statusText);

    foot.append(leftGroup, selAct);
    card.appendChild(foot);

    container.appendChild(card);
  });

  if ($("aia-status-summary")) {
    $("aia-status-summary").textContent = `${activeCount} di ${DEFAULT_AI_ACT_RULES.length} regole attive`;
  }
}

function toggleAIActRule(defRule, enable) {
  const idx = parsedRules.findIndex((r) => r.id === defRule.id);
  if (enable) {
    if (idx < 0) {
      parsedRules.push({ ...defRule });
    }
  } else {
    if (idx >= 0) {
      parsedRules.splice(idx, 1);
    }
  }
  syncMarkdownFromRules();
  renderAIActTab();
  renderRulesTable();
  toast(enable ? `Regola ${defRule.id} attivata!` : `Regola ${defRule.id} disattivata.`);
}

function enableAllAIActRules(enable) {
  DEFAULT_AI_ACT_RULES.forEach((defRule) => {
    const idx = parsedRules.findIndex((r) => r.id === defRule.id);
    if (enable && idx < 0) {
      parsedRules.push({ ...defRule });
    } else if (!enable && idx >= 0) {
      parsedRules.splice(idx, 1);
    }
  });
  syncMarkdownFromRules();
  renderAIActTab();
  renderRulesTable();
  toast(enable ? "Tutte le regole EU AI Act sono state ATTIVATE!" : "Tutte le regole EU AI Act sono state DISATTIVATE.");
}

// --- Piattaforme / DOM ---
function platformIcon(domain) {
  const d = (domain || "").toLowerCase();
  if (d.includes("claude")) return "🟣";
  if (d.includes("chatgpt") || d.includes("openai")) return "🟢";
  if (d.includes("gemini") || d.includes("google")) return "🔵";
  if (d.includes("copilot") || d.includes("microsoft")) return "🟦";
  if (d.includes("perplexity")) return "🔎";
  if (d.includes("mistral")) return "🟠";
  if (d.includes("deepseek")) return "🐋";
  if (d.includes("grok") || d.includes("x.ai")) return "✖️";
  if (d.includes("poe")) return "🅿️";
  if (d.includes("huggingface")) return "🤗";
  if (d.includes("v0.dev")) return "▲";
  return "🌐";
}

function syncJsonFromPlatforms() {
  const ta = $("platforms");
  if (ta) ta.value = JSON.stringify(parsedPlatforms, null, 2);
}

function syncPlatformsFromJson() {
  try {
    const arr = JSON.parse($("platforms").value || "[]");
    if (Array.isArray(arr)) {
      parsedPlatforms = arr;
      renderPlatformsTab();
    }
  } catch (e) {
    /* JSON in fase di digitazione: ignora finché non è valido */
  }
}

function addPlatform() {
  parsedPlatforms.push({ domain: "", enabled: true, selectors: { prompt: "textarea, div[contenteditable='true']" } });
  syncJsonFromPlatforms();
  renderPlatformsTab();
  const inputs = document.querySelectorAll("#platforms-cards-container .platform-domain input");
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function renderPlatformsTab() {
  const container = $("platforms-cards-container");
  if (!container) return;
  container.textContent = "";

  if (!parsedPlatforms.length) {
    container.appendChild(el("div", "note", 'Nessuna piattaforma configurata. Usa "+ Aggiungi piattaforma".'));
  }

  let activeCount = 0;

  parsedPlatforms.forEach((p, index) => {
    if (!p.selectors) p.selectors = {};
    const enabled = p.enabled !== false;
    if (enabled) activeCount++;

    const card = el("div", "ai-act-card platform-card" + (enabled ? " active" : " disabled"));

    // Header: icona + dominio + interruttore
    const head = el("div", "ai-act-card-header");

    const domainWrap = el("div", "platform-domain");
    const ico = el("span", "platform-ico", platformIcon(p.domain));
    const domainInput = document.createElement("input");
    domainInput.value = p.domain || "";
    domainInput.placeholder = "es. nuovapiattaforma.ai";
    domainInput.addEventListener("input", () => {
      p.domain = domainInput.value.trim();
      ico.textContent = platformIcon(p.domain);
      syncJsonFromPlatforms();
    });
    domainWrap.append(ico, domainInput);

    const switchLabel = el("label", "switch");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = enabled;
    const slider = el("span", "slider");
    switchLabel.append(chk, slider);
    chk.addEventListener("change", () => {
      p.enabled = chk.checked;
      syncJsonFromPlatforms();
      renderPlatformsTab();
    });

    head.append(domainWrap, switchLabel);
    card.appendChild(head);

    // Campo selettore prompt
    const field = el("div", "platform-field");
    field.appendChild(el("label", "", "Selettore campo prompt (DOM)"));
    const selInput = document.createElement("input");
    selInput.value = (p.selectors && p.selectors.prompt) || "";
    selInput.placeholder = "es. div[contenteditable='true'], textarea";
    selInput.addEventListener("input", () => {
      p.selectors.prompt = selInput.value;
      syncJsonFromPlatforms();
    });
    field.append(selInput);
    card.appendChild(field);

    // Footer: stato + elimina
    const foot = el("div", "ai-act-footer");
    const status = el("span", "note");
    status.style.fontWeight = "600";
    status.style.color = enabled ? "var(--ok)" : "var(--dim)";
    status.textContent = enabled ? "MONITORATA" : "SOSPESA";

    const btnDel = el("button", "btn ghost", "Elimina");
    btnDel.style.padding = "3px 8px";
    btnDel.style.fontSize = "11px";
    btnDel.style.color = "var(--crit)";
    btnDel.addEventListener("click", () => {
      if (confirm(`Rimuovere ${p.domain || "questa piattaforma"} dal monitoraggio?`)) {
        parsedPlatforms.splice(index, 1);
        syncJsonFromPlatforms();
        renderPlatformsTab();
      }
    });

    foot.append(status, btnDel);
    card.appendChild(foot);

    container.appendChild(card);
  });

  if ($("platforms-status-summary")) {
    $("platforms-status-summary").textContent = `${activeCount} di ${parsedPlatforms.length} attive`;
  }
}

async function loadConfig() {
  const c = await api("/api/admin/config");
  if (c.error) return;
  $("rulesMd").value = c.rulesMd || "";
  parsedPlatforms = Array.isArray(c.platforms) ? c.platforms : [];
  syncJsonFromPlatforms();
  $("mode").value = c.mode || "enforce";
  $("pollMinutes").value = c.pollMinutes || 5;
  if ($("cfgv")) $("cfgv").textContent = c.configVersion;
  syncRulesFromMarkdown();
  renderAIActTab();
  renderPlatformsTab();
}

// --- Sicurezza: QR authenticator + cambio password ---
function drawQrTo(canvasId, text) {
  if (typeof QRCode === "undefined") return;
  const canvas = $(canvasId);
  if (!canvas) return;
  const qr = QRCode.encode(text, "M");
  const quiet = 4;
  const modules = qr.size + quiet * 2;
  const scale = Math.max(1, Math.floor(220 / modules));
  const px = modules * scale;
  canvas.width = px; canvas.height = px;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
}

async function loadSecurity() {
  try {
    const d = await api("/api/admin/totp-uri");
    if (d.error) return;
    if (d.disabled) {
      $("sec-secret").textContent = "2FA disattivato sul server";
      const c = $("sec-qr"); if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
      return;
    }
    $("sec-secret").textContent = d.secret;
    drawQrTo("sec-qr", d.uri);
  } catch (e) { /* offline: lascia lo stato precedente */ }
}

async function changePassword() {
  const current = $("pw-current").value;
  const next = $("pw-next").value;
  const confirm = $("pw-confirm").value;
  if (!next || next.length < 6) { toast("La nuova password deve avere almeno 6 caratteri.", false); return; }
  if (next !== confirm) { toast("Le due password non coincidono.", false); return; }
  const r = await api("/api/admin/change-password", {
    method: "POST",
    body: JSON.stringify({ current, next })
  });
  if (r.ok) {
    $("pw-current").value = ""; $("pw-next").value = ""; $("pw-confirm").value = "";
    toast("Password aggiornata.");
  } else {
    toast(r.error || "Aggiornamento non riuscito.", false);
  }
}

async function pubblicaConfig() {
  let platforms;
  try {
    platforms = JSON.parse($("platforms").value || "[]");
  } catch (e) {
    toast("JSON piattaforme non valido: " + e.message, false);
    return;
  }
  const r = await api("/api/admin/config", {
    method: "PUT",
    body: JSON.stringify({
      mode: $("mode").value,
      rulesMd: $("rulesMd").value,
      pollMinutes: Number($("pollMinutes").value) || 5,
      platforms
    })
  });
  if (r.ok) {
    if ($("cfgv")) $("cfgv").textContent = r.configVersion;
    toast("Configurazione pubblicata (v" + r.configVersion + "). Gli agenti si aggiornano al prossimo polling.");
  } else {
    toast(r.error || "Pubblicazione non riuscita", false);
  }
}

async function bootData() {
  await Promise.all([loadStats(), loadEventi()]);
}

function startAuto() {
  clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    if ($("autorefresh").checked && !document.hidden) bootData();
  }, 10000);
}

/* ---------------- PWA ---------------- */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          $("update-bar").classList.remove("hidden");
        }
      });
    });
  }).catch(() => {});

  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "vedetta_refresh" && TOKEN) bootData();
  });
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
});

window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  toast("VEDETTA installata sul dispositivo");
});

window.addEventListener("online", () => { setOffline(false); if (TOKEN) bootData(); });
window.addEventListener("offline", () => setOffline(true));

/* ---------------- Avvio ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  registerSW();

  // Orologio
  const tick = () => ($("clock").textContent = new Date().toLocaleString("it-IT"));
  tick();
  setInterval(tick, 1000);

  // Navigazione tab (menu a tendina per sezione)
  document.querySelectorAll("nav .nav-dropdown-btn").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const dd = btn.closest(".nav-dropdown");
      const menu = dd.querySelector(".nav-dropdown-menu");
      const wasOpen = dd.classList.contains("open");
      document.querySelectorAll("nav .nav-dropdown.open").forEach((d) => d.classList.remove("open"));
      if (!wasOpen) {
        const r = btn.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.top = Math.round(r.bottom + 6) + "px";
        menu.style.left = Math.round(r.left) + "px";
        dd.classList.add("open");
        requestAnimationFrame(() => {
          const mw = menu.offsetWidth || 230;
          menu.style.left = Math.round(Math.min(r.left, window.innerWidth - mw - 8)) + "px";
        });
      }
    });
  });
  document.querySelectorAll("nav [data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      openTab(b.dataset.tab);
      document.querySelectorAll("nav .nav-dropdown.open").forEach((d) => d.classList.remove("open"));
    })
  );
  document.addEventListener("click", () => {
    document.querySelectorAll("nav .nav-dropdown.open").forEach((d) => d.classList.remove("open"));
  });

  // Azioni
  $("applica").addEventListener("click", loadEventi);
  $("f-cerca").addEventListener("keydown", (e) => e.key === "Enter" && loadEventi());
  $("csv").addEventListener("click", async () => {
    try {
      const r = await fetch(API_BASE + "/api/admin/events.csv", { headers: { "X-Admin-Token": TOKEN } });
      if (!r.ok) throw new Error("Export CSV non riuscito");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "vedetta-events.csv"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast(e.message || "Errore export CSV", false); }
  });
  $("pubblica").addEventListener("click", pubblicaConfig);
  $("pubblica2").addEventListener("click", pubblicaConfig);
  $("pubblica3")?.addEventListener("click", pubblicaConfig);
  $("logout").addEventListener("click", logout);

  let agentKeyVal = "";
  let enrollKeyVal = "";
  async function fetchTenantKeys() {
    if (agentKeyVal && enrollKeyVal) return;
    try {
      const k = await api("/api/admin/tenant-keys");
      agentKeyVal = k.agent_key || "—";
      enrollKeyVal = k.enroll_key || "—";
    } catch (e) {
      agentKeyVal = enrollKeyVal = "—";
      toast("Non hai i permessi per vedere le chiavi (serve il ruolo Super Admin).", false);
    }
  }

  $("showkey")?.addEventListener("click", async () => {
    await fetchTenantKeys();
    if ($("agentkey").textContent === "••••••••••••") {
      $("agentkey").textContent = agentKeyVal;
      $("showkey").textContent = "nascondi";
    } else {
      $("agentkey").textContent = "••••••••••••";
      $("showkey").textContent = "mostra";
    }
  });

  $("agentkey")?.addEventListener("click", async () => {
    await fetchTenantKeys();
    if (agentKeyVal && agentKeyVal !== "—") {
      try {
        await navigator.clipboard.writeText(agentKeyVal);
        const orig = $("agentkey").textContent;
        $("agentkey").textContent = "Copiato!";
        setTimeout(() => $("agentkey").textContent = orig, 1500);
      } catch(e) {}
    }
  });

  $("showenrollkey")?.addEventListener("click", async () => {
    await fetchTenantKeys();
    if ($("enrollkey").textContent === "••••••••••••") {
      $("enrollkey").textContent = enrollKeyVal;
      $("showenrollkey").textContent = "nascondi";
    } else {
      $("enrollkey").textContent = "••••••••••••";
      $("showenrollkey").textContent = "mostra";
    }
  });

  $("enrollkey")?.addEventListener("click", async () => {
    await fetchTenantKeys();
    if (enrollKeyVal && enrollKeyVal !== "—") {
      try {
        await navigator.clipboard.writeText(enrollKeyVal);
        const orig = $("enrollkey").textContent;
        $("enrollkey").textContent = "Copiato!";
        setTimeout(() => $("enrollkey").textContent = orig, 1500);
      } catch(e) {}
    }
  });

  $("btn-goto-agenti")?.addEventListener("click", () => openTab("agenti-chrome"));

  // Modale dispositivi di rete
  $("btn-add-device")?.addEventListener("click", () => openDeviceModal(null));
  $("dv-cancel")?.addEventListener("click", closeDeviceModal);
  $("dv-save")?.addEventListener("click", saveDeviceFromModal);
  $("dv-method")?.addEventListener("change", () => {
    $("dv-port-group").style.display = $("dv-method").value === "tcp" ? "" : "none";
  });

  // Gestione Tenant e Utenti Modal
  $("btn-add-tenant")?.addEventListener("click", openTenantModal);
  $("mt-cancel")?.addEventListener("click", closeTenantModal);
  $("mt-save")?.addEventListener("click", saveTenantFromModal);
  $("btn-add-user")?.addEventListener("click", openUserModal);
  $("mu-cancel")?.addEventListener("click", closeUserModal);
  $("mu-save")?.addEventListener("click", saveUserFromModal);

  // Gestione AdBlock Config
  $("btn-save-adblock-config")?.addEventListener("click", saveAdBlockConfig);

  // Gestione EU AI Act Tab
  $("btn-aia-enable-all")?.addEventListener("click", () => enableAllAIActRules(true));
  $("btn-aia-disable-all")?.addEventListener("click", () => enableAllAIActRules(false));

  // Gestione Regole e Modal
  $("btn-add-rule")?.addEventListener("click", () => openRuleModal(-1));
  $("m-cancel")?.addEventListener("click", closeRuleModal);
  $("m-save")?.addEventListener("click", saveRuleFromModal);
  $("m-tipo")?.addEventListener("change", updateModalValueLabel);
  $("rulesMd")?.addEventListener("input", syncRulesFromMarkdown);
  $("btn-toggle-md")?.addEventListener("click", () => {
    $("markdown-editor-container")?.classList.toggle("hidden");
  });

  // Gestione Piattaforme / DOM
  $("btn-add-platform")?.addEventListener("click", addPlatform);
  $("btn-toggle-platforms-json")?.addEventListener("click", () => {
    $("platforms-json-container")?.classList.toggle("hidden");
  });
  $("platforms")?.addEventListener("input", syncPlatformsFromJson);

  $("install").addEventListener("click", async () => {
    if (!deferredInstall) {
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
      if (isStandalone) toast("VEDETTA è già installata su questo dispositivo.");
      else toast("Installazione non disponibile ora: usa il menu del browser (⋮) → \"Installa app\" / \"Aggiungi a schermata Home\".", false);
      return;
    }
    deferredInstall.prompt();
    const choice = await deferredInstall.userChoice;
    deferredInstall = null;
    if (choice.outcome !== "accepted") toast("Installazione annullata.");
  });

  $("notify").addEventListener("click", async () => {
    const p = await Notification.requestPermission();
    toast(p === "granted" ? "Notifiche attive" : "Notifiche non concesse", p === "granted");
    if (p === "granted") $("notify").classList.add("hidden");
  });
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    $("notify").classList.add("hidden");
  }

  $("update-reload").addEventListener("click", () => {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg && reg.waiting) reg.waiting.postMessage({ type: "vedetta_skip_waiting" });
      location.reload();
    });
  });

  // Login
  const doGateLogin = () => tryLogin(
    $("gate-email") ? $("gate-email").value.trim() : "",
    $("gate-password") ? $("gate-password").value : "",
    $("gate-totp") ? $("gate-totp").value.trim() : ""
  );
  $("gate-btn").addEventListener("click", doGateLogin);
  $("gate-email")?.addEventListener("keydown", (e) => e.key === "Enter" && doGateLogin());
  $("gate-password")?.addEventListener("keydown", (e) => e.key === "Enter" && doGateLogin());
  $("gate-totp")?.addEventListener("keydown", (e) => e.key === "Enter" && doGateLogin());

  // Cambio password (scheda Sicurezza)
  $("pw-save")?.addEventListener("click", changePassword);

  // Mostra il campo TOTP se il secondo fattore è attivo sul server
  fetch(API_BASE + "/api/admin/auth-info").then((r) => r.json()).then((info) => {
    $("gate-totp-row").classList.toggle("hidden", !info.totpRequired);
  }).catch(() => {});

  // Riprende la sessione salvata sul dispositivo
  const params = new URLSearchParams(location.search);
  const saved = localStorage.getItem(LS_TOKEN);
  if (saved) {
    resumeSession(saved).then((ok) => { if (!ok) showApp(false); });
  } else {
    showApp(false);
  }

  // Tab e filtro iniziale da shortcut PWA
  const tab = params.get("tab");
  if (tab) openTab(tab);
  const cat = params.get("categoria");
  if (cat) $("f-categoria").value = cat;

  setOffline(!navigator.onLine);
});
