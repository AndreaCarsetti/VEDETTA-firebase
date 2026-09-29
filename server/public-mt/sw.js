/**
 * VEDETTA PWA - Service Worker
 * Strategia:
 *  - App shell (HTML/CSS/JS/icone): cache-first con aggiornamento in background
 *  - API admin: network-first con fallback sull'ultima risposta in cache (consultazione offline)
 *  - Notifiche: mostrate dal client quando rileva nuove violazioni ad alta severità
 */
"use strict";

const VERSION = "vedetta-firebase-v8.0.0";
const SHELL_CACHE = VERSION + "-shell";
const DATA_CACHE = VERSION + "-data";

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/qrcode.js",
  "/enroll.html",
  "/rules-parser.js",
  "/manifest.webmanifest",
  "/icons/vedetta-192.png",
  "/icons/vedetta-512.png",
  "/icons/vedetta-maskable-192.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, fallback su cache dati
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) {
            const body = await cached.json();
            return new Response(JSON.stringify(body), {
              headers: { "Content-Type": "application/json", "X-Vedetta-Offline": "1" }
            });
          }
          return new Response(JSON.stringify({ error: "offline", offline: true }), {
            status: 503,
            headers: { "Content-Type": "application/json", "X-Vedetta-Offline": "1" }
          });
        })
    );
    return;
  }

  // App shell: network-first per aggiornamento immediato, fallback su cache
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});

/* Notifica richiesta dal client (nuova violazione critica) */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "vedetta_notify") {
    self.registration.showNotification(msg.title || "VEDETTA", {
      body: msg.body || "",
      icon: "/icons/vedetta-192.png",
      badge: "/icons/vedetta-96.png",
      tag: msg.tag || "vedetta-alert",
      renotify: true,
      data: { url: msg.url || "/?tab=eventi&categoria=violazione" }
    });
  } else if (msg.type === "vedetta_skip_waiting") {
    self.skipWaiting();
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

/* Sincronizzazione periodica (se il browser la supporta) */
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "vedetta-poll") {
    event.waitUntil(
      self.clients.matchAll().then((list) => list.forEach((c) => c.postMessage({ type: "vedetta_refresh" })))
    );
  }
});
