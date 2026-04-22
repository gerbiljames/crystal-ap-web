// On-screen gamepad. Binds touch + mouse handlers to a root element, routes
// presses/releases into binjgb via `_set_joyp_<input>(e, held)`. Supports
// finger-rolling across buttons via elementFromPoint hit-testing, coalesced
// to one resolution per animation frame.

export function bindGamepad(rootEl, { emulator, module }) {
  if (!rootEl) return () => {};

  const setBtn = (btn, held) => {
    if (!btn) return;
    module[`_set_joyp_${btn.dataset.input}`](emulator, held);
    btn.dataset.held = held ? "1" : "0";
  };
  const btnUnder = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest(".gp-btn[data-input]");
  };

  // Map value is the button currently held by that touch, or null if the
  // finger is between buttons. Keeping the entry (as null) lets a touch that
  // rolls off a button later roll back onto another one.
  const touchBtns = new Map();
  const onTouchStart = (ev) => {
    let hitAny = false;
    for (const t of ev.changedTouches) {
      const btn = btnUnder(t.clientX, t.clientY);
      if (!btn) continue;
      setBtn(btn, true);
      touchBtns.set(t.identifier, btn);
      hitAny = true;
    }
    // Only consume the event when the touch actually landed on a button,
    // so swipes that start in the gap between buttons still trigger
    // native vertical scroll (touch-action: pan-y on .gamepad).
    if (hitAny) ev.preventDefault();
  };

  // Touchmove fires many times per frame on mobile. Coalesce each touch's
  // latest position into a map and resolve it once per rAF so we don't spam
  // elementFromPoint (a layout read) on every event.
  const pendingMove = new Map(); // touchId -> {x, y}
  let moveQueued = false;
  const flushMove = () => {
    moveQueued = false;
    for (const [id, pos] of pendingMove) {
      if (!touchBtns.has(id)) continue;
      const prev = touchBtns.get(id);
      const now = btnUnder(pos.x, pos.y);
      if (now === prev) continue;
      if (prev) setBtn(prev, false);
      if (now) setBtn(now, true);
      touchBtns.set(id, now || null);
    }
    pendingMove.clear();
  };
  const onTouchMove = (ev) => {
    for (const t of ev.changedTouches) {
      pendingMove.set(t.identifier, { x: t.clientX, y: t.clientY });
    }
    if (!moveQueued) { moveQueued = true; requestAnimationFrame(flushMove); }
    // No preventDefault — `touch-action: none` on .gamepad already blocks
    // scroll/zoom, and making this listener passive lets the browser
    // dispatch events without waiting for this handler to finish.
  };
  const onTouchEnd = (ev) => {
    for (const t of ev.changedTouches) {
      if (!touchBtns.has(t.identifier)) continue;
      const btn = touchBtns.get(t.identifier);
      if (btn) setBtn(btn, false);
      touchBtns.delete(t.identifier);
    }
  };

  rootEl.addEventListener("touchstart",  onTouchStart, { passive: false });
  rootEl.addEventListener("touchmove",   onTouchMove,  { passive: true });
  rootEl.addEventListener("touchend",    onTouchEnd);
  rootEl.addEventListener("touchcancel", onTouchEnd);
  const onCtx = (ev) => ev.preventDefault();
  rootEl.addEventListener("contextmenu", onCtx);

  // Mouse events per-button for desktop testing — simple, no rolling.
  const mouseBindings = [];
  rootEl.querySelectorAll(".gp-btn[data-input]").forEach(btn => {
    const press   = (ev) => { ev.preventDefault(); setBtn(btn, true); };
    const release = () => { setBtn(btn, false); };
    btn.addEventListener("mousedown",  press);
    btn.addEventListener("mouseup",    release);
    btn.addEventListener("mouseleave", release);
    mouseBindings.push([btn, press, release]);
  });

  // Cleanup for HMR / teardown — not used today but cheap to expose.
  return () => {
    rootEl.removeEventListener("touchstart",  onTouchStart);
    rootEl.removeEventListener("touchmove",   onTouchMove);
    rootEl.removeEventListener("touchend",    onTouchEnd);
    rootEl.removeEventListener("touchcancel", onTouchEnd);
    rootEl.removeEventListener("contextmenu", onCtx);
    for (const [btn, press, release] of mouseBindings) {
      btn.removeEventListener("mousedown",  press);
      btn.removeEventListener("mouseup",    release);
      btn.removeEventListener("mouseleave", release);
    }
  };
}
