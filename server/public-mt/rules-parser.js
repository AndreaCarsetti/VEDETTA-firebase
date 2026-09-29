/**
 * AI Usage Guard - Parser regole Markdown
 * Formato atteso (vedi rules.md di esempio):
 *
 * ## Regola: Nome regola
 * - id: R01
 * - tipo: file_upload | keyword | regex | dominio
 * - azione: block | alert | log
 * - severita: alta | media | bassa
 * - estensioni: pdf, docx, xlsx        (solo tipo file_upload; vuoto = tutti)
 * - pattern: parola1, parola2          (tipo keyword)
 * - regex: espressione                 (tipo regex)
 * - descrizione: testo libero
 */
(function (global) {
  "use strict";

  function parseRulesMarkdown(md) {
    const rules = [];
    if (!md) return rules;

    const sections = md.split(/^##\s+Regola\s*:\s*/m).slice(1);

    for (const section of sections) {
      const lines = section.split(/\r?\n/);
      const name = (lines.shift() || "").trim();
      const rule = {
        id: null,
        name: name || "Regola senza nome",
        tipo: null,
        azione: "log",
        severita: "media",
        estensioni: [],
        pattern: [],
        regex: null,
        descrizione: ""
      };

      for (const line of lines) {
        const m = line.match(/^\s*[-*]\s*([a-zA-Zà-ù_]+)\s*:\s*(.+)\s*$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();

        switch (key) {
          case "id":
            rule.id = value;
            break;
          case "tipo":
            rule.tipo = value.toLowerCase();
            break;
          case "azione":
            rule.azione = value.toLowerCase();
            break;
          case "severita":
          case "severità":
            rule.severita = value.toLowerCase();
            break;
          case "estensioni":
            rule.estensioni = value
              .split(",")
              .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
              .filter(Boolean);
            break;
          case "pattern":
            rule.pattern = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            break;
          case "regex":
            rule.regex = value;
            break;
          case "descrizione":
            rule.descrizione = value;
            break;
        }
      }

      if (rule.tipo) {
        if (!rule.id) rule.id = "R" + String(rules.length + 1).padStart(2, "0");
        rules.push(rule);
      }
    }
    return rules;
  }

  /** Compila le regex una sola volta, con gestione errori. */
  function compileRules(rules) {
    return rules.map((r) => {
      const c = Object.assign({}, r);
      if (r.tipo === "regex" && r.regex) {
        try {
          c._re = new RegExp(r.regex, "giu");
        } catch (e) {
          c._re = null;
          c._reError = String(e);
        }
      }
      if (r.tipo === "keyword" && r.pattern.length) {
        c._kw = r.pattern.map((p) => p.toLowerCase());
      }
      return c;
    });
  }

  function stringifyRulesMarkdown(rules) {
    if (!Array.isArray(rules)) return "";
    return rules.map((r) => {
      let md = `## Regola: ${r.name || "Senza nome"}\n`;
      if (r.id) md += `- id: ${r.id}\n`;
      if (r.tipo) md += `- tipo: ${r.tipo}\n`;
      if (r.azione) md += `- azione: ${r.azione}\n`;
      if (r.severita) md += `- severita: ${r.severita}\n`;
      if (r.estensioni && r.estensioni.length) md += `- estensioni: ${r.estensioni.join(", ")}\n`;
      if (r.pattern && r.pattern.length) md += `- pattern: ${r.pattern.join(", ")}\n`;
      if (r.regex) md += `- regex: ${r.regex}\n`;
      if (r.descrizione) md += `- descrizione: ${r.descrizione}\n`;
      return md;
    }).join("\n");
  }

  const api = { parseRulesMarkdown, compileRules, stringifyRulesMarkdown };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.AIGuardRules = api;
})(typeof self !== "undefined" ? self : this);
