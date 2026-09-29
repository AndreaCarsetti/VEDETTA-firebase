#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VEDETTA NOC Agent - agente di monitoraggio endpoint (PC / Mac / Linux).

Si collega alla console VEDETTA MT e trasmette periodicamente i dati NOC
(Network Operations Center) della macchina: CPU, RAM, disco, rete, uptime,
numero processi, indirizzo IP, sistema operativo.

USO RAPIDO
----------
1) (consigliato) installa psutil per metriche complete:
       pip install psutil
2) configura e avvia:
       python3 vedetta-noc-agent.py --url http://IP-CONSOLE:8500 \\
               --key <ENROLL_KEY> --label "PC Reception"
   Oppure metti i valori in vedetta-noc.config.json (creato al primo avvio),
   oppure via variabili d'ambiente VEDETTA_URL / VEDETTA_ENROLL_KEY / VEDETTA_LABEL.

La ENROLL_KEY si trova nella console: scheda "Endpoint NOC" -> "Chiave endpoint".

Nessuna dipendenza obbligatoria oltre alla standard library (psutil opzionale).
"""

import argparse
import json
import os
import platform
import socket
import sys
import time
import uuid
import urllib.request

AGENT_VERSION = "1.0.0"
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vedetta-noc.config.json")

try:
    import psutil  # type: ignore
    HAVE_PSUTIL = True
except Exception:
    HAVE_PSUTIL = False


# ----------------------------- Config -----------------------------
def load_config():
    cfg = {}
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    return cfg


def save_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
    except Exception as e:
        print("! Impossibile salvare la config:", e)


def resolve_config():
    ap = argparse.ArgumentParser(description="VEDETTA NOC Agent")
    ap.add_argument("--url", help="URL console VEDETTA (es. http://192.168.1.5:8500)")
    ap.add_argument("--key", help="Enroll key dell'organizzazione")
    ap.add_argument("--label", help="Etichetta della postazione")
    ap.add_argument("--interval", type=int, help="Secondi tra un invio e l'altro (default 30)")
    ap.add_argument("--once", action="store_true", help="Invia un solo campione ed esci")
    args = ap.parse_args()

    cfg = load_config()
    cfg["url"] = args.url or os.environ.get("VEDETTA_URL") or cfg.get("url")
    cfg["enrollKey"] = args.key or os.environ.get("VEDETTA_ENROLL_KEY") or cfg.get("enrollKey")
    cfg["label"] = args.label or os.environ.get("VEDETTA_LABEL") or cfg.get("label") or socket.gethostname()
    cfg["interval"] = args.interval or cfg.get("interval") or 30
    if not cfg.get("hostId"):
        cfg["hostId"] = "%s-%s" % (socket.gethostname()[:40], hex(uuid.getnode())[2:])

    # richiesta interattiva se mancano dati essenziali
    if not cfg.get("url"):
        cfg["url"] = input("URL console VEDETTA (es. http://192.168.1.5:8500): ").strip()
    if not cfg.get("enrollKey"):
        cfg["enrollKey"] = input("Enroll key: ").strip()

    save_config(cfg)
    args.once = args.once
    return cfg, args.once


# ----------------------------- Metriche -----------------------------
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
    # uptime
    try:
        if HAVE_PSUTIL:
            m["uptime"] = int(time.time() - psutil.boot_time())
        elif hasattr(time, "clock_gettime") and hasattr(time, "CLOCK_BOOTTIME"):
            m["uptime"] = int(time.clock_gettime(time.CLOCK_BOOTTIME))
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
                m["netUp"] = round((io.bytes_sent - _last_net["up"]) / dt)   # byte/s
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
        # Fallback minimale senza psutil
        try:
            if hasattr(os, "getloadavg"):
                la = os.getloadavg()
                m["load1"] = round(la[0], 2)
                cores = os.cpu_count() or 1
                m["cpu"] = round(min(100.0, la[0] / cores * 100), 1)
        except Exception:
            pass
        try:
            import shutil
            root = "C:\\" if platform.system() == "Windows" else "/"
            du = shutil.disk_usage(root)
            m["disk"] = round(du.used / du.total * 100, 1)
        except Exception:
            pass
    return m


def build_payload(cfg):
    return {
        "hostId": cfg["hostId"],
        "hostname": socket.gethostname(),
        "label": cfg.get("label", ""),
        "os": platform.system(),           # Darwin / Windows / Linux
        "osRelease": platform.release(),
        "agentVersion": AGENT_VERSION,
        "ip": local_ip(),
        "metrics": collect_metrics(),
    }


# ----------------------------- Invio -----------------------------
def send(cfg, payload):
    url = cfg["url"].rstrip("/") + "/api/v1/noc"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Enroll-Key", cfg["enrollKey"])
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        return body


def main():
    cfg, once = resolve_config()
    print("VEDETTA NOC Agent %s  |  host=%s  os=%s  psutil=%s"
          % (AGENT_VERSION, cfg["hostId"], platform.system(), "sì" if HAVE_PSUTIL else "NO (metriche ridotte, 'pip install psutil')"))
    print("Console: %s  ·  intervallo: %ss" % (cfg["url"], cfg["interval"]))

    interval = int(cfg.get("interval", 30))
    while True:
        try:
            payload = build_payload(cfg)
            body = send(cfg, payload)
            if isinstance(body, dict) and body.get("pollSeconds"):
                interval = int(body["pollSeconds"])
            m = payload["metrics"]
            print("[%s] inviato · cpu=%s%% mem=%s%% disk=%s%% batteria=%s%% temp=%s porte=%s"
                  % (time.strftime("%H:%M:%S"), m.get("cpu", "?"), m.get("mem", "?"), m.get("disk", "?"),
                     (m.get("battery") or {}).get("percent", "-"), len(m.get("temperatures", [])), len(m.get("listenPorts", []))))
        except Exception as e:
            print("[%s] errore invio: %s" % (time.strftime("%H:%M:%S"), e))
        if once:
            break
        time.sleep(interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrotto.")
        sys.exit(0)
