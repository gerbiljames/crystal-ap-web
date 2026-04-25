// Central reactive app state. The shape mirrors the old vanilla `STATE`
// object but is wrapped in a Solid store so components can subscribe.
//
// `emu` is intentionally NOT reactive — it holds WASM pointers, audio
// context references, IDB connections, etc. Keep it as a plain object.

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { loadSessions } from "./lib/sessions.js";
import { loadYamls } from "./lib/yamls.js";

const HOST_PREF_KEY = "crystal-ap-host-pref";

export const [app, setApp] = createStore({
  step: "options",                                  // options | generating | rom | patching | play
  session: { state: "idle", label: "disconnected" }, // drives data-session

  seedId: null,
  slotName: "Player1",
  artifacts: null,     // {name: Uint8Array}
  hosted: null,        // {room_url, ws_url, host, port}
  patchedRom: null,    // ArrayBuffer
  sessions: loadSessions(),
  yamls: loadYamls(),

  hostPref: localStorage.getItem(HOST_PREF_KEY) === "on",

  // Transient UI state per-step.
  gen:   { visible: false, status: "queued", elapsed: "0.0s", error: null, done: false },
  rom:   { progressText: null, error: null },
  yamlErr: null,
});

export function persistHostPref(on) {
  try { localStorage.setItem(HOST_PREF_KEY, on ? "on" : "off"); } catch {}
  setApp("hostPref", on);
}

export function refreshSessions() { setApp("sessions", loadSessions()); }
export function refreshYamls()    { setApp("yamls", loadYamls()); }

export const [settingsOpen, setSettingsOpen] = createSignal(false);

// ---------- overlay settings ----------
const OVERLAY_KEY = "crystal-ap-overlay";
export type OverlayPrefs = { persistSec: number; maxEntries: number };
const OVERLAY_DEFAULTS: OverlayPrefs = { persistSec: 0, maxEntries: 8 };

function loadOverlayPrefs(): OverlayPrefs {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return { ...OVERLAY_DEFAULTS };
    const p = JSON.parse(raw);
    return {
      persistSec: Number.isFinite(p.persistSec) && p.persistSec >= 0 ? p.persistSec : OVERLAY_DEFAULTS.persistSec,
      maxEntries: Number.isFinite(p.maxEntries) && p.maxEntries >= 1 ? Math.min(50, Math.floor(p.maxEntries)) : OVERLAY_DEFAULTS.maxEntries,
    };
  } catch { return { ...OVERLAY_DEFAULTS }; }
}

export const [overlayPrefs, _setOverlayPrefs] = createSignal<OverlayPrefs>(loadOverlayPrefs());
export function setOverlayPrefs(next: OverlayPrefs) {
  _setOverlayPrefs(next);
  try { localStorage.setItem(OVERLAY_KEY, JSON.stringify(next)); } catch {}
}

// ---------- controller settings ----------
const CONTROLLER_PREFS_KEY = "crystal-ap-controller-prefs";
export type ControllerPrefs = { background: boolean };
const CONTROLLER_DEFAULTS: ControllerPrefs = { background: false };

function loadControllerPrefs(): ControllerPrefs {
  try {
    const raw = localStorage.getItem(CONTROLLER_PREFS_KEY);
    if (!raw) return { ...CONTROLLER_DEFAULTS };
    const p = JSON.parse(raw);
    return { background: !!p.background };
  } catch { return { ...CONTROLLER_DEFAULTS }; }
}

export const [controllerPrefs, _setControllerPrefs] = createSignal<ControllerPrefs>(loadControllerPrefs());
export function setControllerPrefs(next: ControllerPrefs) {
  _setControllerPrefs(next);
  try { localStorage.setItem(CONTROLLER_PREFS_KEY, JSON.stringify(next)); } catch {}
}

// Log buffer. Each entry is { kind, time, text?, ansi? }.
export const [logLines, setLogLines] = createSignal([]);
