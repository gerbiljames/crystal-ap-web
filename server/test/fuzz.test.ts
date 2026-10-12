// Hostile input at every endpoint of a real server (and MultiServer behind
// it): malformed HTTP, junk API bodies and cookies, bad WebSocket upgrades and
// frames, and nonsense Archipelago packets, before login and with a running
// turn's real credentials. After each batch the server must still be up and
// still watching the game.
//
// Skipped unless YOGOS_IT_SEED, YOGOS_IT_PYTHON and YOGOS_IT_AP are set (see
// integration.test.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const SEED = process.env.YOGOS_IT_SEED;
const PYTHON = process.env.YOGOS_IT_PYTHON;
const AP = process.env.YOGOS_IT_AP;
const skip = !SEED || !PYTHON || !AP ? "set YOGOS_IT_SEED, YOGOS_IT_PYTHON and YOGOS_IT_AP to run" : false;

const PORT = 19080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;
let dataDir: string;
let logs = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Deterministic randomness, so a failure can be replayed.
let rng = 0x2545f491;
const rand = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 2 ** 32; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

// Values of every awkward shape.
function junk(depth = 0): unknown {
  const simple = [null, true, false, 0, -1, 1e308, -0, NaN, 2 ** 53, "", "x", "💥", "\u0000", "a".repeat(5000),
    "__proto__", "constructor", "toString", "!admin login x", "Pokemon Crystal", "Player1"];
  if (depth > 3 || rand() < 0.5) return pick(simple);
  if (rand() < 0.5) return Array.from({ length: Math.floor(rand() * 6) }, () => junk(depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(rand() * 5); i++) o[pick(["cmd", "games", "locations", "password", "tags", "name", "game", "version", "keys", "key", "value", "operations", "status", "text", "slots", "data", "__proto__", "x"])] = junk(depth + 1);
  return o;
}

const LOGGED_IN_CMDS = ["Sync", "LocationChecks", "LocationScouts", "CreateHints", "UpdateHint",
  "StatusUpdate", "Say", "GetDataPackage", "Bounce", "Get", "Set", "SetNotify", "Nope", "", "__proto__"];
const CMDS = ["Connect", "ConnectUpdate", ...LOGGED_IN_CMDS];
// A command with junk fields. `loggedIn`: none of the ones that (rightly)
// close the connection or end the turn, so the rest of the junk gets through.
function junkCommand(loggedIn = false): unknown {
  const c = junk() as any;
  const o = c && typeof c === "object" && !Array.isArray(c) ? c : {};
  o.cmd = pick(loggedIn ? LOGGED_IN_CMDS : CMDS);
  return o;
}

async function healthy(what: string) {
  const until = Date.now() + 15000;
  for (;;) {
    try {
      const h = await (await fetch(`${BASE}/api/health`)).json() as { ok: boolean; serverReady: boolean };
      if (h.ok && h.serverReady) return;
    } catch {}
    if (server.exitCode !== null || Date.now() > until) {
      assert.fail(`not healthy after ${what}\n--- server log ---\n${logs.slice(-5000)}`);
    }
    await sleep(250);
  }
}

function rawHttp(text: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    const sock = connect(PORT, "127.0.0.1", () => sock.write(text));
    sock.on("error", () => {});
    sock.on("data", () => {});
    sock.on("close", () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 1500);
  });
}

// Open a socket, send some frames, then let it go.
// How much of the junk actually got through to a live socket (a suite that
// never opens one tests nothing).
const stats = { opened: 0, refused: 0, messages: 0 };

function wsBurst(path: string, frames: (string | Buffer)[], opts: { origin?: string; headers?: Record<string, string> } = {}): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { origin: opts.origin, headers: opts.headers });
    ws.on("unexpected-response", () => { stats.refused++; });
    ws.on("open", async () => {
      stats.opened++;
      for (const f of frames) { try { ws.send(f); } catch {} await sleep(2); }
      setTimeout(() => { try { ws.terminate(); } catch {} }, 300);
    });
    ws.on("message", () => { stats.messages++; });
    ws.on("error", () => {});
    ws.on("close", () => resolve());
    setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 3000);
  });
}

async function login(name: string) {
  const res = await fetch(`${BASE}/api/auth/dev?name=${name}`, { redirect: "manual" });
  return res.headers.get("set-cookie")!.split(";")[0];
}

