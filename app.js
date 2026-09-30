// Summit Benchmark: app logic.
// Live elevation readout via geolocation.watchPosition(), smoothed with a
// rolling median, and corrected to sea level (MSL) by a calibration offset.
//
// Correction is calibration-based (Design B): the raw GPS altitude is in the
// device's native frame (iOS ≈ MSL, Android = raw ellipsoidal, ~30 m low), and
// geoid separation varies by location, so rather than bundle a fragile per-
// region table we let the user calibrate against a known elevation, either a
// USGS ground-truth lookup when online or a hand-entered value. One calibration
// holds across a whole region/day.
//
// Logging: while a session is active, a reading is saved to IndexedDB (db.js)
// at most every LOG_INTERVAL_MS. A later phase adds the uPlot chart.

// USGS EPQS returns orthometric (NAVD88 / sea-level) elevation, the same frame
// as trail signs, so an offset from it cancels geoid separation and device bias
// at once. US coverage only; needs a connection (so: park entrance, visitor
// center, or the hotel the night before).
const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';
const EPQS_TIMEOUT_MS = 30000; // EPQS is authoritative but often slow (10-30 s)

const $ = id => document.getElementById(id);
const M_TO_FT = 3.28084;
const SMOOTHING_SAMPLES = 5; // rolling-median window; damps GPS altitude jitter
const CAL_KEY = 'summit.calibration';
const LOG_INTERVAL_MS = 15000; // one saved reading per 15 s keeps a full day small

// Coarse altitude-sickness cue. Real AMS risk depends on ascent rate and
// sleeping altitude, not just where you're standing, so this is an at-a-glance
// band, not medical advice. Highest matching band wins; below 8,000 ft: none.
const BANDS = [
  { min: 12000, cls: 'extreme', text: 'Extreme altitude. Descend if you feel unwell.' },
  { min: 10000, cls: 'high',    text: 'Above 10,000 ft: take it easy, watch for altitude sickness.' },
  { min: 8000,  cls: 'caution', text: 'High altitude: hydrate and pace yourself.' }
];

let watchId = null;
let count = 0;
let altSamples = [];  // recent raw altitudes (m), newest last
let lastFix = null;   // { rawM, accM, lat, lng } from the most recent good reading
let calibration = null; // { offsetM, source, ts } or null when uncalibrated
let session = null;     // active log session from db.js, or null when not logging
let savedCount = 0;     // readings saved in the active session
let lastLoggedT = 0;    // timestamp of the last fix written (throttle)

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
  const elevFt = elevM * M_TO_FT;
  $('elevFt').textContent = Math.round(elevFt).toLocaleString() + ' ft';
  $('elevM').textContent = elevM.toFixed(1) + ' m';
  $('accuracy').textContent = lastFix.accM != null
    ? '± ' + Math.round(lastFix.accM * M_TO_FT) + ' ft'
    : 'vertical accuracy not reported (normal on Android)';
  renderBand(elevFt);
}

function renderBand(elevFt) {
  const el = $('band');
  const band = BANDS.find(b => elevFt >= b.min);
  if (!band) { el.hidden = true; el.className = 'band'; return; }
  el.hidden = false;
  el.className = 'band ' + band.cls;
  el.textContent = band.text;
}

