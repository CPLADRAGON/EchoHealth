/* EchoHealth service worker.
   App-shell caching only — never user data (everything stays in memory/on the
   device). The shell (this page + icons) is precached so the app opens offline.
   CDN libraries (Plotly, Leaflet, fflate, jsPDF) and the AI chat proxy are
   network-only: the dashboard works offline once a file is parsed, but those
   extras need a connection. */
const CACHE = "echohealth-v5";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./parser.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only handle same-origin navigations/assets; let CDN + API go to network.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/api/")) return;
  // Network-first for the HTML document so updates land; fall back to cache.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("./index.html", copy));
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }
  // Cache-first for static shell assets.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
