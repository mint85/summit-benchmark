// Summit Benchmark service worker.
// Offline-first with a NETWORK-FIRST strategy: when online, always fetch fresh
// (and update the cache), so a new deploy shows on the next open with no
// stale-cache lag; when offline, fall back to the precached shell so the app
// still runs with no signal. GPS itself needs no network; only loading the
// page does.
//
// The network gets NETWORK_TIMEOUT_MS to answer. A weak or flickering signal
// doesn't make fetch() fail, it makes it hang (it left Android stuck on the
// splash screen in the parks), so without the timeout the cached copy would
// never be used.
//
// Because online devices refresh automatically, you normally do NOT need to
// bump CACHE_VERSION to ship a change. Bump it only to force-purge the offline
// cache (e.g. to evict an asset that was removed).

const CACHE_VERSION = 'summit-v1';
const NETWORK_TIMEOUT_MS = 5000;
// After one request times out, skip the wait for the next SLOW_NETWORK_MS so
// the page's scripts and styles don't each wait out their own timeout (which
// doubled the splash screen to ~10 s in testing). Any network answer clears it.
const SLOW_NETWORK_MS = 30000;
let networkSlowUntil = 0;
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './db.js',
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

// Cached copy of a request; a navigation that isn't cached under its exact
// URL falls back to the app shell.
function fromCache(req) {
  return caches.match(req).then(cached =>
    cached || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)
  );
}

// Network-first for the app shell, cache as fallback. Only handle same-origin
// GET requests so we never interfere with the geolocation subsystem or
// cross-origin calls (USGS EPQS lookups).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  const network = fetch(req);

  // Keep the offline copy current whenever the network answers, even if the
  // timeout already served the cached copy. This handler is attached before
  // the one below that hands the response to the page, so the clone happens
  // before the body is read.
  event.waitUntil(
    network.then(res => {
      if (res.status !== 200) return;
      const copy = res.clone();
      return caches.open(CACHE_VERSION).then(cache => cache.put(req, copy));
    }).catch(() => {})
  );

  event.respondWith(new Promise((resolve, reject) => {
    // Slow network: switch to the cached copy. With nothing cached (first
    // visit), keep waiting for the network instead.
    const wait = Date.now() < networkSlowUntil ? 0 : NETWORK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      networkSlowUntil = Date.now() + SLOW_NETWORK_MS;
      fromCache(req).then(cached => { if (cached) resolve(cached); });
    }, wait);

    network.then(
      res => { clearTimeout(timer); networkSlowUntil = 0; resolve(res); },
      () => {
        // Offline (fetch failed outright): serve from cache right away.
        clearTimeout(timer);
        fromCache(req).then(cached =>
          cached ? resolve(cached) : reject(new Error('offline and not cached'))
        );
      }
    );
  }));
});
