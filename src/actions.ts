// Imperative UI actions: signing in, following the queue, preparing the ROM,
// and running a turn (boot, connect, pause while disconnected, tear down when
// it ends). These mutate the reactive store (state.js) and talk to the
// framework-agnostic lib/ modules.

import { app, setApp, setPageNotice, you, setYou, publicState, setPublicState, setClockOffset, setPlayStatus, setMeLoaded, setLoginUrl, setLiveConnected, setEndedNotice, setConnectOpen, prep, setPrep, romOverridePrefs } from "./state.js";
import { GB_ROM_SIZE, PHASE_LABELS, ROM_STORE, VANILLA_STORE, SAVE_STORE, STATE_STORE, WRAM_BASE, RAM, VANILLA_ROM_HASHES } from "./lib/constants.js";
import { checkPatch } from "./lib/apworld.js";
import { buildOverrides, overridesHash } from "./lib/overrides.js";
import { log, logOk, logErr, logWarn } from "./lib/log.js";
import { db, idbGet, idbPut, idbDel, idbKeys, setDbNoticeHandler } from "./lib/idb.js";
import { apWorker, WorkerRestartedError, type ApState } from "./lib/ap-worker.js";
import { api, ApiError, fetchPatch, openLive } from "./lib/api.js";
import { bindGamepad } from "./lib/gamepad.js";
import { bindController } from "./lib/controller.js";
import { initPlayLayout } from "./lib/layout.js";
import { bootEmulator, type EmulatorHandle } from "./lib/emulator.js";
import { installBizHawkBridge } from "./lib/bizhawk.js";
import type { ServerMessage, YouState, Credentials } from "../shared/protocol.js";

// -----------------------------------------------------------------------------
// step + session chip
// -----------------------------------------------------------------------------
export type Step = "lobby" | "play";

export function setStep(step: Step) {
  setApp("step", step);
  // The session popup only belongs to the play step; clear it on any
  // transition so a lingering open state can't leak onto the lobby.
  if (step !== "play") setConnectOpen(false);
  if (window.__updateEmuMaxH) window.__updateEmuMaxH();
}

export type SessionState = "idle" | "connecting" | "live" | "error";
export function setSessionState(state: SessionState, label?: string) {
  setApp("session", { state, label: label ?? state });
}

// Short-hand for element lookups. Typed as the caller expects.
function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

// IndexedDB upgrade trouble (see idb.ts). Being superseded is permanent for
// this page, so it gets the page-wide notice; a blocked open shows on the ROM
// card, where it would otherwise just hang.
const DB_BLOCKED_MSG = "another tab is still running an older version of this site — close it to finish updating your saved data";
setDbNoticeHandler((notice) => {
  if (notice === "blocked") { logErr(DB_BLOCKED_MSG); setApp("rom", "error", DB_BLOCKED_MSG); }
  else if (notice === "unblocked") { if (app.rom.error === DB_BLOCKED_MSG) setApp("rom", "error", null); }
  else {
    const msg = "this site was updated in another tab — reload this page; it can no longer save";
    logErr(msg);
    setPageNotice(msg);
  }
});

// -----------------------------------------------------------------------------
// startup + server state
// -----------------------------------------------------------------------------
let closeLive: (() => void) | null = null;

