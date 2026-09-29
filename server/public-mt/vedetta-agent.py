#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VEDETTA Agent - agente unico multipiattaforma (Windows / macOS / Linux).

UN SOLO SCRIPT, TUTTO INSIEME:
  * monitora la navigazione di TUTTI i browser installati (Chrome, Edge, Brave,
    Chromium, Firefox e Safari su Mac) e rileva accessi a piattaforme AI,
    pubblicita'/tracker e domini malevoli;
  * invia telemetria NOC (CPU, RAM, disco, rete, uptime, processi, IP) per
    alimentare la scheda "Agenti System" / "Postazioni";
  * si autoconfigura al primo avvio (chiede URL console e chiavi) e salva
    tutto in vedetta-agent.config.json accanto a se stesso.

USO RAPIDO
----------
1) (consigliato) per le metriche NOC complete:
       pip install psutil
2) avvio:
       python3 vedetta-agent.py --url https://TUA-CONSOLE --agent-key <AGENT_KEY>

Le chiavi si trovano nella console web, scheda "Agenti" -> box "Credenziali":
  * AGENT_KEY  -> sempre richiesta (eventi di navigazione + telemetria NOC)
  * ENROLL_KEY -> SOLO se usi la console multi-tenant (Firebase).
                  Se non la imposti, la telemetria NOC usa l'Agent Key
                  (va bene per la console locale/single-tenant).

I valori possono anche essere messi in vedetta-agent.config.json (creato al
primo avvio) o via variabili d'ambiente VEDETTA_URL / VEDETTA_AGENT_KEY /
VEDETTA_ENROLL_KEY / VEDETTA_LABEL.

IMPORTANTE: se lanci questo file con doppio clic e la finestra si chiude
subito senza messaggi, apri un Prompt dei comandi (cmd) e lancialo da li'
con "python vedetta-agent.py" per vedere l'errore — oppure usa il launcher
vedetta-agent.bat incluso, che tiene sempre la finestra aperta.

Nessuna dipendenza obbligatoria oltre alla standard library (psutil opzionale).
"""

import argparse
import glob
import json
import os
import platform
import shutil
import socket
import sqlite3
import sys
import tempfile
import time
import traceback
import uuid
import urllib.request
import urllib.error

AGENT_VERSION = "2.0.0 (agente unico: browser + NOC)"
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vedetta-agent.config.json")

try:
    import psutil  # type: ignore
    HAVE_PSUTIL = True
except Exception:
    HAVE_PSUTIL = False

try:
    import threading
    import webbrowser
    import io
    import pystray  # type: ignore
    from PIL import Image, ImageDraw  # type: ignore
    HAVE_TRAY = True
except Exception:
    HAVE_TRAY = False

try:
    if platform.system() != "Windows" and not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        raise RuntimeError("nessun display grafico disponibile")
    import tkinter as tk
    from tkinter import messagebox
    HAVE_TK = True
except Exception:
    HAVE_TK = False

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vedetta-agent.log")


def log(msg):
    """Stampa a video (se c'e' una console) E scrive sempre su file di log,
    cosi' anche in modalita' 'app in system tray' (senza console) resta
    una traccia consultabile di cosa e' successo."""
    line = "[%s] %s" % (time.strftime("%H:%M:%S"), msg)
    try:
        print(line)
    except Exception:
        pass
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ============================ Domini monitorati ============================
AI_PLATFORMS = [
    "chatgpt.com", "openai.com", "claude.ai", "anthropic.com", "gemini.google.com",
    "bard.google.com", "copilot.microsoft.com", "bing.com/chat", "perplexity.ai",
    "chat.mistral.ai", "chat.deepseek.com", "grok.com", "x.ai", "poe.com",
    "huggingface.co", "v0.dev", "character.ai", "you.com", "phind.com",
]
AD_TRACKER = [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "google-analytics.com", "googletagmanager.com", "adservice.google.com",
    "criteo.com", "taboola.com", "outbrain.com", "adnxs.com", "rubiconproject.com",
    "pubmatic.com", "amazon-adsystem.com", "moatads.com", "scorecardresearch.com",
    "hotjar.com", "clarity.ms", "mixpanel.com", "segment.io", "quantserve.com",
    "connect.facebook.net", "ads-twitter.com", "analytics.tiktok.com",
]
MALWARE = ["coinhive.com", "cryptoloot.pro", "crypto-loot.com", "webminepool.com", "cnhv.co"]


