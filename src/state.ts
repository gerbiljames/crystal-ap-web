// Central reactive app state. The shape mirrors the old vanilla `STATE`
// object but is wrapped in a Solid store so components can subscribe.
//
// `emu` is intentionally NOT reactive — it holds WASM pointers, audio
// context references, IDB connections, etc. Keep it as a plain object.

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import type { OverridePrefs } from "./lib/overrides.js";
import type { PublicState, YouState, EndReason } from "../shared/protocol.js";

export const [app, setApp] = createStore({
  step: "lobby",                                     // lobby | play
  session: { state: "idle", label: "offline" },      // drives data-session

  patchedRom: null as ArrayBuffer | null,

  // Transient UI state for preparing the ROM.
  rom: { error: null as string | null },
  // Display version of the apworld the ROM is patched with, once resolved.
  runningApworld: null as string | null,
});

// A condition that makes this page unusable until it is reloaded (the site was
// updated underneath it). Shown above everything, and never cleared.
export const [pageNotice, setPageNotice] = createSignal<string | null>(null);

export const [settingsOpen, setSettingsOpen] = createSignal(false);

// ---------- server state ----------
// Whether /api/me has answered yet, and what it said: the signed-in user (null
// when signed out) and where the Discord sign-in starts.
export const [meLoaded, setMeLoaded] = createSignal(false);
export const [loginUrl, setLoginUrl] = createSignal("/api/auth/login");
export const [you, setYou] = createSignal<YouState | null>(null);
// What everyone sees, pushed over the live socket.
export const [publicState, setPublicState] = createSignal<PublicState | null>(null);
// The server's clock minus ours, from its last push: countdowns to server
// deadlines (offers, grace) use it so a skewed device clock doesn't mislead.
export const [clockOffset, setClockOffset] = createSignal(0);
// Whether the live socket is up; the lobby shows a reconnecting notice when not.
export const [liveConnected, setLiveConnected] = createSignal(false);
// How the player's last session ended, shown on the lobby afterwards.
export const [endedNotice, setEndedNotice] = createSignal<{ reason: EndReason; detail: string | null } | null>(null);
// Whether the admin page is showing (#admin).
export const [adminOpen, setAdminOpen] = createSignal(false);

// The ROM the player will play, prepared while they wait: the verified vanilla
// ROM is in IndexedDB, and the patched ROM is held here once made.
export type Prep =
  | { kind: "need-rom" }
  // The vanilla ROM is in this browser; it's patched once the player queues.
  | { kind: "saved" }
  | { kind: "working"; text: string }
  | { kind: "ready"; overridesHash: string }
  | { kind: "error"; message: string };
export const [prep, setPrep] = createSignal<Prep>({ kind: "need-rom" });

// This tab starting a running turn, or having failed to: tells the lobby the
// turn isn't elsewhere.
export const [playStatus, setPlayStatus] = createSignal<{ sessionId: string; kind: "starting" | "failed" | "other-tab" } | null>(null);

// On mobile the session panel lives in a popup opened from the session chip
// rather than below the fold. `connectOpen` toggles that overlay; `isMobile`
// tracks the same breakpoint the touch play layout uses so the chip only acts
// as a trigger when the popup presentation is actually in effect.
export const [connectOpen, setConnectOpen] = createSignal(false);

const mobileMedia = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(max-width: 900px) and (any-pointer: coarse)")
  : null;
export const [isMobile, setIsMobile] = createSignal(mobileMedia?.matches ?? false);
mobileMedia?.addEventListener("change", (e) => setIsMobile(e.matches));

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

// Log buffer. `time` is the display stamp, `ts` the epoch ms used for
// overlay expiry. Exactly one of `text` (plain) / `ansi` (SGR-coloured) is set.
export type LogEntry = { kind: string; time: string; ts: number; text?: string; ansi?: string };
export const [logLines, setLogLines] = createSignal<LogEntry[]>([]);
