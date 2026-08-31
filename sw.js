// Summit Benchmark service worker.
// Offline-first: precache the app shell, serve it cache-first so the app opens
// with no signal. GPS itself needs no network; only loading the page does.
// Bump CACHE_VERSION whenever a shell asset changes to force a refresh.

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

// Cache-first for the app shell; network fallback for everything else.
// Only handle same-origin GET requests so we never interfere with the
// geolocation subsystem or cross-origin calls (future: USGS EPQS lookups).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});
