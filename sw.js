// Summit Benchmark service worker.
// Offline-first with a NETWORK-FIRST strategy: when online, always fetch fresh
// (and update the cache), so a new deploy shows on the next open with no
// stale-cache lag; when offline, fall back to the precached shell so the app
// still runs with no signal. GPS itself needs no network; only loading the
// page does.
//
// Because online devices refresh automatically, you normally do NOT need to
// bump CACHE_VERSION to ship a change. Bump it only to force-purge the offline
// cache (e.g. to evict an asset that was removed).

const CACHE_VERSION = 'summit-v1';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first for the app shell, cache as fallback. Only handle same-origin
// GET requests so we never interfere with the geolocation subsystem or
// cross-origin calls (future: USGS EPQS lookups).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    fetch(req)
      .then(res => {
        // Keep the offline copy current: cache each successful fetch.
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // Offline (or the fetch failed): serve from cache. For a navigation
        // that isn't cached under its exact URL, fall back to the app shell.
        caches.match(req).then(cached =>
          cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
        )
      )
  );
});