def classify(host):
    h = (host or "").lower()
    for d in AI_PLATFORMS:
        base = d.split("/")[0]
        if h == base or h.endswith("." + base):
            return ("accesso", "Accesso piattaforma AI", "bassa")
    for d in MALWARE:
        if h == d or h.endswith("." + d):
            return ("violazione", "Dominio malevolo / miner", "alta")
    for d in AD_TRACKER:
        if h == d or h.endswith("." + d):
            return ("adblock", "Pubblicita' / tracker", "bassa")
    return None


# ============================ Config ============================
def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print("! Impossibile salvare la config:", e)


def gui_config_dialog(need_url, need_key, need_enroll_hint):
    """Piccola finestra di configurazione (usata quando non c'e' una console
    disponibile per l'input testuale, es. eseguibile .exe 'windowed')."""
    result = {}

    root = tk.Tk()
    root.title("VEDETTA Agent — Configurazione")
    root.resizable(False, False)
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    pad = {"padx": 14, "pady": 6}
    tk.Label(root, text="Configurazione VEDETTA Agent", font=("Segoe UI", 12, "bold")).grid(row=0, column=0, columnspan=2, **pad)

    row = 1
    entries = {}
    if need_url:
        tk.Label(root, text="URL console:").grid(row=row, column=0, sticky="e", **pad)
        e = tk.Entry(root, width=42)
        e.insert(0, "https://")
        e.grid(row=row, column=1, **pad)
        entries["url"] = e
        row += 1
    if need_key:
        tk.Label(root, text="Agent Key:").grid(row=row, column=0, sticky="e", **pad)
        e = tk.Entry(root, width=42)
        e.grid(row=row, column=1, **pad)
        entries["agentKey"] = e
        row += 1

    tk.Label(root, text="Enroll Key (solo Firebase, opzionale):").grid(row=row, column=0, sticky="e", **pad)
    e = tk.Entry(root, width=42)
    e.grid(row=row, column=1, **pad)
    entries["enrollKey"] = e
    row += 1

    tk.Label(root, text="Etichetta postazione (opzionale):").grid(row=row, column=0, sticky="e", **pad)
    e = tk.Entry(root, width=42)
    e.insert(0, socket.gethostname())
    e.grid(row=row, column=1, **pad)
    entries["label"] = e
    row += 1

    def on_ok():
        if need_url and not entries["url"].get().strip():
            messagebox.showerror("VEDETTA Agent", "Inserisci l'URL della console.")
            return
        if need_key and not entries["agentKey"].get().strip():
            messagebox.showerror("VEDETTA Agent", "Inserisci la Agent Key.")
            return
        for k, w in entries.items():
            result[k] = w.get().strip()
        root.destroy()

    def on_cancel():
        root.destroy()
        os._exit(1)

    btns = tk.Frame(root)
    btns.grid(row=row, column=0, columnspan=2, pady=12)
    tk.Button(btns, text="Annulla", command=on_cancel, width=12).pack(side="left", padx=6)
    tk.Button(btns, text="Avvia agente", command=on_ok, width=14, default="active").pack(side="left", padx=6)

    root.protocol("WM_DELETE_WINDOW", on_cancel)
    root.eval("tk::PlaceWindow . center")
    root.mainloop()
    return result


