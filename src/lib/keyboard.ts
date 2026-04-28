// Keyboard rebinding. Mirrors controller.ts: a small map of joypad inputs
// to KeyboardEvent.code values, persisted in localStorage, with a capture
// helper for the settings UI. emulator.ts reads `getKeyBindings()` on each
// keydown/keyup so rebinds take effect without restarting the emulator.

import type { InputName } from "./controller.js";

export const DEFAULT_KEY_BINDINGS: Record<InputName, string> = {
  A: "KeyX", B: "KeyZ", start: "Enter", select: "Tab",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

export const KEYBOARD_BINDINGS_KEY = "crystal-ap-keyboard-bindings";

export function loadKeyBindings(): Record<InputName, string> {
  try {
    const raw = localStorage.getItem(KEYBOARD_BINDINGS_KEY);
    if (!raw) return { ...DEFAULT_KEY_BINDINGS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_KEY_BINDINGS };
    for (const k of Object.keys(DEFAULT_KEY_BINDINGS) as InputName[]) {
      if (typeof parsed[k] === "string" && parsed[k]) merged[k] = parsed[k];
    }
    return merged;
  } catch {
    return { ...DEFAULT_KEY_BINDINGS };
  }
}

let currentKeyBindings: Record<InputName, string> = loadKeyBindings();

export function getKeyBindings(): Record<InputName, string> {
  return currentKeyBindings;
}

export function saveKeyBindings(b: Record<InputName, string>) {
  try { localStorage.setItem(KEYBOARD_BINDINGS_KEY, JSON.stringify(b)); } catch {}
  currentKeyBindings = { ...b };
}

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

// Capture the next keydown and report its `code`. Modifier-only presses are
// ignored. Escape cancels capture without binding (and stops propagation so
// the settings modal's own Esc-to-close handler doesn't fire).
export function captureNextKey(onPress: (code: string) => void): () => void {
  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
      return;
    }
    if (MODIFIER_CODES.has(ev.code)) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
    onPress(ev.code);
  };
  const cancel = () => { window.removeEventListener("keydown", onKey, true); };
  window.addEventListener("keydown", onKey, true);
  return cancel;
}
