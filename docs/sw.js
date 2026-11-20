// Mines' Mapper service worker. The version and the precache list below are filled in at build
// time (see vite.config.ts), so every deploy gets a fresh cache and old ones are dropped.
const VERSION = '87a1258c6b';
const CACHE = `minefield-${VERSION}`;
const PRECACHE = ["./","assets/badlands-C8VH_RZ8.svg","assets/beach-DAmO179g.svg","assets/cinzel-latin-700-normal-Dkw14w9r.woff2","assets/desert-B4fh82Px.svg","assets/forest-BRTMh9BH.svg","assets/grassland-D82J4ljy.svg","assets/home-CBtC2QHB.svg","assets/index-BJGVIHQc.css","assets/index-Cfe2QIrY.js","assets/jungle-DYRjIBWT.svg","assets/kalam-latin-700-normal-D2H-9ISU.woff2","assets/lake-BvK-8qgj.svg","assets/logo-Up8suCQS.png","assets/minefield_bg-S18Oj3A-.wasm","assets/monster-kraken-BauH6Ms1.svg","assets/monster-serpent-B1RQV55O.svg","assets/mountain-rock-DQtSsWT1.svg","assets/mountain-snow-BvVTqbqH.svg","assets/render-BshTBhPK.js","assets/savanna-DxFNYEx_.svg","assets/ship-B5InVsch.svg","assets/swamp-Bo9eH6G2.svg","assets/taiga-Cpubno_v.svg","assets/tundra-D76Er-Rw.svg","assets/viewer3d-DbuDyrIV.js","assets/wave-1-YTJB3WNB.svg","manifest.webmanifest","favicon.png","favicon-64.png","icon-192.png","icon-512.png","icon-maskable-512.png","apple-touch-icon.png"];

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
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