before(async () => {
  if (skip) return;
  dataDir = mkdtempSync(join(tmpdir(), "yogos-fuzz-"));
  server = spawn(process.execPath, ["server/src/main.ts"], {
    env: {
      ...process.env, PORT: String(PORT), PUBLIC_URL: BASE, DATA_DIR: dataDir, SEED_DIR: SEED, AP_DIR: AP, PYTHON,
      MULTISERVER_PORT: String(PORT + 1000), DEV_LOGIN: "1", SESSION_SECRET: "fuzz-test-secret-value",
      ADMIN_DISCORD_IDS: "dev-admin",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => { logs += d; });
  server.stderr!.on("data", (d) => { logs += d; });
  await healthy("startup");
});

after(() => {
  if (skip) return;
  server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
});

test("malformed HTTP requests", { skip }, async () => {
  const requests = [
    "GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET //[::1 HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET http://%zz/ HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET /../../etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET /..%2f..%2fetc%2fpasswd HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET /api/me HTTP/1.1\r\nHost: x\r\nCookie: yogos_session=%E0%A4%A; a=%\r\n\r\n",
    "GET /api/me HTTP/1.1\r\nHost: x\r\nCookie: yogos_session=a.b.c.d.e.f\r\n\r\n",
    `GET /api/me HTTP/1.1\r\nHost: x\r\nCookie: ${"a=b; ".repeat(2000)}\r\n\r\n`,
    "POST /api/admin/ban HTTP/1.1\r\nHost: x\r\nContent-Length: 999999999\r\n\r\n{",
    "POST /api/queue/join HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
    "BREW /api/me HTTP/1.1\r\nHost: x\r\n\r\n",
    "\x00\x01\x02 garbage\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    "GET /api/live HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 99\r\nSec-WebSocket-Key: nope\r\n\r\n",
    "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    "GET /archipelago?join=%zz&holder=%E0 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
  ];
  for (const r of requests) await rawHttp(r);
  await healthy("malformed HTTP");
});

// Before the junk API suite, whose random calls queue and pause things.
test("junk from a running turn's own game and PopTracker connections", { skip }, async (t) => {
  Object.assign(stats, { opened: 0, refused: 0, messages: 0 });
  const cookie = await login("fuzzturn");
  const post = (path: string) => fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, origin: BASE } });
  // The junk API suite may have left the queue paused (it calls the admin
  // routes at random, as an admin too).
  await fetch(`${BASE}/api/admin/resume`, { method: "POST", headers: { cookie: await login("admin"), origin: BASE } });
  const me = async (): Promise<any> => ((await (await fetch(`${BASE}/api/me`, { headers: { cookie } })).json()) as any).you;
  await post("/api/queue/join");
  for (let i = 0; i < 40 && !(await me())?.offer; i++) await sleep(250);
  await post("/api/session/start");
  const creds = (await me()).session.credentials;
  const holder = ((await (await post("/api/session/claim")).json()) as any).holder;
  const gamePath = `${new URL(creds.apUrl).pathname}${new URL(creds.apUrl).search}&holder=${holder}`;
  const login_ = (role: "game" | "tracker") => role === "game"
    ? { cmd: "Connect", password: creds.gamePassword, game: "Pokemon Crystal", name: "Player1", tags: ["AP"], items_handling: 3, uuid: "f", version: { major: 0, minor: 6, build: 8, class: "Version" } }
    : { cmd: "Connect", password: creds.trackerPassword, game: "", name: "Player1", tags: ["PopTracker", "NoText", "Tracker"], items_handling: 7, uuid: "f", version: { major: 0, minor: 5, build: 1, class: "Version" } };

  // Shapes that are valid commands with invalid fields: what a modified client
  // would send once logged in. (PopTracker sending writes is a violation and
  // ends the turn; the game's junk mostly reaches MultiServer.)
  const gameJunk = () => pick([
    { cmd: "LocationChecks", locations: junk() },
    { cmd: "LocationChecks", locations: Array.from({ length: 5000 }, (_, i) => i) },
    { cmd: "LocationScouts", locations: junk(), create_as_hint: junk() },
    { cmd: "Set", key: junk(), default: junk(), want_reply: junk(), operations: junk() },
    { cmd: "Get", keys: junk() },
    { cmd: "SetNotify", keys: junk() },
    { cmd: "Bounce", games: junk(), slots: junk(), tags: junk(), data: junk() },
    { cmd: "StatusUpdate", status: junk() },
    { cmd: "ConnectUpdate", tags: ["AP", pick(["DeathLink", "TrapLink", "x"])], items_handling: junk() },
    { cmd: "Sync" },
    junkCommand(true),
  ]);
  for (let round = 0; round < 3; round++) {
    await wsBurst(gamePath, [JSON.stringify([login_("game")]), ...Array.from({ length: 60 }, () => JSON.stringify([gameJunk(), gameJunk()]))]);
    await healthy(`game junk, round ${round}`);
    // None of that was a reason to end the turn (junk isn't a violation),
    // so it's still running: the junk really went through a logged-in game.
    assert.ok((await me())?.session, `the turn survived round ${round}`);
  }
  await wsBurst("/", [JSON.stringify([login_("tracker")]), ...Array.from({ length: 20 }, () => JSON.stringify([pick([
    { cmd: "Get", keys: junk() }, { cmd: "SetNotify", keys: junk() }, { cmd: "GetDataPackage", games: junk() }, { cmd: "Sync" },
  ])]))]);
  await healthy("tracker junk");
  t.diagnostic(`turn: ${JSON.stringify(stats)}`);
  assert.ok(stats.messages > 0, "the server answered the turn's connections");
});

