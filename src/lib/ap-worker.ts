// Pyodide worker (generation + patching + AP session bridge). Lazy-inits on
// first call. Exposes a small command surface; the bizhawk bridge callback
// is registered via setBhHandler.

import { logAnsi, logErr } from "./log.js";
import { latestWorlds, runtimeFor, sameRuntime, type RuntimeConfig } from "./apworld.js";

// Shape of a resolved call response. `out` is command-specific:
//   - "patch":    { byteLength, buffer, ... }  (Uint8Array)
//   - "generate": { artifacts: Record<string, Uint8Array> }
//   - others:     not meaningfully typed here
type CallResult = { ok: boolean; out: any };
type ProgressCb = (phase: string) => void;

let worker: Worker | null = null;
// The world set a runtime is built from is part of the worker's identity:
// Archipelago's registries are keyed by game name, so a booted interpreter
// can't swap a world. `wantedRuntime` is what the next spawn boots (posted as
// the worker's first message, so it can never boot unconfigured — including
// the respawn after a fatal); `workerRuntime` is what the live worker got.
let wantedRuntime: RuntimeConfig = runtimeFor(latestWorlds());
let workerRuntime: RuntimeConfig | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: CallResult) => void; reject: (e: Error) => void; onProgress: ProgressCb | null }>();
let onBhReq: ((reqId: number, payload: string) => void) | null = null;
let onTrackerDirty: (() => void) | null = null;
let onHintsDirty: (() => void) | null = null;
let onHintMsg: ((text: string, kind: string) => void) | null = null;
let onFatal: ((reason: string) => void) | null = null;

// The worker flags `fatal` when Pyodide has latched its dead-runtime state.
// Nothing inside that worker can be recovered, so drop it: terminate, clear the
// singleton (the next call() spawns a fresh worker that re-boots Pyodide), and
// fail every in-flight call rather than leaving them hanging forever. Session,
// host and tracker state all lived in the dead worker — onFatal owns rebuilding
// them. The handler callbacks above are main-thread state and survive untouched.
function killWorker(reason: string) {
  const dead = worker;
  worker = null;
  if (dead) {
    dead.onmessage = null;
    dead.onerror = null;
    dead.terminate();
  }
  const orphans = [...pending.values()];
  pending.clear();
  for (const p of orphans) p.reject(new Error("ap worker restarted after a fatal error"));
  // Defer so the rejections above settle before the handler starts issuing new
  // calls against the respawned worker.
  queueMicrotask(() => onFatal?.(reason));
}

// Would booting `runtime` mean restarting the live worker? Pure: the caller
// decides whether that is acceptable before committing with setRuntime.
function compareRuntime(runtime: RuntimeConfig): { needsRestart: boolean; current: RuntimeConfig | null } {
  return { needsRestart: !!worker && !sameRuntime(workerRuntime, runtime), current: workerRuntime };
}

// Record the world set the next spawn (or respawn after a fatal) boots.
function setRuntime(runtime: RuntimeConfig) { wantedRuntime = runtime; }

// Deliberate restart, used to boot a different apworld version. Unlike
// killWorker this is not a crash — onFatal is not invoked and the caller owns
// whatever main-thread state mirrored the old runtime. The in-worker
// MultiServer and client are asked to stop first so the loopback host's .apsave
// reaches IndexedDB; a hung or still-booting runtime can't hold the restart up
// past the timeout, since terminate() follows either way. The next call()
// spawns a fresh worker configured with wantedRuntime.
const RESTART_GRACE_MS = 3000;
async function restart(): Promise<void> {
  const dead = worker;
  if (!dead) return;
  const graceful = Promise.allSettled([call("host-flush"), call("session-stop"), call("host-stop")]);
  await Promise.race([graceful, new Promise((r) => setTimeout(r, RESTART_GRACE_MS))]);
  // A fatal during the grace period already replaced (or cleared) the worker.
  if (worker !== dead) return;
  worker = null;
  dead.onmessage = null;
  dead.onerror = null;
  dead.terminate();
  const orphans = [...pending.values()];
  pending.clear();
  for (const p of orphans) p.reject(new Error("ap worker restarted to switch apworld version"));
}

function handle(ev: MessageEvent) {
  const { id, event, phase, reqId, payload, ok, error, out, fatal } = ev.data;
  if (event === "progress")      { pending.get(id)?.onProgress?.(phase); return; }
  if (event === "bh-req")        { onBhReq?.(reqId, payload); return; }
  if (event === "py-log") {
    // ap_worker.js is served unhashed from public/, so a cached copy can
    // outlive the bundle by a deploy: accept the old per-line {msg} shape too.
    const msgs: string[] = ev.data.msgs ?? (ev.data.msg !== undefined ? [ev.data.msg] : []);
    for (const msg of msgs) logAnsi("info", msg);
    return;
  }
  if (event === "hint-msg")      { onHintMsg?.(ev.data.text, ev.data.kind); return; }
  if (event === "tracker-dirty") { onTrackerDirty?.(); return; }
  if (event === "hints-dirty")   { onHintsDirty?.(); return; }
  const p = pending.get(id);
  if (p) {
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve({ ok, out });
  }
  if (fatal) killWorker(error || "pyodide fatal error");
}

