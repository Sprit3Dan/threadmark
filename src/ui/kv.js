// Small persistent key/value layer for the little things that should survive a
// reload: scroll position, which cards were open, an unsaved draft, an annotation
// made before the file was connected.
//
// IndexedDB on a file:// origin is not something to take on faith, so every call
// degrades to memory rather than throwing at the reader.

const DB_NAME = "threadmark";
const STORE = "state";
const memory = new Map();
let idbBroken = false;

function openDb() {
  if (idbBroken) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (e) {
      idbBroken = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      idbBroken = true;
      resolve(null);
    };
    req.onblocked = () => {
      idbBroken = true;
      resolve(null);
    };
  });
}

export const available = () => !idbBroken;

export async function kvGet(key) {
  const db = await openDb();
  if (!db) return memory.get(key);
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? memory.get(key) : req.result);
      req.onerror = () => resolve(memory.get(key));
    } catch (e) {
      resolve(memory.get(key));
    }
  });
}

export async function kvPut(key, value) {
  memory.set(key, value);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
  } catch (e) {
    /* memory only */
  }
}

export async function kvDelete(key) {
  memory.delete(key);
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
  } catch (e) {
    /* nothing to do */
  }
}
