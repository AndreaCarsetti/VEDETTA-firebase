#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VEDETTA Premium Agent - agente unico multipiattaforma (Windows / macOS / Linux).

A differenza dell'estensione Chrome (limitata a un solo browser), l'agente Premium:
  * monitora la navigazione di TUTTI i browser installati (Chrome, Edge, Brave,
    Chromium, Firefox e Safari su Mac) leggendo la cronologia in tempo reale;
  * rileva l'accesso alle piattaforme AI e alle richieste verso domini
    pubblicitari / tracker / malware, inviando gli eventi alla console VEDETTA;
  * svolge CONTEMPORANEAMENTE il servizio NOC (CPU, RAM, disco, rete, uptime,
    processi, IP) alimentando la pagina "Agenti System".

Un solo processo, due funzioni: eventi di navigazione + telemetria NOC.

USO RAPIDO
----------
1) (consigliato) metriche NOC complete:
       pip install psutil
2) avvio:
       python3 vedetta-premium-agent.py \
           --url https://vedetta-24464.web.app \
           --agent-key <AGENT_KEY> --enroll-key <ENROLL_KEY> \
           --label "PC Reception"

Le chiavi si trovano nella console:
   * AGENT_KEY  -> scheda "Agenti Chrome" (Agent Key per le estensioni)
   * ENROLL_KEY -> scheda "Tenants / Clienti" (Enroll key dell'organizzazione)

I valori possono anche essere messi in vedetta-premium.config.json (creato al
primo avvio) o via variabili d'ambiente VEDETTA_URL / VEDETTA_AGENT_KEY /
VEDETTA_ENROLL_KEY / VEDETTA_LABEL.

Nessuna dipendenza obbligatoria oltre alla standard library (psutil opzionale).
Per creare un eseguibile installabile: vedi PREMIUM-AGENT-INSTALL.txt (PyInstaller).
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
import uuid
import urllib.request

AGENT_VERSION = "1.0.0 Premium (all-browser + NOC)"
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vedetta-premium.config.json")

try:
    import psutil  # type: ignore
    HAVE_PSUTIL = True
except Exception:
    HAVE_PSUTIL = False


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


def resolve_config():
    ap = argparse.ArgumentParser(description="VEDETTA Premium Agent")
    ap.add_argument("--url", help="URL console VEDETTA")
    ap.add_argument("--agent-key", help="Agent key (eventi di navigazione)")
    ap.add_argument("--enroll-key", help="Enroll key (telemetria NOC)")
    ap.add_argument("--label", help="Etichetta della postazione")
    ap.add_argument("--interval", type=int, help="Secondi tra i cicli (default 30)")
    ap.add_argument("--no-noc", action="store_true", help="Disattiva la parte NOC")
    ap.add_argument("--no-browser", action="store_true", help="Disattiva il monitoraggio browser")
    ap.add_argument("--once", action="store_true", help="Un solo ciclo ed esci")
    args = ap.parse_args()

    cfg = load_config()
    cfg["url"] = args.url or os.environ.get("VEDETTA_URL") or cfg.get("url")
    cfg["agentKey"] = args.agent_key or os.environ.get("VEDETTA_AGENT_KEY") or cfg.get("agentKey")
    cfg["enrollKey"] = args.enroll_key or os.environ.get("VEDETTA_ENROLL_KEY") or cfg.get("enrollKey")
    cfg["label"] = args.label or os.environ.get("VEDETTA_LABEL") or cfg.get("label") or socket.gethostname()
    cfg["interval"] = args.interval or cfg.get("interval") or 30
    if not cfg.get("hostId"):
        cfg["hostId"] = "%s-%s" % (socket.gethostname()[:40], hex(uuid.getnode())[2:])
    if not cfg.get("agentId"):
        cfg["agentId"] = "PREM-" + hex(uuid.getnode())[2:][:8].upper()
    if "lastScan" not in cfg:
        cfg["lastScan"] = time.time()  # da ora in avanti (non spedire tutta la cronologia storica)

    if not cfg.get("url"):
        cfg["url"] = input("URL console VEDETTA: ").strip()
    if not cfg.get("agentKey"):
        cfg["agentKey"] = input("Agent key: ").strip()
    if not cfg.get("enrollKey"):
        cfg["enrollKey"] = input("Enroll key (NOC): ").strip()

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
    try:
        if HAVE_PSUTIL:
            m["uptime"] = int(time.time() - psutil.boot_time())
    except Exception:
        pass
    if HAVE_PSUTIL:
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
    # Chromium: last_visit_time = microsecondi dal 1601-01-01
    chrome_since = int((since_epoch + 11644473600) * 1_000_000)
    for p in _chromium_history_paths():
        for r in _read_sqlite(p, "SELECT url, last_visit_time FROM urls WHERE last_visit_time > %d ORDER BY last_visit_time DESC LIMIT 500" % chrome_since):
            try:
                ep = r["last_visit_time"] / 1_000_000 - 11644473600
                visits.append((ep, r["url"]))
            except Exception:
                pass
    # Firefox: last_visit_date = microsecondi dal 1970-01-01
    ff_since = int(since_epoch * 1_000_000)
    for p in _firefox_history_paths():
        for r in _read_sqlite(p, "SELECT url, last_visit_date FROM moz_places WHERE last_visit_date > %d ORDER BY last_visit_date DESC LIMIT 500" % ff_since):
            try:
                if r["last_visit_date"]:
                    visits.append((r["last_visit_date"] / 1_000_000, r["url"]))
            except Exception:
                pass
    # Safari: visit_time = secondi dal 2001-01-01 (Cocoa epoch)
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
            "dettaglio": "%s (agente Premium, tutti i browser)" % regola,
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
    """Registra l'agente Premium nella pagina Agenti Chrome (type=premium)."""
    base = cfg["url"].rstrip("/")
    http_get(base + "/api/v1/config", {
        "X-Agent-Key": cfg["agentKey"], "X-Agent-Id": cfg["agentId"],
        "X-Agent-Label": cfg.get("label", ""), "X-Agent-Type": "premium",
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
    return http_post(base + "/api/v1/noc", {"X-Enroll-Key": cfg["enrollKey"]}, payload)


# ============================ Main ============================
def main():
    cfg, args = resolve_config()
    print("VEDETTA Premium Agent %s" % AGENT_VERSION)
    print("host=%s  agentId=%s  os=%s  psutil=%s"
          % (cfg["hostId"], cfg["agentId"], platform.system(), "si" if HAVE_PSUTIL else "NO (pip install psutil)"))
    print("Console: %s  ·  intervallo: %ss  ·  browser=%s  noc=%s"
          % (cfg["url"], cfg["interval"], "OFF" if args.no_browser else "ON", "OFF" if args.no_noc else "ON"))

    interval = int(cfg.get("interval", 30))
    while True:
        stamp = time.strftime("%H:%M:%S")
        # 1) heartbeat + eventi navigazione (tutti i browser)
        if not args.no_browser:
            try:
                heartbeat(cfg)
                ev = scan_browser_events(cfg)
                n = send_events(cfg, ev)
                save_config(cfg)
                print("[%s] browser: %d eventi inviati" % (stamp, n))
            except Exception as e:
                print("[%s] browser errore: %s" % (stamp, e))
        # 2) telemetria NOC
        if not args.no_noc:
            try:
                body = send_noc(cfg)
                if isinstance(body, dict) and body.get("pollSeconds"):
                    interval = int(body["pollSeconds"])
                m = collect_metrics()
                print("[%s] NOC: cpu=%s%% mem=%s%% disk=%s%%"
                      % (stamp, m.get("cpu", "?"), m.get("mem", "?"), m.get("disk", "?")))
            except Exception as e:
                print("[%s] NOC errore: %s" % (stamp, e))
        if args.once:
            break
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrotto.")
        sys.exit(0)
