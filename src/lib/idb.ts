// IndexedDB: one DB, four stores (SRAM and savestate per session, the patched
// ROM per session, the vanilla ROM). Promise-wrapped get/put/delete plus a
// shared DB connection.

import { SAVE_DB_NAME, SAVE_STORE, STATE_STORE, ROM_STORE, VANILLA_STORE, DB_VERSION } from "./constants.js";

export type DbNotice = "blocked" | "unblocked" | "superseded";
let onDbNotice: ((notice: DbNotice) => void) | null = null;
export function setDbNoticeHandler(fn: typeof onDbNotice) { onDbNotice = fn; }

export function openSaveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAVE_DB_NAME, DB_VERSION);
    let blocked = false;
    req.onblocked = () => { blocked = true; onDbNotice?.("blocked"); };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE_STORE))      db.createObjectStore(SAVE_STORE);
      if (!db.objectStoreNames.contains(STATE_STORE))     db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(ROM_STORE))       db.createObjectStore(ROM_STORE);
      if (!db.objectStoreNames.contains(VANILLA_STORE))   db.createObjectStore(VANILLA_STORE);
    };
    req.onsuccess = () => { if (blocked) onDbNotice?.("unblocked"); resolve(req.result); };
    req.onerror   = () => reject(req.error);
  });
}

export function idbGet<T = any>(db: IDBDatabase, k: IDBValidKey, store: string = SAVE_STORE): Promise<T | undefined> {
  return new Promise((res, rej) => {
    const t = db.transaction(store, "readonly").objectStore(store).get(k);
    t.onsuccess = () => res(t.result as T | undefined);
    t.onerror   = () => rej(t.error);
  });
}

// Writes resolve once their transaction commits, not when the request
// succeeds: a transaction can still abort after that (Chrome reports quota
// that way), and callers that record what they stored rely on it being there.
function commit(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onabort = tx.onerror = () => rej(tx.error ?? new DOMException("transaction aborted", "AbortError"));
  });
}

export function idbPut(db: IDBDatabase, k: IDBValidKey, v: any, store: string = SAVE_STORE): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(v, k);
    commit(tx).then(res, rej);
  });
}

// Several puts, across stores, in one transaction: all of them land or none.
export function idbPutMany(db: IDBDatabase, puts: [store: string, k: IDBValidKey, v: any][]): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction([...new Set(puts.map(([store]) => store))], "readwrite");
    for (const [store, k, v] of puts) tx.objectStore(store).put(v, k);
    commit(tx).then(res, rej);
  });
}

export function idbKeys(db: IDBDatabase, store: string): Promise<IDBValidKey[]> {
  return new Promise((res, rej) => {
    const t = db.transaction(store, "readonly").objectStore(store).getAllKeys();
    t.onsuccess = () => res(t.result);
    t.onerror   = () => rej(t.error);
  });
}

export function idbDel(db: IDBDatabase, k: IDBValidKey, store: string = SAVE_STORE): Promise<void> {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(k);
    commit(tx).then(res, rej);
  });
}

// Single shared connection, lazily opened. Returns null if IDB is
// unavailable (private mode, quota, etc.) so callers can degrade gracefully.
let _dbPromise: Promise<IDBDatabase | null> | null = null;
export function db(): Promise<IDBDatabase | null> {
  if (!_dbPromise) _dbPromise = openSaveDb().then((dbc) => {
    // A newer build in another tab wants to upgrade: close so it isn't
    // blocked on us. This tab's schema is now stale, so from here on it has
    // no DB (callers already degrade on null) and must reload.
    dbc.onversionchange = () => {
      dbc.close();
      _dbPromise = Promise.resolve(null);
      onDbNotice?.("superseded");
    };
    return dbc;
  }).catch(err => { console.warn("IDB open failed:", err); return null; });
  return _dbPromise;
}
