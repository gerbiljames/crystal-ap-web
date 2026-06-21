import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { app, logLines, overlayPrefs, audioPrefs, setAudioPrefs, trackerInLogic, trackerGoMode, trackerStatus, hints, hintsStatus, hintItemNames, hintFeedback, connectOpen, setConnectOpen, isMobile, uiPrefs } from "../state.js";
import { ansiToHtml } from "../lib/ansi.js";
import { isPatchName } from "../lib/zip.js";
import { connectSession, disconnectSession, disposeEmulator, ensureEmulator, ensureTracker, ensureHints, requestHint, importSaveFile, stopTrackerPolling } from "../actions.js";
import { db, idbGet } from "../lib/idb.js";
import { SAVE_STORE } from "../lib/constants.js";
import { logErr, logWarn } from "../lib/log.js";
import { apWorker } from "../lib/ap-worker.js";
import { keyBindings, isDefaultKeyBindings } from "../lib/keyboard.js";

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
  // Tick every second so age-based expiry re-evaluates while fullscreen.
  // Cheap: only wakes the overlay memo, not the whole page.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  // When this frame unmounts (HMR, route-like teardown), dispose the
  // emulator so its ticker/interval/listeners don't outlive the canvas.
  // On remount, re-boot if we were already playing — this is what makes
  // HMR self-heal instead of leaving a blank canvas.
  onMount(() => { ensureEmulator(); });
  onCleanup(() => disposeEmulator());

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
        <Show when={isDefaultKeyBindings(keyBindings())}>
          <span class="screen-keys">arrows · <kbd>Z</kbd> b · <kbd>X</kbd> a · <kbd>↵</kbd> start · <kbd>⇥</kbd> select</span>
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

function TrackerPanel() {
  const status = () => trackerStatus();
  const placeholder = () => {
    const s = status();
    if (app.session.state !== "live") return "connect a session to see what's in logic";
    if (s.kind === "error")  return "tracker unavailable: " + (s.reason || "").split("\n")[0];
    if (s.kind === "idle")   return "waiting for tracker…";
    if (trackerInLogic().length === 0) return "no locations in logic right now";
    return null;
  };
  return (
    <div class="tracker-panel">
      <Show when={app.session.state === "live"}>
        <div class="tracker-header">
          <span>{trackerInLogic().length} in logic</span>
          <Show when={trackerGoMode() !== "no"}>
            <span
              class="tracker-go"
              data-mode={trackerGoMode()}
              title="UT has_beaten_game on the current logic state"
            >go mode{trackerGoMode() === "glitched" ? " (glitched)" : ""}</span>
          </Show>
        </div>
      </Show>
      <Show when={placeholder() !== null}>
        <div class="tracker-empty">{placeholder()}</div>
      </Show>
      <Show when={placeholder() === null}>
        <ul class="tracker-list">
          <For each={trackerInLogic()}>{(name) => (
            <li class="tracker-loc">{name}</li>
          )}</For>
        </ul>
      </Show>
    </div>
  );
}

function HintsPanel() {
  let inputRef: HTMLInputElement | undefined;
  const status = () => hintsStatus();
  const list = () => hints() || [];
  const placeholder = () => {
    const s = status();
    if (app.session.state !== "live") return "connect a session to see your hints";
    if (s.kind === "error") return "hints unavailable: " + (s.reason || "").split("\n")[0];
    if (hints() === null)   return "waiting for hints…";
    if (list().length === 0) return "no hints yet — request one below";
    return null;
  };
  // Show outstanding (not-yet-found) hints first; stable within each group so
  // the server's ordering is otherwise preserved.
  const sorted = () => list()
    .map((h, i) => [h, i] as const)
    .sort((a, b) => (Number(a[0].found) - Number(b[0].found)) || (a[1] - b[1]))
    .map(([h]) => h);
  // Index of the first found hint — used to drop a divider between the
  // outstanding group and the found group. -1 when one group is empty (no
  // boundary to mark).
  const dividerAt = () => {
    const s = sorted();
    const idx = s.findIndex((h) => h.found);
    return idx > 0 ? idx : -1;
  };
  // Type an item name to request a hint. requestHint wraps a bare name in !hint,
  // sends it, and mirrors the server's response into hintFeedback (below) so the
  // outcome is visible without switching to the console.
  const submitHint = () => {
    if (!inputRef) return;
    if (requestHint(inputRef.value)) inputRef.value = "";
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Enter") { ev.preventDefault(); submitHint(); }
  };
  return (
    <div class="tracker-panel">
      <Show when={app.session.state === "live" && hints() !== null}>
        <div class="tracker-header">
          <span>{list().length} hint{list().length === 1 ? "" : "s"}</span>
        </div>
      </Show>
      <Show when={placeholder() !== null}>
        <div class="tracker-empty">{placeholder()}</div>
      </Show>
      <Show when={placeholder() === null}>
        <ul class="tracker-list">
          <For each={sorted()}>{(h, i) => (
            <>
            <Show when={i() === dividerAt()}>
              <li class="hint-divider" aria-hidden="true"><span>found</span></li>
            </Show>
            <li class="hint-row" data-found={h.found}>
              <span class="hint-item">{h.item}</span>
              <span class="hint-sep"> is at </span>
              <span class="hint-loc">{h.location}</span>
              <span class="hint-who">
                {h.forYou ? ` (${h.finding})` : ` — for ${h.receiving}`}
              </span>
              <span class="hint-status" data-status={h.status}>{h.status}</span>
            </li>
            </>
          )}</For>
        </ul>
      </Show>
      <Show when={hintFeedback()}>
        <div class="hint-feedback" data-kind={hintFeedback()!.kind}>{hintFeedback()!.text}</div>
      </Show>
      <div class="log-input-row">
        <input
          ref={inputRef}
          class="log-input"
          type="text"
          list="hint-item-list"
          autocomplete="off"
          spellcheck={false}
          placeholder={app.session.state === "live" ? "item to hint… (sends !hint)" : "connect to request hints"}
          disabled={app.session.state !== "live"}
          onKeyDown={onKey}
        />
        <datalist id="hint-item-list">
          <For each={hintItemNames()}>{(name) => <option value={name} />}</For>
        </datalist>
        <button
          class="log-send-btn"
          type="button"
          disabled={app.session.state !== "live"}
          onClick={submitHint}
          aria-label="request hint"
          title="request hint"
        >hint</button>
      </div>
    </div>
  );
}

