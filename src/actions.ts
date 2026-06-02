// Imperative UI actions: step transitions, YAML/ROM drops, generation,
// patching, session connect/disconnect. These mutate the reactive store
// (state.js) and talk to the framework-agnostic lib/ modules.

import { unwrap } from "solid-js/store";
import { app, setApp, refreshSessions, refreshYamls, setTrackerInLogic, setTrackerGoMode, setTrackerStatus, setYamlCreatorOpen, setYamlEditTarget, setConnectOpen } from "./state.js";
import { GB_ROM_SIZE, PHASE_LABELS, ROM_STORE, VANILLA_STORE, ARTIFACTS_STORE, SAVE_STORE, STATE_STORE, YAML_STORE, MHOST_SAVE_STORE, WRAM_BASE, RAM, VANILLA_ROM_HASHES } from "./lib/constants.js";
import { isPatchName, readPatchManifest, extractAllZipEntries } from "./lib/zip.js";
import { log, logOk, logErr, logWarn } from "./lib/log.js";
import { db, idbGet, idbPut, idbDel } from "./lib/idb.js";
import { loadSessions, saveSessions, recordSession as recordSessionPure, removeSession } from "./lib/sessions.js";
import { recordYaml, renameYaml as renameYamlPure, removeYaml, sha256Hex, loadYamls } from "./lib/yamls.js";
import { tryHostMultidata } from "./lib/host.js";
import { apWorker } from "./lib/ap-worker.js";
import { bindGamepad } from "./lib/gamepad.js";
import { bindController } from "./lib/controller.js";
import { initPlayLayout } from "./lib/layout.js";
import { bootEmulator, type EmulatorHandle } from "./lib/emulator.js";
import { installBizHawkBridge } from "./lib/bizhawk.js";

// -----------------------------------------------------------------------------
// step machine + history
// -----------------------------------------------------------------------------
export type Step = "options" | "generating" | "rom" | "patching" | "play";

let _historyPushed = false;
export function setStep(step: Step) {
  setApp("step", step);
  // The connection popup only belongs to the play step; clear it on any
  // transition so a lingering open state can't leak onto another step
  // (PlayStep stays mounted — steps toggle via CSS, not unmount).
  if (step !== "play") setConnectOpen(false);
  if (window.__updateEmuMaxH) window.__updateEmuMaxH();
  if (step !== "options" && !_historyPushed) {
    history.pushState({ inApp: true }, "");
    _historyPushed = true;
  } else if (step === "options") {
    _historyPushed = false;
  }
}

export type SessionState = "idle" | "connecting" | "live" | "error";
export function setSessionState(state: SessionState, label?: string) {
  setApp("session", { state, label: label ?? state });
}

// Short-hand for element lookups. Typed as the caller expects — callers pass
// the HTML element subtype they need, e.g. `$<HTMLInputElement>("#vol")`.
function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
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
export async function forgetSession(id: string) {
  const { removed } = removeSession(id);
  refreshSessions();
  const dbc = await db();
  if (dbc) {
    idbDel(dbc, id, ROM_STORE).catch(() => {});
    idbDel(dbc, id, ARTIFACTS_STORE).catch(() => {});
    idbDel(dbc, id, MHOST_SAVE_STORE).catch(() => {});
    if (removed?.romHash) {
      idbDel(dbc, removed.romHash, SAVE_STORE).catch(() => {});
      idbDel(dbc, removed.romHash, STATE_STORE).catch(() => {});
    }
  }
}

export async function resumeSession(id: string) {
  const session = loadSessions().find((s: any) => s.id === id);
  if (!session) return;
  setApp("seedId", id);
  setApp("slotName", session.slot || "Player1");
  setApp("hosted", session.hosted || null);

  const dbc = await db();
  const cachedRom = dbc ? await idbGet<ArrayBuffer>(dbc, id, ROM_STORE).catch(() => null) : null;
  const savedArtifacts = dbc ? await idbGet<Record<string, Uint8Array>>(dbc, id, ARTIFACTS_STORE).catch((err) => { logWarn(`read artifacts failed: ${err}`); return null; }) : null;
  if (cachedRom && cachedRom.byteLength === GB_ROM_SIZE) {
    setApp("patchedRom", cachedRom);
    if (savedArtifacts && Object.keys(savedArtifacts).length > 0) {
      setApp("artifacts", savedArtifacts);
    } else {
      logWarn(`no cached artifacts for ${id} — download links will be empty, regenerate to restore them`);
    }
    setStep("play");
    logOk(`resumed ${id} with cached ROM`);
    await bootEmulatorAndUi();
    return;
  }
  // No patched ROM yet — if we still have the generation artifacts, drop
  // the user back into the ROM-upload step (or straight to patching if the
  // vanilla ROM is already cached).
  if (savedArtifacts && Object.keys(savedArtifacts).length > 0) {
    setApp("artifacts", savedArtifacts);
    logOk(`resumed ${id} — need ROM to patch`);
    await continueToRom();
    return;
  }
  const msg = `couldn't resume ${id} — the browser cleared this seed's cached files. Drop the YAML again to roll a new seed.`;
  setApp("yamlErr", msg);
  logErr(msg);
}

