// End to end against a real MultiServer: the server, the proxy and scripted
// clients shaped like the Crystal game client, PopTracker and an impostor.
//
// Skipped unless these are set:
//   YOGOS_IT_SEED    directory holding a generated one-slot Crystal seed (.zip)
//                    with remote_items on, slot "Player1"
//   YOGOS_IT_PYTHON  a Python with Archipelago's requirements installed
//   YOGOS_IT_AP      an Archipelago checkout to run MultiServer from (with
//                    _speedups built), e.g. a copy of vendor/archipelago

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { connect } from "node:net";
import type { AdminState, CheckpointRow, MeResponse, PublicState, RollbackResult } from "../../shared/protocol.ts";

const SEED = process.env.YOGOS_IT_SEED;
const PYTHON = process.env.YOGOS_IT_PYTHON;
const AP = process.env.YOGOS_IT_AP;
const skip = !SEED || !PYTHON || !AP ? "set YOGOS_IT_SEED, YOGOS_IT_PYTHON and YOGOS_IT_AP to run" : false;

const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT = 10;
let server: ChildProcess;
let dataDir: string;
let logs = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n--- server log ---\n${logs.slice(-4000)}`);
}

// A signed-in browser: the dev login's cookie, sent on every request.
async function login(name: string) {
  const res = await fetch(`${BASE}/api/auth/dev?name=${name}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const call = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie, origin: BASE };
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return r.status === 204 ? null : r.json();
  };
  return {
    me: async () => (await call("GET", "/api/me") as MeResponse).you!,
    post: (path: string, body?: unknown) => call("POST", path, body),
    get: (path: string) => call("GET", path),
  };
}