def resolve_config():
    ap = argparse.ArgumentParser(description="VEDETTA Agent (browser + NOC, unico script)")
    ap.add_argument("--url", help="URL console VEDETTA")
    ap.add_argument("--agent-key", help="Agent key (eventi di navigazione + telemetria NOC)")
    ap.add_argument("--enroll-key", help="Enroll key (SOLO console multi-tenant/Firebase, telemetria NOC)")
    ap.add_argument("--label", help="Etichetta della postazione")
    ap.add_argument("--interval", type=int, help="Secondi tra i cicli (default 30)")
    ap.add_argument("--no-noc", action="store_true", help="Disattiva la parte NOC")
    ap.add_argument("--no-browser", action="store_true", help="Disattiva il monitoraggio browser")
    ap.add_argument("--once", action="store_true", help="Un solo ciclo ed esci")
    args = ap.parse_args()

    cfg = load_config()
    cfg["url"] = args.url or os.environ.get("VEDETTA_URL") or cfg.get("url")
    cfg["agentKey"] = args.agent_key or os.environ.get("VEDETTA_AGENT_KEY") or cfg.get("agentKey")
    cfg["enrollKey"] = args.enroll_key or os.environ.get("VEDETTA_ENROLL_KEY") or cfg.get("enrollKey") or ""
    cfg["label"] = args.label or os.environ.get("VEDETTA_LABEL") or cfg.get("label") or socket.gethostname()
    cfg["interval"] = args.interval or cfg.get("interval") or 30
    if not cfg.get("hostId"):
        cfg["hostId"] = "%s-%s" % (socket.gethostname()[:40], hex(uuid.getnode())[2:])
    if not cfg.get("agentId"):
        cfg["agentId"] = "AGT-" + hex(uuid.getnode())[2:][:8].upper()
    if "lastScan" not in cfg:
        cfg["lastScan"] = time.time()  # da ora in avanti (non spedire tutta la cronologia storica)

    need_url = not cfg.get("url")
    need_key = not cfg.get("agentKey")
    has_console = sys.stdin is not None and hasattr(sys.stdin, "isatty") and sys.stdin.isatty()

    if (need_url or need_key) and not has_console and HAVE_TK:
        vals = gui_config_dialog(need_url, need_key, True)
        if need_url:
            cfg["url"] = vals.get("url", "")
        if need_key:
            cfg["agentKey"] = vals.get("agentKey", "")
        if not cfg.get("enrollKey") and vals.get("enrollKey"):
            cfg["enrollKey"] = vals["enrollKey"]
        if vals.get("label"):
            cfg["label"] = vals["label"]
    else:
        if (need_url or need_key) and not has_console:
            log("ERRORE: mancano URL/Agent Key e non c'e' ne' una console ne' tkinter per chiederli.")
            log("Avvia almeno una volta da riga di comando con --url e --agent-key.")
            sys.exit(1)
        if need_url:
            cfg["url"] = input("URL console VEDETTA (es. https://tuo-progetto.web.app): ").strip()
        if need_key:
            cfg["agentKey"] = input("Agent key: ").strip()

    if "enrollKey" not in cfg or cfg.get("enrollKey") is None:
        cfg["enrollKey"] = ""
    if not cfg["enrollKey"] and has_console:
        print("\nLa Enroll Key serve SOLO se questa console è quella multi-tenant/Firebase")
        print("(la trovi nella console web, scheda \"Agenti\" -> box \"Credenziali\", campo Enroll Key).")
        print("Se invece usi la console locale (single-tenant), premi solo INVIO per saltare.\n")
        risposta = input("Enroll key (INVIO per saltare): ").strip()
        cfg["enrollKey"] = risposta

    save_config(cfg)
    return cfg, args


# ============================ Metriche NOC ============================
def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return ""


_last_net = {"t": None, "up": 0, "down": 0}


def _powershell_json(script):
    if platform.system() != "Windows": return None
    try:
        import subprocess
        kwargs = {"stderr": subprocess.DEVNULL, "timeout": 4}
        if platform.system() == "Windows":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        out = subprocess.check_output(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], **kwargs)
        txt = out.decode("utf-8", errors="ignore").strip()
        return json.loads(txt) if txt else None
    except Exception: return None

def collect_battery():
    try:
        b = psutil.sensors_battery() if HAVE_PSUTIL and hasattr(psutil, "sensors_battery") else None
        if b is not None and b.percent is not None:
            return {"percent": round(float(b.percent),1), "plugged": bool(b.power_plugged)}
    except Exception: pass
    return None

