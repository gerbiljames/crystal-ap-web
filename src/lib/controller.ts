// Hardware gamepad support via the Web Gamepad API. Polls the default
// controller on a rAF loop and maps standard buttons/axes to the
// emulator's joypad inputs. Started on first connect, stopped when the
// last controller disconnects.

import { log } from "./log.js";

// Standard gamepad layout: https://w3c.github.io/gamepad/#remapping
const BUTTON_MAP: Record<number, string> = {
  0: "A",       // A / Cross
  1: "B",       // B / Circle
  8: "select",  // Back / Share / View
  9: "start",   // Start / Options / Menu
  12: "up",
  13: "down",
  14: "left",
  15: "right",
};

const AXIS_THRESHOLD = 0.5;

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
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find(p => p && p.connected);
    if (!pad) return;

    // Buttons.
    for (const [idx, name] of Object.entries(BUTTON_MAP)) {
      const b = pad.buttons[+idx];
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
    log(`controller connected: ${ev.gamepad.id}`);
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