export async function startApp() {
  // Everyone gets the live state, signed in or not. While the socket is down
  // the server can't tell us a session ended; the game connection itself is
  // refused if it did.
  closeLive = openLive(onServerMessage, setLiveConnected);

  // Who we are. The server may be mid-restart: keep asking rather than
  // showing a signed-out page to someone who isn't.
  let me;
  for (let delay = 2000; ; delay = Math.min(delay * 2, 30000)) {
    try { me = await api.me(); break; }
    catch (err: any) {
      if (delay === 2000) logErr(`couldn't reach the server: ${err?.message || err} — retrying`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  setLoginUrl(me.loginUrl);
  setMeLoaded(true);
  void noteSavedRom();
  // The live socket may already have said who we are, and more recently.
  if (!liveYouSeen) applyYou(me.you);
  const current = you();
  // Signed out: we can't know whether a turn of ours is still running, so
  // leave any local save alone until we do.
  if (!current) return;
  // Anything a previous session left behind goes, except the session that's
  // still running (a reload mid-turn picks it back up).
  void purgeLocalSessions(current.session?.id ?? null);
}

export async function signOut() {
  markPlaysHere(null);
  try { await api.logout(); } catch {}
  closeLive?.();
  location.reload();
}

// Set once the live socket has said who we are: from then on it's newer than
// anything /api/me answered.
let liveYouSeen = false;

function onServerMessage(msg: ServerMessage) {
  if (msg.type === "public") {
    setClockOffset(msg.now - Date.now());
    // The server moved to another seed under this open page: what was
    // patched for the old one is useless now.
    if (patchCache?.seed && patchCache.seed !== msg.state.seed && !playingId && !prepareInFlight) {
      log("the server is running a new seed — your ROM will be patched again");
      patchCache = null;
      setApp("patchedRom", null);
      if (prep().kind === "ready" || prep().kind === "error") resetPrep();
      void maybePrepare();
    }
    setPublicState(msg.state);
  }
  else if (msg.type === "you") { liveYouSeen = true; applyYou(msg.you); }
  else if (msg.type === "session-ended") {
    if (msg.sessionId === playingId || msg.sessionId === you()?.session?.id) {
      setEndedNotice({ reason: msg.reason, detail: msg.detail });
      if (playingId) void endPlay(`session ended: ${msg.reason}`);
      else forgetEndedTurn();
    }
  }
}

// The session applyYou last started play for.
let autoStarted: string | null = null;

// Which turn this browser plays. Only the browser that started a turn (or
// took it over) joins it on its own; elsewhere the lobby offers to play
// there instead, rather than two devices fighting over the connection.
// The session id lives in localStorage (any tab of this browser may resume
// it after a reload; the play lock keeps that to one). "This tab just clicked
// start" lives in sessionStorage, so of several open tabs only that one
// picks the new turn up.
const PLAYING_KEY = "yogos-playing";
const STARTING_KEY = "yogos-starting";
// "Starting" is this user's, and recent: one left behind by a failed request
// (or another account in this tab) mustn't claim a turn started elsewhere.
const STARTING_FOR_MS = 10 * 60 * 1000;
function startingHere(): boolean {
  try {
    const mark = JSON.parse(sessionStorage.getItem(STARTING_KEY) || "null");
    return !!mark && mark.user === you()?.user.id && Date.now() - mark.at < STARTING_FOR_MS;
  } catch { return false; }
}
// The turn this browser plays, with the device claim it got for it. It only
// resumes by itself while that claim is still the one holding the turn: a
// device the turn moved away from (while its page wasn't running to hear) must
// not take it back on its next load.
function playMark(): { session: string; holder: string | null } | null {
  try { return JSON.parse(localStorage.getItem(PLAYING_KEY) || "null"); }
  catch { return null; }
}
// Unreadable storage counts as not here: the lobby offers to play here, rather
// than every load of such a page taking the turn from wherever it's played.
function playsHere(sessionId: string, currentHolder: string | null): boolean {
  const mark = playMark();
  const mine = !!mark && mark.session === sessionId && (currentHolder === null || mark.holder === currentHolder);
  return mine || startingHere();
}
function markPlaysHere(value: string | null, holder: string | null = null) {
  try {
    sessionStorage.removeItem(STARTING_KEY);
    if (value === "starting") sessionStorage.setItem(STARTING_KEY, JSON.stringify({ user: you()?.user.id, at: Date.now() }));
    else if (value) {
      // Without a new claim, keep the one this browser already has for it.
      const prev = JSON.parse(localStorage.getItem(PLAYING_KEY) || "null");
      const keep = !holder && prev?.session === value ? prev.holder : holder;
      localStorage.setItem(PLAYING_KEY, JSON.stringify({ session: value, holder: keep }));
    }
    else localStorage.removeItem(PLAYING_KEY);
  } catch {}
}

function applyYou(next: YouState | null) {
  const prev = you();
  setYou(next);
  const session = next?.session ?? null;
  // Each session starts playing here once; if that fails (another tab has the
  // game, the ROM wouldn't patch) the lobby offers a retry rather than every
  // later push trying again.
  if (session && session.id !== playingId && session.id !== autoStarted && playsHere(session.id, session.holder)) {
    autoStarted = session.id;
    // Resuming by itself: only while no other device has claimed it since
    // (checked again by the server when this one claims, after booting).
    const mark = playMark();
    void beginPlay(session.id, session.credentials, mark?.session === session.id ? mark.holder ?? null : null);
  } else if (!session && playingId) {
    // The server no longer has a session for us: it ended while we weren't
    // listening (or the session-ended push raced this update).
    void endPlay("session no longer active on the server");
  } else if (!session && prev?.session) {
    // It ended while this tab wasn't playing it (played elsewhere, or play
    // couldn't start here): its ROM and any save here go all the same.
    forgetEndedTurn();
  }
  // The attempt just got used up, or a ban landed: nothing left to prepare.
  if (prev && next && !prev.attemptUsed && next.attemptUsed && !session) resetPrep();
  // In the queue or offered a turn: get the ROM ready (a no-op when it is).
  if (next && (next.inQueue || next.offer)) void maybePrepare();
}

// Whether this user can still play, so preparing a ROM is worth the download.
function canStillPlay(): boolean {
  const y = you();
  return !!y && !y.attemptUsed && !y.banned;
}

// -----------------------------------------------------------------------------
// queue
// -----------------------------------------------------------------------------
export async function joinQueue() {
  try { await api.joinQueue(); }
  catch (err: any) { logErr(err?.message || String(err)); }
}

export async function leaveQueue() {
  try { await api.leaveQueue(); }
  catch (err: any) { logErr(err?.message || String(err)); }
}

// Take the offered turn. The server answers by pushing the session, which
// starts play (applyYou → beginPlay).
export async function startTurn() {
  if (prep().kind !== "ready") { logWarn("your ROM isn't ready yet"); return; }
  markPlaysHere("starting");
  try { await api.startTurn(); }
  catch (err: any) {
    // The server said no: this tab isn't starting anything. A lost reply is
    // different: the session may exist after all, and this tab should still
    // be the one that picks it up, so the marker stays.
    if (err instanceof ApiError) { try { sessionStorage.removeItem(STARTING_KEY); } catch {} }
    logErr(err?.message || String(err));
  }
}

export async function giveUp() {
  // Only a turn that uses all its checks gets to hint.
  const hints = publicState()?.hintsPerTurn ?? 0;
  const warning = hints > 0 ? "\n\nEnding early means you miss the chance to hint locations: only a turn that uses all its checks gets hints." : "";
  if (!confirm(`End your turn now? You won't be able to play again.${warning}`)) return;
  try { await api.giveUp(); }
  catch (err: any) { logErr(err?.message || String(err)); }
}

// -----------------------------------------------------------------------------
// ROM preparation
// -----------------------------------------------------------------------------
// The patch is the same for everyone, so it is fetched once per page.
let patchCache: { name: string; bytes: Uint8Array; seed: string | null } | null = null;
let prepareInFlight: Promise<boolean> | null = null;

export async function handleRomDrop(f: File) {
  setApp("rom", "error", null);
  if (f.size !== GB_ROM_SIZE) {
    const msg = `expected 2,097,152 bytes, got ${f.size.toLocaleString()} — is this the right file?`;
    setApp("rom", "error", msg);
    logErr(msg);
    return;
  }
  let romBuf: Uint8Array;
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
  const dbc = await db();
  if (dbc) await idbPut(dbc, "rom", romBuf.slice().buffer, VANILLA_STORE).catch((err) => logWarn("cache vanilla rom failed: " + err));
  vanillaInMemory = romBuf;
  noVanilla = false;
  // A new ROM replaces anything patched from the old one.
  setApp("patchedRom", null);
  setPrep({ kind: "saved" });
  await maybePrepare();
}

// The vanilla ROM, from this drop or from an earlier visit.
let vanillaInMemory: Uint8Array | null = null;
// This browser has been checked and has no ROM: don't ask IndexedDB again on
// every push. Cleared when one is dropped.
let noVanilla = false;
async function loadVanilla(): Promise<Uint8Array | null> {
  if (vanillaInMemory) return vanillaInMemory;
  if (noVanilla) return null;
  const dbc = await db();
  const cached = dbc ? await idbGet<ArrayBuffer>(dbc, "rom", VANILLA_STORE).catch(() => null) : null;
  if (cached && cached.byteLength === GB_ROM_SIZE) vanillaInMemory = new Uint8Array(cached);
  else if (dbc) noVanilla = true;
  return vanillaInMemory;
}

// Back to the idle ROM state: saved if this browser has a vanilla ROM.
function resetPrep() {
  setPrep(vanillaInMemory ? { kind: "saved" } : { kind: "need-rom" });
}

// Prepare in the background once there's a ROM to do it with. Only for
// players who are queued or offered a turn: a spectator's visit shouldn't
// boot the runtime and patch a ROM nobody will play.
async function maybePrepare() {
  const y = you();
  if (!canStillPlay() || !y || !(y.inQueue || y.offer)) return;
  const kind = prep().kind;
  if (kind !== "need-rom" && kind !== "saved") return;
  if (await loadVanilla()) await prepareRom();
}

// On load: a ROM already in this browser shows as saved rather than asked for.
export async function noteSavedRom() {
  if (prep().kind !== "need-rom") return;
  // Re-checked after the read: a prepare may have started meanwhile.
  if (await loadVanilla() && prep().kind === "need-rom") setPrep({ kind: "saved" });
}

// Boot the runtime, fetch the patch and patch the ROM with the current option
// overrides. Resolves whether a patched ROM is ready.
export function prepareRom(): Promise<boolean> {
  if (!prepareInFlight) {
    prepareInFlight = prepareRomNow().finally(() => { prepareInFlight = null; });
  }
  return prepareInFlight;
}

async function prepareRomNow(): Promise<boolean> {
  const vanilla = await loadVanilla();
  if (!vanilla) { setPrep({ kind: "need-rom" }); return false; }
  const status = (text: string) => setPrep({ kind: "working", text });
  try {
    if (!patchCache) {
      status("downloading the patch…");
      patchCache = await fetchPatch();
      log(`patch: ${patchCache.name}`);
    }
    // This prepare's patch, whatever happens to the cache meanwhile (a seed
    // change drops it).
    const patch = patchCache;
    const check = await checkPatch(patch.bytes);
    if ("reason" in check) throw new Error(check.reason);
    setApp("runningApworld", check.world.display_version);
    log(`apworld: ${check.world.game} ${check.world.display_version}`);

    const overrides = buildOverrides(romOverridePrefs());
    const ovHash = overridesHash(overrides);
    if (Object.keys(overrides).length > 0) log(`applying ${Object.keys(overrides).length} option override(s)`);
    status("starting the patcher…");
    const { out } = await apWorker.patch(vanilla.slice(), patch.bytes.slice(), overrides, (phase) => {
      status(PHASE_LABELS[phase] || phase);
    });
    const patched: Uint8Array = out;
    if (patched.byteLength !== GB_ROM_SIZE) throw new Error(`patched ROM was ${patched.byteLength} bytes, expected ${GB_ROM_SIZE}`);
    setApp("patchedRom", patched.buffer as ArrayBuffer);
    setApp("rom", "error", null);
    setPrep({ kind: "ready", overridesHash: ovHash });
    logOk("ROM patched and ready");
    return true;
  } catch (err: any) {
    const msg = err?.message || String(err);
    setApp("rom", "error", `patch failed: ${msg}`);
    setPrep({ kind: "error", message: msg });
    logErr(`patch failed: ${msg}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// local data
// -----------------------------------------------------------------------------
// Everything stored per session: the patched ROM and the save. Saves exist
// only for their session, so whatever isn't the running one is deleted.
const SESSION_STORES = [ROM_STORE, SAVE_STORE, STATE_STORE];

async function purgeLocalSessions(keep: string | null) {
  const dbc = await db();
  if (!dbc) return;
  for (const store of SESSION_STORES) {
    let keys: IDBValidKey[] = [];
    try { keys = await idbKeys(dbc, store); } catch { continue; }
    for (const k of keys) if (k !== keep) await idbDel(dbc, k, store).catch(() => {});
  }
}

// -----------------------------------------------------------------------------
// play: boot + connect
// -----------------------------------------------------------------------------
let currentEmu: EmulatorHandle | null = null;
// Unbinders for the input and layout wiring each boot installs against its
// emulator, run on dispose so a reboot doesn't leave the old ones driving
// (and pinning) the freed instance.
let emuUiDisposers: (() => void)[] = [];
// The session being played in this tab, from the moment play starts until it
// has been torn down.
let playingId: string | null = null;
let playCredentials: Credentials | null = null;
// Whether the game connection should be up right now. Fatal-crash recovery
// and the connection events check it after each await, so an end that lands
// mid-flight wins.
let sessionWanted = false;
// The latest connection state the worker reported.
let apState: ApState | "none" = "none";

export function disposeEmulator() {
  for (const off of emuUiDisposers) { try { off(); } catch {} }
  emuUiDisposers = [];
  if (!currentEmu) return;
  try { currentEmu.dispose(); } catch {}
  currentEmu = null;
  try { delete (window as any).ap; } catch {}
}

// Called on canvas mount. Under normal flow beginPlay has already booted the
// emulator, so this is a no-op; after HMR remounts <ScreenFrame/> we boot a
// fresh one against the new canvas using the ROM that's still in the store.
export async function ensureEmulator() {
  if (currentEmu || booting) return;
  if (app.step !== "play" || !app.patchedRom || !playingId) return;
  await bootEmulatorNow(playingId);
}

let booting = false;

// Only one tab may play: two would keep replacing each other's connection.
// Held from the start of play until it ends (or the tab closes).
let releasePlayLock: (() => void) | null = null;
function dropPlayLock() {
  releasePlayLock?.();
  releasePlayLock = null;
}
function acquirePlayLock(): Promise<boolean> {
  if (releasePlayLock) return Promise.resolve(true);
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request("yogos-play", { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return; }
      resolve(true);
      return new Promise<void>((release) => { releasePlayLock = release; });
    }).catch(() => resolve(true));
  });
}

// Play couldn't start in this tab: back to the lobby, which offers a retry.
// The session itself runs on.
function abandonPlay(sessionId: string, why: string) {
  logErr(why);
  if (playingId !== sessionId) return;
  playingId = null;
  playCredentials = null;
  setPlayStatus({ sessionId, kind: "failed" });
  dropPlayLock();
  setStep("lobby");
}

// resumeFrom: when resuming by itself, the device claim this browser last had
// for the turn (null if none); left out when the player chose to play here.
async function beginPlay(sessionId: string, credentials: Credentials, resumeFrom?: string | null) {
  if (playingId === sessionId) return;
  playingId = sessionId;
  setPlayStatus({ sessionId, kind: "starting" });
  if (!(await acquirePlayLock())) {
    if (playingId === sessionId) playingId = null;
    setPlayStatus({ sessionId, kind: "other-tab" });
    try { sessionStorage.removeItem(STARTING_KEY); } catch {}
    logWarn("the game is already open in another tab of this browser — play there");
    return;
  }
  // Ended (or replaced) while waiting for the lock.
  if (playingId !== sessionId) { dropPlayLock(); return; }
  playCredentials = credentials;
  setEndedNotice(null);
  markPlaysHere(sessionId);
  logOk("your turn has started");

  // The ROM: from this session's cache (a reload mid-turn), else the one
  // prepared in the lobby, re-patched if the overrides changed since.
  const dbc = await db();
  const cached = dbc ? await idbGet<ArrayBuffer>(dbc, sessionId, ROM_STORE).catch(() => null) : null;
  if (cached && cached.byteLength === GB_ROM_SIZE) {
    setApp("patchedRom", cached);
  } else {
    // Patched with today's overrides? A prepare already running may have
    // started with older ones: wait for it, then look again (twice at most).
    const upToDate = () => {
      const p = prep();
      return p.kind === "ready" && !!app.patchedRom && p.overridesHash === overridesHash(buildOverrides(romOverridePrefs()));
    };
    for (let tries = 0; !upToDate(); tries++) {
      if (tries === 2 || !(await prepareRom())) {
        abandonPlay(sessionId, "couldn't prepare the ROM — your session is still running, try again from the lobby");
        return;
      }
    }
    if (playingId !== sessionId) return;
    if (dbc) {
      await idbPut(dbc, sessionId, app.patchedRom!.slice(0), ROM_STORE).catch((err) => logWarn("cache patched rom failed: " + err));
      // Ended while that was being written: the purge may have run first.
      if (playingId !== sessionId) { await idbDel(dbc, sessionId, ROM_STORE).catch(() => {}); return; }
    }
  }
  if (playingId !== sessionId) return;

  setStep("play");
  await bootEmulatorNow(sessionId);
  if (playingId !== sessionId) return;
  // No game, no connection: connecting would tell the server the player is
  // here (stopping the grace clock) with nothing to play.
  if (!currentEmu) {
    abandonPlay(sessionId, "the game couldn't start — try again from the lobby, or reload the page");
    return;
  }
  // Claim the turn for this device: its game connection carries the claim,
  // and a device the turn was taken from can't take it back.
  let holder: string;
  try { holder = (await api.claimPlay(resumeFrom)).holder; }
  catch (err: any) {
    abandonPlay(sessionId, `couldn't claim the turn for this device: ${err?.message || err}`);
    return;
  }
  if (playingId !== sessionId) return;
  markPlaysHere(sessionId, holder);
  playCredentials = { ...credentials, apUrl: `${credentials.apUrl}&holder=${encodeURIComponent(holder)}` };
  setPlayStatus(null);
  sessionWanted = true;
  await runConnect();
}

async function bootEmulatorNow(sessionId: string) {
  booting = true;
  try {
    disposeEmulator();
    const saveDb = await db();
    const emu = await bootEmulator({
      canvas: $<HTMLCanvasElement>("#screen"),
      romBuf: app.patchedRom!,
      saveDb,
      saveKey: sessionId,
      // Frozen until the game is connected; see onApState.
      startPaused: apState !== "connected",
    });
    if (!emu) return;
    if (playingId !== sessionId) { emu.dispose(); return; }
    currentEmu = emu;
    const { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash } = emu;
    emuUiDisposers.push(
      initPlayLayout(),
      bindGamepad($<HTMLElement>(".gamepad"), { emulator: e, module: Module }),
      bindController({ emulator: e, module: Module }),
    );
    installBizHawkBridge(emu, apWorker);
    // For console poking while developing. Not in production: it would hand
    // players a memory editor for a game whose checks are meant to be earned.
    if (import.meta.env.DEV) window.ap = { e, Module, readMem, writeMem, guardedWrite, readDomain, writeDomain, romHash, RAM, WRAM_BASE };
  } catch (err: any) {
    logErr(`emulator failed to start: ${err?.message || err} — reload the page to try again`);
  } finally {
    booting = false;
  }
}

// True from the moment a connect attempt enters until it settles, so a
// recovery and a first connect can't stack.
let connectInFlight = false;

async function runConnect() {
  if (connectInFlight || !playCredentials) return;
  connectInFlight = true;
  try {
    const { apUrl, slot, gamePassword } = playCredentials;
    setSessionState("connecting", "connecting…");
    log(`connecting to the server as ${slot}`);
    await apWorker.startSession(apUrl, slot, gamePassword);
    if (!sessionWanted) return;
    startHeartbeat();
  } catch (err: any) {
    if (!sessionWanted) return;
    setSessionState("error", "error");
    if (!(err instanceof WorkerRestartedError)) logErr("couldn't start the game connection: " + (err.message || err));
  } finally {
    connectInFlight = false;
  }
}

apWorker.setApStateHandler((state, reason) => {
  if (state === "alive") {
    // The connection answered. Only news while play is held for a network
    // drop that turned out not to have cost the socket.
    if (sessionWanted && apState === "connected" && heldForOffline && navigator.onLine) {
      heldForOffline = false;
      currentEmu?.setPaused(false);
      setSessionState("live", "connected");
    }
    return;
  }
  // A session being wound down may still report in (a reconnect in flight);
  // that's no news about the next one.
  if (!sessionWanted) return;
  apState = state;
  heldForOffline = false;
  if (state === "connected") {
    setSessionState("live", "connected");
    currentEmu?.setPaused(false);
    logOk("connected — play on");
  } else if (state === "closed") {
    setSessionState("connecting", "reconnecting…");
    currentEmu?.setPaused(true);
  } else if (state === "replaced") {
    // The turn is being played in another browser now. Step aside rather
    // than reconnect and take it back; this browser's save stays, in case
    // play comes back here.
    log("your turn was opened somewhere else — the game here has stopped");
    void endPlay("playing elsewhere", { keepSave: true });
  } else if (state === "refused") {
    // Usually our credentials were rotated and the session is over; the
    // server says which (confirmEnded) before we tear anything down.
    currentEmu?.setPaused(true);
    setSessionState("connecting", "checking…");
    log(`the server refused the game connection (${reason || "refused"})`);
    void confirmEnded();
  }
});

// The browser knows the network is gone before any socket does: freeze at
// once, and let the connection events decide when play resumes.
// Play held because the browser went offline: resumed by proof the
// connection still works (an "alive" from the worker's watchdog) or a fresh
// "connected", never by the network merely coming back.
let heldForOffline = false;
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => {
    if (!sessionWanted) return;
    heldForOffline = true;
    currentEmu?.setPaused(true);
    setSessionState("connecting", "offline");
  });
}

// Ask the server whether our session is still running: tear down if not,
// reconnect if it is (the game server refused us while it was restarting).
async function confirmEnded() {
  const id = playingId;
  try {
    const me = await api.me();
    applyYou(me.you);
    if (id && playingId === id && me.you?.session?.id === id) {
      log("the session is still running — reconnecting");
      await new Promise((r) => setTimeout(r, 3000));
      if (sessionWanted && playingId === id) await runConnect();
    }
  } catch { /* the live socket will tell us once it's back */ }
}

// Tear the running session down: stop the client, drop the emulator, delete
// this session's ROM and save, and go back to the lobby.
let endInFlight: Promise<void> | null = null;
// keepSave: the session goes on elsewhere, so this browser's save for it stays.
function endPlay(why: string, opts: { keepSave?: boolean } = {}): Promise<void> {
  if (!endInFlight) endInFlight = endPlayNow(why, opts.keepSave ?? false).finally(() => { endInFlight = null; });
  return endInFlight;
}

async function endPlayNow(why: string, keepSave: boolean) {
  const id = playingId;
  if (!id) return;
  log(why);
  // Nothing more counts: stop the game now, not once the client has wound
  // down.
  currentEmu?.setPaused(true);
  sessionWanted = false;
  playingId = null;
  playCredentials = null;
  apState = "none";
  stopHeartbeat();
  const STOP_WAIT_MS = 5000;
  await Promise.race([apWorker.stopSession().catch(() => {}), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
  // A new play started while that ran (the player took it back here): it
  // owns the emulator, the lock and the step now. Only this play's data goes.
  if (playingId) {
    if (!keepSave) await purgeLocalSessions(playingId);
    return;
  }
  // Dispose first: its final flush writes the save, which the purge then
  // removes (IndexedDB runs the transactions in order).
  disposeEmulator();
  await purgeLocalSessions(keepSave ? id : null);
  setApp("patchedRom", null);
  resetPrep();
  setPlayStatus(null);
  markPlaysHere(null);
  dropPlayLock();
  setSessionState("idle", "offline");
  setStep("lobby");
}

// Start playing a session that's running on the server but not in this tab:
// it's playing in another browser (this takes over from it), or its ROM
// couldn't be prepared the first time.
export function resumeTurn() {
  const s = you()?.session;
  if (s && !playingId) void beginPlay(s.id, s.credentials);
}

// A turn ended that this tab wasn't playing: nothing to tear down but its
// local data (unless another play has started here since).
function forgetEndedTurn() {
  if (playingId) return;
  setPlayStatus(null);
  markPlaysHere(null);
  void purgeLocalSessions(null);
}

// Brand-click teardown: stop the session and reload for a clean slate.
export function teardownAndReload(ev?: Event) {
  if (ev) ev.preventDefault();
  try { apWorker.stopSession(); } catch {}
  window.location.reload();
}

// -----------------------------------------------------------------------------
// heartbeat + fatal python-runtime recovery
// -----------------------------------------------------------------------------
// Nothing else on the main thread calls the worker on a timer, so a runtime
// that dies while no bizhawk request happens to be outstanding would go
// unnoticed until the session's grace period ran out.
const HEARTBEAT_MS = 20000;
let heartbeatTimer: number | null = null;
function stopHeartbeat() {
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}
function startHeartbeat() {
  stopHeartbeat();
  // A failed ping needs no handling here: the worker flags it fatal, which is
  // what kicks off recovery.
  heartbeatTimer = setInterval(() => { apWorker.ping().catch(() => {}); }, HEARTBEAT_MS) as unknown as number;
}

// Pyodide can die outright — OOM, a WASM abort. lib/ap-worker.ts terminates
// and respawns the worker; the client that lived inside it is gone, so start
// a new one. Crashes are budgeted over a rolling window so one that
// reproduces on every connect doesn't reboot Pyodide forever.
const MAX_FATAL_RECOVERIES = 3;
const FATAL_WINDOW_MS = 10 * 60 * 1000;
let fatalTimes: number[] = [];
let recovering = false;

apWorker.setFatalHandler((reason) => {
  const now = Date.now();
  fatalTimes = fatalTimes.filter((t) => now - t < FATAL_WINDOW_MS);
  fatalTimes.push(now);
  logErr("python runtime crashed: " + reason);
  stopHeartbeat();
  apState = "none";
  currentEmu?.setPaused(true);
  if (!sessionWanted || recovering) return;
  if (fatalTimes.length > MAX_FATAL_RECOVERIES) {
    setSessionState("error", "error");
    logErr(`python runtime has crashed ${fatalTimes.length} times in the last ${FATAL_WINDOW_MS / 60000} minutes — reload the page to reconnect`);
    return;
  }
  recovering = true;
  void (async () => {
    try {
      setSessionState("connecting", "restarting…");
      log("restarting the python runtime and reconnecting — this takes as long as the initial boot");
      await apWorker.init((phase) => log(PHASE_LABELS[phase] || phase));
      if (sessionWanted) await runConnect();
    } catch (err: any) {
      setSessionState("error", "error");
      logErr("auto-reconnect failed: " + (err?.message || err));
    } finally {
      recovering = false;
    }
  })();
});
