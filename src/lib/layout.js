// Play-step layout measurement: publishes two CSS variables by sampling the
// real DOM on resize / orientation / step change.
//   --play-game-h : height from play-game's top to the viewport bottom
//   --emu-max-h   : budget for the emulator canvas (cell minus chrome + gamepad)
// Also physically relocates .log-area between .play-game (mobile portrait)
// and .play-controls (desktop / mobile landscape) since it serves different
// roles in each layout.

export function initPlayLayout() {
  const playGameEl     = document.querySelector(".play-game");
  const gamepadEl      = document.querySelector(".gamepad");
  const screenFrameEl  = document.querySelector(".screen-frame");
  const canvasEl       = document.querySelector("#screen");
  const logAreaEl      = document.querySelector(".log-area");
  const playControlsEl = document.querySelector(".play-controls");
  if (!playGameEl || !gamepadEl || !screenFrameEl || !canvasEl) return;

  const mobileMQ    = window.matchMedia("(max-width: 900px)");
  const landscapeMQ = window.matchMedia("(max-width: 1100px) and (max-height: 600px) and (orientation: landscape)");

  const relocateLogArea = () => {
    if (!logAreaEl || !playControlsEl) return;
    // Mobile portrait: slot between emulator and gamepad so it fills the
    // slack. Mobile landscape + desktop: keep in play-controls so it flows
    // below the play area.
    if (mobileMQ.matches && !landscapeMQ.matches) {
      if (logAreaEl.parentElement !== playGameEl) {
        playGameEl.insertBefore(logAreaEl, gamepadEl);
      }
    } else {
      if (logAreaEl.parentElement !== playControlsEl) {
        playControlsEl.appendChild(logAreaEl);
      }
    }
  };

  const doMeasure = () => {
    // Only active when play step is live (mobile layout + visible).
    if (playGameEl.offsetParent === null || getComputedStyle(gamepadEl).display === "none") {
      document.documentElement.style.removeProperty("--emu-max-h");
      return;
    }
    const vh = window.innerHeight;
    const pgTop = playGameEl.getBoundingClientRect().top;
    // Real chrome inside the screen-frame = padding + row gap + label row +
    // wrap padding. Computed from parts because the frame may be stretched
    // to fill a grid cell (landscape), in which case
    // frame.offsetHeight - canvas.offsetHeight reflects all the stretched
    // slack, not the actual chrome.
    const screenWrapEl = screenFrameEl.querySelector(".screen-wrap");
    const labelEl = screenFrameEl.querySelector(".screen-label-bottom");
    const fCs = getComputedStyle(screenFrameEl);
    const wCs = screenWrapEl ? getComputedStyle(screenWrapEl) : null;
    const framePad = parseFloat(fCs.paddingTop) + parseFloat(fCs.paddingBottom);
    const frameGap = parseFloat(fCs.rowGap || fCs.gap) || 0;
    const labelH   = labelEl ? labelEl.offsetHeight : 0;
    const wrapPad  = wCs ? (parseFloat(wCs.paddingTop) + parseFloat(wCs.paddingBottom)) : 0;
    const frameChrome = framePad + frameGap + labelH + wrapPad;

    const pgH = Math.max(240, vh - pgTop);
    document.documentElement.style.setProperty("--play-game-h", `${pgH}px`);

    let budget;
    if (landscapeMQ.matches) {
      // Landscape splits the gamepad around the emulator via
      // `display: contents` — A/B + start/select stack in the right column
      // and don't eat vertical space. Extra 8px safety margin for
      // rendering/sub-pixel slack.
      budget = Math.max(100, pgH - frameChrome - 8);
    } else {
      const gpH = gamepadEl.offsetHeight;
      // One 14px gap, plus a second gap if the log is slotted between.
      const logInside = logAreaEl && logAreaEl.parentElement === playGameEl;
      const gaps = logInside ? 28 : 14;
      budget = Math.max(120, pgH - gpH - gaps - frameChrome);
    }
    document.documentElement.style.setProperty("--emu-max-h", `${budget}px`);
  };

  // Defer to next frame so layout is settled after attribute/CSS changes.
  const update = () => requestAnimationFrame(() => requestAnimationFrame(doMeasure));

  relocateLogArea();
  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  mobileMQ.addEventListener("change",    () => { relocateLogArea(); update(); });
  landscapeMQ.addEventListener("change", () => { relocateLogArea(); update(); });
  new MutationObserver(update).observe(document.body, {
    attributes: true, attributeFilter: ["data-step"], subtree: true,
  });

  // Exposed on window so setStep() can poke it from the step machine.
  window.__updateEmuMaxH = update;

  return update;
}
