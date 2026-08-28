// Event log: appends entries to a reactive signal consumed by <LogArea>.
// The API (log / logOk / logErr / logWarn / logLine / logAnsi) is unchanged
// from the vanilla version — callers just push strings; the Solid layer
// renders.
//
// Pushes are coalesced: entries accumulate in a plain queue and are committed
// to the signal once per animation frame. A connected session can emit
// hundreds of lines in a burst (join spam, item sends, !hint output), and
// committing each one individually meant a <For> reconcile, a DOM append and
// a forced-layout scroll per line — enough to stall the emulator's ticker.

import { setLogLines, type LogEntry } from "../state.js";

const LOG_MAX = 500;
const LOG_TRIM_TO = 450;

// Ceiling on how long a line can sit in the queue before it's committed.
// requestAnimationFrame doesn't fire in background tabs, so the timer keeps
// the log moving (and keeps the queue bounded) while the tab is hidden.
const FLUSH_FALLBACK_MS = 100;

function timeString() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
}

let queue: LogEntry[] = [];
let rafId: number | null = null;
let timerId: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (rafId !== null)   { cancelAnimationFrame(rafId); rafId = null; }
  if (timerId !== null) { clearTimeout(timerId); timerId = null; }
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  setLogLines(l => {
    // Trim from the combined tail so a burst larger than the buffer still
    // leaves the newest LOG_TRIM_TO lines rather than an overfull array.
    const next = l.concat(batch);
    return next.length > LOG_MAX ? next.slice(next.length - LOG_TRIM_TO) : next;
  });
}

function schedule() {
  // The timer is always armed alongside the frame, so it alone marks "pending".
  if (timerId !== null) return;
  if (!document.hidden) rafId = requestAnimationFrame(flush);
  timerId = setTimeout(flush, FLUSH_FALLBACK_MS);
}

function push(kind: string, content: { text?: string; ansi?: string }) {
  queue.push({ kind, time: timeString(), ts: Date.now(), ...content });
  schedule();
}

export function logLine(kind: string, msg: unknown) { push(kind, { text: String(msg) }); }
export function logAnsi(kind: string, msg: unknown) { push(kind, { ansi: String(msg) }); }
export const log     = (m: unknown) => logLine("info", m);
export const logOk   = (m: unknown) => logLine("ok", m);
export const logErr  = (m: unknown) => logLine("err", m);
export const logWarn = (m: unknown) => logLine("warn", m);
