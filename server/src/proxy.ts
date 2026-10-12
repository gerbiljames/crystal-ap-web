// The Archipelago endpoint players' clients connect to. Until a client logs
// in, it's answered from the observer's copies of the server's RoomInfo and
// data package, so a socket that never logs in costs MultiServer nothing.
// Once a login is accepted, the client gets its own socket to MultiServer and
// packets in both directions go through here, the client's checked against
// rules.ts on the way.

import WebSocket from "ws";
import type { Game, ProxyConn } from "./game.ts";
import { classifyConnect, filterBeforeConnect, filterCommand, parsePacket, type Role, type StorageScope } from "./rules.ts";
import { connectUpstream } from "./observer.ts";

// Client packets held while the upstream socket is still opening, or while a
// login waits for the server's answer.
const MAX_BACKLOG = 64;
// A client that stops answering pings is gone (its network died without
// closing the socket): drop it so the session's grace period starts.
const PING_EVERY_MS = 10000;
// How long a connection may stay open without logging in.
const LOGIN_DEADLINE_MS = 30000;

export function handleApClient(client: WebSocket, deps: {
  game: Game;
  upstreamUrl: () => string;
  log: (line: string) => void;
  remote: string;
  // Called when the server accepts the client's login.
  onLogin: () => void;
  // The device's claim on the turn, from its connection URL (the game's).
  holder: string | null;
  // The world's sign names (data storage keys hold them).
  signs: ReadonlySet<string>;
}) {
  const { game, log } = deps;
  let role: Role | null = null;
  let sessionId: string | null = null;
  // The slot the server logged us into, which data storage commands may reach.
  let scope: StorageScope | null = null;
  let setDropLogged = false;
  // Between an accepted Connect and the server's Connected, the slot it logged
  // into isn't confirmed yet: whatever the client sends meanwhile waits here.
  let held: unknown[] | null = null;
  // The server's own RoomInfo, which the client already had from us.
  let roomInfoSkipped = false;
  // Before logging in a client asks for each game's data package (often one
  // command per game, in one packet): each game is answered once, at most.
  const packagesSent = new Set<string>();
  let closed = false;
  let upstream: WebSocket | null = null;
  const backlog: string[] = [];

  const conn: ProxyConn = {
    close(code, reason) {
      if (closed) return;
      closed = true;
      try { client.close(code, reason.slice(0, 120)); } catch {}
      try { upstream?.close(); } catch {}
    },
  };

  // Nothing to tell the client until we've seen the server ourselves.
  const roomInfo = game.roomInfo;
  if (!roomInfo) { conn.close(1013, "the game server is starting — try again"); return; }

  let alive = true;
  client.on("pong", () => { alive = true; });
  const pinger = setInterval(() => {
    if (!alive) { log(`[proxy] ${role ?? "client"} from ${deps.remote} stopped answering`); client.terminate(); return; }
    alive = false;
    try { client.ping(); } catch {}
  }, PING_EVERY_MS);
  const loginDeadline = setTimeout(() => { if (!role) conn.close(1008, "log in sooner"); }, LOGIN_DEADLINE_MS);

  const sendClient = (msgs: unknown[]) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(msgs));
  };
  sendClient([roomInfo]);

  function openUpstream(): WebSocket {
    const ws = upstream = connectUpstream(deps.upstreamUrl());
    ws.on("open", () => {
      for (const text of backlog.splice(0)) ws.send(text);
    });
    ws.on("message", (data, isBinary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // While a login is waiting, look at what the server says.
      if (held) {
        let msgs: any[] = [];
        try { msgs = parsePacket(data.toString()) as any[]; } catch {}
        if (!Array.isArray(msgs)) msgs = [];
        if (!roomInfoSkipped && msgs.some((m) => m?.cmd === "RoomInfo")) {
          roomInfoSkipped = true;
          msgs = msgs.filter((m) => m?.cmd !== "RoomInfo");
          if (!msgs.length) return;
          data = Buffer.from(JSON.stringify(msgs));
        }
        if (msgs.some((m) => m?.cmd === "ConnectionRefused")) {
          // MultiServer turned the login down (version, items handling): pass
          // its reasons on and end the connection rather than wait forever.
          client.send(data, { binary: isBinary });
          conn.close(4003, "refused by the game server");
          return;
        }
        for (const msg of msgs) {
          if (msg?.cmd !== "Connected") continue;
          if (!role || !game.connected(conn, role, msg.slot)) {
            // Not this turn's slot, or the turn is over: nothing more passes.
            conn.close(4002, "not allowed");
            return;
          }
          // Logged in for real: past the deadline, out of the waiting pool.
          clearTimeout(loginDeadline);
          scope = { team: msg.team, slot: msg.slot, signs: deps.signs };
          deps.onLogin();
          // The right slot: let through what the client sent meanwhile.
          const waiting = held;
          held = null;
          client.send(data, { binary: isBinary });
          sendUpstream(apply(waiting));
          return;
        }
      }
      client.send(data, { binary: isBinary });
    });
    ws.on("close", () => conn.close(1011, "the game server went away"));
    ws.on("error", () => { /* close follows */ });
    return ws;
  }

  const sendUpstream = (msgs: unknown[]) => {
    if (!msgs.length || closed) return;
    const ws = upstream ?? openUpstream();
    const text = JSON.stringify(msgs);
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
    else if (backlog.length < MAX_BACKLOG) backlog.push(text);
    else conn.close(1008, "too many packets before the server was ready");
  };

  // Apply the rules to a client's commands; returns what goes to the server.
  // Stops (closing the connection) at a violation.
  function apply(cmds: any[]): unknown[] {
    const out: unknown[] = [];
    for (const cmd of cmds) {
      if (closed) return [];
      if (cmd?.cmd === "Connect") {
        // Until our own view of the slot is up (after a restart), the quota
        // and slot checks can't be applied: have the client come back.
        if (!game.serverReady) { conn.close(1013, "the game server is starting — try again"); return []; }
        const creds = game.credentials();
        const verdict = classifyConnect(cmd, creds, game.slot);
        if (verdict.kind === "refuse") {
          sendClient([{ cmd: "ConnectionRefused", errors: [verdict.error] }]);
          conn.close(4003, verdict.error === "InvalidSlot" ? "wrong slot" : "wrong password");
          return [];
        }
        if (verdict.kind === "violation") {
          log(`[proxy] violation from ${deps.remote}: ${verdict.detail}`);
          game.violation(verdict.detail);
          conn.close(4002, "not allowed");
          return [];
        }
        if (verdict.role === "game" && !game.holdsPlay(deps.holder)) {
          // A device the turn was taken from, reconnecting: it steps aside
          // (4001: replaced) instead of taking the turn back.
          conn.close(4001, "this turn is being played on another device");
          return [];
        }
        if (role && role !== verdict.role) {
          game.violation("one connection logged in as both the game and PopTracker");
          conn.close(4002, "not allowed");
          return [];
        }
        role = verdict.role;
        sessionId = creds!.sessionId;
        game.attach(conn);
        log(`[proxy] ${role} connected from ${deps.remote}`);
        // MultiServer has no password of its own; the session's stays here.
        // The game client names its slot by the ROM's auth string, which we
        // can't check, so name the slot ourselves: a game login can only land
        // in this one. (PopTracker's name was already checked.)
        out.push({ ...cmd, password: null, ...(role === "game" ? { name: game.slot.name } : {}) });
        // A repeated Connect while one is pending keeps what was held for it.
        held ??= [];
        continue;
      }
      if (held) {
        if (held.length >= MAX_BACKLOG) { conn.close(1008, "too many packets before the login finished"); return []; }
        held.push(cmd);
        continue;
      }

      const verdict = role ? filterCommand(role, cmd, role === "game" && !game.gameOpen(conn), scope) : filterBeforeConnect(cmd);
      if (verdict.action === "drop") {
        // Once per connection: a data storage write the rules don't know, as
        // a world update that starts writing a new key would cause.
        if (cmd?.cmd === "Set" && role && scope && !setDropLogged) {
          setDropLogged = true;
          log(`[proxy] dropped a data storage write from the ${role} (key ${JSON.stringify(String(cmd.key).slice(0, 80))})`);
        }
        continue;
      }
      if (verdict.action === "violation") {
        log(`[proxy] violation from ${deps.remote}: ${verdict.detail}`);
        game.violation(verdict.detail);
        conn.close(4002, "not allowed");
        return [];
      }
      if (!role) {
        // Before logging in, only the data package is asked for: answer it
        // from our copy rather than open a server connection for it.
        if (verdict.action === "forward" && cmd.cmd === "GetDataPackage") {
          const known = new Set(game.dataPackageGames());
          const wanted = (Array.isArray(cmd.games) ? cmd.games : [...known])
            .filter((g: unknown): g is string => typeof g === "string" && known.has(g) && !packagesSent.has(g));
          if (wanted.length && client.readyState === WebSocket.OPEN) {
            for (const g of wanted) packagesSent.add(g);
            client.send(game.dataPackage(wanted));
          }
        }
        continue;
      }
      if (verdict.action === "goal") {
        // Whatever came before it in this packet (the last checks) goes to
        // the server first: claiming the goal ends the session and closes us.
        sendUpstream(out.splice(0));
        game.claimGoal(conn);
        continue;
      }
      if (verdict.action === "checks") {
        const ids = game.checks(conn, verdict.locations);
        if (ids.length) out.push({ cmd: "LocationChecks", locations: ids });
        continue;
      }
      out.push(verdict.cmd);
    }
    return out;
  }

  client.on("message", (data, isBinary) => {
    if (isBinary) { conn.close(1003, "binary frames aren't part of the protocol"); return; }
    let cmds: any;
    try { cmds = parsePacket(data.toString()); } catch { conn.close(1007, "not JSON"); return; }
    if (!Array.isArray(cmds)) { conn.close(1007, "expected a list of commands"); return; }
    // The session this connection logged into has ended: nothing more goes
    // through. (end() closes it; this covers packets already in flight.)
    if (sessionId && !game.isCurrent(sessionId)) { conn.close(4000, "session ended"); return; }
    sendUpstream(apply(cmds));
  });
  client.on("close", () => {
    clearInterval(pinger);
    clearTimeout(loginDeadline);
    closed = true;
    try { upstream?.close(); } catch {}
    game.detach(conn);
  });
  client.on("error", () => { /* close follows */ });
}
