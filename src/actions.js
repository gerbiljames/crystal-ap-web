// Imperative UI actions: step transitions, YAML/ROM drops, generation,
// patching, session connect/disconnect. These mutate the reactive store
// (state.js) and talk to the framework-agnostic lib/ modules.

import { app, setApp, refreshSessions } from "./state.js";
import { GB_ROM_SIZE, PHASE_LABELS, ROM_STORE, VANILLA_STORE, ARTIFACTS_STORE, SAVE_STORE, WRAM_BASE, RAM } from "./lib/constants.js";
import { isPatchName, readPatchManifest, extractAllZipEntries } from "./lib/zip.js";
import { log, logOk, logErr, logWarn } from "./lib/log.js";
import { db, idbGet, idbPut, idbDel } from "./lib/idb.js";
import { loadSessions, saveSessions, recordSession as recordSessionPure, removeSession } from "./lib/sessions.js";
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
export function setStep(step) {
  setApp("step", step);
  if (window.__updateEmuMaxH) window.__updateEmuMaxH();
  if (step !== "options" && !_historyPushed) {
    history.pushState({ inApp: true }, "");
    _historyPushed = true;
  } else if (step === "options") {
    _historyPushed = false;
  }
}

export function setSessionState(state, label) {
  setApp("session", { state, label: label ?? state });
}

export function resetTransient() {
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
// resume + forget
// -----------------------------------------------------------------------------
export async function forgetSession(id) {
  const { removed } = removeSession(id);
  refreshSessions();
  const dbc = await db();
  if (dbc) {
    idbDel(dbc, id, ROM_STORE).catch(() => {});
    idbDel(dbc, id, ARTIFACTS_STORE).catch(() => {});
    if (removed?.romHash) idbDel(dbc, removed.romHash, SAVE_STORE).catch(() => {});
  }
}

export async function resumeSession(id) {
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

// -----------------------------------------------------------------------------
// generation
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// rom + patch
// -----------------------------------------------------------------------------
export async function continueToRom() {
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
    setApp("rom", { progressText: null, error: "no .apcrystal on this session — regenerate" });
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

// -----------------------------------------------------------------------------
// yaml / rom drops
// -----------------------------------------------------------------------------
function extractSlotNameFromYaml(text) {
  const m = text.match(/^name:\s*(.+)\s*$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
}

export async function handleYamlDrop(f) {
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

export async function handleRomDrop(f) {
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
// play-step boot + session connect
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

export async function connectSession() {
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

export async function disconnectSession() {
  try { await apWorker.stopSession(); } catch {}
  setSessionState("idle", "disconnected");
}

// Brand-click teardown: stop the session and reload for a clean slate.
export function teardownAndReload(ev) {
  if (ev) ev.preventDefault();
  try { apWorker.stopSession(); } catch {}
  window.location.reload();
}
