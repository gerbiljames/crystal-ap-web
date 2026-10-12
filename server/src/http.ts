// The HTTP server: the built site, the /api routes, and the two WebSocket
// endpoints (the live state socket at /api/live, and the Archipelago proxy on
// every other path, so PopTracker can connect to the bare host:port).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Duplex } from "node:stream";
import { extname, join, normalize, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Seed } from "./seed.ts";
import { Game, HttpError } from "./game.ts";
import { handleApClient } from "./proxy.ts";
import { AuthError, beginLogin, clearSessionCookie, clearStateCookie, completeLogin, sessionCookie, userIdFrom } from "./auth.ts";
import type { MeResponse } from "../../shared/protocol.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".tar": "application/x-tar",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export type HttpDeps = {
  config: Config;
  db: Db;
  seed: Seed;
  game: Game;
  multiServerUrl: () => string;
  log: (line: string) => void;
  // The Crystal world's sign names (see loadSignNames).
  signs: ReadonlySet<string>;
};

export function startHttp(deps: HttpDeps) {
  const { config, db, game, log } = deps;
  // The patch every player downloads, as one buffer for every response.
  const p = deps.seed.patchBytes;
  const patchBuffer = Buffer.from(p.buffer, p.byteOffset, p.byteLength);

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const noContent = (res: ServerResponse) => { res.writeHead(204, { "cache-control": "no-store" }); res.end(); };

  // State-changing requests must come from our own pages.
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return !origin || origin === config.publicUrl.origin || (config.devLogin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin));
  };

  const signedIn = (req: IncomingMessage): string => {
    const id = userIdFrom(config, req);
    if (!id || !db.user(id)) throw new HttpError(401, "sign in first");
    return id;
  };
  const admin = (req: IncomingMessage): string => {
    const id = signedIn(req);
    if (!config.admins.has(id)) throw new HttpError(403, "admins only");
    return id;
  };

  // Checkpoints and rollbacks fail for reasons an admin can act on (the game
  // server didn't save, didn't come back): say what happened.
  const adminTask = async <T>(task: Promise<T>): Promise<T> => {
    try { return await task; }
    catch (err) {
      if (err instanceof HttpError) throw err;
      log(`admin task failed: ${(err as Error)?.stack || err}`);
      throw new HttpError(500, (err as Error)?.message || String(err));
    }
  };

  const readBody = (req: IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      // Stop collecting but keep the connection, so the 413 gets through.
      if (size > 64 * 1024) { req.removeAllListeners("data"); req.resume(); reject(new HttpError(413, "request too big")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new HttpError(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });

  const userIdArg = (body: any): string => {
    if (typeof body?.userId !== "string" || !body.userId) throw new HttpError(400, "userId is required");
    if (!db.user(body.userId)) throw new HttpError(404, "no such user");
    return body.userId;
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const route = `${req.method} ${url.pathname}`;
    if (req.method === "POST" && !sameOrigin(req)) throw new HttpError(403, "cross-origin request refused");

    switch (route) {
      case "GET /api/health":
        return json(res, 200, { ok: true, serverReady: game.serverReady });

      case "GET /api/me": {
        const id = userIdFrom(config, req);
        const body: MeResponse = { you: id ? game.youFor(id) : null, loginUrl: "/api/auth/login" };
        return json(res, 200, body);
      }

      case "GET /api/auth/login": {
        if (!config.discord.clientId) throw new HttpError(503, "Discord sign-in isn't configured");
        const { location, setCookie } = beginLogin(config);
        res.writeHead(302, { location, "set-cookie": setCookie, "cache-control": "no-store" });
        return res.end();
      }

      case "GET /api/auth/callback": {
        try {
          const user = await completeLogin(config, req, url.searchParams);
          db.upsertUser(user);
          game.userChanged();
          log(`${user.name} (${user.id}) signed in`);
          res.writeHead(302, { location: "/", "set-cookie": [sessionCookie(config, user.id), clearStateCookie(config)], "cache-control": "no-store" });
          return res.end();
        } catch (err) {
          const msg = err instanceof AuthError ? err.message : "sign-in failed";
          if (!(err instanceof AuthError)) log(`sign-in failed: ${err}`);
          res.writeHead(400, { "content-type": "text/html; charset=utf-8", "set-cookie": clearStateCookie(config) });
          return res.end(`<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>${escapeHtml(msg)}</p><p><a href="/">Back</a></p>`);
        }
      }

      case "GET /api/auth/dev": {
        // Local testing without a Discord app: sign in as any name.
        if (!config.devLogin) throw new HttpError(404, "not found");
        const name = (url.searchParams.get("name") || "tester").slice(0, 32);
        const id = `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        db.upsertUser({ id, name, avatar: null });
        res.writeHead(302, { location: "/", "set-cookie": sessionCookie(config, id), "cache-control": "no-store" });
        return res.end();
      }

      case "POST /api/auth/logout":
        res.writeHead(204, { "set-cookie": clearSessionCookie(config), "cache-control": "no-store" });
        return res.end();

      case "GET /api/patch": {
        if (db.user(signedIn(req))?.banned) throw new HttpError(403, "you can't take part in this event");
        res.writeHead(200, {
          // Which seed this patch is for (as PublicState.seed names it).
          "x-yogos-seed": deps.seed.hash.slice(0, 16),
          "content-type": "application/octet-stream",
          // ASCII fallback plus the real (possibly non-Latin) slot name.
          "content-disposition": `attachment; filename="${deps.seed.patchName.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${rfc5987(deps.seed.patchName)}`,
          "cache-control": "private, no-cache",
        });
        return res.end(patchBuffer);
      }

      case "POST /api/queue/join": game.join(signedIn(req)); return noContent(res);
      case "POST /api/queue/leave": game.leave(signedIn(req)); return noContent(res);
      case "POST /api/session/start": game.start(signedIn(req)); return noContent(res);
      case "POST /api/session/end": game.giveUp(signedIn(req)); return noContent(res);
      case "POST /api/session/claim": {
        const userId = signedIn(req);
        const from = (await readBody(req))?.resumeFrom;
        if (from !== undefined && from !== null && typeof from !== "string") throw new HttpError(400, "resumeFrom: a claim or null");
        return json(res, 200, { holder: game.claimPlay(userId, from) });
      }

      case "GET /api/admin/state": admin(req); return json(res, 200, game.adminState());
      case "POST /api/admin/pause": admin(req); game.setPaused(true); return noContent(res);
      case "POST /api/admin/resume": admin(req); game.setPaused(false); return noContent(res);
      case "POST /api/admin/skip": admin(req); game.skipOffer(userIdArg(await readBody(req))); return noContent(res);
      case "POST /api/admin/end-session": {
        const who = admin(req);
        const body = await readBody(req);
        if (typeof body?.sessionId !== "string") throw new HttpError(400, "sessionId is required");
        game.endSession(body.sessionId, `ended by ${db.user(who)?.name ?? who}`);
        return noContent(res);
      }
      case "POST /api/admin/dequeue": admin(req); game.leave(userIdArg(await readBody(req))); return noContent(res);
      case "POST /api/admin/reset-user": admin(req); game.resetUser(userIdArg(await readBody(req))); return noContent(res);
      case "POST /api/admin/ban": {
        const who = admin(req);
        const target = userIdArg(await readBody(req));
        if (target === who) throw new HttpError(400, "you can't ban yourself");
        game.setBanned(target, true);
        return noContent(res);
      }
      case "POST /api/admin/unban": admin(req); game.setBanned(userIdArg(await readBody(req)), false); return noContent(res);
      case "POST /api/admin/checkpoint": {
        const who = admin(req);
        const label = (await readBody(req))?.label;
        if (label !== undefined && label !== null && typeof label !== "string") throw new HttpError(400, "label: text or nothing");
        const text = (label ?? "").trim().slice(0, 80) || `taken by ${db.user(who)?.name ?? who}`;
        return json(res, 200, await adminTask(game.checkpoint(text, "manual", null)));
      }
      case "POST /api/admin/rollback": {
        const who = admin(req);
        const body = await readBody(req);
        if (typeof body?.checkpointId !== "string") throw new HttpError(400, "checkpointId is required");
        if (typeof body?.returnTurns !== "boolean") throw new HttpError(400, "returnTurns: true or false");
        return json(res, 200, await adminTask(game.rollback(body.checkpointId, body.returnTurns, db.user(who)?.name ?? who)));
      }
    }
    throw new HttpError(404, "not found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!config.staticDir) { res.writeHead(404); return res.end("no site configured (STATIC_DIR)"); }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (rel.endsWith("/")) rel += "index.html";
    const path = normalize(join(config.staticDir, rel));
    if (!path.startsWith(config.staticDir + sep)) { res.writeHead(403); return res.end(); }
    let file = path;
    if (!(await stat(path).then((st) => st.isFile(), () => false))) {
      // Pages fall back to the app; files that don't exist are 404s. The page
      // relies on that to notice it's older than the deploy (a worker script
      // or bundle tar it names is gone).
      if (extname(rel)) { res.writeHead(404, { "cache-control": "no-store" }); return res.end("not found"); }
      file = join(config.staticDir, "index.html");
    }
    const isIndex = file.endsWith(`${sep}index.html`);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      // The page names everything else by build or content hash.
      "cache-control": isIndex ? "no-cache" : rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file)
      .on("error", (err) => { log(`reading ${file}: ${err.message}`); res.destroy(); })
      .pipe(res);
  }

  const server = createServer(async (req, res) => {
    const url = parseTarget(req.url);
    if (!url) { res.writeHead(400); res.end(); return; }
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      log(`error handling ${req.method} ${url.pathname}: ${(err as Error)?.stack || err}`);
      json(res, 500, { error: "internal error" });
    }
  });

  const liveWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const apWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: true });

  // Connections that haven't logged in yet. They cost MultiServer nothing,
  // but they're bounded, per address and overall. At either limit the oldest
  // waiting connection gives way, rather than the new one being turned away:
  // idle sockets mustn't be able to keep the real player's PopTracker out.
  // Logged-in connections aren't counted; there are only ever a couple,
  // belonging to the turn in progress. Waiting costs us little (no
  // MultiServer connection until a login is accepted), so the pool is large
  // and each address's share small (an IPv6 /48 counts as one address: one
  // host can have that many). When the whole pool is full, the address with
  // the most waiting gives way first, so a newcomer with fewer always gets
  // in: keeping the player out takes more addresses than the pool has room.
  const MAX_WAITING_PER_ADDRESS = 4;
  const MAX_WAITING = 1024;
  // Only a connection that has had this long to log in can be pushed out (a
  // real client logs in within a second): a flood of new sockets can't evict
  // a player's reconnect before it gets its login in.
  const EVICTABLE_AFTER_MS = 5000;
  const waitingSince = new WeakMap<WebSocket, number>();
  const addressOf = new WeakMap<WebSocket, string>();
  const waiting = new Set<WebSocket>();
  const waitingByAddress = new Map<string, Set<WebSocket>>();
  const MAX_JOIN_SOCKETS = 4;
  let joinSockets = 0;
  const stopWaiting = (ws: WebSocket, remote: string) => {
    waiting.delete(ws);
    const mine = waitingByAddress.get(remote);
    if (!mine) return;
    mine.delete(ws);
    if (!mine.size) waitingByAddress.delete(remote);
  };

  // Live sockets. Signed-in users get a few each (tabs, devices), never
  // counted against anyone else: a queued player without one is dropped from
  // the queue, so strangers mustn't be able to crowd them out. Signed-out
  // viewers share plenty per address (a venue, a carrier NAT) and a ceiling
  // overall, since each gets every broadcast.
  const MAX_LIVE_PER_USER = 16;
  const MAX_ANON_PER_ADDRESS = 128;
  const MAX_ANON = 2000;
  const anonPerAddress = new Map<string, number>();
  // Signed-in users' live upgrades still mid-handshake (the game counts them
  // once they're open).
  const upgradingFor = new Map<string, number>();
  let anonTotal = 0;
  const bump = (m: Map<string, number>, k: string, by: number) => {
    const n = (m.get(k) ?? 0) + by;
    if (n > 0) m.set(k, n); else m.delete(k);
  };

  server.on("upgrade", (req, socket, head) => {
    // A throw here would be uncaught (it's an event listener): turn the
    // request away instead.
    try { upgrade(req, socket, head); }
    catch (err) {
      log(`error handling an upgrade: ${(err as Error)?.stack || err}`);
      socket.destroy();
    }
  });

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => { /* a reset mid-handshake mustn't throw */ });
    const url = parseTarget(req.url);
    if (!url) { socket.destroy(); return; }
    if (url.pathname === "/api/live") {
      if (!sameOrigin(req)) { socket.destroy(); return; }
      const source = addressGroup(clientAddress(req, config.trustProxy));
      const id = userIdFrom(config, req);
      const userId = id && db.user(id) ? id : null;
      const full = userId ? game.liveSocketsOf(userId) + (upgradingFor.get(userId) ?? 0) >= MAX_LIVE_PER_USER
        : (anonPerAddress.get(source) ?? 0) >= MAX_ANON_PER_ADDRESS || anonTotal >= MAX_ANON;
      if (full) { rejectUpgrade(socket); return; }
      // Counted from now, not once the handshake is done, so a burst of
      // upgrades can't all slip under the cap together.
      if (userId) {
        bump(upgradingFor, userId, 1);
        let counted = true;
        const settle = () => { if (counted) { counted = false; bump(upgradingFor, userId, -1); } };
        socket.once("close", settle);
        liveWss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("error", () => { /* a bad frame closes the socket; it mustn't throw */ });
          settle();
          game.addLive(ws, userId);
        });
      } else {
        anonTotal++;
        bump(anonPerAddress, source, 1);
        socket.once("close", () => { anonTotal--; bump(anonPerAddress, source, -1); });
        liveWss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("error", () => { /* a bad frame closes the socket; it mustn't throw */ });
          game.addLive(ws, null);
        });
      }
      return;
    }
    // Anything else is the Archipelago endpoint: "/archipelago" from the
    // browser, the bare host from PopTracker.
    const remote = clientAddress(req, config.trustProxy);
    // The running turn's game (its join token) never waits in the pool,
    // though even it only gets a few at once (a reconnect overlapping an old
    // socket is the most it needs).
    if (game.isJoinToken(url.searchParams.get("join"))) {
      if (joinSockets >= MAX_JOIN_SOCKETS) {
        rejectUpgrade(socket);
        return;
      }
      joinSockets++;
      socket.once("close", () => { joinSockets--; });
      apWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => { /* a bad frame closes the socket; it mustn't throw */ });
        handleApClient(ws, { game, upstreamUrl: deps.multiServerUrl, log, remote, signs: deps.signs, onLogin: () => {}, holder: url.searchParams.get("holder") });
      });
      return;
    }
    const source = addressGroup(remote);
    apWss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => { /* a bad frame closes the socket; it mustn't throw */ });
      const mineSize = waitingByAddress.get(source)?.size ?? 0;
      let evict: WebSocket | null = null;
      if (mineSize >= MAX_WAITING_PER_ADDRESS) {
        // This address's share is used: its oldest gives way, once it's had
        // its chance to log in.
        const oldest = waitingByAddress.get(source)!.values().next().value!;
        if (Date.now() - (waitingSince.get(oldest) ?? 0) < EVICTABLE_AFTER_MS) {
          ws.close(1013, "too many connections waiting to log in — try again");
          return;
        }
        evict = oldest;
      } else if (waiting.size >= MAX_WAITING) {
        // The pool is full: the address with the most waiting gives way, if
        // that's more than this one has.
        let largest: Set<WebSocket> | null = null;
        for (const set of waitingByAddress.values()) if (!largest || set.size > largest.size) largest = set;
        if (!largest || largest.size <= mineSize) {
          ws.close(1013, "too many connections waiting to log in — try again");
          return;
        }
        evict = largest.values().next().value!;
      }
      if (evict) {
        stopWaiting(evict, addressOf.get(evict)!);
        evict.close(1013, "too many connections waiting to log in");
      }
      // Looked up after any eviction, which may have dropped this address's set.
      const mine = waitingByAddress.get(source) ?? new Set<WebSocket>();
      waitingByAddress.set(source, mine);
      waitingSince.set(ws, Date.now());
      addressOf.set(ws, source);
      waiting.add(ws);
      mine.add(ws);
      ws.on("close", () => stopWaiting(ws, source));
      handleApClient(ws, { game, upstreamUrl: deps.multiServerUrl, log, remote, signs: deps.signs, onLogin: () => stopWaiting(ws, source), holder: url.searchParams.get("holder") });
    });
  }

  server.listen(config.port, () => log(`listening on :${config.port} (public ${config.publicUrl.origin})`));
  return server;
}