def collect_temperatures():
    out=[]
    if HAVE_PSUTIL and hasattr(psutil,"sensors_temperatures"):
        try:
            for group,items in (psutil.sensors_temperatures(fahrenheit=False) or {}).items():
                for item in items:
                    cur=getattr(item,"current",None)
                    if cur is not None: out.append({"sensor":str(group),"label":str(getattr(item,"label","") or group),"current":round(float(cur),1)})
        except Exception: pass
    if not out and platform.system()=="Windows":
        data=_powershell_json("$x=Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object InstanceName,CurrentTemperature; @($x) | ConvertTo-Json -Compress")
        if isinstance(data,dict): data=[data]
        for item in data or []:
            try: out.append({"sensor":"ACPI","label":str(item.get("InstanceName","ACPI")),"current":round(float(item["CurrentTemperature"])/10.0-273.15,1)})
            except Exception: pass
    return out[:24]

def collect_listen_ports():
    if not HAVE_PSUTIL or not hasattr(psutil,"net_connections"): return []
    ports={}
    try:
        for c in psutil.net_connections(kind="inet"):
            if getattr(c,"status","")!="LISTEN" or not c.laddr: continue
            addr=getattr(c.laddr,"ip","") or "0.0.0.0"; port=int(getattr(c.laddr,"port",0) or 0)
            if not port: continue
            key=(addr,port)
            if key in ports: continue
            ports[key]={"address":addr,"port":port}
    except Exception: pass
    return sorted(ports.values(),key=lambda x:(x["port"],x["address"]))[:200]


def collect_metrics():
    m = {}
    if HAVE_PSUTIL:
        try:
            m["uptime"] = int(time.time() - psutil.boot_time())
        except Exception:
            pass
        try:
            m["cpu"] = round(psutil.cpu_percent(interval=0.5), 1)
        except Exception:
            pass
        try:
            m["mem"] = round(psutil.virtual_memory().percent, 1)
        except Exception:
            pass
        try:
            root = "C:\\" if platform.system() == "Windows" else "/"
            m["disk"] = round(psutil.disk_usage(root).percent, 1)
        except Exception:
            pass
        try:
            m["procs"] = len(psutil.pids())
        except Exception:
            pass
        try:
            io = psutil.net_io_counters()
            now = time.time()
            if _last_net["t"] is not None:
                dt = max(0.001, now - _last_net["t"])
                m["netUp"] = round((io.bytes_sent - _last_net["up"]) / dt)
                m["netDown"] = round((io.bytes_recv - _last_net["down"]) / dt)
            _last_net.update(t=now, up=io.bytes_sent, down=io.bytes_recv)
        except Exception:
            pass
        try:
            if hasattr(psutil, "getloadavg"):
                m["load1"] = round(psutil.getloadavg()[0], 2)
        except Exception:
            pass
        try:
            battery=collect_battery()
            if battery is not None: m["battery"]=battery
        except Exception: pass
        try: m["temperatures"]=collect_temperatures()
        except Exception: pass
        try: m["listenPorts"]=collect_listen_ports()
        except Exception: pass
    else:
        try:
            if hasattr(os, "getloadavg"):
                la = os.getloadavg()
                cores = os.cpu_count() or 1
                m["cpu"] = round(min(100.0, la[0] / cores * 100), 1)
                m["load1"] = round(la[0], 2)
        except Exception:
            pass
        try:
            root = "C:\\" if platform.system() == "Windows" else "/"
            du = shutil.disk_usage(root)
            m["disk"] = round(du.used / du.total * 100, 1)
        except Exception:
            pass
    return m


# ============================ Cronologia browser ============================
def _home():
    return os.path.expanduser("~")


def _chromium_history_paths():
    sysname = platform.system()
    roots = []
    if sysname == "Windows":
        la = os.environ.get("LOCALAPPDATA", os.path.join(_home(), "AppData", "Local"))
        roots = [
            os.path.join(la, "Google", "Chrome", "User Data"),
            os.path.join(la, "Microsoft", "Edge", "User Data"),
            os.path.join(la, "BraveSoftware", "Brave-Browser", "User Data"),
            os.path.join(la, "Chromium", "User Data"),
        ]
    elif sysname == "Darwin":
        base = os.path.join(_home(), "Library", "Application Support")
        roots = [
            os.path.join(base, "Google", "Chrome"),
            os.path.join(base, "Microsoft Edge"),
            os.path.join(base, "BraveSoftware", "Brave-Browser"),
            os.path.join(base, "Chromium"),
        ]
    else:  # Linux
        base = os.path.join(_home(), ".config")
        roots = [
            os.path.join(base, "google-chrome"),
            os.path.join(base, "microsoft-edge"),
            os.path.join(base, "BraveSoftware", "Brave-Browser"),
            os.path.join(base, "chromium"),
        ]
    paths = []
    for r in roots:
        for prof in ("Default", "Profile 1", "Profile 2", "Profile 3"):
            p = os.path.join(r, prof, "History")
            if os.path.exists(p):
                paths.append(p)
    return paths


