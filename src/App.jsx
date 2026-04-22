// Root Solid tree. Mirrors the old index.html body byte-for-byte on the DOM
// side (same classes, IDs, data-* attributes, child order) so the inline
// stylesheet in index.html keeps matching. State lives in ./state.js;
// framework-agnostic helpers come from ./lib/.

import { onMount, onCleanup, createEffect, For, Show, createSignal } from "solid-js";
import { app, setApp, persistHostPref, refreshSessions, logLines } from "./state.js";
import {
  GB_ROM_SIZE, WRAM_BASE, RAM, PHASE_LABELS,
  ROM_STORE, VANILLA_STORE, ARTIFACTS_STORE, SAVE_STORE,
} from "./lib/constants.js";
import { isPatchName, readPatchManifest, extractAllZipEntries } from "./lib/zip.js";
import { log, logOk, logErr, logWarn, logLine } from "./lib/log.js";
import { ansiToHtml } from "./lib/ansi.js";
import { db, idbGet, idbPut, idbDel } from "./lib/idb.js";
import { loadSessions, saveSessions, recordSession as recordSessionPure, removeSession, formatAge } from "./lib/sessions.js";
import { tryHostMultidata } from "./lib/host.js";
import { apWorker } from "./lib/ap-worker.js";
import { bindGamepad } from "./lib/gamepad.js";
import { initPlayLayout } from "./lib/layout.js";
import { bootEmulator } from "./lib/emulator.js";
import { installBizHawkBridge } from "./lib/bizhawk.js";

// -----------------------------------------------------------------------------
// step machine + history
// -----------------------------------------------------------------------------
let _historyPushed = false;
function setStep(step) {
  setApp("step", step);
  if (window.__updateEmuMaxH) window.__updateEmuMaxH();
  if (step !== "options" && !_historyPushed) {
    history.pushState({ inApp: true }, "");
    _historyPushed = true;
  } else if (step === "options") {
    _historyPushed = false;
  }
}

function setSessionState(state, label) {
  setApp("session", { state, label: label ?? state });
}

// -----------------------------------------------------------------------------
// actions
// -----------------------------------------------------------------------------
async function forgetSession(id) {
  const { removed } = removeSession(id);
  refreshSessions();
  const dbc = await db();
  if (dbc) {
    idbDel(dbc, id, ROM_STORE).catch(() => {});
    idbDel(dbc, id, ARTIFACTS_STORE).catch(() => {});
    if (removed?.romHash) idbDel(dbc, removed.romHash, SAVE_STORE).catch(() => {});
  }
}

async function resumeSession(id) {
  const session = loadSessions().find(s => s.id === id);
  if (!session) return;
  setApp("seedId", id);
  setApp("slotName", session.slot || "Player1");
  setApp("hosted", session.hosted || null);

  const dbc = await db();
  const cachedRom = dbc ? await idbGet(dbc, id, ROM_STORE).catch(() => null) : null;
  if (cachedRom && cachedRom.byteLength === GB_ROM_SIZE) {
    setApp("patchedRom", cachedRom);
    const savedArtifacts = dbc ? await idbGet(dbc, id, ARTIFACTS_STORE).catch(() => null) : null;
    if (savedArtifacts) setApp("artifacts", savedArtifacts);
    setStep("play");
    logOk(`resumed ${id} with cached ROM`);
    await bootEmulatorAndUi();
    return;
  }
  logErr(`no cached ROM for ${id} — drop your YAML again to regenerate`);
}

async function runGeneration(yamlText) {
  const start = performance.now();
  setApp("gen", { visible: true, status: "starting", elapsed: "0.0s", error: null, done: false });
  const elapsedTimer = setInterval(
    () => setApp("gen", "elapsed", `${((performance.now()-start)/1000).toFixed(1)}s`),
    100,
  );

  let artifacts;
  try {
    const res = await apWorker.generate(yamlText, (phase) => {
      setApp("gen", "status", PHASE_LABELS[phase] || phase);
      log("gen: " + phase);
    });
    artifacts = res.out.artifacts;
  } catch (err) {
    clearInterval(elapsedTimer);
    setApp("gen", { visible: false, error: err.message || String(err) });
    logErr(`generation failed: ${err.message || err}`);
    return;
  }

  setApp("artifacts", artifacts);
  logOk(`generated ${Object.keys(artifacts).length} artifacts locally`);

  const multiName = Object.keys(artifacts).find(n => n.endsWith(".archipelago"));
  let hosted = null;
  if (multiName && app.hostPref) {
    setApp("gen", "status", "hosting on archipelago.gg…");
    hosted = await tryHostMultidata(artifacts[multiName]);
  } else if (!app.hostPref) {
    log("hosting disabled — the multidata is downloadable from the results card");
  }
  setApp("hosted", hosted);

  clearInterval(elapsedTimer);
  setApp("gen", { visible: false, status: hosted ? "ready · hosted" : "ready", done: true });
  logOk(hosted ? `hosted on ${hosted.host}:${hosted.port}` : "no archipelago.gg room (skipped)");
}

