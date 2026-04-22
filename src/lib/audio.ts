// Singleton AudioContext, primed on the very first user gesture in the
// tab. Browsers require a gesture to start audio; by capturing the
// earliest one (click/touch/keydown anywhere) we guarantee the context is
// already running by the time the emulator boots, so there's no silent
// window before the first emulator input.

let ctx: AudioContext | null = null;

// Re-run on every user gesture, not just the first — iOS/Android can miss
// a one-shot resume (first gesture may not fully unlock, or the context
// can transition back to suspended on visibility / memory events).
function onGesture() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
}

document.addEventListener("pointerdown", onGesture, true);
document.addEventListener("keydown",     onGesture, true);
document.addEventListener("touchstart",  onGesture, true);
document.addEventListener("touchend",    onGesture, true);
document.addEventListener("click",       onGesture, true);

// Callers get the primed context; if no gesture has occurred yet, they
// still get a suspended context and can set up nodes — the audio will
// flow as soon as the user interacts.
export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}
