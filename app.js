// Summit Benchmark — app shell.
// Phase 1: live elevation readout via geolocation.watchPosition().
// Later phases layer on: smoothing (rolling median), MSL/geoid correction,
// "calibrate here", IndexedDB logging, and the uPlot chart.

const $ = id => document.getElementById(id);
const M_TO_FT = 3.28084;
const SMOOTHING_SAMPLES = 5; // rolling-median window; damps GPS altitude jitter

let watchId = null;
let count = 0;
let altSamples = []; // recent raw altitudes (m), newest last

// Median is robust to the occasional wild GPS altitude spike in a way a mean
// is not. With a constant correction offset (added later), median(raw) + offset
// equals median(corrected), so smoothing here composes cleanly with Phase 2's
// geoid/calibration correction.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function setStatus(cls, text) {
  const el = $('status');
  el.className = 'status ' + cls;
  el.textContent = text;
}

// NOTE: the browser reports altitude in the device's native reference frame
// (iOS = orthometric/MSL, Android = raw ellipsoidal). Phase 2 normalizes this
// to sea level. For now we display the raw reading as-is.
function onPosition(pos) {
  count++;
  const c = pos.coords;

  $('count').textContent = count;
  $('time').textContent = new Date(pos.timestamp).toLocaleTimeString();
  $('lat').textContent = c.latitude.toFixed(6);
  $('lng').textContent = c.longitude.toFixed(6);
  $('horAcc').textContent = c.accuracy != null ? '± ' + Math.round(c.accuracy) + ' m' : '—';

  if (c.altitude == null || Number.isNaN(c.altitude)) {
    $('elevFt').textContent = '—';
    $('elevM').textContent = 'altitude not provided';
    $('accuracy').textContent = '';
    setStatus('bad', '✗ This device is not reporting altitude.');
    return;
  }

  altSamples.push(c.altitude);
  if (altSamples.length > SMOOTHING_SAMPLES) altSamples.shift();
  const elevM = median(altSamples);

  const ft = elevM * M_TO_FT;
  $('elevFt').textContent = Math.round(ft).toLocaleString() + ' ft';
  $('elevM').textContent = elevM.toFixed(1) + ' m';
  $('accuracy').textContent = c.altitudeAccuracy != null
    ? '± ' + Math.round(c.altitudeAccuracy * M_TO_FT) + ' ft'
    : 'accuracy unknown';
  setStatus('good', '✓ Live fix.');
}

function onError(err) {
  const msgs = { 1: 'Permission denied', 2: 'Position unavailable', 3: 'Timeout' };
  setStatus('bad', '✗ ' + (msgs[err.code] || 'Error') + '. ' + err.message);
}

function start() {
  if (!('geolocation' in navigator)) {
    setStatus('bad', '✗ This browser has no Geolocation API.');
    return;
  }
  if (!window.isSecureContext) {
    setStatus('bad', '✗ Not a secure context (HTTPS). Serve this over HTTPS.');
    return;
  }
  setStatus('wait', 'Requesting location… allow the permission prompt.');
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000
  });
}

// --- Offline / connectivity indicator ---
function updateOnlineState() {
  $('offline-badge').hidden = navigator.onLine;
}
window.addEventListener('online', updateOnlineState);
window.addEventListener('offline', updateOnlineState);
updateOnlineState();

// --- Service worker (offline app shell) ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      $('sw-state').textContent = reg.active
        ? 'app shell cached for offline use'
        : 'caching app shell…';
    }).catch(err => {
      $('sw-state').textContent = 'offline caching unavailable';
      console.error('SW registration failed:', err);
    });
  });
}

start();