async function continueToRom() {
  const dbc = await db();
  const cached = dbc ? await idbGet(dbc, "rom", VANILLA_STORE).catch(() => null) : null;
  if (cached && cached.byteLength === GB_ROM_SIZE) {
    log("using saved vanilla ROM from this browser");
    await runPatch(new Uint8Array(cached), "cached");
    return;
  }
  setStep("rom");
}

async function runPatch(romBytes, sourceLabel = "uploaded") {
  setApp("rom", { progressText: "reading ROM…", error: null });
  setStep("patching");
  log(`${sourceLabel} ROM (${romBytes.length} bytes); patching locally`);

  const patchName = Object.keys(app.artifacts || {}).find(isPatchName);
  if (!patchName) {
    setApp("rom", "error", "no .apcrystal on this session — regenerate");
    setApp("rom", "progressText", null);
    logErr("no .apcrystal on this session — regenerate");
    return;
  }
  const patchBytes = app.artifacts[patchName].slice();
  const vanillaBuf = romBytes.slice().buffer;

  try {
    const { out } = await apWorker.patch(romBytes, patchBytes, (phase) => {
      setApp("rom", "progressText", PHASE_LABELS[phase] || phase);
      log("patcher: " + phase);
    });
    setApp("rom", "progressText", "booting emulator…");
    if (out.byteLength !== GB_ROM_SIZE) {
      const msg = `patched ROM was ${out.byteLength} bytes, expected ${GB_ROM_SIZE}`;
      setApp("rom", { progressText: null, error: msg });
      logErr(msg);
      return;
    }
    setApp("patchedRom", out.buffer);
    logOk(`patched locally (${out.byteLength} bytes)`);
    recordSessionPure({
      id: app.seedId,
      slot: app.slotName,
      hosted: app.hosted,
      romCached: true,
    });
    refreshSessions();
    const dbc = await db();
    if (dbc) {
      idbPut(dbc, app.seedId, out.buffer.slice(0), ROM_STORE).catch(err => logWarn("cache patched rom failed: " + err));
      idbPut(dbc, "rom", vanillaBuf, VANILLA_STORE).catch(err => logWarn("cache vanilla rom failed: " + err));
      if (app.artifacts) {
        idbPut(dbc, app.seedId, app.artifacts, ARTIFACTS_STORE).catch(err => logWarn("cache artifacts failed: " + err));
      }
    }
    setStep("play");
    setApp("rom", "progressText", null);
    await bootEmulatorAndUi();
  } catch (err) {
    const msg = `patch failed: ${err.message || err}`;
    setApp("rom", { progressText: null, error: msg });
    logErr(msg);
  }
}

