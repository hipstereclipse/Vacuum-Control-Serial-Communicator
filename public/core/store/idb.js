// @ts-check
/**
 * IndexedDB persistence: separate stores for sessions, sample chunks and traffic, as the plan
 * asks (section 9). Autosave writes the session record plus the unflushed samples of every
 * series. Every call is guarded: a private window or blocked storage makes these no-ops that
 * report `available: false` instead of throwing into the UI.
 */

const DB_NAME = "gauge-serial-communicator";
const DB_VERSION = 1;

/** @type {Promise<IDBDatabase | null> | null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!globalThis.indexedDB) return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("samples")) {
          const store = db.createObjectStore("samples", { autoIncrement: true });
          store.createIndex("bySession", "sessionId");
        }
        if (!db.objectStoreNames.contains("traffic")) {
          const store = db.createObjectStore("traffic", { autoIncrement: true });
          store.createIndex("bySession", "sessionId");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** @param {IDBRequest | IDBTransaction} req */
function done(req) {
  return new Promise((resolve, reject) => {
    if ("oncomplete" in req) {
      req.oncomplete = () => resolve(undefined);
      req.onerror = () => reject(req.error);
      req.onabort = () => reject(req.error);
    } else {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }
  });
}

export async function storageAvailable() {
  return Boolean(await openDb());
}

/** Ask the browser not to evict a long log (🟠 V15). */
export async function requestPersistence() {
  try {
    return Boolean(await navigator.storage?.persist?.());
  } catch {
    return false;
  }
}

/**
 * @param {any} record  session JSON with an `id`
 * @param {{ seriesId: string, unit: string, t: Float64Array, v: Float32Array, s: Uint8Array }[]} chunks
 * @param {{ t: number, dir: string, device: string, bytes: Uint8Array, note?: string }[]} traffic
 */
export async function saveSession(record, chunks = [], traffic = []) {
  const db = await openDb();
  if (!db) return false;
  const tx = db.transaction(["sessions", "samples", "traffic"], "readwrite");
  tx.objectStore("sessions").put(record);
  for (const chunk of chunks) if (chunk.t.length) tx.objectStore("samples").add({ sessionId: record.id, ...chunk });
  for (const entry of traffic) tx.objectStore("traffic").add({ sessionId: record.id, ...entry });
  await done(tx);
  return true;
}

export async function listSessions() {
  const db = await openDb();
  if (!db) return [];
  const all = /** @type {any[]} */ (await done(db.transaction("sessions").objectStore("sessions").getAll()));
  return all.sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
}

/** @param {string} id */
export async function loadSession(id) {
  const db = await openDb();
  if (!db) return null;
  const tx = db.transaction(["sessions", "samples", "traffic"]);
  const record = await done(tx.objectStore("sessions").get(id));
  if (!record) return null;
  const samples = /** @type {any[]} */ (await done(tx.objectStore("samples").index("bySession").getAll(id)));
  const traffic = /** @type {any[]} */ (await done(tx.objectStore("traffic").index("bySession").getAll(id)));
  return { record, samples, traffic };
}

/** @param {string} id */
export async function deleteSession(id) {
  const db = await openDb();
  if (!db) return false;
  const tx = db.transaction(["sessions", "samples", "traffic"], "readwrite");
  tx.objectStore("sessions").delete(id);
  for (const store of ["samples", "traffic"]) {
    const index = tx.objectStore(store).index("bySession");
    const keys = /** @type {IDBValidKey[]} */ (await done(index.getAllKeys(id)));
    for (const key of keys) tx.objectStore(store).delete(key);
  }
  await done(tx);
  return true;
}
