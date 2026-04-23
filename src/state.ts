// Central reactive app state. The shape mirrors the old vanilla `STATE`
// object but is wrapped in a Solid store so components can subscribe.
//
// `emu` is intentionally NOT reactive — it holds WASM pointers, audio
// context references, IDB connections, etc. Keep it as a plain object.

import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { loadSessions } from "./lib/sessions.js";

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

export const [settingsOpen, setSettingsOpen] = createSignal(false);

// Log buffer. Each entry is { kind, time, text?, ansi? }.
export const [logLines, setLogLines] = createSignal([]);