// -----------------------------------------------------------------------------
// hosting
// -----------------------------------------------------------------------------
// Last-ditch flush before tab close. The in-worker async saver runs every 5s,
// but a refresh in the gap between ticks would lose the very latest activity.
// `pagehide` fires before unload (and before the worker is killed), giving us
// one chance to commit. The fire-and-forget postMessage will be processed by
// the worker, which writes to IDB synchronously enough to survive unload.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (app.hosted?.kind === "loopback") {
      try { apWorker.hostFlush(); } catch {}
    }
  });
}
type Hosted =
  | { kind: "loopback"; ws_url: string; host: null; port: null; room_url: null }
  | { kind: "remote";   ws_url: string; host: string; port: number; room_url: string | null };

// Apply the user's host preference to a freshly-produced multidata blob.
// "local"  → run MultiServer.py inside Pyodide; returns a loopback:// URI.
// "remote" → upload to archipelago.gg via the Cloudflare Worker.
// "off"    → null (user hosts externally).
async function hostMultidata(multidata: Uint8Array, status?: (label: string) => void): Promise<Hosted | null> {
  if (app.hostPref === "off") {
    log("hosting disabled — the multidata is downloadable from the results card");
    return null;
  }
  if (app.hostPref === "local") {
    status?.("hosting in this tab…");
    try {
      // .slice() so the worker can transfer ownership without detaching the
      // copy that's still living in app.artifacts (used by download links).
      const res = await apWorker.host(app.seedId || "", multidata.slice());
      return { kind: "loopback", ws_url: res.out.ws_url, host: null, port: null, room_url: null };
    } catch (err: any) {
      logErr(`in-browser host failed: ${err?.message || err}`);
      return null;
    }
  }
  status?.("hosting on archipelago.gg…");
  const remote = await tryHostMultidata(multidata);
  return remote ? { kind: "remote", ...remote } : null;
}

