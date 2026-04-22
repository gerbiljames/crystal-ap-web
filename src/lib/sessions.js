// Local session history: small list of recent seeds with resume metadata.
// Pure localStorage helpers — no DOM rendering (that's the UI layer's job).

import { SESSIONS_KEY, SESSIONS_MAX } from "./constants.js";

export function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]"); }
  catch { return []; }
}

export function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, SESSIONS_MAX))); }
  catch { /* storage full or disabled — not fatal */ }
}

// Upsert by id. Returns the updated list so callers can refresh their view.
export function recordSession(entry) {
  const list = loadSessions().filter(s => s.id !== entry.id);
  list.unshift({ ...entry, savedAt: Date.now() });
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
