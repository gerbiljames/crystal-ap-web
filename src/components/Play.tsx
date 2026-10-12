import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { app, logLines, type LogEntry, overlayPrefs, audioPrefs, setAudioPrefs, connectOpen, setConnectOpen, isMobile, uiPrefs, you, publicState } from "../state.js";
import { ansiToHtml } from "../lib/ansi.js";
import { disposeEmulator, ensureEmulator, giveUp } from "../actions.js";
import { keyBindings, isDefaultKeyBindings, keyLabel, DEFAULT_KEY_BINDINGS } from "../lib/keyboard.js";
import { ChecksMeter, FindList, formatCountdown, useNow } from "./Home.jsx";

// Recent log lines drawn over the game canvas while fullscreen. Mounted only
// for the duration of fullscreen (see ScreenFrame), so everything here —
// the expiry ticker, the buffer scan, the DOM — has that lifetime.
function LogOverlay() {
  const FADE_SEC = 0.8;

  // Tick every second so age-based expiry re-evaluates.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  // Last N non-expired log entries. `persistSec === 0` means entries never
  // expire. Entries are appended in time order, so walk back from the newest
  // and stop as soon as we have enough or hit one that's already expired.
  const tailLines = createMemo(() => {
    const prefs = overlayPrefs();
    const n = now();
    const lines = logLines();
    const out: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < prefs.maxEntries; i--) {
      const e = lines[i];
      if (prefs.persistSec !== 0) {
        // Clamp so a backward wall-clock step reads as "brand new" rather than
        // a negative age that would stop the walk early.
        const ageSec = Math.max(0, n - e.ts) / 1000;
        if (ageSec >= prefs.persistSec + FADE_SEC) break;
      }
      out.push(e);
    }
    return out.reverse();
  });

  // Per-entry CSS for the fade animation. A negative animation-delay
  // fast-forwards entries that are already part-way through their fade —
  // every fullscreen entry mounts this fresh with entries already in the
  // buffer, so this is the common case, not an edge case.
  const lineStyle = (entry: LogEntry) => {
    const prefs = overlayPrefs();
    if (prefs.persistSec === 0) return undefined;
    const ageSec = Math.max(0, Date.now() - entry.ts) / 1000;
    const delaySec = prefs.persistSec - ageSec;
    return {
      "animation": `fs-line-fade ${FADE_SEC}s linear forwards`,
      "animation-delay": `${delaySec}s`,
    };
  };

  return (
    <div class="fs-log-overlay" aria-hidden="true">
      <For each={tailLines()}>{(entry) => (
        <div class={`fs-log-line log-${entry.kind}`} style={lineStyle(entry)}>
          <span class="fs-log-time">{entry.time}</span>{" "}
          {entry.ansi !== undefined
            ? <span innerHTML={ansiToHtml(entry.ansi)} />
            : <span>{entry.text}</span>}
        </div>
      )}</For>
    </div>
  );
}

// Over the game while it is frozen: the game only runs while its checks can
// reach the server.
function PauseOverlay() {
  return (
    <Show when={app.step === "play" && app.session.state !== "live"}>
      <PauseMessage />
    </Show>
  );
}

// Mounted only while paused, so its clock only ticks then.
function PauseMessage() {
  const now = useNow();
  const graceEndsAt = () => you()?.session?.graceEndsAt ?? null;
  return (
    <div class="pause-overlay" role="status">
      <span class="pause-title">paused</span>
      <span class="pause-text">
        {app.session.state === "error"
          ? `the game couldn't connect — reload the page to try again${graceEndsAt() ? ` (your turn ends in ${formatCountdown(graceEndsAt()! - now())} without a connection)` : ""}`
          : graceEndsAt()
            ? `reconnecting… your turn ends in ${formatCountdown(graceEndsAt()! - now())} unless the game reconnects`
            : "connecting to the server…"}
      </span>
    </div>
  );
}

