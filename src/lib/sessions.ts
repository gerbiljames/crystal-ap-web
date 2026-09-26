// Local session history: small list of recent seeds with resume metadata.
// Pure localStorage helpers — no DOM rendering (that's the UI layer's job).

import { SESSIONS_KEY } from "./constants.js";

export function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); }
  catch { return []; }
}

// Not capped: dropping the oldest entry would strand its save (no resume or
// forget left for it) and its ROM/artifacts in IndexedDB. Forget prunes.
export function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list)); }
  catch { /* storage full or disabled — not fatal */ }
}

// Upsert by id, merging over the existing entry so callers only state what
// changed (a re-patch doesn't have to re-supply romHash, say). Returns the
// updated list so callers can refresh their view.
export function recordSession(entry) {
  const all = loadSessions();
  const prev = all.find(s => s.id === entry.id);
  const list = all.filter(s => s.id !== entry.id);
  list.unshift({ ...prev, ...entry, savedAt: Date.now() });
  saveSessions(list);
  return list;
}

// Remove a session by id. Returns {list, removed} so callers can clean up
// any IDB entries keyed on fields of `removed` (e.g. romHash).
export function removeSession(id) {
  const all = loadSessions();
  const removed = all.find(s => s.id === id) || null;
  const list = all.filter(s => s.id !== id);
  saveSessions(list);
  return { list, removed };
}

export function formatAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return Math.floor(s / 60)   + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return           Math.floor(s / 86400) + "d ago";
}
