// Play-step layout measurement: publishes two CSS variables by sampling the
// real DOM on resize / orientation / step change.
//   --play-game-h : height from play-game's top to the viewport bottom
//   --emu-max-h   : budget for the emulator canvas (cell minus chrome + gamepad)
// Also physically relocates .log-area between .play-game (mobile portrait
// with enough vertical slack) and .play-controls (fallback) since it
// serves different roles in each layout.

// Minimum pixels of usable log height before we bother slotting it inside
// .play-game. Below this the log was collapsing to 0 and looking broken.
const MIN_LOG_SLACK_PX = 90;

export function initPlayLayout() {
  const playGameEl     = document.querySelector<HTMLElement>(".play-game");
  const gamepadEl      = document.querySelector<HTMLElement>(".gamepad");
  const screenFrameEl  = document.querySelector<HTMLElement>(".screen-frame");
  const canvasEl       = document.querySelector<HTMLCanvasElement>("#screen");
  const logAreaEl      = document.querySelector<HTMLElement>(".log-area");
  const playControlsEl = document.querySelector<HTMLElement>(".play-controls");
  if (!playGameEl || !gamepadEl || !screenFrameEl || !canvasEl) return;

  const mobileMQ    = window.matchMedia("(max-width: 900px)");
  const landscapeMQ = window.matchMedia("(max-width: 1100px) and (max-height: 600px) and (orientation: landscape)");

  const placeLog = (inside: boolean) => {
    if (!logAreaEl || !playControlsEl) return;
    if (inside) {
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
      placeLog(false);
      return;
    }
    // Prefer visualViewport — on iOS Safari window.innerHeight is the
    // "large" viewport and doesn't shrink when the URL bar is visible,
    // whereas visualViewport.height tracks the actually-visible area.
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const pgTop = playGameEl.getBoundingClientRect().top;
    // Real chrome inside the screen-frame = padding + row gap + label row +
    // wrap padding. Computed from parts because the frame may be stretched
    // to fill a grid cell (landscape), in which case
    // frame.offsetHeight - canvas.offsetHeight reflects all the stretched
    // slack, not the actual chrome.
    const screenWrapEl = screenFrameEl.querySelector<HTMLElement>(".screen-wrap");
    const labelEl = screenFrameEl.querySelector<HTMLElement>(".screen-label-bottom");
    const fCs = getComputedStyle(screenFrameEl);
    const wCs = screenWrapEl ? getComputedStyle(screenWrapEl) : null;
    const framePad = parseFloat(fCs.paddingTop) + parseFloat(fCs.paddingBottom);
    const frameGap = parseFloat(fCs.rowGap || fCs.gap) || 0;
    const labelH   = labelEl ? labelEl.offsetHeight : 0;
    const wrapPad  = wCs ? (parseFloat(wCs.paddingTop) + parseFloat(wCs.paddingBottom)) : 0;
    const frameChrome = framePad + frameGap + labelH + wrapPad;

    const pgH = Math.max(240, vh - pgTop);
    document.documentElement.style.setProperty("--play-game-h", `${pgH}px`);

    let budget: number;
    if (landscapeMQ.matches) {
      // Landscape splits the gamepad around the emulator via
      // `display: contents` — A/B + start/select stack in the right column
      // and don't eat vertical space. Extra 8px safety margin for
      // rendering/sub-pixel slack.
      budget = Math.max(100, pgH - frameChrome - 8);
      // No log slot inside play-game in landscape.
      placeLog(false);
    } else if (mobileMQ.matches) {
      const gpH = gamepadEl.offsetHeight;
      // What the canvas (aspect-locked) would actually occupy vertically
      // at the current wrap width — that's the height it'll pin to when
      // the width bound, not the height bound, dominates.
      const wrapWidth = screenWrapEl ? screenWrapEl.clientWidth : playGameEl.clientWidth;
      const canvasFromWidth = wrapWidth * 144 / 160;
      const frameHeight = canvasFromWidth + frameChrome;
      // Slack available for a log between the frame and the gamepad
      // (minus two gaps: frame-to-log and log-to-gamepad).
      const slack = pgH - frameHeight - gpH - 28;
      const logInside = slack >= MIN_LOG_SLACK_PX;
      placeLog(logInside);
      const gaps = logInside ? 28 : 14;
      budget = Math.max(120, pgH - gpH - gaps - frameChrome);
    } else {
      placeLog(false);
      budget = Math.max(120, pgH - frameChrome);
    }
    document.documentElement.style.setProperty("--emu-max-h", `${budget}px`);
  };

  // Defer to next frame so layout is settled after attribute/CSS changes.
  const update = () => requestAnimationFrame(() => requestAnimationFrame(doMeasure));

  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  // Mobile browser chrome (URL bar) hides/shows without always firing a
  // window `resize` — visualViewport is the reliable signal there.
  window.visualViewport?.addEventListener("resize", update);
  mobileMQ.addEventListener("change",    update);
  landscapeMQ.addEventListener("change", update);
  new MutationObserver(update).observe(document.body, {
    attributes: true, attributeFilter: ["data-step"], subtree: true,
  });

  // Exposed on window so setStep() can poke it from the step machine.
  window.__updateEmuMaxH = update;

  return update;
}
