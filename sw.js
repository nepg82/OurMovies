const CACHE_VERSION = 'movie-shelf-v5';
const CORE_ASSETS = [
  'index.html',
  'admin.html',
  'style.css',
  'app.js',
  'admin.js',
  'import.js',
  'migrate.js',
  'shared.js',
  'sync.js',
  'manifest.json',
  'data.json',
  'app-icon/app-icon-192.png',
  'app-icon/app-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // data.json and version.json: network first, so a fresh push is never hidden
  // behind the cache. The cache is only the offline fallback.
  const url = new URL(req.url);
  if (url.origin === self.location.origin && /\/(data|version)\.json$/.test(url.pathname)) {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // runtime-cache cover thumbnails and any other same-origin asset as it's used
          if (res.ok && new URL(req.url).origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
