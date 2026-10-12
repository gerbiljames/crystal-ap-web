// Pyodide worker (patching + AP session bridge). Lazy-inits on first call.
// Exposes a small command surface; the bizhawk bridge callback is registered
// via setBhHandler.

import { logAnsi, logErr } from "./log.js";
import { setPageNotice } from "../state.js";
import { bundledRuntime, type RuntimeConfig } from "./apworld.js";

// Shape of a resolved call response. `out` is command-specific:
//   - "patch":    { byteLength, buffer, ... }  (Uint8Array)
//   - others:     not meaningfully typed here
type CallResult = { ok: boolean; out: any };
type ProgressCb = (phase: string) => void;

let worker: Worker | null = null;
// The bundled world set every worker boots (posted as its first message, so
// it can never boot unconfigured, including the respawn after a fatal).
const runtime: RuntimeConfig = bundledRuntime();
let nextId = 1;
// Whether the live worker has posted anything yet. An error before its first
// message usually means the script itself failed to load.
let heardFromWorker = false;
// Set once the pinned worker script turns out to be gone from the server: this
// page is from an older deploy and can't get a worker that matches it.
let outdatedPage = false;
const OUTDATED_PAGE_MSG = "this page is out of date — the site was updated since it was opened. Reload the page to continue.";
const pending = new Map<number, { cmd: string; resolve: (v: CallResult) => void; reject: (e: Error) => void; onProgress: ProgressCb | null }>();
// The game client's server connection, as the worker's session reports it.
export type ApState = "connected" | "alive" | "closed" | "refused" | "replaced";
let onBhReq: ((reqId: number, payload: string) => void) | null = null;
let onApState: ((state: ApState, reason?: string) => void) | null = null;
let onFatal: ((reason: string) => void) | null = null;

// The worker flags `fatal` when Pyodide has latched its dead-runtime state.
// Nothing inside that worker can be recovered, so drop it: terminate, clear the
// singleton (the next call() spawns a fresh worker that re-boots Pyodide), and
// fail every in-flight call rather than leaving them hanging forever. The
// session lived in the dead worker — onFatal owns rebuilding it. The handler callbacks above are main-thread state and survive untouched.
// What in-flight calls reject with when a fatal takes the worker down and
// recovery is about to take over, so callers can leave that to recovery.
export class WorkerRestartedError extends Error {}

function killWorker(reason: string, recover = true) {
  const dead = worker;
  worker = null;
  if (dead) {
    dead.onmessage = null;
    dead.onerror = null;
    dead.terminate();
  }
  const orphans = [...pending.values()];
  pending.clear();
  const err = recover ? new WorkerRestartedError("ap worker restarted after a fatal error") : new Error(reason);
  for (const p of orphans) p.reject(err);
  if (!recover) return;
  // Defer so the rejections above settle before the handler starts issuing new
  // calls against the respawned worker.
  queueMicrotask(() => onFatal?.(reason));
}

function handle(ev: MessageEvent) {
  heardFromWorker = true;
  const { id, event, phase, reqId, payload, ok, error, out, fatal } = ev.data;
  if (event === "progress")      { pending.get(id)?.onProgress?.(phase); return; }
  if (event === "bh-req")        { onBhReq?.(reqId, payload); return; }
  if (event === "py-log") {
    // Accept the old per-line {msg} shape too, from workers that predate
    // per-build pinning.
    const msgs: string[] = ev.data.msgs ?? (ev.data.msg !== undefined ? [ev.data.msg] : []);
    for (const msg of msgs) logAnsi("info", msg);
    return;
  }
  if (event === "ap-state")      { onApState?.(ev.data.state, ev.data.reason); return; }
  const p = pending.get(id);
  if (p) {
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve({ ok, out });
  }
  if (fatal) killWorker(error || "pyodide fatal error");
}

// In a build the worker is emitted under a per-build name (vite.config.js) so
// the bundle only ever talks to the worker it was built with. Dev serves the
// live public/ap_worker.js.
const WORKER_URL = import.meta.env.DEV ? "ap_worker.js" : `ap_worker.${__BUILD_ID__}.js`;

// Tar paths as the worker should fetch them: with their content hash, so a
// cached copy of different content under the same name is never used.
const TAR_HASHES: Record<string, string> = __AP_TAR_HASHES__;
function withTarHashes(runtime: RuntimeConfig): RuntimeConfig {
  const q = (tar: string) => (TAR_HASHES[tar] ? `${tar}?h=${TAR_HASHES[tar]}` : tar);
  return { coreTar: q(runtime.coreTar), worlds: runtime.worlds.map((w) => ({ ...w, tar: q(w.tar) })) };
}

async function workerScriptMissing(): Promise<boolean> {
  // Bounded: every in-flight call waits on this answer.
  try { return (await fetch(WORKER_URL, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(5000) })).status === 404; }
  catch { return false; }
}

