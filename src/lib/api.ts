// The YOGOS server's HTTP API, and the live socket it pushes queue and session
// state over. Same origin as the page; the session cookie rides along.

import type { MeResponse, ServerMessage, AdminState, CheckpointRow, RollbackResult } from "../../shared/protocol.js";
import { logWarn } from "./log.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(res.status, j.error || `${method} ${path} failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  me:          () => request<MeResponse>("GET", "/api/me"),
  logout:      () => request<void>("POST", "/api/auth/logout"),
  joinQueue:   () => request<void>("POST", "/api/queue/join"),
  leaveQueue:  () => request<void>("POST", "/api/queue/leave"),
  startTurn:   () => request<void>("POST", "/api/session/start"),
  giveUp:      () => request<void>("POST", "/api/session/end"),
  // This device starts playing the turn; returns its claim on it.
  // resumeFrom: the claim this device last had, when resuming by itself.
  claimPlay:   (resumeFrom?: string | null) =>
    request<{ holder: string }>("POST", "/api/session/claim", resumeFrom === undefined ? undefined : { resumeFrom }),
  admin: {
    state:     () => request<AdminState>("GET", "/api/admin/state"),
    action:    (action: string, body: Record<string, unknown> = {}) => request<void>("POST", `/api/admin/${action}`, body),
    checkpoint: (label: string) => request<CheckpointRow>("POST", "/api/admin/checkpoint", { label }),
    rollback:  (checkpointId: string, returnTurns: boolean) =>
      request<RollbackResult>("POST", "/api/admin/rollback", { checkpointId, returnTurns }),
  },
};

// The seed's patch file, as bytes.
// `seed` is which seed it's for, as PublicState.seed names it.
export async function fetchPatch(): Promise<{ name: string; bytes: Uint8Array; seed: string | null }> {
  const res = await fetch("/api/patch", { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, `couldn't download the patch (${res.status})`);
  const disposition = res.headers.get("content-disposition") || "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let name = /filename="([^"]+)"/.exec(disposition)?.[1] || "seed.apcrystal";
  if (encoded) { try { name = decodeURIComponent(encoded); } catch {} }
  return { name, bytes: new Uint8Array(await res.arrayBuffer()), seed: res.headers.get("x-yogos-seed") };
}

// The live socket. Reconnects on its own with a capped backoff; `onMessage`
// sees every push, `onStatus` whether the socket is currently up.
export function openLive(onMessage: (msg: ServerMessage) => void, onStatus: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    const url = new URL("/api/live", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = ws = new WebSocket(url);
    sock.onopen = () => { delay = 1000; onStatus(true); };
    sock.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      onStatus(false);
      if (closed) return;
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
    sock.onerror = () => { /* onclose follows */ };
  };
  connect();

  // Coming back to a tab the browser froze: reconnect now rather than after
  // whatever backoff was pending.
  const onVisible = () => {
    if (document.visibilityState !== "visible" || ws || closed) return;
    if (timer) clearTimeout(timer);
    delay = 1000;
    connect();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    try { ws?.close(); } catch (err) { logWarn(`closing live socket: ${err}`); }
    ws = null;
  };
}
