// IndexedDB: one DB, four stores (SRAM / patched ROM / vanilla ROM / gen
// artifacts). Promise-wrapped get/put/delete plus a shared DB connection.

import {
  SAVE_DB_NAME, SAVE_STORE, ROM_STORE, VANILLA_STORE, ARTIFACTS_STORE, DB_VERSION,
} from "./constants.js";

export function openSaveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAVE_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE_STORE))      db.createObjectStore(SAVE_STORE);
      if (!db.objectStoreNames.contains(ROM_STORE))       db.createObjectStore(ROM_STORE);
      if (!db.objectStoreNames.contains(VANILLA_STORE))   db.createObjectStore(VANILLA_STORE);
      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) db.createObjectStore(ARTIFACTS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
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

export function idbPut(db: IDBDatabase, k: IDBValidKey, v: any, store: string = SAVE_STORE): Promise<void> {
  return new Promise((res, rej) => {
    const t = db.transaction(store, "readwrite").objectStore(store).put(v, k);
    t.onsuccess = () => res();
    t.onerror   = () => rej(t.error);
  });
}

export function idbDel(db: IDBDatabase, k: IDBValidKey, store: string = SAVE_STORE): Promise<void> {
  return new Promise((res, rej) => {
    const t = db.transaction(store, "readwrite").objectStore(store).delete(k);
    t.onsuccess = () => res();
    t.onerror   = () => rej(t.error);
  });
}

// Single shared connection, lazily opened. Returns null if IDB is
// unavailable (private mode, quota, etc.) so callers can degrade gracefully.
let _dbPromise: Promise<IDBDatabase | null> | null = null;
export function db(): Promise<IDBDatabase | null> {
  if (!_dbPromise) _dbPromise = openSaveDb().catch(err => { console.warn("IDB open failed:", err); return null; });
  return _dbPromise;
}