test("junk API calls, signed in and out, admin and not", { skip }, async (t) => {
  const statuses: Record<string, number> = {};
  const player = await login("fuzzplayer");
  const admin = await login("admin");
  const routes = ["/api/me", "/api/patch", "/api/queue/join", "/api/queue/leave", "/api/session/start", "/api/session/end",
    "/api/session/claim", "/api/admin/state", "/api/admin/pause", "/api/admin/resume", "/api/admin/skip",
    "/api/admin/end-session", "/api/admin/dequeue", "/api/admin/reset-user", "/api/admin/ban", "/api/admin/unban",
    "/api/admin/checkpoint", "/api/admin/rollback", "/api/admin/skip-hints", "/api/hints", "/api/auth/callback?code=x&state=y", "/api/auth/logout", "/api/nope"];
  for (let i = 0; i < 300; i++) {
    const cookie = pick([undefined, player, admin, "yogos_session=forged.123.abc", "yogos_session=%zz"]);
    const method = pick(["GET", "POST", "POST", "POST", "PUT", "DELETE"]);
    const body = method === "GET" ? undefined : pick([undefined, "", "{", "null", "[]", "1e999", JSON.stringify(junk()), "x".repeat(70000)]);
    await fetch(`${BASE}${pick(routes)}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), origin: pick([BASE, "https://evil.example", ""]), "content-type": "application/json" },
      body: body === undefined ? undefined : body,
      redirect: "manual",
    }).then((r) => { statuses[r.status] = (statuses[r.status] ?? 0) + 1; return r.arrayBuffer(); })
      .catch((e) => { statuses[`error: ${e?.cause?.code ?? e}`] = (statuses[`error: ${e?.cause?.code ?? e}`] ?? 0) + 1; });
  }
  await healthy("junk API calls");
  t.diagnostic(`api statuses: ${JSON.stringify(statuses)}`);
});

test("junk on the live socket", { skip }, async (t) => {
  Object.assign(stats, { opened: 0, refused: 0, messages: 0 });
  const cookie = await login("fuzzlive");
  for (let i = 0; i < 40; i++) {
    const frames = Array.from({ length: 5 }, () => pick<string | Buffer>([
      JSON.stringify(junk()), "x".repeat(2000), Buffer.from([0xff, 0xfe]), "", "{",
    ]));
    await wsBurst("/api/live", frames, { origin: pick<string | undefined>([BASE, undefined]), headers: rand() < 0.5 ? { cookie } : {} });
  }
  await healthy("live socket junk");
  t.diagnostic(`live: ${JSON.stringify(stats)}`);
  assert.ok(stats.opened > 20, "most live sockets opened");
});

test("junk at the Archipelago endpoint before login", { skip }, async (t) => {
  Object.assign(stats, { opened: 0, refused: 0, messages: 0 });
  for (let i = 0; i < 60; i++) {
    const frames = Array.from({ length: 8 }, () => pick<string | Buffer>([
      JSON.stringify([junkCommand()]),
      JSON.stringify([junkCommand(), junkCommand(), junkCommand()]),
      JSON.stringify(junk()),
      JSON.stringify([{ cmd: "GetDataPackage", games: junk() }]),
      JSON.stringify([{ cmd: "Connect", password: junk(), game: junk(), name: junk(), tags: junk(), version: junk(), items_handling: junk(), uuid: junk() }]),
      "[" .repeat(10000),
      Buffer.from([1, 2, 3]),
      "not json",
    ]));
    await wsBurst(pick(["/", "/archipelago", "/archipelago?join=x&holder=y", "/anything"]), frames);
  }
  await healthy("pre-login Archipelago junk");
  t.diagnostic(`pre-login: ${JSON.stringify(stats)}`);
  assert.ok(stats.opened > 30, "most Archipelago sockets opened");
});

test("the server logged no unexpected errors", { skip }, async () => {
  const bad = logs.split("\n").filter((l) => /error handling|uncaught|unhandled|TypeError|RangeError/i.test(l) && !/\[multiserver\]/.test(l));
  assert.deepEqual(bad, [], bad.join("\n"));
});