function ScreenFrame() {
  let frameRef!: HTMLDivElement;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      // Fullscreen the parent .play-game so the on-screen gamepad (sibling
      // of .screen-frame) rides into the top-layer too on touch devices.
      const target = (frameRef.closest(".play-game") as HTMLElement | null) ?? frameRef;
      target.requestFullscreen?.();
    }
  };
  // When this frame unmounts (HMR, route-like teardown), dispose the
  // emulator so its ticker/interval/listeners don't outlive the canvas.
  // On remount, re-boot if we were already playing — this is what makes
  // HMR self-heal instead of leaving a blank canvas.
  onMount(() => { ensureEmulator(); });
  onCleanup(() => disposeEmulator());

  // The log overlay only renders in fullscreen. Mounting it conditionally
  // (rather than hiding it with CSS) means its ticker, memo and DOM don't
  // exist at all the rest of the time.
  const [fullscreen, setFullscreen] = createSignal(!!document.fullscreenElement);
  const onFsChange = () => setFullscreen(!!document.fullscreenElement);
  document.addEventListener("fullscreenchange", onFsChange);
  onCleanup(() => document.removeEventListener("fullscreenchange", onFsChange));

  return (
    <div class="screen-frame" ref={frameRef}>
      <Show when={fullscreen()}><LogOverlay /></Show>
      <div class="screen-wrap">
        <canvas id="screen" width="160" height="144"></canvas>
        <PauseOverlay />
      </div>
      <div class="screen-label-bottom">
        <Show when={isDefaultKeyBindings(keyBindings())}>
          <span class="screen-keys">arrows · <kbd>{keyLabel(DEFAULT_KEY_BINDINGS.B)}</kbd> b · <kbd>{keyLabel(DEFAULT_KEY_BINDINGS.A)}</kbd> a · <kbd>↵</kbd> start · <kbd>⇥</kbd> select</span>
        </Show>
        <label class="vol" title="volume">
          <span class="vol-label" classList={{ muted: audioPrefs().volume === 0 }}>
            {audioPrefs().volume === 0 ? "mute" : "vol"}
          </span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(audioPrefs().volume * 100)}
            onInput={(ev) => setAudioPrefs({ ...audioPrefs(), volume: Number(ev.currentTarget.value) / 100 })}
          />
        </label>
        <button class="fs-btn" onClick={toggleFullscreen} aria-label="fullscreen" title="fullscreen">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm16 0v5h-5v-2h3v-3h2z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

function Gamepad() {
  // Hidden via data attribute rather than unmounting so bindGamepad's
  // listeners survive the user toggling the setting mid-session.
  return (
    <div class="gamepad" aria-hidden="true" data-user-hidden={uiPrefs().hideGamepad}>
      <div class="gamepad-row">
        <div class="gp-dpad">
          <button class="gp-btn gp-up"    data-input="up"    aria-label="up">▲</button>
          <button class="gp-btn gp-left"  data-input="left"  aria-label="left">◀</button>
          <button class="gp-btn gp-right" data-input="right" aria-label="right">▶</button>
          <button class="gp-btn gp-down"  data-input="down"  aria-label="down">▼</button>
        </div>
        <div class="gp-ab">
          <button class="gp-btn gp-b" data-input="B" aria-label="B">B</button>
          <button class="gp-btn gp-a" data-input="A" aria-label="A">A</button>
        </div>
      </div>
      <div class="gamepad-row gp-ss">
        <button class="gp-btn gp-sel"   data-input="select" aria-label="select">select</button>
        <button class="gp-btn gp-start" data-input="start"  aria-label="start">start</button>
      </div>
    </div>
  );
}

function LogArea() {
  let wrapRef;
  let atBottom = true;
  const onScroll = () => {
    atBottom = wrapRef.scrollHeight - wrapRef.clientHeight - wrapRef.scrollTop < 16;
  };
  createEffect(() => {
    logLines();
    if (!wrapRef) return;
    if (atBottom) queueMicrotask(() => { wrapRef.scrollTop = wrapRef.scrollHeight; });
  });
  return (
    <div class="log-area">
      <div class="log-tabs" role="tablist">
        <button type="button" class="log-tab" role="tab" aria-selected="true" data-active="true">console</button>
      </div>
      <div id="log-wrap" class="log-wrap" ref={wrapRef} onScroll={onScroll}>
        <pre id="log">
          <For each={logLines()}>{(entry) => (
            <>
              <span class="log-time">{entry.time} </span>
              {entry.ansi !== undefined
                ? <span class={`log-${entry.kind}`} innerHTML={ansiToHtml(entry.ansi)} />
                : <span class={`log-${entry.kind}`}>{entry.text}</span>}
              {"\n"}
            </>
          )}</For>
        </pre>
      </div>
    </div>
  );
}

