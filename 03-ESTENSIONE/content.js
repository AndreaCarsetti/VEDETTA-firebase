/**
 * AI Usage Guard v2 — content script
 * Regole, modalità e selettori DOM arrivano dalla console VEDETTA.
 * Gli hook usano eventi standard in fase di capture: restano validi anche
 * quando la piattaforma AI cambia interfaccia. I selettori configurati
 * servono solo come aggancio aggiuntivo al campo prompt.
 */
(function () {
  "use strict";

  const HOST = location.hostname;
  let RULES = [];
  let MODE = "enforce"; // di default le regole "block" bloccano davvero
  let SELECTORS = "";
  let lastScan = 0;

  function loadConfig() {
    chrome.runtime.sendMessage({ type: "aiguard_get_config" }, (cfg) => {
      if (chrome.runtime.lastError || !cfg) return;
      MODE = cfg.mode || "enforce";
      RULES = AIGuardRules.compileRules(AIGuardRules.parseRulesMarkdown(cfg.rulesMd || ""));
      rebuildBlockedExtRegex();
      const p = (cfg.platforms || []).find(
        (x) => HOST === x.domain || HOST.endsWith("." + x.domain)
      );
      SELECTORS = (p && p.selectors && p.selectors.prompt) || "";
      attachPromptWatcher();
    });
  }
  loadConfig();
  window.addEventListener("focus", loadConfig);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "aiguard_config_updated") loadConfig();
    if (msg.type === "aiguard_page_security") {
      try { sendResponse({ ok: true, host: HOST, url: location.href, ...computeSecurity() }); }
      catch (e) { sendResponse({ ok: false }); }
    }
  });

  /* ---------- Utilità ---------- */
  function report(rule, dettaglio, categoria) {
    try {
      chrome.runtime.sendMessage({
        type: "aiguard_event",
        categoria: categoria || "violazione",
        piattaforma: HOST,
        url: location.href,
        regola: rule ? `${rule.id} — ${rule.name}` : "-",
        azione: rule ? rule.azione : "log",
        severita: rule ? rule.severita : "bassa",
        dettaglio
      });
    } catch (e) { /* contesto estensione invalidato */ }
  }

  /* ---------- Funzioni speciali: insight di sicurezza (read-only, passivi) ---------- */
  let scanned = false;
  const eTLD1 = (host) => { const p = String(host || "").split("."); return p.length <= 2 ? host : p.slice(-2).join("."); };
  const AI_HINTS = ["openai", "anthropic", "claude", "gemini", "perplexity", "mistral", "deepseek", "x.ai", "grok", "huggingface", "cohere", "poe.com"];
  const TRACKER_HINTS = ["google-analytics", "googletagmanager", "doubleclick", "facebook", "fbcdn", "hotjar", "segment", "mixpanel", "amplitude", "fullstory", "clarity.ms", "adservice", "criteo", "taboola", "yandex", "matomo"];
  function classifyHost(h) {
    const s = String(h).toLowerCase();
    if (AI_HINTS.some((k) => s.includes(k))) return "AI";
    if (TRACKER_HINTS.some((k) => s.includes(k))) return "tracker";
    return "terza-parte";
  }

  function reportInsight(regola, severita, dettaglio) {
    try {
      chrome.runtime.sendMessage({
        type: "aiguard_event",
        categoria: "sicurezza",
        piattaforma: HOST,
        url: location.href,
        regola,
        azione: "log",
        severita,
        dettaglio
      });
    } catch (e) { /* contesto invalidato */ }
  }

  // Analizza SOLO la pagina già aperta dall'utente: protocollo, contenuto misto,
  // campi password, meta-CSP e domini di terze parti. Nessuna scansione attiva di rete.
  function computeSecurity() {
    const https = location.protocol === "https:";
    const base = eTLD1(location.hostname);
    let mixed = 0;
    const thirdHosts = new Set();
    const nodes = document.querySelectorAll("script[src],img[src],iframe[src],link[href],source[src],video[src],audio[src]");
    nodes.forEach((n) => {
      const u = n.getAttribute("src") || n.getAttribute("href") || "";
      if (!u) return;
      let abs; try { abs = new URL(u, location.href); } catch { return; }
      if (https && abs.protocol === "http:") mixed++;
      if (abs.hostname && eTLD1(abs.hostname) !== base) thirdHosts.add(abs.hostname);
    });
    try {
      performance.getEntriesByType("resource").forEach((r) => {
        try { const h = new URL(r.name).hostname; if (h && eTLD1(h) !== base) thirdHosts.add(h); } catch { /* skip */ }
      });
    } catch { /* performance non disponibile */ }

    const pw = document.querySelectorAll("input[type=password]").length;
    const cspMeta = !!document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    const cls = { AI: [], tracker: [], "terza-parte": [] };
    Array.from(thirdHosts).sort().forEach((h) => cls[classifyHost(h)].push(h));
    return { https, mixed, pw, cspMeta, thirdHosts: Array.from(thirdHosts), cls };
  }

  function securityScan() {
    if (scanned) return; scanned = true;
    try {
      const r = computeSecurity();
      const rilievi = [];
      if (!r.https) rilievi.push("HTTP non cifrato");
      if (r.mixed) rilievi.push(r.mixed + " risorse in contenuto misto");
      if (r.pw) rilievi.push(r.pw + " campo password");
      if (!r.cspMeta) rilievi.push("nessun meta-CSP");
      const sev = !r.https ? "alta" : (r.mixed ? "media" : "bassa");
      reportInsight("SEC — Postura pagina", sev,
        `Sicurezza pagina: ${r.https ? "HTTPS" : "HTTP (INSICURO)"} · ${rilievi.length ? rilievi.join(", ") : "nessun rilievo"}`);

      if (r.thirdHosts.length) {
        const parts = [];
        if (r.cls.AI.length) parts.push("AI: " + r.cls.AI.join(", "));
        if (r.cls.tracker.length) parts.push("tracker: " + r.cls.tracker.join(", "));
        if (r.cls["terza-parte"].length) parts.push("terze parti: " + r.cls["terza-parte"].slice(0, 25).join(", "));
        reportInsight("SEC — Inventario domini (" + r.thirdHosts.length + ")",
          r.cls.tracker.length ? "media" : "bassa", parts.join(" | ").slice(0, 900));
      }
    } catch (e) { /* non bloccare mai la pagina */ }
  }

  // Esegue lo scan una volta a caricamento completato
  if (document.readyState === "complete") setTimeout(securityScan, 1200);
  else window.addEventListener("load", () => setTimeout(securityScan, 1200), { once: true });

  const shouldBlock = (rule) => MODE !== "test" && rule.azione === "block";

  function banner(text, type = "block") {
    let e = document.getElementById("aiguard-banner");
    if (!e) {
      e = document.createElement("div");
      e.id = "aiguard-banner";
      e.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;color:#fff;" +
        "font:14px/1.4 system-ui,sans-serif;padding:11px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35);transition:all .3s ease;";
      document.documentElement.appendChild(e);
    }
    const isAiAct = text.includes("AIA-") || text.includes("EU AI Act");
    if (type === "block") {
      e.style.background = isAiAct ? "#8b0000" : "#c62828";
      e.textContent = (isAiAct ? "🇪🇺 EU AI Act Compliance (BLOCCO) — " : "⛔ Policy Aziendale AI (BLOCCO) — ") + text;
    } else {
      e.style.background = isAiAct ? "#1f4d40" : "#e65100";
      e.textContent = (isAiAct ? "🇪🇺 EU AI Act Compliance (AVVISO) — " : "⚠️ Policy Aziendale AI (AVVISO) — ") + text;
    }
    clearTimeout(e._t);
    e._t = setTimeout(() => e.remove(), 6500);
  }

  /* ---------- Blocco totale della pagina ----------
     Invece di provare a "rimuovere chirurgicamente" un allegato dal DOM
     (fragile: dipende dalla struttura esatta di ogni sito, che puo'
     cambiare in qualsiasi momento), quando rileviamo una violazione di
     tipo BLOCCO copriamo l'intera pagina con un overlay che impedisce
     qualsiasi ulteriore interazione (compreso l'invio). E' l'unico modo
     per garantire il blocco indipendentemente da come e' fatta la pagina. */
  let lockdownActive = false;
  function lockdownPage(message) {
    lockdownActive = true;
    if (document.getElementById("vedetta-lockdown")) return;
    const div = document.createElement("div");
    div.id = "vedetta-lockdown";
    div.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(10,15,20,.97);" +
      "display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;" +
      "color:#eef2f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "text-align:center;padding:24px;";
    const icon = document.createElement("div");
    icon.textContent = "⛔";
    icon.style.cssText = "font-size:46px;line-height:1;";
    const title = document.createElement("div");
    title.textContent = "Azione bloccata dalla policy aziendale VEDETTA";
    title.style.cssText = "font-size:19px;font-weight:700;max-width:560px;";
    const sub = document.createElement("div");
    sub.textContent = message || "Questa operazione non è consentita su questa piattaforma.";
    sub.style.cssText = "font-size:14px;color:#9aa5b8;max-width:520px;";
    const btn = document.createElement("button");
    btn.textContent = "Ricarica la pagina per continuare";
    btn.style.cssText =
      "margin-top:8px;padding:10px 22px;border-radius:8px;border:0;background:#5aba93;" +
      "color:#0e1420;font-weight:700;cursor:pointer;font-size:14px;";
    btn.addEventListener("click", () => location.reload());
    div.append(icon, title, sub, btn);
    document.documentElement.appendChild(div);
    document.documentElement.style.overflow = "hidden";
    // Rete di sicurezza extra: blocca ogni click/tasto che raggiunga la pagina sottostante
    ["click", "mousedown", "keydown", "submit"].forEach((type) => {
      document.addEventListener(type, (ev) => {
        if (!lockdownActive) return;
        if (div.contains(ev.target)) return; // permetti il click sul pulsante "Ricarica"
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }, true);
    });
  }

  const extOf = (n) => {
    const i = (n || "").lastIndexOf(".");
    return i >= 0 ? n.slice(i + 1).toLowerCase() : "";
  };

  /* ---------- Svuota il prompt dopo un BLOCCO (così non si può proseguire) ---------- */
  function clearPromptElement(el) {
    if (!el) return;
    try {
      el.focus();
      if (el.isContentEditable) {
        // editor rich (ChatGPT/Claude/Gemini): seleziona tutto ed elimina
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        try { document.execCommand("delete"); } catch (e) { /* */ }
        el.textContent = "";
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else if (el.value !== undefined) {
        // textarea/input controllati da React: usa il setter nativo + evento input
        const proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, ""); else el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (e) { /* non bloccare mai la pagina */ }
  }

  function activeEditable() {
    const a = document.activeElement;
    if (!a) return null;
    if (a instanceof HTMLTextAreaElement) return a;
    if (a instanceof HTMLInputElement && /^(text|search|url|email|)$/.test(a.type || "")) return a;
    if (a.isContentEditable) return a;
    return null;
  }

  // Intercettatore globale: su INVIO, se il testo viola una regola di BLOCCO,
  // impedisce l'invio ED ELIMINA il prompt (funziona su qualsiasi piattaforma AI).
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
    if (MODE === "test") return; // modalità di test: nessun blocco reale
    const el = activeEditable();
    if (!el) return;
    const text = (el.value !== undefined ? el.value : el.textContent) || "";
    if (text.length < 3) return;
    const blockHits = matchText(text).filter((h) => h.rule.azione === "block");
    if (!blockHits.length) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    for (const h of blockHits) report(h.rule, h.dettaglio);
    banner((blockHits[0].rule.name || blockHits[0].rule.id) + " — prompt eliminato, invio bloccato", "block");
    clearPromptElement(el);
  }, true);

  /* ---------- Valutazione ---------- */
  function matchFiles(files) {
    const hits = [];
    for (const rule of RULES) {
      if (rule.tipo !== "file_upload") continue;
      for (const f of files) {
        if (!rule.estensioni.length || rule.estensioni.includes(extOf(f.name))) hits.push({ rule, file: f });
      }
    }
    return hits;
  }

  function matchText(text) {
    const hits = [];
    if (!text) return hits;
    const low = text.toLowerCase();
    for (const rule of RULES) {
      if (rule.tipo === "keyword" && rule._kw) {
        const found = rule._kw.filter((k) => low.includes(k));
        if (found.length) hits.push({ rule, dettaglio: "Parole chiave: " + found.join(", ") });
      } else if (rule.tipo === "regex" && rule._re) {
        rule._re.lastIndex = 0;
        const m = rule._re.exec(text);
        if (m) hits.push({ rule, dettaglio: "Pattern rilevato: " + m[0].slice(0, 40) });
      }
    }
    return hits;
  }

  function handleFiles(hits, ev) {
    let blocked = false;
    let alerted = false;
    let alertMsg = "";
    let blockMsg = "";

    for (const h of hits) {
      report(h.rule, `File "${h.file.name}" (${Math.round((h.file.size || 0) / 1024)} KB)`);
      if (h.rule.azione === "block") {
        if (MODE !== "test") {
          blocked = true;
          blockMsg = blockMsg || `Caricamento file "${h.file.name}" bloccato (${h.rule.name || h.rule.id})`;
        } else {
          alerted = true;
          alertMsg = alertMsg || `[TEST] Rilevato file "${h.file.name}" (${h.rule.name || h.rule.id}) — non bloccato: modalita di test attiva`;
        }
      } else if (h.rule.azione === "alert") {
        alerted = true;
        alertMsg = alertMsg || `Avviso caricamento file "${h.file.name}" (${h.rule.name || h.rule.id})`;
      }
    }

    if (blocked) {
      if (ev) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      banner(blockMsg || "Caricamento file non consentito su questa piattaforma.", "block");
      lockdownPage(blockMsg || "Il file selezionato non è consentito su questa piattaforma.");
      return true;
    } else if (alerted) {
      banner(alertMsg || "Attenzione: caricamento file soggetto a monitoraggio di sicurezza.", "alert");
    }
    return false;
  }

  function handleText(hits, ev) {
    let blocked = false;
    let alerted = false;
    let alertMsg = "";
    let blockMsg = "";

    for (const h of hits) {
      report(h.rule, h.dettaglio);
      if (h.rule.azione === "block") {
        if (MODE !== "test") {
          blocked = true;
          blockMsg = blockMsg || `Invio bloccato per policy: ${h.rule.name || h.rule.id} (${h.dettaglio})`;
        } else {
          alerted = true;
          alertMsg = alertMsg || `[TEST] Possibile violazione rilevata: ${h.rule.name || h.rule.id} (${h.dettaglio}) — non bloccato: modalita di test attiva`;
        }
      } else if (h.rule.azione === "alert") {
        alerted = true;
        alertMsg = alertMsg || `Avviso di sicurezza: ${h.rule.name || h.rule.id} (${h.dettaglio})`;
      }
    }

    if (blocked) {
      if (ev) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
      banner(blockMsg || "Il contenuto viola la policy aziendale ed è stato bloccato.", "block");
      return true;
    } else if (alerted) {
      banner(alertMsg || "Attenzione: rilevato contenuto sensibile nel prompt.", "alert");
    }
    return false;
  }

  /* ---------- Hook eventi (indipendenti dal DOM) ---------- */
  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLInputElement) || t.type !== "file") return;
    const files = Array.from(t.files || []);
    if (!files.length) return;
    const hits = matchFiles(files);
    if (hits.length) {
      if (handleFiles(hits, ev)) t.value = "";
    } else {
      report(null, "Upload: " + files.map((f) => f.name).join(", "), "info");
    }
  }, true);

  document.addEventListener("drop", (ev) => {
    const files = Array.from(ev.dataTransfer?.files || []);
    if (!files.length) return;
    const hits = matchFiles(files);
    if (hits.length) handleFiles(hits, ev);
    else report(null, "Drop file: " + files.map((f) => f.name).join(", "), "info");
  }, true);

  document.addEventListener("paste", (ev) => {
    const items = Array.from(ev.clipboardData?.items || []);
    const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
    if (files.length) {
      const h = matchFiles(files);
      if (h.length && handleFiles(h, ev)) return;
    }
    const text = ev.clipboardData?.getData("text") || "";
    if (text) {
      const h = matchText(text);
      if (h.length) handleText(h, ev);
    }
  }, true);

  document.addEventListener("input", (ev) => {
    const now = Date.now();
    if (now - lastScan < 1500) return;
    lastScan = now;
    const t = ev.target;
    let text = "";
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) text = t.value || "";
    else if (t && t.isContentEditable) text = t.textContent || "";
    if (text.length < 8) return;
    for (const h of matchText(text)) report(h.rule, h.dettaglio);
  }, true);

  /* ---------- Aggancio al prompt tramite selettori configurati ---------- */
  let observer = null;
  function attachPromptWatcher() {
    if (observer) observer.disconnect();
    if (!SELECTORS) return;

    const check = () => {
      let els = [];
      try { els = Array.from(document.querySelectorAll(SELECTORS)); } catch { return; }
      for (const e of els) {
        if (e._aiguard) continue;
        e._aiguard = true;

        const evalAndProcess = (ev) => {
          const text = e.value !== undefined ? e.value : e.textContent || "";
          if (!text) return false;
          const hits = matchText(text);
          if (hits.length && handleText(hits, ev)) {
            clearPromptElement(e); // blocco: svuota il prompt così non si può proseguire
            return true;
          }
          return false;
        };

        // Intercetta l'invio con INVIO da tastiera
        e.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" || ev.shiftKey) return;
          evalAndProcess(ev);
        }, true);

        // Intercetta il click sul form / pulsante di invio padre se presente
        const form = e.closest("form");
        if (form && !form._aiguard) {
          form._aiguard = true;
          form.addEventListener("submit", (ev) => {
            evalAndProcess(ev);
          }, true);
        }
      }
    };

    check();
    observer = new MutationObserver(() => check());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- Difesa aggiuntiva: rileva l'allegato comparso nel DOM ----------
     Alcuni siti (es. ChatGPT) non usano un tradizionale <input type="file">
     per il selettore file di sistema (usano API del browser più moderne),
     quindi l'evento "change" non si attiva mai. Come rete di sicurezza,
     osserviamo il DOM: se compare il nome di un file con un'estensione
     bloccata (es. nella "chip" di anteprima allegato), proviamo a rimuoverlo
     subito e blocchiamo comunque l'invio del messaggio. */
  let blockedExtRe = null;
  function rebuildBlockedExtRegex() {
    const exts = new Set();
    for (const r of RULES) {
      if (r.tipo === "file_upload" && r.azione === "block" && r.estensioni.length) {
        r.estensioni.forEach((e) => exts.add(e));
      }
    }
    blockedExtRe = exts.size
      ? new RegExp("([\\w àèéìòù\\-\\.]{1,120}\\.(" + Array.from(exts).join("|") + "))(?:[^\\w]|$)", "i")
      : null;
  }

  let lastAttachmentBlockAt = 0;
  let attachmentBlockActive = false;

  function tryRemoveAttachmentNear(el) {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      const btn = node.querySelector && node.querySelector(
        'button[aria-label*="remov" i], button[aria-label*="delet" i], button[aria-label*="rimuov" i], button[aria-label*="elimin" i], button[aria-label*="close" i], button[aria-label*="chiudi" i], [role="button"][aria-label*="remov" i]'
      );
      if (btn) { btn.click(); return true; }
      node = node.parentElement;
    }
    return false;
  }

  function scanForAttachmentChips(root) {
    if (!blockedExtRe || MODE === "test") return;
    const now = Date.now();
    if (now - lastAttachmentBlockAt < 800) return; // evita loop su rimozioni multiple
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const txt = n.nodeValue;
      if (!txt || txt.length < 5) continue;
      const m = txt.match(blockedExtRe);
      if (!m) continue;
      const filename = m[1];
      const ext = m[2].toLowerCase();
      const rule = RULES.find((r) => r.tipo === "file_upload" && r.azione === "block" && r.estensioni.includes(ext));
      if (!rule) continue;

      lastAttachmentBlockAt = now;
      const el = n.parentElement || root;
      const removed = tryRemoveAttachmentNear(el);
      try {
        document.querySelectorAll('input[type="file"]').forEach((inp) => { inp.value = ""; });
      } catch (e) { /* noop */ }

      report(rule, `Allegato "${filename}" rilevato nell'interfaccia (${rule.name || rule.id})${removed ? " — rimosso automaticamente" : " — rimozione automatica non riuscita"}`);
      banner(`Caricamento file "${filename}" bloccato (${rule.name || rule.id})`, "block");
      lockdownPage(`Il file "${filename}" non è consentito su questa piattaforma (${rule.name || rule.id}).`);

      attachmentBlockActive = true;
      setTimeout(() => { attachmentBlockActive = false; }, 4000);
      return;
    }
  }

  const attachmentObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType === 1 || node.nodeType === 3) scanForAttachmentChips(node.nodeType === 3 ? node.parentElement || document.body : node);
      }
    }
  });
  attachmentObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Ultima rete di sicurezza: se un allegato bloccato è stato rilevato di
  // recente, impedisce comunque l'invio (Invio da tastiera o submit form)
  // anche se la rimozione automatica della chip non fosse riuscita.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.shiftKey) return;
    if (attachmentBlockActive) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
  document.addEventListener("submit", (ev) => {
    if (attachmentBlockActive) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  }, true);
})();
