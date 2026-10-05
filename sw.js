// Bump this version string every time you deploy a change to
// index.html / style.css / game.js / manifest.json, otherwise
// returning players will keep getting the old cached build.
const CACHE_NAME = "airblasthero-cache-v27";
// BUGFIX: mp-room-net.js is loaded unconditionally by index.html and is
// required for FFA/Team/Race (game.js calls straight into it) but was
// missing from this list — it was falling into the cache-first, may-go-
// stale branch below instead of the network-first one every other
// gameplay file gets, and wasn't guaranteed to be precached for offline/
// installed play at all.
const CORE_ASSETS = ["./index.html", "./style.css", "./game.js", "./mp.js", "./mp-room-net.js", "./mp-lobby.js", "./manifest.json"];
const STATIC_ASSETS = ["./icon-192.png", "./icon-512.png", "./mp-icon.png", "./gameover-moai.jpg", "./gameover-slender.jpg"];
const ASSETS = ["./", ...CORE_ASSETS, ...STATIC_ASSETS];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isCoreAsset(url) {
  return CORE_ASSETS.some((a) => url.endsWith(a.replace("./", "/")) || url.endsWith(a.replace("./", "")));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Network-first for the game's own code/markup, so a new deploy
  // shows up immediately instead of being stuck behind an old cache.
  // Falls back to cache when offline.
  if (req.method === "GET" && url.origin === location.origin && isCoreAsset(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for static assets (icons etc.)
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((response) => {
          if (response && response.status === 200 && req.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
