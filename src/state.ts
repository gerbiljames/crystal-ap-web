// Central reactive app state. The shape mirrors the old vanilla `STATE`
// object but is wrapped in a Solid store so components can subscribe.
//
// `emu` is intentionally NOT reactive — it holds WASM pointers, audio
// context references, IDB connections, etc. Keep it as a plain object.

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { loadSessions } from "./lib/sessions.js";
import { loadYamls } from "./lib/yamls.js";
import type { OverridePrefs } from "./lib/overrides.js";

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
export const [yamlCreatorOpen, setYamlCreatorOpen] = createSignal(false);

// On mobile the connection form lives in a popup opened from the session chip
// rather than below the fold. `connectOpen` toggles that overlay; `isMobile`
// tracks the same breakpoint the touch play layout uses so the chip only acts
// as a trigger when the popup presentation is actually in effect.
export const [connectOpen, setConnectOpen] = createSignal(false);

const mobileMedia = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(max-width: 900px) and (any-pointer: coarse)")
  : null;
export const [isMobile, setIsMobile] = createSignal(mobileMedia?.matches ?? false);
mobileMedia?.addEventListener("change", (e) => setIsMobile(e.matches));

// When set, the YAML creator opens in raw-text edit mode pre-populated with
// this saved YAML. Save will replace the original entry (the hash changes
// whenever the text changes, so we forget the old one).
export type YamlEditTarget = { hash: string; text: string; displayName: string };
export const [yamlEditTarget, setYamlEditTarget] = createSignal<YamlEditTarget | null>(null);

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

// ---------- ui settings ----------
const UI_PREFS_KEY = "crystal-ap-ui-prefs";
export type UiPrefs = { hideGamepad: boolean };
const UI_DEFAULTS: UiPrefs = { hideGamepad: false };

function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return { ...UI_DEFAULTS };
    const p = JSON.parse(raw);
    return { hideGamepad: !!p.hideGamepad };
  } catch { return { ...UI_DEFAULTS }; }
}

export const [uiPrefs, _setUiPrefs] = createSignal<UiPrefs>(loadUiPrefs());
export function setUiPrefs(next: UiPrefs) {
  _setUiPrefs(next);
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next)); } catch {}
}

// ---------- rom override settings ----------
// Patch-time Pokemon Crystal option overrides (see lib/overrides.ts). Stored as
// a flat pref map; an empty value means "leave the seed's own value alone".
const ROM_OVERRIDES_KEY = "crystal-ap-rom-overrides";

function loadOverridePrefs(): OverridePrefs {
  try {
    const raw = localStorage.getItem(ROM_OVERRIDES_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    if (!p || typeof p !== "object") return {};
    // Coerce every value to string and drop empties so the stored shape stays
    // the flat string map the form and buildOverrides expect.
    const out: OverridePrefs = {};
    for (const [k, v] of Object.entries(p)) {
      if (v == null || v === "") continue;
      out[k] = String(v);
    }
    return out;
  } catch { return {}; }
}

export const [romOverridePrefs, _setRomOverridePrefs] = createSignal<OverridePrefs>(loadOverridePrefs());
export function setRomOverridePrefs(next: OverridePrefs) {
  _setRomOverridePrefs(next);
  try { localStorage.setItem(ROM_OVERRIDES_KEY, JSON.stringify(next)); } catch {}
}

// Log buffer. Each entry is { kind, time, text?, ansi? }.
export const [logLines, setLogLines] = createSignal([]);

// Universal Tracker state. trackerInLogic is the list of in-logic location
// names from UT's last update. trackerStatus drives the Tracker tab placeholder
// when a session has no tracker (no yaml, import failed, world incompatible).
export const [trackerInLogic, setTrackerInLogic] = createSignal<string[]>([]);
export type TrackerGoMode = "no" | "yes" | "glitched";
export const [trackerGoMode, setTrackerGoMode] = createSignal<TrackerGoMode>("no");
export const [trackerStatus, setTrackerStatus] = createSignal<
  { kind: "idle" } | { kind: "ready" } | { kind: "error"; reason: string }
>({ kind: "idle" });

// Hints relevant to the local player, mirrored from the live session's
// _read_hints data-storage key. `forYou` is true when we receive the hinted
// item; otherwise the item is on one of our locations for another player.
// `hints` is null until the server has replied with the hint list.
export type HintRow = {
  receiving: string;
  finding: string;
  item: string;
  location: string;
  entrance: string;
  found: boolean;
  status: string;
  forYou: boolean;
  itemFlags: number;
};
export const [hints, setHints] = createSignal<HintRow[] | null>(null);
export const [hintsStatus, setHintsStatus] = createSignal<
  { kind: "idle" } | { kind: "ready" } | { kind: "error"; reason: string }
>({ kind: "idle" });
// Hint-point readout for the Hints tab. The server grants points per checked
// location and charges `costPoints` (derived from the `costPercent`-of-total
// hint cost) per hint; `available` is how many hints the current `points`
// balance affords. `available` is null when hints are free (cost 0) or the
// balance/total isn't known yet. Null until the session reports any of it.
export type HintPoints = {
  points: number | null;
  costPercent: number | null;
  costPoints: number;
  available: number | null;
};
export const [hintPoints, setHintPoints] = createSignal<HintPoints | null>(null);
// Own-game item names (and item-name groups) for hint-box autocomplete. Static
// per game, so fetched once per session.
export const [hintItemNames, setHintItemNames] = createSignal<string[]>([]);
// Transient feedback shown in the hints tab right after a !hint request, so the
// server's response (success text or an error) is visible without switching to
// the console. Captured from the server log for a short window post-request.
export type HintFeedback = { text: string; kind: "info" | "ok" | "err" };
export const [hintFeedback, setHintFeedback] = createSignal<HintFeedback | null>(null);
