// Summit Benchmark: IndexedDB persistence for the elevation log.
//
// Two stores:
//   sessions  keyPath 'id' (auto-increment)
//             { id, startedAt, endedAt, label }  endedAt null = still logging
//   readings  keyPath ['sessionId', 't']
//             { sessionId, t, altM, offsetM, vAccM, hAccM, lat, lng }
//
// Readings store the smoothed altitude in the device's native frame (altM) plus
// the calibration offset in effect at the time (offsetM, null = uncalibrated),
// not a pre-corrected value, so recalibrating never loses information.
// The compound key sorts a session's readings by time, so one key range fetches
// (or deletes) a whole session with no extra index.
//
// IndexedDB's API is event-based; this file wraps the few operations the app
// needs in promises. Exposed as a single global, SummitDB.

const SummitDB = (() => {
  const DB_NAME = 'summit-benchmark';
  const DB_VERSION = 1;
  let dbPromise = null;

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        // Version 1: initial schema. A future version adds a branch keyed on
        // event.oldVersion; new fields on a record need no upgrade at all.
        const db = req.result;
        db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('readings', { keyPath: ['sessionId', 't'] });
      };
      req.onsuccess = () => {
        const db = req.result;
        // The browser can close a connection on its own (a newer tab upgrading
        // the schema, or WebKit dropping it after the app is backgrounded).
        // Forget it so the next call reopens instead of failing forever.
        db.onversionchange = () => { db.close(); dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  // Run fn(stores...) in one transaction; resolve with fn's result once the
  // transaction commits, so callers know the data is actually on disk.
  async function run(storeNames, mode, fn) {
    const db = await open();
    const tx = db.transaction(storeNames, mode);
    const stores = [].concat(storeNames).map(name => tx.objectStore(name));
    const result = fn(...stores);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    });
    return result;
  }

  // Key range covering every reading in one session.
  function sessionRange(sessionId) {
    return IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
  }

  async function startSession() {
    const session = { startedAt: Date.now(), endedAt: null, label: null };
    const idReq = await run('sessions', 'readwrite', s => s.add(session));
    session.id = idReq.result;
    return session;
  }

  async function endSession(id) {
    return run('sessions', 'readwrite', s => {
      const get = s.get(id);
      get.onsuccess = () => {
        if (get.result) s.put({ ...get.result, endedAt: Date.now() });
      };
    });
  }

  // The most recent session still logging, or null. Found from the data itself
  // (endedAt null), so an app kill mid-hike resumes on the next open.
  async function getActiveSession() {
    const db = await open();
    const all = await promisify(db.transaction('sessions').objectStore('sessions').getAll());
    return all.filter(s => s.endedAt === null).pop() || null;
  }

  function addReading(reading) {
    return run('readings', 'readwrite', s => { s.put(reading); });
  }

  async function countReadings(sessionId) {
    const db = await open();
    return promisify(db.transaction('readings').objectStore('readings').count(sessionRange(sessionId)));
  }

  async function getReadings(sessionId) {
    const db = await open();
    return promisify(db.transaction('readings').objectStore('readings').getAll(sessionRange(sessionId)));
  }

  return { startSession, endSession, getActiveSession, addReading, countReadings, getReadings };
})();
