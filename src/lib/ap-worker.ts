// Pyodide worker (generation + patching + AP session bridge). Lazy-inits on
// first call. Exposes a small command surface; internal bizhawk/printjson
// callbacks are registered via setBhHandler / setPrintHandler.

import { logAnsi, logErr } from "./log.js";

// Shape of a resolved call response. `out` is command-specific:
//   - "patch":    { byteLength, buffer, ... }  (Uint8Array)
//   - "generate": { artifacts: Record<string, Uint8Array> }
//   - others:     not meaningfully typed here
type CallResult = { ok: boolean; out: any };
type ProgressCb = (phase: string) => void;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: CallResult) => void; reject: (e: Error) => void; onProgress: ProgressCb | null }>();
let onBhReq: ((reqId: number, payload: string) => void) | null = null;
let onPrint: ((text: string) => void) | null = null;
let onTrackerDirty: (() => void) | null = null;
let onHintsDirty: (() => void) | null = null;
let onHintMsg: ((text: string, kind: string) => void) | null = null;

function handle(ev: MessageEvent) {
  const { id, event, phase, reqId, payload, ok, error, out } = ev.data;
  if (event === "progress")      { pending.get(id)?.onProgress?.(phase); return; }
  if (event === "bh-req")        { onBhReq?.(reqId, payload); return; }
  if (event === "printjson")     { onPrint?.(ev.data.text); return; }
  if (event === "py-log")        { logAnsi("info", ev.data.msg); return; }
  if (event === "hint-msg")      { onHintMsg?.(ev.data.text, ev.data.kind); return; }
  if (event === "tracker-dirty") { onTrackerDirty?.(); return; }
  if (event === "hints-dirty")   { onHintsDirty?.(); return; }
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) p.reject(new Error(error));
  else p.resolve({ ok, out });
}

function spawn(): Worker {
  if (worker) return worker;
  worker = new Worker("ap_worker.js");
  worker.onmessage = handle;
  worker.onerror = ev => logErr("ap worker error: " + ev.message);
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
  patch:           (rom: Uint8Array, patch: Uint8Array, overrides?: Record<string, any>, cb?: ProgressCb) => call("patch",    { rom, patch, overrides: overrides ?? {} }, [rom.buffer, patch.buffer], cb ?? null),
  generate:        (yaml: string, cb?: ProgressCb)                     => call("generate", { yaml }, [], cb ?? null),
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
  setPrintHandler: (fn: typeof onPrint)                                => { onPrint = fn; },
  setTrackerDirtyHandler: (fn: typeof onTrackerDirty)                  => { onTrackerDirty = fn; },
  setHintsDirtyHandler:   (fn: typeof onHintsDirty)                    => { onHintsDirty = fn; },
  setHintMsgHandler:      (fn: typeof onHintMsg)                       => { onHintMsg = fn; },
};
