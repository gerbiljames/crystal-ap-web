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
const pending = new Map<number, { resolve: (v: CallResult) => void; reject: (e: Error) => void }>();
let onProgress: ProgressCb | null = null;
let onBhReq: ((reqId: number, payload: string) => void) | null = null;
let onPrint: ((text: string) => void) | null = null;

function handle(ev: MessageEvent) {
  const { id, event, phase, reqId, payload, ok, error, out } = ev.data;
  if (event === "progress")  { onProgress?.(phase); return; }
  if (event === "bh-req")    { onBhReq?.(reqId, payload); return; }
  if (event === "printjson") { onPrint?.(ev.data.text); return; }
  if (event === "py-log")    { logAnsi("info", ev.data.msg); return; }
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
  onProgress = cb;
  const id = nextId++;
  spawn().postMessage({ id, cmd, ...payload }, transfer);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function fire(cmd: string, payload: Record<string, any> = {}) { spawn().postMessage({ cmd, ...payload }); }

export const apWorker = {
  init:            (cb?: ProgressCb)                                   => call("init", {}, [], cb ?? null),
  patch:           (rom: Uint8Array, patch: Uint8Array, cb?: ProgressCb) => call("patch",    { rom, patch }, [rom.buffer, patch.buffer], cb ?? null),
  generate:        (yaml: string, cb?: ProgressCb)                     => call("generate", { yaml }, [], cb ?? null),
  startSession:    (server: string, slot: string, password: string)    => call("session-start", { server, slot, password }),
  stopSession:     ()                                                  => call("session-stop"),
  sendBhResponse:  (reqId: number, payload: string)                    => fire("bh-res", { reqId, payload }),
  setBhHandler:    (fn: typeof onBhReq)                                => { onBhReq = fn; },
  setPrintHandler: (fn: typeof onPrint)                                => { onPrint = fn; },
};
