import { For, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { app, logLines, overlayPrefs } from "../state.js";
import { ansiToHtml } from "../lib/ansi.js";
import { isPatchName } from "../lib/zip.js";
import { connectSession, disconnectSession } from "../actions.js";
import { db, idbGet } from "../lib/idb.js";
import { SAVE_STORE } from "../lib/constants.js";
import { logErr, logWarn } from "../lib/log.js";
import { apWorker } from "../lib/ap-worker.js";

function ScreenFrame() {
  let frameRef!: HTMLDivElement;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      frameRef.requestFullscreen?.();
    }
  };
  // Tick every second so age-based expiry re-evaluates while fullscreen.
  // Cheap: only wakes the overlay memo, not the whole page.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  const FADE_SEC = 0.8;

  // Last N non-expired log entries — rendered as an overlay only while
  // fullscreen. `persistSec === 0` means entries never expire.
  const tailLines = createMemo(() => {
    const prefs = overlayPrefs();
    const n = now();
    const visible = logLines().filter(e => {
      if (prefs.persistSec === 0) return true;
      const ageSec = (n - (e.ts ?? 0)) / 1000;
      return ageSec < prefs.persistSec + FADE_SEC;
    });
    return visible.slice(Math.max(0, visible.length - prefs.maxEntries));
  });

  // Per-entry CSS for the fade animation. A negative animation-delay
  // fast-forwards entries that are already part-way through their fade
  // (e.g. when the overlay first mounts with entries already in the buffer).
  const lineStyle = (entry: { ts?: number }) => {
    const prefs = overlayPrefs();
    if (prefs.persistSec === 0) return undefined;
    const ageSec = (Date.now() - (entry.ts ?? 0)) / 1000;
    const delaySec = prefs.persistSec - ageSec;
    return {
      "animation": `fs-line-fade ${FADE_SEC}s linear forwards`,
      "animation-delay": `${delaySec}s`,
    };
  };
  return (
    <div class="screen-frame" ref={frameRef}>
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
  let inputRef: HTMLInputElement | undefined;
  let atBottom = true;
  const onScroll = () => {
    atBottom = wrapRef.scrollHeight - wrapRef.clientHeight - wrapRef.scrollTop < 16;
  };
  createEffect(() => {
    logLines();
    if (!wrapRef) return;
    if (atBottom) queueMicrotask(() => { wrapRef.scrollTop = wrapRef.scrollHeight; });
  });
  const submitInput = () => {
    if (!inputRef) return;
    const text = inputRef.value.trim();
    if (!text) return;
    if (app.session.state !== "live") { logWarn("not connected — can't send"); return; }
    inputRef.value = "";
    try { apWorker.sendInput(text); }
    catch (err: any) { logErr("send failed: " + (err?.message || err)); }
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Enter") { ev.preventDefault(); submitInput(); }
  };
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
      <div class="log-input-row">
        <input
          ref={inputRef}
          class="log-input"
          type="text"
          autocomplete="off"
          spellcheck={false}
          placeholder={app.session.state === "live" ? "send message or !command…" : "connect to send messages"}
          disabled={app.session.state !== "live"}
          onKeyDown={onKey}
        />
        <button
          class="log-send-btn"
          type="button"
          disabled={app.session.state !== "live"}
          onClick={submitInput}
          aria-label="send"
          title="send"
        >send</button>
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

  const downloadSave = async () => {
    const session = app.sessions.find((s) => s.id === app.seedId);
    const romHash = session?.romHash;
    if (!romHash) { logErr("no ROM hash on this session — can't locate save"); return; }
    const dbc = await db();
    if (!dbc) { logErr("IDB unavailable"); return; }
    const sram = await idbGet<ArrayBuffer>(dbc, romHash, SAVE_STORE).catch(() => null);
    if (!sram || !sram.byteLength) { logWarn("no save data yet — play a bit first"); return; }
    const url = URL.createObjectURL(new Blob([sram], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session?.slot || app.slotName || "pokecrystal"}.sav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      <a href="#" data-kind="download" onClick={(ev) => { ev.preventDefault(); downloadSave(); }}>save file</a>
    </div>
  );
}

function PlayControls() {
  return (
    <div class="play-controls">
      <div class="session-form" id="session-form">
        <label>server<input type="text" id="sess-server" autocomplete="off" spellcheck={false} placeholder="archipelago.gg:xxxxx" /></label>
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