function renderCalState() {
  const state = $('calState');
  if (calibration) {
    state.textContent = 'Calibrated to sea level (' + calibration.source + ', '
      + fmtOffsetFt(calibration.offsetM) + ')';
    state.classList.add('on');
    $('calReset').hidden = false;
  } else {
    state.textContent = 'Uncalibrated: showing raw GPS';
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
  // Raw diagnostic value; Android reports null here (see the readout note).
  $('altAcc').textContent = c.altitudeAccuracy != null
    ? '± ' + Math.round(c.altitudeAccuracy) + ' m'
    : 'null';

  if (c.altitude == null || Number.isNaN(c.altitude)) {
    lastFix = null;
    $('elevFt').textContent = '—';
    $('elevM').textContent = 'altitude not provided';
    $('accuracy').textContent = '';
    $('band').hidden = true;
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
  logReading(pos);
  const acc = c.accuracy != null ? ' (±' + Math.round(c.accuracy) + ' m)' : '';
  setStatus('good', '✓ Live GPS fix' + acc + ', updating continuously.');
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

// Calibrate against USGS ground truth at the current location (online only).
async function calibrateUsgs() {
  if (!lastFix) { setCalMsg('Wait for a GPS fix before calibrating.'); return; }
  if (!navigator.onLine) {
    setCalMsg('No connection. Use "Enter known elevation" instead.');
    return;
  }
  const btn = $('calUsgs');
  const label = btn.textContent;
  btn.disabled = true;

  // Live elapsed-seconds counter so a slow EPQS call feels responsive.
  const started = Date.now();
  const tick = () => {
    btn.textContent = 'Checking USGS… ' + Math.floor((Date.now() - started) / 1000) + 's';
  };
  tick();
  const ticker = setInterval(tick, 250);

  setCalMsg('Querying USGS ground truth. This can take up to 30 seconds.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EPQS_TIMEOUT_MS);
  try {
    const url = EPQS_URL + '?x=' + lastFix.lng + '&y=' + lastFix.lat
      + '&units=Meters&wkid=4326&includeDate=false';
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const groundM = parseFloat(data && data.value);
    // EPQS returns a large negative sentinel for points with no elevation data.
    if (!isFinite(groundM) || groundM < -900000) throw new Error('no data here');
    applyCalibration(groundM, 'USGS');
    setCalMsg('Calibrated against USGS ground truth ('
      + Math.round(groundM * M_TO_FT).toLocaleString() + ' ft).');
  } catch (e) {
    const why = e.name === 'AbortError'
      ? 'USGS was too slow to respond'
      : 'USGS lookup failed (' + e.message + ')';
    setCalMsg(why + '. Try again, or enter a known elevation.');
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
    btn.disabled = false;
    btn.textContent = label;
  }
}

// --- Elevation log (sessions + throttled capture) ---
function setLogMsg(text) {
  $('logMsg').textContent = text || '';
}

function renderLog() {
  const state = $('logState');
  const btn = $('logToggle');
  if (session) {
    state.textContent = 'Logging';
    state.classList.add('on');
    $('logDetail').textContent = savedCount + (savedCount === 1 ? ' reading' : ' readings')
      + ' saved since ' + new Date(session.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    btn.textContent = 'Stop logging';
    btn.className = 'stop';
  } else {
    state.textContent = 'Not logging';
    state.classList.remove('on');
    $('logDetail').textContent = 'Saves a reading every 15 seconds while the app is open.';
    btn.textContent = 'Start logging';
    btn.className = 'primary';
  }
}

// Called on every fix. The throttle lives here, keyed on the fix's own
// timestamp, rather than in a timer: a timer would keep re-saving a stale
// lastFix when GPS stalls, faking a flat line. This way every saved row is a
// real, fresh fix, and a stall shows up as an honest gap.
function logReading(pos) {
  if (!session || !lastFix) return;
  if (pos.timestamp - lastLoggedT < LOG_INTERVAL_MS) return;
  lastLoggedT = pos.timestamp;
  const sessionId = session.id;
  SummitDB.addReading({
    sessionId,
    t: pos.timestamp,
    altM: lastFix.rawM,
    offsetM: calibration ? calibration.offsetM : null,
    vAccM: lastFix.accM,
    hAccM: pos.coords.accuracy,
    lat: lastFix.lat,
    lng: lastFix.lng
  }).then(() => {
    if (!session || session.id !== sessionId) return; // stopped meanwhile
    savedCount++;
    renderLog();
  }).catch(err => {
    console.error('Saving reading failed:', err);
    setLogMsg('Could not save a reading (' + err.message + '). Still trying.');
  });
}

async function toggleLog() {
  const btn = $('logToggle');
  btn.disabled = true;
  try {
    if (session) {
      const count = savedCount;
      await SummitDB.endSession(session.id);
      session = null;
      setLogMsg('Session saved with ' + count + (count === 1 ? ' reading.' : ' readings.'));
    } else {
      session = await SummitDB.startSession();
      savedCount = 0;
      lastLoggedT = 0; // save on the very next fix
      setLogMsg('');
      // Ask the browser not to evict the log under storage pressure. Home
      // screen apps on iOS are already exempt from WebKit's 7-day cap.
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    }
  } catch (err) {
    console.error('Log toggle failed:', err);
    setLogMsg('Storage error: ' + err.message);
  } finally {
    btn.disabled = false;
    renderLog();
  }
}

// Resume a session left running when the app was closed or killed.
async function initLog() {
  if (!('indexedDB' in window)) {
    $('logToggle').disabled = true;
    setLogMsg('This browser has no IndexedDB, so logging is unavailable.');
    return;
  }
  try {
    const active = await SummitDB.getActiveSession();
    if (active) {
      savedCount = await SummitDB.countReadings(active.id);
      session = active;
      setLogMsg('Resumed the session that was running.');
    }
  } catch (err) {
    console.error('Opening the log failed:', err);
    $('logToggle').disabled = true;
    setLogMsg('Logging unavailable: storage could not be opened (private browsing?).');
  }
  renderLog();
}

$('logToggle').addEventListener('click', toggleLog);

// --- Calibration UI wiring ---
$('calUsgs').addEventListener('click', calibrateUsgs);

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
initLog();
start();
