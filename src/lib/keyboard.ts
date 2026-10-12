// Keyboard rebinding. Mirrors controller.ts: a small map of joypad inputs
// to KeyboardEvent.code values, persisted in localStorage, with a capture
// helper for the settings UI. emulator.ts reads `getKeyBindings()` on each
// keydown/keyup so rebinds take effect without restarting the emulator.

import { createSignal } from "solid-js";
import type { InputName } from "./controller.js";

export const DEFAULT_KEY_BINDINGS: Record<InputName, string> = {
  A: "KeyX", B: "KeyZ", start: "Enter", select: "Tab",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

export const KEYBOARD_BINDINGS_KEY = "crystal-ap-keyboard-bindings";

// Empty string means "unbound" — used after a key is reassigned away from
// another input via the rebind UI.
export function loadKeyBindings(): Record<InputName, string> {
  try {
    const raw = localStorage.getItem(KEYBOARD_BINDINGS_KEY);
    if (!raw) return { ...DEFAULT_KEY_BINDINGS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_KEY_BINDINGS };
    for (const k of Object.keys(DEFAULT_KEY_BINDINGS) as InputName[]) {
      if (typeof parsed[k] === "string") merged[k] = parsed[k];
    }
    return merged;
  } catch {
    return { ...DEFAULT_KEY_BINDINGS };
  }
}

// Reactive so UI elsewhere (e.g. the on-screen key hint) can subscribe.
export const [keyBindings, _setKeyBindings] = createSignal<Record<InputName, string>>(loadKeyBindings());

export function getKeyBindings(): Record<InputName, string> {
  return keyBindings();
}

export function saveKeyBindings(b: Record<InputName, string>) {
  try { localStorage.setItem(KEYBOARD_BINDINGS_KEY, JSON.stringify(b)); } catch {}
  _setKeyBindings({ ...b });
}

export function isDefaultKeyBindings(b: Record<InputName, string>): boolean {
  for (const k of Object.keys(DEFAULT_KEY_BINDINGS) as InputName[]) {
    if (b[k] !== DEFAULT_KEY_BINDINGS[k]) return false;
  }
  return true;
}

// What each key (KeyboardEvent.code) is marked with on the player's layout.
// Bindings are by position, so on AZERTY the default B button (KeyZ) is the
// key marked W. Chromium can read the whole layout up front; elsewhere a key's
// mark is learnt the first time it's pressed.
const [layoutLabels, setLayoutLabels] = createSignal<Record<string, string>>({});

function learnLabel(code: string, key: string) {
  if (key.length !== 1 || key === " " || layoutLabels()[code] === key) return;
  setLayoutLabels({ ...layoutLabels(), [code]: key });
}

if (typeof window !== "undefined") {
  try {
    (navigator as any).keyboard?.getLayoutMap?.().then((map: Map<string, string>) => {
      const labels: Record<string, string> = {};
      map.forEach((key, code) => { labels[code] = key; });
      // Keys already pressed know better.
      setLayoutLabels({ ...labels, ...layoutLabels() });
    }).catch(() => {});
  } catch {}
  // Unmodified presses only: Shift or AltGr give a different character than
  // the one on the key.
  window.addEventListener("keydown", (ev) => {
    if (!ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) learnLabel(ev.code, ev.key);
  }, true);
}

// A key's name for display, as marked on the player's keyboard.
export function keyLabel(code: string): string {
  if (code === "ArrowUp") return "↑";
  if (code === "ArrowDown") return "↓";
  if (code === "ArrowLeft") return "←";
  if (code === "ArrowRight") return "→";
  const key = layoutLabels()[code];
  if (key) return key.toUpperCase();
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

// Capture the next keydown and report its `code`. Modifier-only presses are
// ignored, and so is auto-repeat from a key already held when capture began.
// Escape cancels capture without binding, reported through onCancel (and
// stops propagation so the settings modal's own Esc-to-close handler doesn't
// fire).
export function captureNextKey(onPress: (code: string) => void, onCancel?: () => void): () => void {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
      onCancel?.();
      return;
    }
    if (MODIFIER_CODES.has(ev.code) || ev.repeat) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
    onPress(ev.code);
  };
  const cancel = () => { window.removeEventListener("keydown", onKey, true); };
  window.addEventListener("keydown", onKey, true);
  return cancel;
}