// A request's client address: the peer, or behind a reverse proxy we trust
// (TRUST_PROXY=1), the last X-Forwarded-For entry, the one the proxy added.
// Earlier entries are whatever the client sent.
function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const peer = req.socket.remoteAddress || "?";
  if (!trustProxy) return peer;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) || peer;
}

// What the per-address limits count as one address: an IPv4 address, or an
// IPv6 /48 (a single host or site is routinely given a /64 or a /48 of its
// own, so counting each IPv6 address apart would let one machine take any
// number of shares).
export function addressGroup(address: string): string {
  const addr = address.replace(/%.*$/, "").toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4) return v4[1];
  if (!addr.includes(":")) return addr;
  const [head, tail] = addr.split("::", 2) as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  // Only the first three hextets matter; any embedded IPv4 sits at the end.
  const hextets = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return hextets.slice(0, 3).map((h) => (parseInt(h, 16) || 0).toString(16)).join(":") + "::/48";
}

// A header parameter value per RFC 5987: encodeURIComponent leaves ' ( ) *
// alone, which that grammar doesn't allow.
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Turn an upgrade away with 429. Node takes its own error listener off the
// socket before handing it to an upgrade handler: without one, a reset during
// this write would be an uncaught error.
function rejectUpgrade(socket: Duplex) {
  socket.on("error", () => {});
  socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
}

// A request's target as a URL, or null when it isn't one.
function parseTarget(target: string | undefined): URL | null {
  try { return new URL(target || "/", "http://localhost"); } catch { return null; }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