// -----------------------------------------------------------------------------
// generation
// -----------------------------------------------------------------------------
async function runGeneration(yamlText: string) {
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
  const hosted = multiName ? await hostMultidata(artifacts[multiName], (label) => setApp("gen", "status", label)) : null;
  setApp("hosted", hosted);

  clearInterval(elapsedTimer);
  setApp("gen", { visible: false, status: hosted ? "ready · hosted" : "ready", done: true });
  if (hosted?.kind === "loopback") logOk(`self-hosted in this tab`);
  else if (hosted?.kind === "remote") logOk(`hosted on ${hosted.host}:${hosted.port}`);
  else log("no host (skipped)");

  // Persist artifacts + record the session now so a reload before
  // patching can still resume from the ROM step.
  if (app.seedId) {
    recordSessionPure({
      id: app.seedId,
      slot: app.slotName,
      hosted,
      romCached: false,
    });
    refreshSessions();
    const dbc = await db();
    if (dbc) {
      try {
        await idbPut(dbc, app.seedId, unwrap(artifacts), ARTIFACTS_STORE);
      } catch (err) {
        logWarn("cache artifacts failed: " + err);
      }
    }
  }
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

async function runPatch(romBytes: Uint8Array, sourceLabel: string = "uploaded") {
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
    const patched: Uint8Array = out;
    setApp("rom", "progressText", "booting emulator…");
    if (patched.byteLength !== GB_ROM_SIZE) {
      const msg = `patched ROM was ${patched.byteLength} bytes, expected ${GB_ROM_SIZE}`;
      setApp("rom", { progressText: null, error: msg });
      logErr(msg);
      return;
    }
    setApp("patchedRom", patched.buffer);
    logOk(`patched locally (${patched.byteLength} bytes)`);
    recordSessionPure({
      id: app.seedId,
      slot: app.slotName,
      hosted: app.hosted,
      romCached: true,
    });
    refreshSessions();
    const dbc = await db();
    if (dbc) {
      // Await so we don't race a tab close; without this, a quick reload
      // after a fresh patch can resume with a cached ROM but no artifacts,
      // leaving the play screen without download links.
      await Promise.all([
        idbPut(dbc, app.seedId, patched.buffer.slice(0), ROM_STORE).catch(err => logWarn("cache patched rom failed: " + err)),
        idbPut(dbc, "rom", vanillaBuf, VANILLA_STORE).catch(err => logWarn("cache vanilla rom failed: " + err)),
        app.artifacts
          // Solid store values are proxies; hand IDB the raw object so
          // structured-clone doesn't trip on proxy internals.
          ? idbPut(dbc, app.seedId, unwrap(app.artifacts), ARTIFACTS_STORE).catch(err => logWarn("cache artifacts failed: " + err))
          : Promise.resolve(),
      ]);
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
function extractSlotNameFromYaml(text: string): string | null {
  const m = text.match(/^name:\s*(.+)\s*$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "");
}

export async function handleYamlDrop(f: File) {
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

    let artifacts: Record<string, Uint8Array> = {};
    if (isPatch) {
      artifacts[f.name] = bytes;
    } else {
      try { artifacts = await extractAllZipEntries(bytes); }
      catch (e) { setApp("yamlErr", `could not read zip: ${e}`); logErr(`could not read zip: ${e}`); return; }
    }
    const patchName = Object.keys(artifacts).find(isPatchName);
    if (!patchName) { setApp("yamlErr", `no .apcrystal found inside ${f.name}`); logErr(`no .apcrystal found inside ${f.name}`); return; }

    let manifest: Awaited<ReturnType<typeof readPatchManifest>> = {};
    try { manifest = await readPatchManifest(artifacts[patchName]); }
    catch (e) { logWarn(`couldn't read archipelago.json: ${e.message || e}`); }
    if (manifest.player_name) {
      setApp("slotName", manifest.player_name);
      log(`slot from patch: ${manifest.player_name}`);
    }

    const multiName = Object.keys(artifacts).find(n => n.toLowerCase().endsWith(".archipelago"));
    let hosted = null;
    if (multiName && app.hostPref !== "off") {
      setStep("generating");
      const initialStatus = app.hostPref === "local" ? "hosting in this tab…" : "hosting on archipelago.gg…";
      setApp("gen", { visible: true, status: initialStatus, elapsed: "0.0s", error: null, done: false });
      hosted = await hostMultidata(artifacts[multiName], (label) => setApp("gen", "status", label));
      setApp("gen", "visible", false);
    } else if (!multiName && app.hostPref !== "off") {
      logWarn("hosting requested but no .archipelago was found — skip to ROM");
    }
    if (!hosted && manifest.server && manifest.server.includes(":")) {
      const [h, portStr] = manifest.server.split(":");
      const p = Number(portStr);
      if (h && Number.isInteger(p)) {
        hosted = { kind: "remote", host: h, port: p, ws_url: `wss://${h}:${p}`, room_url: null };
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

  await saveYamlToLibrary(text, f.name, slot);

  setStep("generating");
  runGeneration(text);
}

async function saveYamlToLibrary(text: string, filename: string, slot: string | null) {
  try {
    const hash = await sha256Hex(text);
    const existing = loadYamls().find(y => y.hash === hash);
    const dbc = await db();
    if (dbc) await idbPut(dbc, hash, { text }, YAML_STORE).catch((err) => logWarn(`save yaml text failed: ${err}`));
    recordYaml({
      hash,
      name: existing?.name ?? filename,
      slotName: slot,
      size: text.length,
      savedAt: Date.now(),
    });
    refreshYamls();
    if (existing) log(`YAML already saved as "${existing.name}" — timestamp refreshed`);
    else logOk(`saved YAML "${filename}" to library`);
  } catch (err: any) {
    logWarn(`could not save YAML to library: ${err.message || err}`);
  }
}

export async function fetchSavedYamlText(hash: string): Promise<string | null> {
  const dbc = await db();
  if (!dbc) return null;
  const stored = await idbGet<{ text: string }>(dbc, hash, YAML_STORE).catch(() => null);
  return stored?.text ?? null;
}

export async function useSavedYaml(hash: string) {
  const dbc = await db();
  const stored = dbc ? await idbGet<{ text: string }>(dbc, hash, YAML_STORE).catch(() => null) : null;
  if (!stored?.text) {
    logErr(`YAML text missing from storage — forgetting entry`);
    forgetSavedYaml(hash);
    return;
  }
  setApp("yamlErr", null);
  setApp("seedId", (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 12));
  const slot = extractSlotNameFromYaml(stored.text);
  if (slot) { setApp("slotName", slot); log(`parsed slot name: ${slot}`); }
  setStep("generating");
  runGeneration(stored.text);
}

// Save a YAML built by the in-app creation UI. Returns the content hash so
// callers can immediately hand it to `useSavedYaml`.
export async function saveCreatedYaml(text: string, displayName: string): Promise<string> {
  setApp("yamlErr", null);
  const slot = extractSlotNameFromYaml(text);
  await saveYamlToLibrary(text, displayName, slot);
  return sha256Hex(text);
}

export async function createAndUseYaml(text: string, displayName: string) {
  const hash = await saveCreatedYaml(text, displayName);
  await useSavedYaml(hash);
}

// Open the YAML creator in raw-edit mode with the saved YAML loaded.
export async function openYamlForEdit(hash: string) {
  const text = await fetchSavedYamlText(hash);
  if (text == null) {
    logErr("YAML text missing from storage");
    return;
  }
  const entry = loadYamls().find(y => y.hash === hash);
  setYamlEditTarget({ hash, text, displayName: entry?.name ?? "edited.yaml" });
  setYamlCreatorOpen(true);
}

// Save an edited YAML. If the text changed (different hash) the old entry is
// forgotten so the library doesn't pile up versions.
export async function saveEditedYaml(text: string, displayName: string, oldHash: string): Promise<string> {
  setApp("yamlErr", null);
  const slot = extractSlotNameFromYaml(text);
  await saveYamlToLibrary(text, displayName, slot);
  const newHash = await sha256Hex(text);
  if (newHash !== oldHash) {
    await forgetSavedYaml(oldHash);
  }
  return newHash;
}

export function renameSavedYaml(hash: string, newName: string) {
  const trimmed = newName.trim();
  if (!trimmed) return;
  renameYamlPure(hash, trimmed);
  refreshYamls();
}

export async function forgetSavedYaml(hash: string) {
  removeYaml(hash);
  refreshYamls();
  const dbc = await db();
  if (dbc) idbDel(dbc, hash, YAML_STORE).catch(() => {});
}

export async function handleRomDrop(f: File) {
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

  const digest = await crypto.subtle.digest("SHA-256", romBuf.slice().buffer);
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const label = VANILLA_ROM_HASHES[hex];
  if (!label) {
    const msg = "ROM hash doesn't match a supported vanilla Crystal — only English 1.0 and 1.1 are accepted";
    setApp("rom", "error", msg);
    logErr(`${msg} (sha256 ${hex})`);
    return;
  }
  log(`vanilla ROM verified: ${label}`);

  await runPatch(romBuf, "uploaded");
}

// -----------------------------------------------------------------------------
// play-step boot + session connect
// -----------------------------------------------------------------------------
let currentEmu: EmulatorHandle | null = null;
// True from the moment bootEmulatorAndUi enters until currentEmu is assigned
// (or boot fails). Gates reentrant calls so concurrent triggers — e.g. a
// canvas remount racing with a step transition — can't start a second
// emulator while the first is still allocating.
let bootInFlight = false;

// Called on canvas unmount (e.g. HMR replacing <ScreenFrame/>) so the worker
// ticker, save interval, keyboard listeners, and wasm allocations don't
// outlive the DOM they were bound to and keep emitting audio into the void.
export function disposeEmulator() {
  if (!currentEmu) return;
  try { currentEmu.dispose(); } catch {}
  currentEmu = null;
  try { delete (window as any).ap; } catch {}
}

// Called on canvas mount. Under normal flow the step-transition code has
// already booted the emulator, so this is a no-op; after HMR remounts
// <ScreenFrame/> we boot a fresh one against the new canvas using the ROM
// that's still sitting in the store.
export async function ensureEmulator() {
  if (currentEmu || bootInFlight) return;
  if (app.step !== "play" || !app.patchedRom) return;
  await bootEmulatorAndUi();
}

async function bootEmulatorAndUi() {
  if (bootInFlight) return;
  bootInFlight = true;
  try {
    // Clear any prior instance so consecutive boots (session reset, HMR, etc.)
    // don't leak.
    disposeEmulator();
    const saveDb = await db();
    const emu = await bootEmulator({
      canvas: $<HTMLCanvasElement>("#screen"),
      romBuf: app.patchedRom,
      saveDb,
    });
    if (!emu) return;
    currentEmu = emu;
    const { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash } = emu;

    if (app.seedId) {
      const list = loadSessions();
      const entry = list.find((s: any) => s.id === app.seedId);
      if (entry && entry.romHash !== romHash) {
        entry.romHash = romHash;
        saveSessions(list);
      }
    }

    initPlayLayout();
    bindGamepad($<HTMLElement>(".gamepad"), { emulator: e, module: Module });
    bindController({ emulator: e, module: Module });
    installBizHawkBridge(emu, apWorker);
    installTrackerDirtyHandler();

    // For loopback sessions, the in-process MultiServer is keyed off a fresh
    // URI per worker boot. Re-host now so a resumed session points at a live
    // server rather than a stale ws_url from a previous tab. The worker
    // pulls any persisted .apsave from IndexedDB by seedId itself, so
    // MultiServer restores received items / hints / data storage instead of
    // starting from scratch.
    if (app.hosted?.kind === "loopback") {
      const multiName = Object.keys(app.artifacts || {}).find((n) => n.toLowerCase().endsWith(".archipelago"));
      if (multiName && app.seedId) {
        try {
          const res = await apWorker.host(app.seedId, app.artifacts[multiName].slice());
          setApp("hosted", { ...app.hosted, ws_url: res.out.ws_url });
        } catch (err: any) {
          logErr("re-host failed: " + (err?.message || err));
        }
      } else {
        logWarn("loopback session resumed but no .archipelago in cache — drop the YAML again to re-host");
      }
    }

    // Seed the session form with host/slot info. For loopback the input
    // shows a friendly label ("Self Hosted") instead of the synthetic URI;
    // connectSession reads the real ws_url from app.hosted in that case.
    const serverDisplay = app.hosted?.kind === "loopback"
      ? "Self Hosted"
      : (app.hosted ? `${app.hosted.host}:${app.hosted.port}` : "");
    $<HTMLInputElement>("#sess-server").value = serverDisplay;
    $<HTMLInputElement>("#sess-slot").value   = app.slotName || "";

    // Expose for console poking.
    window.ap = { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash, RAM, WRAM_BASE };
    if (app.hosted?.kind === "loopback") {
      log("ready · self-hosted, auto-connecting");
      // Defer one tick so the input fields we just populated are committed
      // to the DOM before connectSession reads them.
      queueMicrotask(() => { connectSession().catch(() => {}); });
    } else {
      log("ready · enter session details and Connect");
    }
  } finally {
    bootInFlight = false;
  }
}

export async function connectSession() {
  // For loopback hosts the input shows "Self Hosted" as a label; the real
  // URI lives on app.hosted.ws_url. Substitute it before handing to the
  // worker so the websockets shim sees `loopback://...` and short-circuits.
  const server = app.hosted?.kind === "loopback" && app.hosted.ws_url
    ? app.hosted.ws_url
    : $<HTMLInputElement>("#sess-server").value.trim();
  const slot   = $<HTMLInputElement>("#sess-slot").value.trim();
  const pw     = $<HTMLInputElement>("#sess-pw").value;
  if (!server || !slot) { logErr("server and slot are required"); return; }
  setSessionState("connecting", "connecting…");
  logOk(`connecting session for ${slot}@${server}`);
  try {
    await apWorker.startSession(server, slot, pw);
    setSessionState("live", slot);
    logOk(`session started`);
    trackerInited = false;
    trackerUnavailable = false;
    setTrackerInLogic([]);
    setTrackerGoMode("no");
    setTrackerStatus({ kind: "idle" });
    const list = loadSessions();
    const entry = list.find((s: any) => s.id === app.seedId);
    if (entry) {
      entry.slot = slot;
      // Loopback URIs are keyed off the worker's in-memory registry; persist
      // the kind so resume can re-host instead of trying a real wss:// dial.
      if (server.startsWith("loopback://")) {
        entry.hosted = { kind: "loopback", host: null, port: null, ws_url: server, room_url: null };
      } else {
        const [h, portStr] = server.split(":");
        const port = Number(portStr);
        if (h && Number.isInteger(port)) {
          entry.hosted = { kind: "remote", host: h, port, ws_url: `wss://${h}:${port}`, room_url: entry.hosted?.room_url || null };
        }
      }
      saveSessions(list);
      setApp("slotName", slot);
      setApp("hosted", entry.hosted);
    }
  } catch (err: any) {
    setSessionState("error", "error");
    logErr("session start failed: " + (err.message || err));
  }
}

// Universal Tracker — pure data-in/out. Init reads the cached multidata from
// app.artifacts; updates feed in the player's checked-locations set. No
// dependency on a live session or in-process MultiServer.
let trackerInited = false;
let trackerInitInFlight: Promise<boolean> | null = null;
// Latched once we've decided this seed can't run the tracker (e.g. patch-only
// upload with no .archipelago). Prevents the dirty handler from re-emitting
// the same warning on every Connected/ReceivedItems/RoomUpdate.
let trackerUnavailable = false;

async function ensureTrackerInited(): Promise<boolean> {
  if (trackerInited) return true;
  if (trackerUnavailable) return false;
  if (app.session.state !== "live") {
    setTrackerStatus({ kind: "idle" });
    return false;
  }
  if (trackerInitInFlight) return trackerInitInFlight;
  const artifacts = app.artifacts || {};
  const multiName = Object.keys(artifacts).find((n) => n.toLowerCase().endsWith(".archipelago"));
  // Patch-only flow: no cached multidata, fall back to driving UT off the
  // live session ctx (slot_data from Connected). The dirty handler retries
  // on Connected/RoomUpdate, so don't latch unavailable when we're just
  // waiting on the websocket handshake.
  const bytes = multiName ? (artifacts[multiName] as Uint8Array) : null;
  trackerInitInFlight = (async () => {
    try {
      const res = await apWorker.trackerInit(bytes, app.slotName || "");
      if (!res?.out?.ok) {
        if (res?.out?.wait) {
          setTrackerStatus({ kind: "idle" });
          return false;
        }
        const reason = res?.out?.reason || "unknown";
        logWarn("tracker unavailable: " + reason.split("\n")[0]);
        console.error("[ut] tracker init failed:\n" + reason);
        setTrackerStatus({ kind: "error", reason });
        trackerUnavailable = true;
        return false;
      }
      trackerInited = true;
      setTrackerStatus({ kind: "ready" });
      return true;
    } finally { trackerInitInFlight = null; }
  })();
  return trackerInitInFlight;
}

async function refreshTrackerLocations() {
  if (!await ensureTrackerInited()) return;
  // Pull the checked-locations set from the worker's host context if running,
  // otherwise from the live session ctx, otherwise an empty set.
  const checked = await fetchCheckedLocations();
  try {
    const res = await apWorker.trackerUpdate(checked);
    if (res?.out?.ok) {
      setTrackerInLogic(res.out.locations || []);
      setTrackerGoMode(res.out.go || "no");
    }
  } catch (e: any) {
    logWarn("tracker update failed: " + (e?.message || e));
  }
}

// Reads checked-location IDs from whichever Python state is live —
// _host_ctx.location_checks when self-hosting, ctx.checked_locations when
// remote-connected. Empty pre-host / pre-connect.
async function fetchCheckedLocations(): Promise<number[]> {
  try {
    const res = await apWorker.trackerChecks();
    return Array.isArray(res?.out?.checked) ? res.out.checked : [];
  } catch { return []; }
}

let trackerDirtyHandlerInstalled = false;
function installTrackerDirtyHandler() {
  if (trackerDirtyHandlerInstalled) return;
  trackerDirtyHandlerInstalled = true;
  apWorker.setTrackerDirtyHandler(() => { refreshTrackerLocations().catch(() => {}); });
}
export async function ensureTracker() {
  installTrackerDirtyHandler();
  await refreshTrackerLocations();
}
// Kept as a no-op for the existing console-tab onClick caller; tracker is now
// event-driven and has nothing to stop.
export function stopTrackerPolling() {}

export async function disconnectSession() {
  try { await apWorker.stopSession(); } catch {}
  setSessionState("idle", "disconnected");
  trackerInited = false;
  trackerUnavailable = false;
  setTrackerInLogic([]);
  setTrackerGoMode("no");
  setTrackerStatus({ kind: "idle" });
  stopTrackerPolling();
  logOk("session disconnected");
}

// Brand-click teardown: stop the session and reload for a clean slate.
export function teardownAndReload(ev?: Event) {
  if (ev) ev.preventDefault();
  try { apWorker.stopSession(); } catch {}
  window.location.reload();
}