function LogArea() {
  let wrapRef;
  let inputRef: HTMLInputElement | undefined;
  let atBottom = true;
  const [tab, setTab] = createSignal<"console" | "tracker" | "hints">("console");
  const onScroll = () => {
    atBottom = wrapRef.scrollHeight - wrapRef.clientHeight - wrapRef.scrollTop < 16;
  };
  createEffect(() => {
    logLines();
    if (!wrapRef) return;
    if (tab() !== "console") return;
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
      <div class="log-tabs" role="tablist">
        <button
          type="button"
          class="log-tab"
          role="tab"
          aria-selected={tab() === "console"}
          data-active={tab() === "console"}
          onClick={() => { setTab("console"); stopTrackerPolling(); }}
        >console</button>
        <button
          type="button"
          class="log-tab"
          role="tab"
          aria-selected={tab() === "tracker"}
          data-active={tab() === "tracker"}
          onClick={() => { setTab("tracker"); ensureTracker().catch(() => {}); }}
        >tracker</button>
        <button
          type="button"
          class="log-tab"
          role="tab"
          aria-selected={tab() === "hints"}
          data-active={tab() === "hints"}
          onClick={() => { setTab("hints"); stopTrackerPolling(); ensureHints().catch(() => {}); }}
        >hints</button>
      </div>
      <Show when={tab() === "console"}>
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
      </Show>
      <Show when={tab() === "tracker"}>
        <TrackerPanel />
      </Show>
      <Show when={tab() === "hints"}>
        <HintsPanel />
      </Show>
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

  let importInput!: HTMLInputElement;
  const onImportPicked = async (ev: Event) => {
    const input = ev.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    // Reset first so picking the same file again still fires onChange.
    input.value = "";
    if (f) await importSaveFile(f);
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
      <a href="#" data-kind="upload" onClick={(ev) => { ev.preventDefault(); importInput.click(); }}>import save</a>
      <input ref={importInput} type="file" accept=".sav,.saveRAM,application/octet-stream"
             style="display:none" onChange={onImportPicked} />
    </div>
  );
}

function PlayControls() {
  const isLoopback = () => app.hosted?.kind === "loopback";
  const closePopup = () => setConnectOpen(false);

  // Esc closes the mobile connection popup while it's open. PlayStep stays
  // mounted across steps (CSS-toggled), so guard on the play step too.
  createEffect(() => {
    if (app.step !== "play" || !connectOpen()) return;
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") closePopup(); };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  // Once a session goes live there's nothing left to fill in — dismiss the
  // popup so the player drops straight back to the emulator.
  createEffect(() => {
    if (app.step === "play" && app.session.state === "live") setConnectOpen(false);
  });

  return (
    <div class="play-controls" data-connect-open={connectOpen() ? "true" : undefined}>
      <div class="connect-backdrop" onClick={closePopup}></div>
      <div class="connect-panel" role={isMobile() ? "dialog" : undefined} aria-modal={isMobile() ? "true" : undefined} aria-label="connection">
        <div class="connect-panel-head">
          <span class="connect-panel-title">connection</span>
          <button class="connect-panel-close" onClick={closePopup} aria-label="close">✕</button>
        </div>
        <div class="session-form" id="session-form">
          <label>
            server
            <input type="text" id="sess-server" autocomplete="off" spellcheck={false}
                   placeholder="archipelago.gg:xxxxx"
                   readOnly={isLoopback()}
                   title={isLoopback() ? "this seed is self-hosted in this tab" : undefined} />
          </label>
          <label>slot<input type="text" id="sess-slot" autocomplete="off" spellcheck={false} value="Player1" readOnly={app.session.state === "live"} /></label>
          <label>password<input type="password" id="sess-pw" autocomplete="off" readOnly={app.session.state === "live"} /></label>
          <Show when={!isLoopback()}>
            <div class="session-actions">
              <button class="btn-primary" id="btn-connect" onClick={connectSession}>connect</button>
              <button id="btn-disconnect" onClick={disconnectSession}>disconnect</button>
            </div>
          </Show>
        </div>
        <SessionLinks />
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