// A value with a copy button, for the PopTracker details.
function CopyField(props: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = createSignal(false);
  const [shown, setShown] = createSignal(!props.secret);
  const copy = async () => {
    try { await navigator.clipboard.writeText(props.value); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked: the value is selectable anyway */ }
  };
  return (
    <label class="copy-field">
      <span class="copy-label">{props.label}</span>
      <input type={shown() ? "text" : "password"} readOnly value={props.value} onFocus={(ev) => ev.currentTarget.select()} />
      <Show when={props.secret}>
        <button type="button" onClick={() => setShown((v) => !v)}>{shown() ? "hide" : "show"}</button>
      </Show>
      <button type="button" onClick={copy}>{copied() ? "copied" : "copy"}</button>
    </label>
  );
}

function SessionPanel() {
  const session = () => you()?.session ?? null;
  const limit = () => publicState()?.checkLimit ?? 10;
  return (
    <div class="session-panel">
      <Show when={session()} fallback={<p class="muted">no session running</p>}>
        <div class="checks-box">
          <div class="session-row">
            <span class="eyebrow">checks</span>
            <ChecksMeter checks={session()!.checks} limit={limit()} />
          </div>
          {/* One 12px line at 1.5 line height plus the list's 6px gap per check. */}
          <div class="session-finds" style={{ height: `min(${limit() * 24 - 6}px, 40vh)` }}>
            <FindList finds={session()!.finds} empty="no new checks yet" />
          </div>
        </div>
        <details class="poptracker" open={!session()!.trackerConnected}>
          <summary>
            <span class="eyebrow">poptracker</span>
            <span class="tracker-state" data-on={session()!.trackerConnected ? "true" : undefined}>
              {session()!.trackerConnected ? "connected" : "not connected"}
            </span>
          </summary>
          <p class="muted">
            In PopTracker, load the Pokémon Crystal Archipelago pack, click the AP button and enter these.
            They only work during this turn. <strong>Only one PopTracker can use them at a time, and anything other than PopTracker that connects with them ends your turn.</strong>
          </p>
          <CopyField label="host" value={session()!.credentials.apAddress} />
          <CopyField label="slot" value={session()!.credentials.slot} />
          <CopyField label="password" value={session()!.credentials.trackerPassword} secret />
        </details>
        <div class="session-actions">
          <button onClick={giveUp}>end my turn</button>
        </div>
      </Show>
    </div>
  );
}

function PlayControls() {
  const closePopup = () => setConnectOpen(false);

  // Esc closes the mobile session popup while it's open. PlayStep stays
  // mounted across steps (CSS-toggled), so guard on the play step too.
  createEffect(() => {
    if (app.step !== "play" || !connectOpen()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closePopup(); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="play-controls" data-connect-open={connectOpen() ? "true" : undefined}>
      <div class="connect-backdrop" onClick={closePopup}></div>
      <div class="connect-panel" role={isMobile() ? "dialog" : undefined} aria-modal={isMobile() ? "true" : undefined} aria-label="your turn">
        <div class="connect-panel-head">
          <span class="connect-panel-title">your turn</span>
          <button class="connect-panel-close" onClick={closePopup} aria-label="close">✕</button>
        </div>
        <SessionPanel />
      </div>
      <LogArea />
    </div>
  );
}

export function PlayStep() {
  return (
    <section class="step" data-step="play">
      <div class="play-stack">
        <div class="play-game">
          <ScreenFrame />
          <Gamepad />
        </div>
        <PlayControls />
      </div>
    </section>
  );
}
