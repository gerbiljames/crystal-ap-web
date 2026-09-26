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
// Best effort throughout: an exception here, or an unhandled request error,
// would abort the whole versionchange transaction and leave the app without
// IndexedDB, which is far worse than a save that stays under its old key.
function migrateSaveKeysToSeedIds(tx: IDBTransaction) {
  try { migrateSaveKeysToSeedIdsUnsafe(tx); }
  catch (err) { console.warn("save key migration skipped:", err); }
}

function migrateSaveKeysToSeedIdsUnsafe(tx: IDBTransaction) {
  let sessions: { id?: unknown; romHash?: unknown }[] = [];
  try { sessions = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); } catch { return; }
  const byHash = new Map<string, string[]>();
  for (const s of sessions) {
    if (typeof s.id !== "string" || typeof s.romHash !== "string" || s.romHash === s.id) continue;
    byHash.set(s.romHash, [...(byHash.get(s.romHash) ?? []), s.id]);
  }
  if (byHash.size === 0) return;
  const sav = tx.objectStore(SAVE_STORE), state = tx.objectStore(STATE_STORE);
  // Every request gets an error handler: an unhandled request error bubbles to
  // the transaction and aborts the whole upgrade. `outstanding` counts the gets
  // and the puts they spawn; the old rows are dropped only once all of them
  // settled and none failed.
  let outstanding = 0;
  let failed = false;
  const quiet = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
  const done = () => {
    if (--outstanding > 0) return;
    if (failed) return;
    for (const hash of byHash.keys()) {
      sav.delete(hash).onerror = quiet;
      state.delete(hash).onerror = quiet;
    }
  };
  const settle = (req: IDBRequest, onOk?: () => void) => {
    outstanding++;
    req.onsuccess = () => { onOk?.(); done(); };
    req.onerror = (ev) => { quiet(ev); failed = true; done(); };
  };
  for (const [hash, ids] of byHash) {
    const s1 = sav.get(hash);
    settle(s1, () => { if (s1.result !== undefined) for (const id of ids) settle(sav.put(s1.result, id)); });
    const s2 = state.get(hash);
    settle(s2, () => {
      if (s2.result !== undefined)
        for (const id of ids) settle(state.put({ romHash: hash, state: s2.result } satisfies SavestateEnvelope, id));
    });
  }
}

// Upgrades need every other connection closed. A tab still running an older
// build holds one and, if that build predates onversionchange below, never lets
// go: the open then waits until that tab closes. Tell the user rather than
// hanging silently ("blocked", then "unblocked" once the open goes through).
// "superseded" is the other side: a newer build upgraded the DB from another
// tab, so this one has closed its connection and must reload.
export type DbNotice = "blocked" | "unblocked" | "superseded";
let onDbNotice: ((notice: DbNotice) => void) | null = null;
export function setDbNoticeHandler(fn: typeof onDbNotice) { onDbNotice = fn; }

export function openSaveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAVE_DB_NAME, DB_VERSION);
    let blocked = false;
    req.onblocked = () => { blocked = true; onDbNotice?.("blocked"); };
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