def _firefox_history_paths():
    sysname = platform.system()
    if sysname == "Windows":
        base = os.path.join(os.environ.get("APPDATA", ""), "Mozilla", "Firefox", "Profiles")
    elif sysname == "Darwin":
        base = os.path.join(_home(), "Library", "Application Support", "Firefox", "Profiles")
    else:
        base = os.path.join(_home(), ".mozilla", "firefox")
    return glob.glob(os.path.join(base, "*", "places.sqlite"))


def _safari_history_path():
    if platform.system() != "Darwin":
        return None
    p = os.path.join(_home(), "Library", "Safari", "History.db")
    return p if os.path.exists(p) else None


def _read_sqlite(path, query):
    """Copia il DB (spesso lockato dal browser) in temp e lo interroga."""
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        shutil.copy2(path, tmp)
        con = sqlite3.connect(tmp)
        con.row_factory = sqlite3.Row
        rows = list(con.execute(query))
        con.close()
        return rows
    except Exception:
        return []
    finally:
        if tmp and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


def collect_visits(since_epoch):
    """Ritorna [(epoch, url)] di tutte le visite piu' recenti di since_epoch, da tutti i browser."""
    visits = []
    chrome_since = int((since_epoch + 11644473600) * 1_000_000)
    for p in _chromium_history_paths():
        for r in _read_sqlite(p, "SELECT url, last_visit_time FROM urls WHERE last_visit_time > %d ORDER BY last_visit_time DESC LIMIT 500" % chrome_since):
            try:
                ep = r["last_visit_time"] / 1_000_000 - 11644473600
                visits.append((ep, r["url"]))
            except Exception:
                pass
    ff_since = int(since_epoch * 1_000_000)
    for p in _firefox_history_paths():
        for r in _read_sqlite(p, "SELECT url, last_visit_date FROM moz_places WHERE last_visit_date > %d ORDER BY last_visit_date DESC LIMIT 500" % ff_since):
            try:
                if r["last_visit_date"]:
                    visits.append((r["last_visit_date"] / 1_000_000, r["url"]))
            except Exception:
                pass
    sp = _safari_history_path()
    if sp:
        saf_since = since_epoch - 978307200
        q = ("SELECT i.url AS url, v.visit_time AS visit_time FROM history_items i "
             "JOIN history_visits v ON v.history_item = i.id WHERE v.visit_time > %f "
             "ORDER BY v.visit_time DESC LIMIT 500" % saf_since)
        for r in _read_sqlite(sp, q):
            try:
                visits.append((r["visit_time"] + 978307200, r["url"]))
            except Exception:
                pass
    return visits


def host_of(url):
    try:
        from urllib.parse import urlparse
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def scan_browser_events(cfg):
    since = float(cfg.get("lastScan") or time.time())
    now = time.time()
    events = []
    seen = set()
    for ep, url in collect_visits(since):
        host = host_of(url)
        if not host:
            continue
        cls = classify(host)
        if not cls:
            continue
        key = host + "|" + str(int(ep))
        if key in seen:
            continue
        seen.add(key)
        categoria, regola, severita = cls
        events.append({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ep)),
            "categoria": categoria,
            "piattaforma": host,
            "url": url[:500],
            "regola": regola,
            "azione": "rilevato",
            "severita": severita,
            "dettaglio": "%s (agente VEDETTA, tutti i browser)" % regola,
        })
    cfg["lastScan"] = now
    return events