function spawn(): Worker {
  if (worker) return worker;
  if (outdatedPage) throw new Error(OUTDATED_PAGE_MSG);
  const w = worker = new Worker(WORKER_URL);
  heardFromWorker = false;
  w.onmessage = handle;
  // First message, ahead of any command that could boot Pyodide: the tars this
  // runtime is assembled from. The worker refuses to boot without it.
  w.postMessage({ cmd: "configure", runtime: withTarHashes(runtime) });
  // An error event means something escaped the worker's own try/catch — a failed
  // importScripts of the Pyodide CDN bundle, a 404 on the script itself, the
  // browser reaping the worker. No reply is ever coming for the calls in flight,
  // so treat it exactly like a Pyodide fatal: kill, respawn, recover. Without
  // this those calls hang forever and every guard keyed off them (connectInFlight)
  // latches shut.
  w.onerror = ev => {
    if (heardFromWorker) {
      logErr("ap worker error: " + ev.message);
      killWorker(ev.message || "worker error");
      return;
    }
    // Nothing heard yet, so the script may not have loaded at all. If it is
    // gone from the server this page predates a deploy: respawning would only
    // 404 again, so fail everything with a reload prompt instead.
    void workerScriptMissing().then((missing) => {
      if (worker !== w) return;
      if (missing) {
        outdatedPage = true;
        logErr(OUTDATED_PAGE_MSG);
        setPageNotice(OUTDATED_PAGE_MSG);
        killWorker(OUTDATED_PAGE_MSG, false);
      } else {
        logErr("ap worker error: " + (ev.message || "failed to start"));
        killWorker(ev.message || "worker error");
      }
    });
  };
  return w;
}

function call(cmd: string, payload: Record<string, any> = {}, transfer: Transferable[] = [], cb: ProgressCb | null = null): Promise<CallResult> {
  if (outdatedPage) return Promise.reject(new Error(OUTDATED_PAGE_MSG));
  const id = nextId++;
  // pending.set runs synchronously inside the Promise executor, so the entry
  // exists before postMessage — no reply (progress or result) can race ahead of
  // it. Progress events carry this id and route back to cb via pending.get(id).
  //
  // Note: Pyodide boot is memoized in the worker, so its boot-phase progress is
  // stamped with the id of the *first* call to touch the worker. That first call
  // must be one that passes a cb (today: init and patch do) or those boot
  // phases route to a null callback and are silently dropped.
  const p = new Promise<CallResult>((resolve, reject) => pending.set(id, { cmd, resolve, reject, onProgress: cb }));
  spawn().postMessage({ id, cmd, ...payload }, transfer);
  return p;
}

// A ping only goes unanswered while synchronous Python holds the worker. A
// real command can do that for a while (tracker init), so with one in flight
// a late ping is given PING_BUSY_TIMEOUT_MS instead of PING_TIMEOUT_MS; past
// either, the runtime is stuck in a loop it won't leave. Recover as from a
// fatal: without this, a hung runtime never fails a call and nothing ever
// notices. Pings are only sent during a live session.
const PING_TIMEOUT_MS = 60000;
const PING_BUSY_TIMEOUT_MS = 5 * 60000;
function ping(): Promise<CallResult> {
  const p = call("ping");
  const w = worker;
  const sent = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  const check = () => {
    if (worker !== w) return;
    const busy = [...pending.values()].some((c) => c.cmd !== "ping");
    const waited = performance.now() - sent;
    if (busy && waited < PING_BUSY_TIMEOUT_MS) { timer = setTimeout(check, PING_BUSY_TIMEOUT_MS - waited); return; }
    logErr("python runtime stopped responding — restarting it");
    killWorker("python runtime stopped responding");
  };
  timer = setTimeout(check, PING_TIMEOUT_MS);
  p.finally(() => clearTimeout(timer)).catch(() => {});
  return p;
}

function fire(cmd: string, payload: Record<string, any> = {}) { if (!outdatedPage) spawn().postMessage({ cmd, ...payload }); }

export const apWorker = {
  init:            (cb?: ProgressCb)                                   => call("init", {}, [], cb ?? null),
  patch:           (rom: Uint8Array, patch: Uint8Array, overrides?: Record<string, any>, cb?: ProgressCb) => call("patch",    { rom, patch, overrides: overrides ?? {} }, [rom.buffer, patch.buffer], cb ?? null),
  ping,
  startSession:    (server: string, slot: string, password: string)    => call("session-start", { server, slot, password }),
  stopSession:     ()                                                  => call("session-stop"),
  sendBhResponse:  (reqId: number, payload: string)                    => fire("bh-res", { reqId, payload }),
  setBhHandler:    (fn: typeof onBhReq)                                => { onBhReq = fn; },
  setApStateHandler: (fn: typeof onApState)                            => { onApState = fn; },
  setFatalHandler:   (fn: typeof onFatal)                              => { onFatal = fn; },
};
