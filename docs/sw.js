// Minefield service worker. The version and the precache list below are filled in at build
// time (see vite.config.ts), so every deploy gets a fresh cache and old ones are dropped.
const VERSION = '50406751ac';
const CACHE = `minefield-${VERSION}`;
const PRECACHE = ["./","assets/index-BF2Yk2EZ.js","assets/index-CHIXWVB3.css","assets/minefield_bg-BUsUE2p0.wasm","manifest.webmanifest","favicon.svg","icon.svg","icon-192.png","icon-512.png","icon-maskable-512.png","apple-touch-icon.png"];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('minefield-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Pages: try the network first (so updates arrive), fall back to the cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./', { ignoreSearch: true })),
    );
    return;
  }

  // Everything else is content-hashed or static: cache first, fill the cache on a miss.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