# ============================ Invio ============================
def http_post(url, headers, body):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for k, v in headers.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(url, headers):
    req = urllib.request.Request(url, method="GET")
    for k, v in headers.items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def heartbeat(cfg):
    """Registra l'agente nella console (tipo 'agente')."""
    base = cfg["url"].rstrip("/")
    http_get(base + "/api/v1/config", {
        "X-Agent-Key": cfg["agentKey"], "X-Agent-Id": cfg["agentId"],
        "X-Agent-Label": cfg.get("label", ""), "X-Agent-Type": "agent",
        "X-Agent-Version": AGENT_VERSION,
    })


def send_events(cfg, events):
    if not events:
        return 0
    base = cfg["url"].rstrip("/")
    http_post(base + "/api/v1/events", {
        "X-Agent-Key": cfg["agentKey"], "X-Agent-Id": cfg["agentId"],
        "X-Agent-Label": cfg.get("label", ""),
    }, {"events": events})
    return len(events)


def send_noc(cfg):
    base = cfg["url"].rstrip("/")
    payload = {
        "hostId": cfg["hostId"], "hostname": socket.gethostname(), "label": cfg.get("label", ""),
        "os": platform.system(), "osRelease": platform.release(),
        "agentVersion": AGENT_VERSION, "ip": local_ip(), "metrics": collect_metrics(),
    }
    # Console multi-tenant (Firebase): la telemetria NOC richiede l'Enroll Key del tenant.
    # Console locale/single-tenant: usa la stessa Agent Key di tutto il resto.
    if cfg.get("enrollKey"):
        headers = {"X-Enroll-Key": cfg["enrollKey"]}
    else:
        headers = {"X-Agent-Key": cfg["agentKey"]}
    return http_post(base + "/api/v1/noc", headers, payload)


# ============================ Main ============================
STATE = {
    "status": "avvio in corso...",
    "last_sync": None,
    "paused": False,
    "url": "",
}
_wake = None  # threading.Event, creato solo se HAVE_TRAY


def run(cfg=None, args=None):
    if cfg is None:
        cfg, args = resolve_config()
    STATE["url"] = cfg["url"]
    log("=" * 64)
    log("VEDETTA Agent %s" % AGENT_VERSION)
    log("=" * 64)
    log("host=%s  agentId=%s  os=%s  psutil=%s"
        % (cfg["hostId"], cfg["agentId"], platform.system(), "si" if HAVE_PSUTIL else "NO (consigliato: pip install psutil)"))
    log("Console: %s" % cfg["url"])
    log("Intervallo: %ss  ·  browser=%s  ·  NOC=%s (auth %s)  ·  tray=%s"
        % (cfg.get("interval", 30), "OFF" if args.no_browser else "ON", "OFF" if args.no_noc else "ON",
           "Enroll Key" if cfg.get("enrollKey") else "Agent Key", "si" if HAVE_TRAY else "no (console)"))
    log("-" * 64)

    interval = int(cfg.get("interval", 30))
    while True:
        if STATE["paused"]:
            STATE["status"] = "in pausa"
            _sleep_or_wake(2)
            continue

        stamp = time.strftime("%H:%M:%S")
        cpu_txt = mem_txt = disk_txt = None
        if not args.no_browser:
            try:
                heartbeat(cfg)
                ev = scan_browser_events(cfg)
                n = send_events(cfg, ev)
                save_config(cfg)
                log("browser: %d eventi inviati" % n)
            except urllib.error.HTTPError as e:
                log("browser errore HTTP %s: %s" % (e.code, e.reason))
            except Exception as e:
                log("browser errore: %s" % e)
        if not args.no_noc:
            try:
                body = send_noc(cfg)
                if isinstance(body, dict) and body.get("pollSeconds"):
                    interval = int(body["pollSeconds"])
                m = collect_metrics()
                cpu_txt, mem_txt, disk_txt = m.get("cpu", "?"), m.get("mem", "?"), m.get("disk", "?")
                log("NOC: cpu=%s%% mem=%s%% disk=%s%%" % (cpu_txt, mem_txt, disk_txt))
            except urllib.error.HTTPError as e:
                log("NOC errore HTTP %s: %s" % (e.code, e.reason))
                if e.code == 401:
                    log("      -> chiave non valida. Se usi la console Firebase multi-tenant,")
                    log("         serve la Enroll Key (scheda Agenti), non la Agent Key.")
            except Exception as e:
                log("NOC errore: %s" % e)

        STATE["last_sync"] = stamp
        STATE["status"] = ("cpu %s%% · mem %s%% · disco %s%%" % (cpu_txt, mem_txt, disk_txt)) if cpu_txt else "in esecuzione"

        if args.once:
            break
        _sleep_or_wake(interval)