function extractSlotNameFromYaml(text) {
  const m = text.match(/^name:\s*(.+)\s*$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
}

async function handleYamlDrop(f) {
  setApp("yamlErr", null);
  log(`read ${f.name} (${f.size} bytes)`);
  setApp("seedId", (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12));

  const name = f.name.toLowerCase();
  const isPatch = isPatchName(name);
  const isZip   = name.endsWith(".zip");

  if (isPatch || isZip) {
    let bytes;
    try { bytes = new Uint8Array(await f.arrayBuffer()); }
    catch (e) { setApp("yamlErr", `could not read file: ${e}`); logErr(`could not read file: ${e}`); return; }

    let artifacts = {};
    if (isPatch) {
      artifacts[f.name] = bytes;
    } else {
      try { artifacts = await extractAllZipEntries(bytes); }
      catch (e) { setApp("yamlErr", `could not read zip: ${e}`); logErr(`could not read zip: ${e}`); return; }
    }
    const patchName = Object.keys(artifacts).find(isPatchName);
    if (!patchName) { setApp("yamlErr", `no .apcrystal found inside ${f.name}`); logErr(`no .apcrystal found inside ${f.name}`); return; }

    let manifest = {};
    try { manifest = await readPatchManifest(artifacts[patchName]); }
    catch (e) { logWarn(`couldn't read archipelago.json: ${e.message || e}`); }
    if (manifest.player_name) {
      setApp("slotName", manifest.player_name);
      log(`slot from patch: ${manifest.player_name}`);
    }

    const multiName = Object.keys(artifacts).find(n => n.toLowerCase().endsWith(".archipelago"));
    let hosted = null;
    if (multiName && app.hostPref) {
      setStep("generating");
      setApp("gen", { visible: true, status: "hosting on archipelago.gg…", elapsed: "0.0s", error: null, done: false });
      hosted = await tryHostMultidata(artifacts[multiName]);
      setApp("gen", "visible", false);
    } else if (!multiName && app.hostPref) {
      logWarn("hosting requested but no .archipelago was found — skip to ROM");
    }
    if (!hosted && manifest.server && manifest.server.includes(":")) {
      const [h, portStr] = manifest.server.split(":");
      const p = Number(portStr);
      if (h && Number.isInteger(p)) {
        hosted = { host: h, port: p, ws_url: `wss://${h}:${p}`, room_url: null };
        log(`server from patch: ${h}:${p}`);
      }
    }
    setApp("artifacts", artifacts);
    setApp("hosted", hosted);
    logOk(`using uploaded ${isPatch ? "patch" : "zip"} — skipping generation` + (hosted ? "" : "; no host"));
    continueToRom();
    return;
  }

  if (!(name.endsWith(".yaml") || name.endsWith(".yml"))) {
    setApp("yamlErr", `unsupported file type: ${f.name}`);
    logErr(`unsupported file type: ${f.name}`);
    return;
  }

  let text;
  try { text = await f.text(); }
  catch (e) { setApp("yamlErr", `could not read file: ${e}`); logErr(`could not read file: ${e}`); return; }
  const slot = extractSlotNameFromYaml(text);
  if (slot) { setApp("slotName", slot); log(`parsed slot name: ${slot}`); }

  setStep("generating");
  runGeneration(text);
}

async function handleRomDrop(f) {
  setApp("rom", "error", null);
  if (f.size !== GB_ROM_SIZE) {
    const msg = `expected 2,097,152 bytes, got ${f.size.toLocaleString()} — is this the right file?`;
    setApp("rom", "error", msg);
    logErr(msg);
    return;
  }
  let romBuf;
  try { romBuf = new Uint8Array(await f.arrayBuffer()); }
  catch (e) { setApp("rom", "error", `read failed: ${e}`); logErr(`read failed: ${e}`); return; }
  await runPatch(romBuf, "uploaded");
}

// -----------------------------------------------------------------------------
// emulator boot (play step)
// -----------------------------------------------------------------------------
async function bootEmulatorAndUi() {
  const saveDb = await db();
  const emu = await bootEmulator({
    canvas: document.querySelector("#screen"),
    romBuf: app.patchedRom,
    saveDb,
  });
  if (!emu) return;
  const { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash, setVolume } = emu;

  if (app.seedId) {
    const list = loadSessions();
    const entry = list.find(s => s.id === app.seedId);
    if (entry && entry.romHash !== romHash) {
      entry.romHash = romHash;
      saveSessions(list);
    }
  }

  const volInput = document.querySelector("#vol");
  const volLabel = document.querySelector("#vol-label");
  const applyVol = () => {
    const v = Number(volInput.value) / 100;
    setVolume(v);
    volLabel.classList.toggle("muted", v === 0);
    volLabel.textContent = v === 0 ? "mute" : "vol";
  };
  volInput.addEventListener("input", applyVol);
  applyVol();

  initPlayLayout();
  bindGamepad(document.querySelector(".gamepad"), { emulator: e, module: Module });
  installBizHawkBridge(emu, apWorker);

  // Seed the session form with host/slot info.
  document.querySelector("#sess-server").value = app.hosted ? `${app.hosted.host}:${app.hosted.port}` : "";
  document.querySelector("#sess-slot").value = app.slotName || "";

  // Expose for console poking.
  window.ap = { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash, RAM, WRAM_BASE };
  log("ready · enter session details and Connect");
}

async function connectSession() {
  const server = document.querySelector("#sess-server").value.trim();
  const slot   = document.querySelector("#sess-slot").value.trim();
  const pw     = document.querySelector("#sess-pw").value;
  if (!server || !slot) { logErr("server and slot are required"); return; }
  setSessionState("connecting", "connecting…");
  logOk(`connecting session for ${slot}@${server}`);
  try {
    await apWorker.startSession(server, slot, pw);
    setSessionState("live", slot);
    logOk(`session started`);
    const list = loadSessions();
    const entry = list.find(s => s.id === app.seedId);
    if (entry) {
      entry.slot = slot;
      const [h, portStr] = server.split(":");
      const port = Number(portStr);
      if (h && Number.isInteger(port)) {
        entry.hosted = { host: h, port, ws_url: `wss://${h}:${port}`, room_url: entry.hosted?.room_url || null };
      }
      saveSessions(list);
      setApp("slotName", slot);
      setApp("hosted", entry.hosted);
    }
  } catch (err) {
    setSessionState("error", "error");
    logErr("session start failed: " + (err.message || err));
  }
}
async function disconnectSession() {
  try { await apWorker.stopSession(); } catch {}
  setSessionState("idle", "disconnected");
}

function resetTransient() {
  setApp({
    seedId: null, artifacts: null, hosted: null, patchedRom: null,
    yamlErr: null,
    gen: { visible: false, status: "queued", elapsed: "0.0s", error: null, done: false },
    rom: { progressText: null, error: null },
  });
  refreshSessions();
  setStep("options");
}

// -----------------------------------------------------------------------------
// components
// -----------------------------------------------------------------------------
function Nav() {
  const onBrandClick = (ev) => {
    ev.preventDefault();
    try { apWorker.stopSession(); } catch {}
    window.location.reload();
  };
  return (
    <header class="nav">
      <a class="gh-link" href="https://github.com/gerbiljames/crystal-ap-web" target="_blank" rel="noopener" aria-label="source on github" title="source on github">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
      <a class="brand" id="brand-home" href="#" onClick={onBrandClick}>
        <span>crystal<span style="color:var(--jade-bright)">.</span>ap</span>
      </a>
      <div class="nav-spacer"></div>
      <SessionChip />
    </header>
  );
}

function SessionChip() {
  return (
    <div class="session-chip" id="session-chip" data-state={app.session.state}>
      <span class="dot"></span><span class="label">{app.session.label}</span>
    </div>
  );
}

function Blurb() {
  return (
    <aside class="blurb">
      <h1>Pokémon Crystal Archipelago <em>in your browser.</em></h1>
      <p>A full multiworld client for <a href="https://github.com/gerbiljames/Archipelago-Crystal/tree/pokecrystal" target="_blank" rel="noopener">Pokémon Crystal</a>. You provide a YAML and your own vanilla Crystal ROM; everything else happens locally.</p>
      <ul class="blurb-list">
        <li>Generation and ROM patching run in your tab via <a href="https://pyodide.org" target="_blank" rel="noopener">Pyodide</a>.</li>
        <li>Your ROM never leaves this browser. It's stored locally so you don't need to re-provide it.</li>
        <li>Emulation by <a href="https://github.com/binji/binjgb" target="_blank" rel="noopener">binjgb</a>. Saves persist per seed.</li>
        <li>The multiworld can be hosted on <a href="https://archipelago.gg" target="_blank" rel="noopener">archipelago.gg</a> via a tiny proxy.</li>
        <li>You can generate a YAML on <a href="https://ap-lobby.bananium.fr/options/pokemon_crystal" target="_blank" rel="noopener">Bananium</a>.</li>
      </ul>
    </aside>
  );
}

function Dropzone(props) {
  // Shared dropzone wiring. props: id, accept, children (inner content),
  // onFile(File).
  let zoneRef;
  const onDrag   = ev => { ev.preventDefault(); zoneRef?.classList.add("drag-over"); };
  const onLeave  = () => zoneRef?.classList.remove("drag-over");
  const onDrop   = ev => {
    ev.preventDefault();
    zoneRef?.classList.remove("drag-over");
    const f = ev.dataTransfer?.files?.[0];
    if (f) props.onFile(f);
  };
  const onChange = ev => {
    const f = ev.target.files?.[0];
    if (f) props.onFile(f);
  };
  return (
    <label
      class="dropzone"
      id={props.id}
      for={props.inputId}
      ref={zoneRef}
      onDragEnter={onDrag}
      onDragOver={onDrag}
      onDragLeave={onLeave}
      onDrop={onDrop}
    >
      <input type="file" accept={props.accept} id={props.inputId} onChange={onChange} />
      {props.children}
    </label>
  );
}

function ResumeList() {
  return (
    <Show when={app.sessions.length > 0}>
      <div class="resume-list" id="resume-list">
        <div class="resume-head">
          <span class="eyebrow">active seeds</span>
          <span class="resume-head-hint">saved locally · ROM cached</span>
        </div>
        <div id="resume-list-inner">
          <For each={app.sessions}>{(s) => (
            <div class="resume-row">
              <span class="slot">{s.slot || "?"}</span>
              <span class="id">
                {s.id}
                <Show when={s.romCached}>
                  <span class="rom-cached" title="patched ROM cached locally — resume skips the ROM upload">ROM</span>
                </Show>
              </span>
              <span class="meta">
                <em>{s.hosted ? `${s.hosted.host}:${s.hosted.port}` : "no host"}</em>
                {" "}{formatAge(Date.now() - s.savedAt)}
              </span>
              <span class="actions">
                <button class="btn-primary resume" onClick={() => resumeSession(s.id)}>resume</button>
                <button class="forget" title="remove from this device" onClick={() => forgetSession(s.id)}>forget</button>
              </span>
            </div>
          )}</For>
        </div>
      </div>
    </Show>
  );
}

function OptionsPane() {
  return (
    <div class="home-pane" data-pane="options">
      <ResumeList />
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">new seed</span></div>
        <Dropzone id="dz-yaml" inputId="yaml-file" accept=".yaml,.yml,.apcrystal,.apcrystalpre,.zip,text/yaml" onFile={handleYamlDrop}>
          <div class="dz-mark">◇</div>
          <div class="dz-primary">Drop YAML, <b>.apcrystal</b>, or <b>output .zip</b></div>
        </Dropzone>
        <label class="switch" title="Generate locally and upload to archipelago.gg so anyone with the room URL can join. When off, the multidata is produced but you'll need to host it yourself.">
          <input type="checkbox" id="host-toggle" checked={app.hostPref} onChange={(ev) => persistHostPref(ev.target.checked)} />
          <span class="switch-track"><span class="switch-knob"></span></span>
          <span class="switch-text">host on <b>archipelago.gg</b></span>
        </label>
        <Show when={app.yamlErr}>
          <div class="error-box" id="yaml-err">
            <span class="err-title">rejected</span>
            <span id="yaml-err-msg">{app.yamlErr}</span>
          </div>
        </Show>
      </div>
    </div>
  );
}

function ArtifactChips() {
  const artifacts = () => app.artifacts || {};
  const blobUrl = (name) => URL.createObjectURL(new Blob([artifacts()[name]], { type: "application/octet-stream" }));
  const chips = () => {
    const a = artifacts();
    const out = [];
    if (app.hosted) out.push({ href: app.hosted.room_url, title: "archipelago.gg room", kind: "external", sublabel: "host" });
    const patch = Object.keys(a).find(isPatchName);
    const spoil = Object.keys(a).find(n => n.endsWith("_Spoiler.txt"));
    const multi = Object.keys(a).find(n => n.endsWith(".archipelago"));
    if (patch) out.push({ href: blobUrl(patch), title: patch,       kind: "download", sublabel: "patch",       download: patch });
    if (spoil) out.push({ href: blobUrl(spoil), title: "spoiler",   kind: "download", sublabel: "txt",         download: spoil });
    if (multi) out.push({ href: blobUrl(multi), title: "multidata", kind: "download", sublabel: "archipelago", download: multi });
    return out;
  };
  return (
    <div class="result-grid" id="result-grid">
      <For each={chips()}>{(c) => (
        <a class="result-chip" href={c.href} target="_blank" rel="noopener" title={c.title}
           attr:download={c.kind === "download" ? (c.download || c.title) : undefined}>
          <span class="chip-left">
            <span class="label">{c.sublabel}</span>
            <span class="title">{c.title}</span>
          </span>
          <span class="arrow">{c.kind === "download" ? "↓" : "↗"}</span>
        </a>
      )}</For>
    </div>
  );
}

function GeneratingPane() {
  const [continueLabel, setContinueLabel] = createSignal("Continue → ROM");
  createEffect(async () => {
    if (!app.gen.done) return;
    const dbc = await db();
    const cached = dbc ? await idbGet(dbc, "rom", VANILLA_STORE).catch(() => null) : null;
    setContinueLabel((cached && cached.byteLength === GB_ROM_SIZE) ? "Continue → Play" : "Continue → ROM");
  });
  return (
    <div class="home-pane" data-pane="generating">
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">rolling seed</span></div>
        <Show when={app.gen.visible}>
          <div class="progress-bar" id="gen-progress"><div class="progress-sweep"></div></div>
        </Show>
        <dl class="seed-meta">
          <dt>seed id</dt><dd id="gen-seed">{app.seedId || "—"}</dd>
          <dt>status</dt><dd id="gen-status">{app.gen.status}</dd>
          <dt>elapsed</dt><dd id="gen-elapsed">{app.gen.elapsed}</dd>
        </dl>
        <Show when={app.gen.done}>
          <div class="seed-result" id="seed-result">
            <ArtifactChips />
            <div style="display:flex; gap:12px; margin-top:4px;">
              <button class="btn-primary" id="next-rom" onClick={continueToRom}>{continueLabel()}</button>
            </div>
          </div>
        </Show>
        <Show when={app.gen.error}>
          <div class="error-box" id="gen-err">
            <span class="err-title">generation failed</span>
            <span id="gen-err-msg">{app.gen.error}</span>
          </div>
        </Show>
        <Show when={app.gen.error}>
          <button class="err-back" onClick={resetTransient}>← start over</button>
        </Show>
      </div>
    </div>
  );
}

function RomPane() {
  return (
    <div class="home-pane" data-pane="rom">
      <div class="home-card">
        <div class="card-head"><span class="eyebrow">your rom</span></div>
        <p class="tip">Patching happens entirely in your browser — Python via Pyodide, in a Web Worker. Your ROM never leaves this tab.</p>
        <p class="legend">accepts: <kbd>.gbc</kbd> · 2,097,152 bytes · Crystal v1.0 or v1.1</p>
        <Dropzone id="dz-rom" inputId="rom-file" accept=".gbc,.gb,application/octet-stream" onFile={handleRomDrop}>
          <div class="dz-mark">▱</div>
          <div class="dz-primary">Drop vanilla Pokémon Crystal ROM</div>
          <div class="dz-meta">your file · your machine</div>
        </Dropzone>
        <Show when={app.rom.progressText}>
          <div class="rom-progress" id="rom-progress">
            <span class="spinner" aria-hidden="true">◐</span>
            <span id="rom-progress-text">{app.rom.progressText}</span>
          </div>
        </Show>
        <Show when={app.rom.error}>
          <div class="error-box" id="rom-err">
            <span class="err-title">patch failed</span>
            <span id="rom-err-msg">{app.rom.error}</span>
          </div>
        </Show>
        <Show when={app.rom.error}>
          <button class="err-back" onClick={resetTransient}>← start over</button>
        </Show>
      </div>
    </div>
  );
}

function Home() {
  return (
    <section class="home">
      <Blurb />
      <div class="home-main">
        <OptionsPane />
        <GeneratingPane />
        <RomPane />
      </div>
    </section>
  );
}

function ScreenFrame() {
  return (
    <div class="screen-frame">
      <div class="screen-wrap">
        <canvas id="screen" width="160" height="144"></canvas>
      </div>
      <div class="screen-label-bottom">
        <span class="screen-keys">arrows · <kbd>Z</kbd> b · <kbd>X</kbd> a · <kbd>↵</kbd> start · <kbd>⇥</kbd> select</span>
        <label class="vol" title="volume">
          <span class="vol-label" id="vol-label">vol</span>
          <input type="range" id="vol" min="0" max="100" value="50" />
        </label>
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
    logLines();                                           // track signal
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
           attr:data-kind={l.kind === "download" ? "download" : undefined}
           attr:download={l.kind === "download" ? l.download : undefined}>
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

function PlayStep() {
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

export function App() {
  onMount(() => {
    const onPop = () => {
      try { apWorker.stopSession(); } catch {}
      window.location.reload();
    };
    window.addEventListener("popstate", onPop);
    onCleanup(() => window.removeEventListener("popstate", onPop));
  });
  return (
    <div class="app" data-step={app.step} data-session={app.session.state}>
      <Nav />
      <main>
        <Home />
        <PlayStep />
      </main>
    </div>
  );
}
