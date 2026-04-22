// Singleton AudioContext, primed on the very first user gesture in the
// tab. Browsers require a gesture to start audio; by capturing the
// earliest one (click/touch/keydown anywhere) we guarantee the context is
// already running by the time the emulator boots, so there's no silent
// window before the first emulator input.

let ctx: AudioContext | null = null;
let primed = false;

function prime() {
  if (primed) return;
  primed = true;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

const cleanup = () => {
  document.removeEventListener("pointerdown", onGesture, true);
  document.removeEventListener("keydown", onGesture, true);
  document.removeEventListener("touchstart", onGesture, true);
};
function onGesture() {
  prime();
  cleanup();
}

document.addEventListener("pointerdown", onGesture, true);
document.addEventListener("keydown", onGesture, true);
document.addEventListener("touchstart", onGesture, true);

// Callers get the primed context; if no gesture has occurred yet, they
// still get a suspended context and can set up nodes — the audio will
// flow as soon as the user interacts.
export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}
