/* EchoHealth service worker.
   App-shell caching only — never user data (everything stays in memory/on the
   device). The shell (this page + icons) is precached so the app opens offline.
   CDN libraries (Plotly, Leaflet, fflate, jsPDF) and the AI chat proxy are
   network-only: the dashboard works offline once a file is parsed, but those
   extras need a connection. */
const CACHE = "echohealth-v11";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./parser.js",
  "./sample.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
];

self.addEventListener("install", (e) => {
  // {cache:"reload"} forces fresh copies from the network, so a new SW version
  // never precaches stale HTTP-cached shell files.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
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
  // Network-first for code + styles. A versioned URL (app.js?v=N) can't beat a
  // cache-first match when ignoreSearch is on, so an old cached app.js/parser.js
  // would otherwise mask a fresh deploy (e.g. new buttons that "do nothing").
  // Online: always take the network copy and refresh the cache. Offline: fall
  // back to whatever is cached (ignoreSearch so a versioned URL still matches).
  if (/\.(?:js|css)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname, copy));
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }
  // Cache-first for static shell assets (icons, manifest). ignoreSearch so a
  // versioned URL still matches the cached entry; otherwise hit the network.
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});
