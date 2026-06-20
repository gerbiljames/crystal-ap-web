// Event log: appends entries to a reactive signal consumed by <LogArea>.
// The API (log / logOk / logErr / logWarn / logLine / logAnsi) is unchanged
// from the vanilla version — callers just push strings; the Solid layer
// renders.

import { setLogLines } from "../state.js";

const LOG_MAX = 500;
const LOG_TRIM_TO = 450;

function timeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
}

function push(kind, content) {
  setLogLines(l => {
    const next = [...l, { kind, time: timeString(), ts: Date.now(), ...content }];
    return next.length > LOG_MAX ? next.slice(next.length - LOG_TRIM_TO) : next;
  });
}

export function logLine(kind, msg) { push(kind, { text: String(msg) }); }
export function logAnsi(kind, msg) { push(kind, { ansi: String(msg) }); }
export const log     = (m) => logLine("info", m);
export const logOk   = (m) => logLine("ok", m);
export const logErr  = (m) => logLine("err", m);
export const logWarn = (m) => logLine("warn", m);