def _sleep_or_wake(seconds):
    """Dorme, ma si sveglia subito se l'utente chiede 'Sincronizza ora' dal tray."""
    if _wake is not None:
        _wake.wait(timeout=seconds)
        _wake.clear()
    else:
        time.sleep(seconds)


# ============================ System tray (Windows/macOS/Linux) ============================
def build_tray_image():
    """Disegna il logo VEDETTA (triangolo teal) per l'icona nella system tray."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    teal = (90, 186, 147, 255)
    d.polygon([(6, 12), (58, 12), (32, 58)], outline=teal, width=6)
    return img


def run_tray(cfg, args):
    global _wake
    _wake = threading.Event()

    def worker():
        try:
            run(cfg, args)
        except Exception:
            log("ERRORE nel ciclo dell'agente:\n" + traceback.format_exc())
            STATE["status"] = "ERRORE — vedi vedetta-agent.log"
            try:
                icon.notify("L'agente ha incontrato un errore. Controlla vedetta-agent.log", "VEDETTA Agent")
            except Exception:
                pass

    def on_open_console(icon_, item):
        webbrowser.open(STATE["url"])

    def on_open_log(icon_, item):
        try:
            if platform.system() == "Windows":
                os.startfile(LOG_FILE)  # type: ignore
            elif platform.system() == "Darwin":
                os.system('open "%s"' % LOG_FILE)
            else:
                os.system('xdg-open "%s"' % LOG_FILE)
        except Exception:
            pass

    def on_sync_now(icon_, item):
        STATE["status"] = "sincronizzazione..."
        _wake.set()

    def on_toggle_pause(icon_, item):
        STATE["paused"] = not STATE["paused"]
        if not STATE["paused"]:
            _wake.set()

    def on_quit(icon_, item):
        icon_.stop()
        os._exit(0)

    def status_label(item):
        return "Stato: %s" % STATE["status"]

    def last_sync_label(item):
        return "Ultimo invio: %s" % (STATE["last_sync"] or "mai")

    def pause_label(item):
        return "▶ Riprendi" if STATE["paused"] else "⏸ Metti in pausa"

    menu = pystray.Menu(
        pystray.MenuItem(status_label, None, enabled=False),
        pystray.MenuItem(last_sync_label, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("🔄 Sincronizza ora", on_sync_now),
        pystray.MenuItem(pause_label, on_toggle_pause),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("🌐 Apri console web", on_open_console),
        pystray.MenuItem("📄 Apri log", on_open_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("✖ Esci", on_quit),
    )

    icon = pystray.Icon("vedetta-agent", build_tray_image(), "VEDETTA Agent — avvio…", menu)
    t = threading.Thread(target=worker, daemon=True)
    t.start()
    icon.run()


def main():
    """Entry point robusto: qualsiasi errore viene registrato (a video se c'e'
    una console, sempre su vedetta-agent.log) e la finestra/processo non
    sparisce mai senza spiegazione."""
    try:
        cfg, args = resolve_config()
        if HAVE_TRAY and not args.once:
            log("Avvio in modalita' applicazione (icona nella system tray).")
            run_tray(cfg, args)
        else:
            if not HAVE_TRAY and not args.once:
                log("Modalita' tray non disponibile (manca 'pystray'/'pillow'): eseguo in console.")
                log("Per l'icona nella barra delle applicazioni: pip install pystray pillow")
            run(cfg, args)
    except KeyboardInterrupt:
        log("Interrotto dall'utente.")
    except Exception:
        log("=" * 64)
        log("ERRORE — l'agente si e' fermato")
        log("=" * 64)
        log(traceback.format_exc())
        try:
            input("\nPremi INVIO per chiudere questa finestra...")
        except Exception:
            pass


if __name__ == "__main__":
    main()
