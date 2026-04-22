// Pyodide worker (generation + patching + AP session bridge). Lazy-inits on
// first call. Exposes a small command surface; internal bizhawk/printjson
// callbacks are registered via setBhHandler / setPrintHandler.

import { logAnsi, logErr } from "./log.js";

let worker = null;
let nextId = 1;
const pending = new Map();
let onProgress = null;
let onBhReq    = null;
let onPrint    = null;

function handle(ev) {
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

function spawn() {
  if (worker) return worker;
  worker = new Worker("ap_worker.js");
  worker.onmessage = handle;
  worker.onerror = ev => logErr("ap worker error: " + ev.message);
  return worker;
}

function call(cmd, payload = {}, transfer = [], cb = null) {
  onProgress = cb;
  const id = nextId++;
  spawn().postMessage({ id, cmd, ...payload }, transfer);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function fire(cmd, payload = {}) { spawn().postMessage({ cmd, ...payload }); }

export const apWorker = {
  init:            (cb)                     => call("init", {}, [], cb),
  patch:           (rom, patch, cb)         => call("patch",    { rom, patch }, [rom.buffer, patch.buffer], cb),
  generate:        (yaml, cb)               => call("generate", { yaml }, [], cb),
  startSession:    (server, slot, password) => call("session-start", { server, slot, password }),
  stopSession:     ()                       => call("session-stop"),
  sendBhResponse:  (reqId, payload)         => fire("bh-res", { reqId, payload }),
  setBhHandler:    (fn)                     => { onBhReq = fn; },
  setPrintHandler: (fn)                     => { onPrint = fn; },
};
