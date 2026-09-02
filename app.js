// Summit Benchmark — app logic.
// Live elevation readout via geolocation.watchPosition(), smoothed with a
// rolling median, and corrected to sea level (MSL) by a calibration offset.
//
// Correction is calibration-based (Design B): the raw GPS altitude is in the
// device's native frame (iOS ≈ MSL, Android = raw ellipsoidal, ~30 m low), and
// geoid separation varies by location, so rather than bundle a fragile per-
// region table we let the user calibrate against a known elevation. One
// calibration holds across a whole region/day. Later phases add USGS auto-
// calibration, IndexedDB logging, and the uPlot chart.

const $ = id => document.getElementById(id);
const M_TO_FT = 3.28084;
const SMOOTHING_SAMPLES = 5; // rolling-median window; damps GPS altitude jitter
const CAL_KEY = 'summit.calibration';

let watchId = null;
let count = 0;
let altSamples = [];  // recent raw altitudes (m), newest last
let lastFix = null;   // { rawM, accM, lat, lng } from the most recent good reading
let calibration = null; // { offsetM, source, ts } or null when uncalibrated

// Median is robust to the occasional wild GPS altitude spike in a way a mean is
// not. A constant offset commutes with the median, so smoothing the raw reading
// and then adding the calibration offset is equivalent to correcting first.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function correctedM(rawM) {
  return rawM + (calibration ? calibration.offsetM : 0);
}

// Signed feet, e.g. "+43 ft" / "-12 ft" (plain hyphen, this is a numeric sign).
function fmtOffsetFt(offsetM) {
  const ft = Math.round(offsetM * M_TO_FT);
  return (ft >= 0 ? '+' : '-') + Math.abs(ft) + ' ft';
}

function setStatus(cls, text) {
  const el = $('status');
  el.className = 'status ' + cls;
  el.textContent = text;
}

function setCalMsg(text) {
  $('calMsg').textContent = text || '';
}

// --- Calibration persistence (localStorage; degrades gracefully if blocked) ---
function loadCalibration() {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    calibration = raw ? JSON.parse(raw) : null;
  } catch (e) {
    calibration = null;
  }
}

function saveCalibration() {
  try {
    if (calibration) localStorage.setItem(CAL_KEY, JSON.stringify(calibration));
    else localStorage.removeItem(CAL_KEY);
  } catch (e) {
    // Private mode / storage disabled: keep the in-memory value for this session.
  }
}

// Compute and store an offset that makes the current reading equal knownM.
function applyCalibration(knownM, source) {
  if (!lastFix) return false;
  calibration = { offsetM: knownM - lastFix.rawM, source, ts: Date.now() };
  saveCalibration();
  refresh();
  return true;
}

function resetCalibration() {
  calibration = null;
  saveCalibration();
  setCalMsg('Calibration cleared.');
  refresh();
}

// --- Rendering ---
function renderElevation() {
  if (!lastFix) return;
  const elevM = correctedM(lastFix.rawM);
  $('elevFt').textContent = Math.round(elevM * M_TO_FT).toLocaleString() + ' ft';
  $('elevM').textContent = elevM.toFixed(1) + ' m';
  $('accuracy').textContent = lastFix.accM != null
    ? '± ' + Math.round(lastFix.accM * M_TO_FT) + ' ft'
    : 'accuracy unknown';
}

function renderCalState() {
  const state = $('calState');
  if (calibration) {
    state.textContent = 'Calibrated to sea level (' + calibration.source + ', '
      + fmtOffsetFt(calibration.offsetM) + ')';
    state.classList.add('on');
    $('calReset').hidden = false;
  } else {
    state.textContent = 'Uncalibrated — showing raw GPS';
    state.classList.remove('on');
    $('calReset').hidden = true;
  }
}

function refresh() {
  renderElevation();
  renderCalState();
}

// --- Geolocation stream ---
function onPosition(pos) {
  count++;
  const c = pos.coords;

  $('count').textContent = count;
  $('time').textContent = new Date(pos.timestamp).toLocaleTimeString();
  $('lat').textContent = c.latitude.toFixed(6);
  $('lng').textContent = c.longitude.toFixed(6);
  $('horAcc').textContent = c.accuracy != null ? '± ' + Math.round(c.accuracy) + ' m' : '—';

  if (c.altitude == null || Number.isNaN(c.altitude)) {
    lastFix = null;
    $('elevFt').textContent = '—';
    $('elevM').textContent = 'altitude not provided';
    $('accuracy').textContent = '';
    setStatus('bad', '✗ This device is not reporting altitude.');
    return;
  }

  altSamples.push(c.altitude);
  if (altSamples.length > SMOOTHING_SAMPLES) altSamples.shift();
  lastFix = {
    rawM: median(altSamples),
    accM: c.altitudeAccuracy,
    lat: c.latitude,
    lng: c.longitude
  };

  renderElevation();
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

// --- Calibration UI wiring ---
$('calManualToggle').addEventListener('click', () => {
  const row = $('calManualRow');
  row.hidden = !row.hidden;
  setCalMsg('');
  if (!row.hidden) $('calManualInput').focus();
});

$('calManualApply').addEventListener('click', () => {
  const ft = parseFloat($('calManualInput').value);
  if (!isFinite(ft)) { setCalMsg('Enter the known elevation in feet.'); return; }
  if (!lastFix) { setCalMsg('Wait for a GPS fix before calibrating.'); return; }
  applyCalibration(ft / M_TO_FT, 'manual');
  $('calManualRow').hidden = true;
  $('calManualInput').value = '';
  setCalMsg('Calibrated using your known elevation.');
});

$('calReset').addEventListener('click', resetCalibration);

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

loadCalibration();
renderCalState();
start();
