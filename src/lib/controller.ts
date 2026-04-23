// Hardware gamepad support via the Web Gamepad API. Polls the default
// controller on a rAF loop and maps standard buttons/axes to the
// emulator's joypad inputs. Started on first connect, stopped when the
// last controller disconnects.

import { log } from "./log.js";

export type InputName = "A" | "B" | "start" | "select" | "up" | "down" | "left" | "right";

// Standard gamepad layout (https://w3c.github.io/gamepad/#remapping).
// Used when the pad reports `mapping === "standard"` and the user hasn't
// customised bindings via the settings panel.
export const DEFAULT_BINDINGS: Record<InputName, number> = {
  A: 0, B: 1, select: 8, start: 9,
  up: 12, down: 13, left: 14, right: 15,
};

export const CONTROLLER_BINDINGS_KEY = "crystal-ap-controller-bindings";

export function loadBindings(): Record<InputName, number> {
  try {
    const raw = localStorage.getItem(CONTROLLER_BINDINGS_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_BINDINGS };
    for (const k of Object.keys(DEFAULT_BINDINGS) as InputName[]) {
      if (typeof parsed[k] === "number") merged[k] = parsed[k];
    }
    return merged;
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

export function saveBindings(b: Record<InputName, number>) {
  try { localStorage.setItem(CONTROLLER_BINDINGS_KEY, JSON.stringify(b)); } catch {}
  currentBindings = { ...b };
}

let currentBindings: Record<InputName, number> = loadBindings();

const AXIS_THRESHOLD = 0.5;

// Exposed so the settings panel can peek at what's connected without
// having to reimplement controller enumeration.
export function getActivePad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  return pads.find(p => p && p.connected) ?? null;
}

export function bindController({ emulator, module }: { emulator: number; module: any }) {
  const held: Record<string, boolean> = {};
  const setHeld = (name: string, down: boolean) => {
    if (held[name] === down) return;
    held[name] = down;
    module[`_set_joyp_${name}`]?.(emulator, down);
  };

  let rafId: number | null = null;
  let connectedCount = 0;

  const poll = () => {
    rafId = requestAnimationFrame(poll);
    const pad = getActivePad();
    if (!pad) return;

    // Buttons via the user-configurable map.
    for (const name of Object.keys(currentBindings) as InputName[]) {
      const idx = currentBindings[name];
      const b = pad.buttons[idx];
      setHeld(name, !!(b && b.pressed));
    }
    // Left stick → dpad. OR with the dpad buttons above so either works.
    const [ax, ay] = pad.axes;
    if (ax !== undefined) {
      setHeld("left",  held.left  || ax < -AXIS_THRESHOLD);
      setHeld("right", held.right || ax >  AXIS_THRESHOLD);
    }
    if (ay !== undefined) {
      setHeld("up",   held.up   || ay < -AXIS_THRESHOLD);
      setHeld("down", held.down || ay >  AXIS_THRESHOLD);
    }
  };

  const start = () => { if (rafId == null) rafId = requestAnimationFrame(poll); };
  const stop  = () => { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };

  const onConnect = (ev: GamepadEvent) => {
    connectedCount++;
    log(`controller connected: ${ev.gamepad.id} (mapping: ${ev.gamepad.mapping || "unknown"})`);
    start();
  };
  const onDisconnect = (ev: GamepadEvent) => {
    connectedCount = Math.max(0, connectedCount - 1);
    log(`controller disconnected: ${ev.gamepad.id}`);
    // Release any buttons the last controller was holding so they don't
    // stick after the cable yanks.
    for (const name of Object.keys(held)) setHeld(name, false);
    if (connectedCount === 0) stop();
  };

  window.addEventListener("gamepadconnected",    onConnect);
  window.addEventListener("gamepaddisconnected", onDisconnect);

  // Some browsers populate `navigator.getGamepads()` with already-connected
  // controllers before firing gamepadconnected — seed from that.
  const existing = (navigator.getGamepads?.() ?? []).filter(p => p && p.connected);
  if (existing.length) {
    connectedCount = existing.length;
    start();
  }

  return () => {
    window.removeEventListener("gamepadconnected", onConnect);
    window.removeEventListener("gamepaddisconnected", onDisconnect);
    stop();
  };
}

// Capture the next freshly-pressed button on the active pad. Used by the
// rebind UI. Returns a disposer that cancels capture.
export function captureNextButton(onPress: (index: number) => void): () => void {
  let rafId: number | null = null;
  // Snapshot initial pressed-state so the button the user released to get
  // into capture mode doesn't auto-fire.
  let baseline: boolean[] | null = null;
  const tick = () => {
    rafId = requestAnimationFrame(tick);
    const pad = getActivePad();
    if (!pad) return;
    if (!baseline) {
      baseline = pad.buttons.map(b => !!b?.pressed);
      return;
    }
    for (let i = 0; i < pad.buttons.length; i++) {
      const pressed = !!pad.buttons[i]?.pressed;
      if (pressed && !baseline[i]) {
        cancel();
        onPress(i);
        return;
      }
      baseline[i] = pressed;
    }
  };
  const cancel = () => { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } };
  rafId = requestAnimationFrame(tick);
  return cancel;
}
