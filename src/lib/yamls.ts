// Local library of saved YAMLs — metadata in localStorage so the list
// renders synchronously, raw text lives in IDB keyed by content hash.

import { YAMLS_KEY, YAMLS_MAX } from "./constants.js";

export type SavedYaml = {
  hash: string;        // sha256 of text (hex)
  name: string;        // user-visible label; defaults to original filename
  slotName: string | null;
  size: number;        // bytes
  savedAt: number;     // ms epoch
};

export function loadYamls(): SavedYaml[] {
  try { return JSON.parse(localStorage.getItem(YAMLS_KEY) || "[]"); }
  catch { return []; }
}

export function saveYamls(list: SavedYaml[]) {
  try { localStorage.setItem(YAMLS_KEY, JSON.stringify(list.slice(0, YAMLS_MAX))); }
  catch { /* quota exceeded — not fatal */ }
}

export function recordYaml(entry: SavedYaml): SavedYaml[] {
  const list = loadYamls();
  const existing = list.find(y => y.hash === entry.hash);
  if (existing) {
    existing.savedAt = entry.savedAt;
    existing.slotName = entry.slotName;
    // Preserve the user's renamed label; only refresh size.
    existing.size = entry.size;
  } else {
    list.unshift(entry);
  }
  // Most-recent first.
  list.sort((a, b) => b.savedAt - a.savedAt);
  saveYamls(list);
  return list;
}

export function renameYaml(hash: string, newName: string): SavedYaml[] {
  const list = loadYamls();
  const entry = list.find(y => y.hash === hash);
  if (entry) { entry.name = newName; saveYamls(list); }
  return list;
}

export function removeYaml(hash: string): { list: SavedYaml[]; removed: SavedYaml | null } {
  const all = loadYamls();
  const removed = all.find(y => y.hash === hash) || null;
  const list = all.filter(y => y.hash !== hash);
  saveYamls(list);
  return { list, removed };
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}