async function publicState(): Promise<PublicState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/live`, { origin: BASE });
    ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "public") { ws.close(); resolve(m.state); } });
    ws.on("error", reject);
  });
}

// An Archipelago client through the proxy, recording what comes back.
class ApClient {
  ws: WebSocket;
  received: any[] = [];
  raw: string[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(path = "/archipelago") {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    this.ws.on("message", (d) => { this.raw.push(d.toString()); for (const m of JSON.parse(d.toString())) this.received.push(m); });
    this.ws.on("close", (code, reason) => { this.closed = { code, reason: reason.toString() }; });
  }
  send(...cmds: object[]) { this.ws.send(JSON.stringify(cmds)); }
  async next(cmd: string, timeoutMs = 15000) {
    return waitFor(cmd, async () => this.received.find((m) => m.cmd === cmd), timeoutMs);
  }
  async connect(fields: object) {
    await this.next("RoomInfo");
    this.send({ cmd: "Connect", uuid: "it", version: { major: 0, minor: 6, build: 8, class: "Version" }, slot_data: false, ...fields });
  }
  waitClosed() { return waitFor("close", async () => this.closed); }
}

const gameConnect = (password: string) => ({ password, game: "Pokemon Crystal", name: "Player1", tags: ["AP"], items_handling: 3 });
const popTrackerConnect = (password: string) => ({ password, game: "", name: "Player1", tags: ["PopTracker", "NoText", "Tracker"], items_handling: 7 });

before(async () => {
  if (skip) return;
  dataDir = mkdtempSync(join(tmpdir(), "yogos-it-"));
  server = spawn(process.execPath, ["server/src/main.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_URL: BASE,
      DATA_DIR: dataDir,
      SEED_DIR: SEED,
      AP_DIR: AP,
      PYTHON,
      MULTISERVER_PORT: String(PORT + 1000),
      DEV_LOGIN: "1",
      ADMIN_DISCORD_IDS: "dev-admin",
      SESSION_SECRET: "integration-test-secret",
      CHECK_LIMIT: String(LIMIT),
      READY_TIMEOUT_SECONDS: "60",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => { logs += d; });
  server.stderr!.on("data", (d) => { logs += d; });
  await waitFor("the server and MultiServer", async () => ((await (await fetch(`${BASE}/api/health`)).json()) as { serverReady: boolean }).serverReady, 120000);
});

after(() => {
  if (skip) return;
  server.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
});

test("a full turn: PopTracker allowed, cheats dropped, exactly ten checks, then shut out", { skip }, async () => {
  const alice = await login("alice");
  await alice.post("/api/queue/join");
  await waitFor("alice's offer", async () => (await alice.me()).offer);
  await alice.post("/api/session/start");
  const creds = (await alice.me()).session!.credentials;

  const gameClient = new ApClient();
  await gameClient.connect(gameConnect(creds.gamePassword));
  const connected = await gameClient.next("Connected");
  const missing: number[] = connected.missing_locations;
  assert.ok(missing.length > LIMIT + 2);

  // PopTracker joins alongside. Like the real one, it fetches the data
  // package before logging in, which is answered without a server socket.
  const tracker = new ApClient("/");
  await tracker.next("RoomInfo");
  // CommonClient asks per game, all in one packet.
  tracker.send({ cmd: "GetDataPackage", games: ["Archipelago"] }, { cmd: "GetDataPackage", games: ["Pokemon Crystal"] });
  await waitFor("both data packages", async () => tracker.received.filter((m) => m.cmd === "DataPackage").length === 2);
  const pkg = tracker.received.find((m) => m.cmd === "DataPackage" && m.data.games["Pokemon Crystal"]);
  assert.ok(pkg.data.games["Pokemon Crystal"].location_name_to_id, "the data package came back before login");
  await tracker.connect(popTrackerConnect(creds.trackerPassword));
  await tracker.next("Connected");
  assert.equal(tracker.received.filter((m) => m.cmd === "RoomInfo").length, 1, "one RoomInfo, not ours and the server's");
  await waitFor("both connected", async () => (await alice.me()).session?.trackerConnected && (await alice.me()).session?.gameConnected);

  // Cheats go nowhere: no items arrive for them.
  const itemsBefore = gameClient.received.filter((m) => m.cmd === "ReceivedItems").length;
  gameClient.send({ cmd: "Say", text: "!getitem Surf" }, { cmd: "Say", text: "!release" }, { cmd: "Say", text: "!hint Surf" });
  await sleep(1000);
  assert.equal(gameClient.received.filter((m) => m.cmd === "ReceivedItems").length, itemsBefore);
  assert.ok(!gameClient.received.some((m) => m.cmd === "PrintJSON" && JSON.stringify(m).includes("Cheat")));

  // Twelve new checks in two batches: only ten reach the server.
  gameClient.send({ cmd: "LocationChecks", locations: missing.slice(0, 7) });
  await waitFor("seven checks", async () => (await alice.me()).session?.checks === 7);
  gameClient.send({ cmd: "LocationChecks", locations: missing.slice(7, 12) });

  await gameClient.waitClosed();
  await tracker.waitClosed();
  assert.equal(gameClient.closed!.code, 4000);
  const me = await alice.me();
  assert.equal(me.session, null);
  assert.equal(me.attemptUsed, true);
  assert.equal(me.lastSession!.reason, "quota");
  assert.equal(me.lastSession!.finds.length, LIMIT);
  await waitFor("named finds", async () => (await alice.me()).lastSession!.finds.every((f) => f.item));
  const totals = (await publicState()).totals;
  assert.equal(totals.checked, LIMIT);

  // The old credentials are dead.
  const stale = new ApClient();
  await stale.connect(gameConnect(creds.gamePassword));
  const refused = await stale.next("ConnectionRefused");
  assert.deepEqual(refused.errors, ["InvalidPassword"]);
  stale.ws.close();

  // And alice can't queue again.
  await assert.rejects(alice.post("/api/queue/join"), /409/);
});

test("anything else using the PopTracker password ends the turn", { skip }, async () => {
  const bob = await login("bob");
  await bob.post("/api/queue/join");
  await waitFor("bob's offer", async () => (await bob.me()).offer);
  await bob.post("/api/session/start");
  const creds = (await bob.me()).session!.credentials;

  const gameClient = new ApClient();
  await gameClient.connect(gameConnect(creds.gamePassword));
  await gameClient.next("Connected");

  // The Archipelago text client.
  const textClient = new ApClient("/");
  await textClient.connect({ password: creds.trackerPassword, game: "", name: "Player1", tags: ["AP", "TextOnly"], items_handling: 7 });
  await textClient.waitClosed();
  await gameClient.waitClosed();
  const me = await bob.me();
  assert.equal(me.lastSession!.reason, "violation");
  assert.equal(me.lastSession!.finds.length, 0);
});

test("scouting can't create hints", { skip }, async () => {
  const carol = await login("carol");
  await carol.post("/api/queue/join");
  await waitFor("carol's offer", async () => (await carol.me()).offer);
  await carol.post("/api/session/start");
  const creds = (await carol.me()).session!.credentials;

  const gameClient = new ApClient();
  await gameClient.connect(gameConnect(creds.gamePassword));
  const connected = await gameClient.next("Connected");
  const team = connected.team, slot = connected.slot;
  const loc = connected.missing_locations[0];
  gameClient.send({ cmd: "LocationScouts", locations: [loc], create_as_hint: 2 });
  await gameClient.next("LocationInfo");
  gameClient.send({ cmd: "Get", keys: [`_read_hints_${team}_${slot}`] });
  const retrieved = await gameClient.next("Retrieved");
  assert.deepEqual(retrieved.keys[`_read_hints_${team}_${slot}`] ?? [], []);
  await carol.post("/api/session/end");
  await gameClient.waitClosed();
});

test("a MultiServer restart mid-turn doesn't cost the player their turn", { skip }, async () => {
  const dave = await login("dave");
  await dave.post("/api/queue/join");
  await waitFor("dave's offer", async () => (await dave.me()).offer);
  await dave.post("/api/session/start");
  const creds = (await dave.me()).session!.credentials;

  let game = new ApClient();
  await game.connect(gameConnect(creds.gamePassword));
  const missing: number[] = (await game.next("Connected")).missing_locations;
  game.send({ cmd: "LocationChecks", locations: missing.slice(0, 2) });
  await waitFor("two checks", async () => (await dave.me()).session?.checks === 2);

  // Kill MultiServer; the server restarts it. Earlier tests rotated its
  // password, so it comes back with a stale one from its save for a moment.
  spawn("pkill", ["-f", `MultiServer.py.*--port ${PORT + 1000}`]);
  await game.waitClosed();

  // Reconnect the way the game client does: retry until logged in.
  const until = Date.now() + 90000;
  for (;;) {
    game = new ApClient();
    try {
      await game.connect(gameConnect(creds.gamePassword));
      const reply = await waitFor("a reply", async () => game.received.find((m) => m.cmd === "Connected" || m.cmd === "ConnectionRefused") || game.closed, 20000);
      if ((reply as any).cmd === "Connected") break;
      assert.notEqual((reply as any).cmd, "ConnectionRefused", "a valid login must never be refused as a wrong password");
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err;
    }
    try { game.ws.close(); } catch {}
    if (Date.now() > until) throw new Error("never reconnected\n" + logs.slice(-3000));
    await sleep(1000);
  }
  const me = await dave.me();
  assert.ok(me.session, "the turn survives the restart");
  assert.equal(me.session!.checks, 2);
  game.send({ cmd: "LocationChecks", locations: [missing[2]] });
  await waitFor("third check", async () => (await dave.me()).session?.checks === 3);
  await dave.post("/api/session/end");
});

test("frames a socket rejects can't take the server down", { skip }, async () => {
  const raw = (path: string, payload: Buffer | string) => new Promise<void>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, { origin: BASE });
    ws.on("open", () => ws.send(payload));
    ws.on("error", () => {});
    ws.on("close", () => resolve());
    setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 3000);
  });
  await raw("/api/live", "x".repeat(4096));                 // over the live socket's size limit
  await raw("/archipelago", Buffer.from([0xff, 0xfe, 0xfd])); // a binary frame
  await raw("/archipelago", "x".repeat(5 * 1024 * 1024));    // over the proxy's size limit
  // Malformed request targets, plain and as an upgrade.
  const rawHttp = (text: string) => new Promise<void>((resolve) => {
    const sock = connect(PORT, "127.0.0.1", () => sock.write(text));
    sock.on("error", () => {});
    sock.on("close", () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 2000);
  });
  await rawHttp("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n");
  await rawHttp("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  await sleep(500);
  const health = await (await fetch(`${BASE}/api/health`)).json() as { ok: boolean };
  assert.equal(health.ok, true, "the server is still up");
  assert.equal(server.exitCode, null);
});

test("a device the turn was taken from can't take it back by reconnecting", { skip }, async () => {
  const fay = await login("fay");
  await fay.post("/api/queue/join");
  await waitFor("fay's offer", async () => (await fay.me()).offer);
  await fay.post("/api/session/start");
  const creds = (await fay.me()).session!.credentials;
  const path = (holder: string) => `${new URL(creds.apUrl).pathname}${new URL(creds.apUrl).search}&holder=${holder}`;

  const phone = (await fay.post("/api/session/claim") as { holder: string }).holder;
  const phoneGame = new ApClient(path(phone));
  await phoneGame.connect(gameConnect(creds.gamePassword));
  await phoneGame.next("Connected");

  // Play moves to the laptop; the phone is replaced.
  const laptop = (await fay.post("/api/session/claim") as { holder: string }).holder;
  const laptopGame = new ApClient(path(laptop));
  await laptopGame.connect(gameConnect(creds.gamePassword));
  await laptopGame.next("Connected");
  await phoneGame.waitClosed();
  assert.equal(phoneGame.closed!.code, 4001);

  // The phone comes back online and reconnects with what it had.
  const again = new ApClient(path(phone));
  await again.connect(gameConnect(creds.gamePassword));
  await again.waitClosed();
  assert.equal(again.closed!.code, 4001, "turned away as replaced");
  await sleep(300);
  assert.equal(laptopGame.closed, null, "the laptop keeps the turn");
  await fay.post("/api/session/end");
});

test("the game's event flags reach data storage intact, and harmful writes don't", { skip }, async () => {
  const gus = await login("gus");
  await gus.post("/api/queue/join");
  await waitFor("gus's offer", async () => (await gus.me()).offer);
  await gus.post("/api/session/start");
  const creds = (await gus.me()).session!.credentials;
  const apPath = new URL(creds.apUrl).pathname + new URL(creds.apUrl).search;
  const gameClient = new ApClient(apPath);
  await gameClient.connect(gameConnect(creds.gamePassword));
  const connected = await gameClient.next("Connected");
  const key = (name: string) => `pokemon_crystal_${name}_${connected.team}_${connected.slot}`;

  // Crystal's event bitfields run past 2^53: sent as written, stored exactly.
  const flags = "38685626227668133590597631";
  gameClient.ws.send(`[{"cmd":"Set","key":"${key("events")}","default":0,"want_reply":false,"operations":[{"operation":"or","value":${flags}}]}]`);
  // An operation that would have MultiServer compute for ever, and an integer
  // too long for it to send back out (which would lock every later client
  // out of the key), are dropped.
  gameClient.send({ cmd: "Set", key: key("events_2"), default: 10, want_reply: false, operations: [{ operation: "pow", value: 1e12 }] });
  gameClient.ws.send(`[{"cmd":"Set","key":"${key("events_3")}","default":0,"operations":[{"operation":"or","value":${"9".repeat(4300)}}]}]`);
  // Keys the game doesn't write are left alone.
  gameClient.send({ cmd: "Set", key: "made_up", operations: [{ operation: "replace", value: 1 }] });
  gameClient.send({ cmd: "Get", keys: [key("events"), key("events_2"), key("events_3"), "made_up"] });
  await gameClient.next("Retrieved", 5000);
  const retrieved = gameClient.raw.find((t) => t.includes('"Retrieved"'))!;
  assert.match(retrieved, new RegExp(`"${key("events")}":\\s*${flags}\\b`));
  for (const k of [key("events_2"), key("events_3"), "made_up"]) assert.match(retrieved, new RegExp(`"${k}":\\s*null`), k);
  gameClient.ws.close();
  await gameClient.waitClosed();

  // The game reconnecting still logs in and reads them back.
  const again = new ApClient(apPath);
  await again.connect(gameConnect(creds.gamePassword));
  await again.next("Connected");
  again.send({ cmd: "SetNotify", keys: [key("events_3")] }, { cmd: "Set", key: key("events_3"), default: 0, want_reply: true, operations: [{ operation: "or", value: 0 }] });
  await again.next("SetReply", 5000);
  await gus.post("/api/session/end");
  await again.waitClosed();
});

test("an admin can roll the game back to a checkpoint, and undo that", { skip }, async () => {
  const admin = await login("admin");
  const adminState = async () => await admin.get("/api/admin/state") as AdminState;
  await waitFor("the first checkpoint", async () => (await adminState()).checkpoints.some((c) => c.kind === "start"));
  const before = await admin.post("/api/admin/checkpoint", { label: "it: before hank" }) as CheckpointRow;
  assert.equal(before.checked, (await publicState()).totals.checked);

  // Hank checks two locations and writes to data storage.
  const hank = await login("hank");
  await hank.post("/api/queue/join");
  await waitFor("hank's offer", async () => (await hank.me()).offer);
  await hank.post("/api/session/start");
  let creds = (await hank.me()).session!.credentials;
  let game = new ApClient();
  await game.connect(gameConnect(creds.gamePassword));
  const connected = await game.next("Connected");
  const statics = `pokemon_crystal_statics_${connected.team}_${connected.slot}`;
  game.send({ cmd: "Set", key: statics, default: 0, want_reply: false, operations: [{ operation: "or", value: 7 }] });
  game.send({ cmd: "LocationChecks", locations: connected.missing_locations.slice(0, 2) });
  await waitFor("hank's two checks", async () => (await hank.me()).session?.checks === 2);
  await hank.post("/api/session/end");
  await game.waitClosed();
  await waitFor("the checkpoint after hank's turn", async () => (await adminState()).checkpoints.some((c) => c.label === "after hank's turn"));
  assert.equal((await publicState()).totals.checked, before.checked + 2);

  // Only admins can checkpoint or roll back.
  await assert.rejects(hank.post("/api/admin/checkpoint", { label: "mine" }), /403/);
  await assert.rejects(hank.post("/api/admin/rollback", { checkpointId: before.id, returnTurns: true }), /403/);
  assert.equal((await publicState()).totals.checked, before.checked + 2);

  // Rolling back takes the checks and the write back, and can give hank his turn back.
  const result = await admin.post("/api/admin/rollback", { checkpointId: before.id, returnTurns: true }) as RollbackResult;
  assert.deepEqual(result, { undone: 2, turnsReturned: 1 });
  let state = await publicState();
  assert.equal(state.totals.checked, before.checked);
  assert.equal(state.paused, true, "the queue stays paused after a rollback");
  assert.ok(!state.recent.some((f) => f.who.name === "hank"), "undone finds aren't shown to players");
  const hankTurn = (await adminState()).sessions.find((s) => s.user.name === "hank")!;
  assert.ok(hankTurn.finds.length === 2 && hankTurn.finds.every((f) => f.undone), "the admin history keeps them, marked undone");
  assert.equal((await hank.me()).attemptUsed, false);

  // Hank's new turn starts from the checkpoint's data storage.
  await admin.post("/api/admin/resume");
  await hank.post("/api/queue/join");
  await waitFor("hank's second offer", async () => (await hank.me()).offer);
  await hank.post("/api/session/start");
  creds = (await hank.me()).session!.credentials;
  game = new ApClient();
  await game.connect(gameConnect(creds.gamePassword));
  await game.next("Connected");
  game.send({ cmd: "Get", keys: [statics] });
  assert.equal((await game.next("Retrieved")).keys[statics], null);
  await hank.post("/api/session/end");
  await game.waitClosed();

  // The rollback took a checkpoint first: rolling back to it undoes it.
  const undo = (await adminState()).checkpoints.find((c) => c.kind === "before-rollback")!;
  assert.deepEqual(await admin.post("/api/admin/rollback", { checkpointId: undo.id, returnTurns: false }), { undone: 0, turnsReturned: 0 });
  assert.equal((await publicState()).totals.checked, before.checked + 2);
  assert.ok((await adminState()).sessions.find((s) => s.id === hankTurn.id)!.finds.every((f) => !f.undone), "the finds stand again");
  await admin.post("/api/admin/resume");
});

// Last: confirming the goal completes the event, so nothing can start after it.
test("a reported goal waits for an admin, then reaches MultiServer", { skip }, async () => {
  const erin = await login("erin");
  const admin = await login("admin");
  await erin.post("/api/queue/join");
  await waitFor("erin's offer", async () => (await erin.me()).offer);
  await erin.post("/api/session/start");
  const creds = (await erin.me()).session!.credentials;

  const game = new ApClient();
  await game.connect(gameConnect(creds.gamePassword));
  await game.next("Connected");
  game.send({ cmd: "StatusUpdate", status: 30 });
  await game.waitClosed();
  assert.equal((await erin.me()).lastSession!.reason, "goal-reported");
  let state = await publicState();
  assert.equal(state.goalPending, true);
  assert.equal(state.complete, false);
  assert.equal(state.paused, true);

  await admin.post("/api/admin/confirm-goal");
  state = await publicState();
  assert.equal(state.complete, true);
  assert.equal((await erin.me()).lastSession!.reason, "goal");
  await waitFor("the goal reaching MultiServer", async () => /reported the goal to the game server/.test(logs));
  assert.match(logs, /Player1 \(Team #1\) has completed their goal/);
});
