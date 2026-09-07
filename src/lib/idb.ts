// IndexedDB: one DB, several stores (SRAM + savestate per seed / patched ROM /
// vanilla ROM / gen artifacts / yamls). Promise-wrapped get/put/delete plus a
// shared DB connection.

import {
  SAVE_DB_NAME, SAVE_STORE, STATE_STORE, ROM_STORE, VANILLA_STORE, ARTIFACTS_STORE, YAML_STORE, MHOST_SAVE_STORE, DB_VERSION,
  SESSIONS_KEY,
} from "./constants.js";
import type { SavestateEnvelope } from "./saves.js";

// DB version 8 re-keyed the SRAM and savestate stores from the patched ROM's
// SHA-1 to the seed id (so a re-patch keeps the save). Copy every legacy row
// to each session that recorded that ROM hash — sessions built from the same
// patch shared one — wrapping the savestate in its {romHash, state} envelope,
// then delete the hash-keyed rows. Runs inside the versionchange transaction,
// so it is all-or-nothing and happens exactly once per browser. The session
// list lives in localStorage, which is readable synchronously here.
function migrateSaveKeysToSeedIds(tx: IDBTransaction) {
  let sessions: { id?: unknown; romHash?: unknown }[] = [];
  try { sessions = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); } catch { return; }
  const byHash = new Map<string, string[]>();
  for (const s of sessions) {
    if (typeof s.id !== "string" || typeof s.romHash !== "string" || s.romHash === s.id) continue;
    byHash.set(s.romHash, [...(byHash.get(s.romHash) ?? []), s.id]);
  }
  if (byHash.size === 0) return;
  const sav = tx.objectStore(SAVE_STORE), state = tx.objectStore(STATE_STORE);
  let outstanding = 0;
  const done = () => {
    if (--outstanding > 0) return;
    for (const hash of byHash.keys()) { sav.delete(hash); state.delete(hash); }
  };
  for (const [hash, ids] of byHash) {
    outstanding += 2;
    const s1 = sav.get(hash);
    s1.onsuccess = () => {
      if (s1.result !== undefined) for (const id of ids) sav.put(s1.result, id);
      done();
    };
    s1.onerror = done;
    const s2 = state.get(hash);
    s2.onsuccess = () => {
      if (s2.result !== undefined) for (const id of ids) state.put({ romHash: hash, state: s2.result } satisfies SavestateEnvelope, id);
      done();
    };
    s2.onerror = done;
  }
}

export function openSaveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAVE_DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SAVE_STORE))      db.createObjectStore(SAVE_STORE);
      if (!db.objectStoreNames.contains(STATE_STORE))     db.createObjectStore(STATE_STORE);
      if (!db.objectStoreNames.contains(ROM_STORE))       db.createObjectStore(ROM_STORE);
      if (!db.objectStoreNames.contains(VANILLA_STORE))   db.createObjectStore(VANILLA_STORE);
      if (!db.objectStoreNames.contains(ARTIFACTS_STORE)) db.createObjectStore(ARTIFACTS_STORE);
      if (!db.objectStoreNames.contains(YAML_STORE))      db.createObjectStore(YAML_STORE);
      if (!db.objectStoreNames.contains(MHOST_SAVE_STORE)) db.createObjectStore(MHOST_SAVE_STORE);
      if (ev.oldVersion > 0 && ev.oldVersion < 8 && req.transaction) migrateSaveKeysToSeedIds(req.transaction);
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

// Presence check that doesn't materialise the value (count is O(1) on an
// indexed-key range vs. reading the whole ArrayBuffer back into JS).
export function idbHas(db: IDBDatabase, k: IDBValidKey, store: string = SAVE_STORE): Promise<boolean> {
  return new Promise((res, rej) => {
    const t = db.transaction(store, "readonly").objectStore(store).count(k);
    t.onsuccess = () => res((t.result as number) > 0);
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