function spawn(): Worker {
  if (worker) return worker;
  // ap_worker.js is served unhashed from public/, so pin it to this build:
  // the worker and the bundle share a protocol and a tar layout, and a cached
  // worker from the previous deploy would understand neither.
  worker = new Worker(`ap_worker.js?v=${__BUILD_ID__}`);
  worker.onmessage = handle;
  // First message, ahead of any command that could boot Pyodide: the tars this
  // runtime is assembled from. The worker refuses to boot without it.
  workerRuntime = wantedRuntime;
  worker.postMessage({ cmd: "configure", runtime: wantedRuntime });
  // An error event means something escaped the worker's own try/catch — a failed
  // importScripts of the Pyodide CDN bundle, a 404 on the script itself, the
  // browser reaping the worker. No reply is ever coming for the calls in flight,
  // so treat it exactly like a Pyodide fatal: kill, respawn, recover. Without
  // this those calls hang forever and every guard keyed off them (connectInFlight)
  // latches shut.
  worker.onerror = ev => {
    logErr("ap worker error: " + ev.message);
    killWorker(ev.message || "worker error");
  };
  return worker;
}

function call(cmd: string, payload: Record<string, any> = {}, transfer: Transferable[] = [], cb: ProgressCb | null = null): Promise<CallResult> {
  const id = nextId++;
  // pending.set runs synchronously inside the Promise executor, so the entry
  // exists before postMessage — no reply (progress or result) can race ahead of
  // it. Progress events carry this id and route back to cb via pending.get(id).
  //
  // Note: Pyodide boot is memoized in the worker, so its boot-phase progress is
  // stamped with the id of the *first* call to touch the worker. That first call
  // must be one that passes a cb (today: patch/generate, both do) or those boot
  // phases route to a null callback and are silently dropped.
  const p = new Promise<CallResult>((resolve, reject) => pending.set(id, { resolve, reject, onProgress: cb }));
  spawn().postMessage({ id, cmd, ...payload }, transfer);
  return p;
}

function fire(cmd: string, payload: Record<string, any> = {}) { spawn().postMessage({ cmd, ...payload }); }

export const apWorker = {
  init:            (cb?: ProgressCb)                                   => call("init", {}, [], cb ?? null),
  compareRuntime,
  setRuntime,
  restart,
  patch:           (rom: Uint8Array, patch: Uint8Array, overrides?: Record<string, any>, cb?: ProgressCb) => call("patch",    { rom, patch, overrides: overrides ?? {} }, [rom.buffer, patch.buffer], cb ?? null),
  generate:        (yaml: string, cb?: ProgressCb)                     => call("generate", { yaml }, [], cb ?? null),
  ping:            ()                                                  => call("ping"),
  startSession:    (server: string, slot: string, password: string)    => call("session-start", { server, slot, password }),
  stopSession:     ()                                                  => call("session-stop"),
  host:            (seedId: string, multidata: Uint8Array)             => call("host", { seedId, multidata }, [multidata.buffer]),
  hostStop:        ()                                                  => call("host-stop"),
  hostFlush:       ()                                                  => call("host-flush"),
  sendInput:       (text: string)                                      => fire("session-input", { text }),
  sendBhResponse:  (reqId: number, payload: string)                    => fire("bh-res", { reqId, payload }),
  trackerInit:     (multidata: Uint8Array | null, slotName: string)    => call("tracker-init", { multidata: multidata ? multidata.slice() : null, slotName }, [], null),
  trackerUpdate:   (checked: number[])                                 => call("tracker-update", { checked }),
  trackerChecks:   ()                                                  => call("tracker-checks"),
  trackerStop:     ()                                                  => call("tracker-stop"),
  hintsGet:        ()                                                  => call("hints-get"),
  hintItems:       ()                                                  => call("hint-items"),
  setBhHandler:    (fn: typeof onBhReq)                                => { onBhReq = fn; },
  setTrackerDirtyHandler: (fn: typeof onTrackerDirty)                  => { onTrackerDirty = fn; },
  setHintsDirtyHandler:   (fn: typeof onHintsDirty)                    => { onHintsDirty = fn; },
  setHintMsgHandler:      (fn: typeof onHintMsg)                       => { onHintMsg = fn; },
  setFatalHandler:        (fn: typeof onFatal)                         => { onFatal = fn; },
};
