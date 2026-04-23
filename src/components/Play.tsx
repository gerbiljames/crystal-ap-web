import { For, createEffect, createMemo } from "solid-js";
import { app, logLines } from "../state.js";
import { ansiToHtml } from "../lib/ansi.js";
import { isPatchName } from "../lib/zip.js";
import { connectSession, disconnectSession } from "../actions.js";

function ScreenFrame() {
  let frameRef!: HTMLDivElement;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      frameRef.requestFullscreen?.();
    }
  };
  // Last N log entries — rendered as an overlay only while fullscreen.
  const tailLines = createMemo(() => {
    const all = logLines();
    return all.slice(Math.max(0, all.length - 8));
  });
  return (
    <div class="screen-frame" ref={frameRef}>
      <div class="fs-log-overlay" aria-hidden="true">
        <For each={tailLines()}>{(entry) => (
          <div class={`fs-log-line log-${entry.kind}`}>
            <span class="fs-log-time">{entry.time}</span>{" "}
            {entry.ansi !== undefined
              ? <span innerHTML={ansiToHtml(entry.ansi)} />
              : <span>{entry.text}</span>}
          </div>
        )}</For>
      </div>
      <div class="screen-wrap">
        <canvas id="screen" width="160" height="144"></canvas>
      </div>
      <div class="screen-label-bottom">
        <span class="screen-keys">arrows · <kbd>Z</kbd> b · <kbd>X</kbd> a · <kbd>↵</kbd> start · <kbd>⇥</kbd> select</span>
        <label class="vol" title="volume">
          <span class="vol-label" id="vol-label">vol</span>
          <input type="range" id="vol" min="0" max="100" value="50" />
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
  return (
    <div class="gamepad" aria-hidden="true">
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
      <div class="log-heading">event log</div>
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

function SessionLinks() {
  const items = () => {
    const out = [];
    if (app.hosted?.room_url) out.push({ href: app.hosted.room_url, label: "archipelago.gg room", kind: "external" });
    const a = app.artifacts || {};
    const blobUrl = (name) => URL.createObjectURL(new Blob([a[name]], { type: "application/octet-stream" }));
    const patch = Object.keys(a).find(isPatchName);
    const spoil = Object.keys(a).find(n => n.endsWith("_Spoiler.txt"));
    const multi = Object.keys(a).find(n => n.endsWith(".archipelago"));
    if (patch) out.push({ href: blobUrl(patch), label: "patch (.apcrystal)", kind: "download", download: patch });
    if (multi) out.push({ href: blobUrl(multi), label: "multidata",          kind: "download", download: multi });
    if (spoil) out.push({ href: blobUrl(spoil), label: "spoiler log",        kind: "download", download: spoil });
    return out;
  };
  return (
    <div class="session-links" id="session-links">
      <For each={items()}>{(l) => (
        <a href={l.href} target="_blank" rel="noopener"
           data-kind={l.kind === "download" ? "download" : undefined}
           download={l.kind === "download" ? l.download : undefined}>
          {l.label}
        </a>
      )}</For>
    </div>
  );
}

function PlayControls() {
  return (
    <div class="play-controls">
      <div class="session-form" id="session-form">
        <label>server<input type="text" id="sess-server" autocomplete="off" spellcheck={false} placeholder="archipelago.gg:50193" /></label>
        <label>slot<input type="text" id="sess-slot" autocomplete="off" spellcheck={false} value="Player1" /></label>
        <label>password<input type="password" id="sess-pw" autocomplete="off" /></label>
        <div class="session-actions">
          <button class="btn-primary" id="btn-connect" onClick={connectSession}>connect</button>
          <button id="btn-disconnect" onClick={disconnectSession}>disconnect</button>
        </div>
      </div>
      <SessionLinks />
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
