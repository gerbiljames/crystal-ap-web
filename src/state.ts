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

// Hosting modes for newly-generated seeds:
//   "local"  — run MultiServer.py inside this tab (Pyodide loopback). Default.
//   "remote" — upload multidata to archipelago.gg via the Cloudflare Worker.
//   "off"    — produce artifacts only; user hosts externally.
export type HostPref = "local" | "remote" | "off";

function loadHostPref(): HostPref {
  const raw = localStorage.getItem(HOST_PREF_KEY);
  // Migrate the prior boolean form: "on" meant archipelago.gg; anything else
  // (including absent) now defaults to "local" since fully-local hosting is
  // the new zero-config path.
  if (raw === "on")  return "remote";
  if (raw === "local" || raw === "remote" || raw === "off") return raw;
  return "local";
}

export const [app, setApp] = createStore({
  step: "options",                                  // options | generating | rom | patching | play
  session: { state: "idle", label: "disconnected" }, // drives data-session

  seedId: null,
  slotName: "Player1",
  artifacts: null,     // {name: Uint8Array}
  hosted: null,        // { kind: "remote" | "loopback", ws_url, host?, port?, room_url? }
  patchedRom: null,    // ArrayBuffer
  sessions: loadSessions(),
  yamls: loadYamls(),

  hostPref: loadHostPref() as HostPref,

  // Transient UI state per-step.
  gen:   { visible: false, status: "queued", elapsed: "0.0s", error: null, done: false },
  rom:   { progressText: null, error: null },
  yamlErr: null,
});

export function persistHostPref(mode: HostPref) {
  try { localStorage.setItem(HOST_PREF_KEY, mode); } catch {}
  setApp("hostPref", mode);
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

// ---------- audio settings ----------
const AUDIO_PREFS_KEY  = "crystal-ap-audio-prefs";
const LEGACY_VOLUME_KEY = "crystal-ap-volume"; // 0–100 string, pre-prefs era
export type AudioPrefs = { volume: number; background: boolean }; // volume 0–1
const AUDIO_DEFAULTS: AudioPrefs = { volume: 0.5, background: false };

function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        volume: Number.isFinite(p.volume) && p.volume >= 0 && p.volume <= 1 ? p.volume : AUDIO_DEFAULTS.volume,
        background: !!p.background,
      };
    }
    // Migrate the legacy 0–100 volume key so existing users don't see
    // their slider snap back to 50% after upgrade.
    const legacy = localStorage.getItem(LEGACY_VOLUME_KEY);
    if (legacy != null) {
      const n = Number(legacy);
      if (Number.isFinite(n) && n >= 0 && n <= 100) {
        return { volume: n / 100, background: AUDIO_DEFAULTS.background };
      }
    }
  } catch {}
  return { ...AUDIO_DEFAULTS };
}

export const [audioPrefs, _setAudioPrefs] = createSignal<AudioPrefs>(loadAudioPrefs());
export function setAudioPrefs(next: AudioPrefs) {
  _setAudioPrefs(next);
  try { localStorage.setItem(AUDIO_PREFS_KEY, JSON.stringify(next)); } catch {}
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
