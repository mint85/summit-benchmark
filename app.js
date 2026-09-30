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
  $('pocketBtn').hidden = !session;
  renderPocket();
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

// --- Pocket mode (keep-awake black screen for continuous logging) ---
// A web app can't use GPS in the background: once the screen locks, the page
// is suspended and logging pauses. Pocket mode holds a screen Wake Lock and
// covers the app with a black overlay that swallows touches, so the phone can
// ride in a pocket while still logging. On OLED screens black pixels are off,
// so the cost is mostly GPS plus the awake processor, not the display.
const UNLOCK_HOLD_MS = 2000;  // hold the circle this long to exit
const UNLOCK_HINT_MS = 5000;  // how long the circle stays up after a touch
const DRIFT_MS = 60000;       // move the dim text so it can't burn in

let pocketOn = false;
let wakeLock = null;          // WakeLockSentinel while held
let wakeLockPending = false;
let holdFrame = null;         // requestAnimationFrame id while the ring is held
let holdStart = 0;
let hintTimer = null;
let driftTimer = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || wakeLockPending) return;
  if (document.visibilityState !== 'visible') return;
  wakeLockPending = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    // The browser releases the lock whenever the page is hidden.
    wakeLock.addEventListener('release', () => { wakeLock = null; renderPocket(); });
  } catch (err) {
    console.warn('Wake lock refused:', err);
  } finally {
    wakeLockPending = false;
    renderPocket();
  }
}

function renderPocket() {
  if (!pocketOn) return;
  const elev = lastFix
    ? Math.round(correctedM(lastFix.rawM) * M_TO_FT).toLocaleString() + ' ft'
    : 'waiting for GPS';
  // Say so if the lock failed: otherwise the screen would auto-lock in the
  // pocket and silently pause logging.
  const warn = wakeLock || wakeLockPending ? '' : '\nScreen may auto-lock. Tap to retry.';
  $('pocketInfo').textContent = elev + ', ' + savedCount + ' saved' + warn;
}

function driftPocket() {
  const x = Math.round((Math.random() - 0.5) * window.innerWidth * 0.5);
  const y = Math.round((Math.random() - 0.5) * window.innerHeight * 0.4);
  $('pocketInfo').style.transform = 'translate(' + x + 'px, ' + y + 'px)';
}

function enterPocket() {
  if (!session) return;
  pocketOn = true;
  $('pocket').hidden = false;
  setUnlockHint(false);
  renderPocket();
  driftPocket();
  driftTimer = setInterval(driftPocket, DRIFT_MS);
  requestWakeLock();
}

function exitPocket() {
  pocketOn = false;
  $('pocket').hidden = true;
  stopHold();
  clearTimeout(hintTimer);
  clearInterval(driftTimer);
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

// Two steps to unlock so pocket contact can't do it: any touch reveals the
// circle for a few seconds, then the circle must be held for UNLOCK_HOLD_MS.
function setUnlockHint(show) {
  $('pocketUnlock').hidden = !show;
  $('pocket').classList.toggle('hinting', show); // parks the reading up top
}

function showUnlockHint() {
  setUnlockHint(true);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => setUnlockHint(false), UNLOCK_HINT_MS);
}

// The ring's fill and the unlock are driven by one animation-frame loop, so
// they can't disagree: lifting the thumb stops the loop and empties the ring.
// (A CSS transition kept sweeping to full on Android after release.)
function holdFrameTick(now) {
  const p = Math.min(1, (now - holdStart) / UNLOCK_HOLD_MS);
  $('pocketRing').style.setProperty('--progress', p * 100);
  if (p < 1) {
    holdFrame = requestAnimationFrame(holdFrameTick);
    return;
  }
  holdFrame = null;
  hapticTick();
  exitPocket();
}

function startHold() {
  clearTimeout(hintTimer);
  holdStart = performance.now();
  holdFrame = requestAnimationFrame(holdFrameTick);
}

function stopHold() {
  if (holdFrame !== null) cancelAnimationFrame(holdFrame);
  holdFrame = null;
  $('pocketRing').style.setProperty('--progress', 0);
}

function cancelHold() {
  if (holdFrame === null) return;
  stopHold();
  showUnlockHint();
}

// Short buzz when pocket mode unlocks. Android has the Vibration API; iOS
// Safari does not, but toggling an <input type="checkbox" switch> (Safari
// 17.4+) fires the system haptic, so fall back to clicking a hidden one. The
// iOS path is a known workaround rather than an API.
function hapticTick() {
  if (navigator.vibrate) {
    navigator.vibrate(40);
    return;
  }
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.appendChild(input);
  label.style.display = 'none';
  document.body.appendChild(label);
  label.click();
  label.remove();
}

$('pocketBtn').addEventListener('click', enterPocket);

$('pocket').addEventListener('pointerdown', () => {
  // A touch is a user gesture, so it is also a good moment to retry a lock
  // the browser refused or dropped.
  requestWakeLock();
  if (holdFrame === null) showUnlockHint();
});
$('pocket').addEventListener('contextmenu', e => e.preventDefault());

$('pocketRing').addEventListener('pointerdown', startHold);
['pointerup', 'pointercancel', 'pointerleave'].forEach(type =>
  $('pocketRing').addEventListener(type, cancelHold));

// Coming back to the app (after the side button or an app switch) needs a
// fresh lock; the old one was released when the page was hidden.
document.addEventListener('visibilitychange', () => {
  if (pocketOn && document.visibilityState === 'visible') requestWakeLock();
});

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
