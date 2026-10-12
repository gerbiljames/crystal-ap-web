import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Db } from "../src/db.ts";
import { Game, type ProxyConn } from "../src/game.ts";
import type { Config } from "../src/config.ts";
import type { Seed } from "../src/seed.ts";
import type { Observer } from "../src/observer.ts";

// A stand-in for the observer: a slot with locations 1..20, none checked.
class FakeObserver extends EventEmitter {
  allLocations = new Set(Array.from({ length: 20 }, (_, i) => i + 1));
  checked = new Set<number>();
  ready = true;
  problem: string | null = null;
  slot = 1;
  scouted: number[][] = [];
  goalsReported = 0;
  locationName(id: number) { return `Location ${id}`; }
  reportGoal() { this.goalsReported++; return Promise.resolve(true); }
  scout(ids: number[]) { this.scouted.push(ids); }
  // The server confirming checks, as RoomUpdate would.
  confirm(ids: number[]) {
    const fresh = ids.filter((id) => !this.checked.has(id));
    for (const id of fresh) this.checked.add(id);
    if (fresh.length) { this.emit("checked", fresh); this.emit("change"); }
  }
}

// (A function, so asserting `closed` was null earlier doesn't narrow later reads.)
const closeCode = (c: FakeConn) => c.closed?.code;

class FakeConn implements ProxyConn {
  closed: { code: number; reason: string } | null = null;
  // Whether the client is still there to answer a ping.
  alive = true;
  close(code: number, reason: string) { this.closed = { code, reason }; }
  answers() { return Promise.resolve(this.alive && !this.closed); }
}

const config = {
  checkLimit: 3,
  graceMs: 60_000,
  offerMs: 60_000,
  queueAbsentMs: 60_000,
  admins: new Set<string>(),
  apUrl: "ws://test/archipelago",
  apPublicAddress: "test:80",
} as Config;
const seed = { slotName: "Player1", game: "Pokemon Crystal", hash: "0123456789abcdef0123" } as Seed;

let db: Db;
let observer: FakeObserver;
let game: Game;

beforeEach(() => {
  db = new Db(":memory:");
  observer = new FakeObserver();
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  for (const id of ["a", "b"]) db.upsertUser({ id, name: id.toUpperCase(), avatar: null });
});
afterEach(() => { game.stop(); db.close(); });

const tick = () => new Promise((r) => setImmediate(r));

// Start a's turn and connect a game client for it.
function startA() {
  game.join("a");
  game.start("a");
  const conn = new FakeConn();
  game.attach(conn);
  game.connected(conn, "game", 1);
  return conn;
}

test("joining offers the turn, starting uses the attempt", () => {
  game.join("a");
  assert.deepEqual(game.youFor("a")!.offer !== null, true);
  game.start("a");
  assert.equal(db.user("a")!.attempt_used, 1);
  assert.ok(game.youFor("a")!.session);
  assert.throws(() => game.join("a"), /already had your turn/);
});

test("the next player waits in the queue until the turn is over", () => {
  startA();
  game.join("b");
  assert.equal(game.youFor("b")!.position, 1);
  assert.equal(game.youFor("b")!.offer, null);
  game.giveUp("a");
  assert.ok(game.youFor("b")!.offer);
});

test("checks beyond the limit are never forwarded, and the session ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const conn = startA();
  // Batch crossing the limit of 3: only three go to the server.
  assert.deepEqual(game.checks(conn, [1, 2, 3, 4, 5]), [1, 2, 3]);
  // Nothing else goes through while the last ones are confirmed.
  assert.deepEqual(game.checks(conn, [6]), []);
  assert.equal(game.gameOpen(conn), false);
  observer.confirm([1, 2, 3]);
  t.mock.timers.tick(2000);
  assert.equal(game.youFor("a")!.session, null);
  assert.equal(game.youFor("a")!.lastSession!.reason, "quota");
  assert.deepEqual(conn.closed?.code, 4000);
  assert.equal(game.credentials(), null);
});

test("already-checked locations don't count", () => {
  observer.confirm([1, 2]);
  const conn = startA();
  assert.deepEqual(game.checks(conn, [1, 2, 3]), [3]);
  observer.confirm([3]);
  assert.equal(game.youFor("a")!.session!.checks, 1);
});

test("unconfirmed checks keep counting, and re-sends go through without counting twice", () => {
  const conn = startA();
  assert.deepEqual(game.checks(conn, [1, 2]), [1, 2]);
  // The server hasn't confirmed 1 and 2: the client sends them again with a
  // new one. Only one more fits the limit of 3.
  assert.deepEqual(game.checks(conn, [1, 2, 4, 5]), [1, 2, 4]);
  assert.equal(game.gameOpen(conn), false);
});

test("a newer connection in the same role replaces the old one once the server accepts it", () => {
  const first = startA();
  const second = new FakeConn();
  game.attach(second);
  assert.equal(first.closed, null, "not before the server has accepted the new login");
  game.connected(second, "game", 1);
  assert.equal(closeCode(first), 4001);
  assert.ok(game.youFor("a")!.session);
  // The replaced connection can no longer check anything.
  assert.deepEqual(game.checks(first, [1]), []);
});

test("a second PopTracker while the first still answers ends the turn", async () => {
  const conn = startA();
  const first = new FakeConn();
  game.attach(first);
  game.connected(first, "tracker", 1);
  const second = new FakeConn();
  game.attach(second);
  game.connected(second, "tracker", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(game.youFor("a")!.session, null);
  assert.equal(game.youFor("a")!.lastSession!.reason, "violation");
  for (const c of [conn, first, second]) assert.equal(c.closed?.code, 4000);
});

test("PopTracker reconnecting over a dead socket replaces it", async () => {
  const conn = startA();
  const first = new FakeConn();
  game.attach(first);
  game.connected(first, "tracker", 1);
  first.alive = false;
  const second = new FakeConn();
  game.attach(second);
  game.connected(second, "tracker", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(closeCode(first), 4001);
  assert.equal(second.closed, null);
  assert.equal(conn.closed, null);
  assert.ok(game.youFor("a")!.session!.trackerConnected);
});

test("a violation ends the session and closes every connection", () => {
  const conn = startA();
  const tracker = new FakeConn();
  game.attach(tracker);
  game.violation("text client");
  assert.equal(conn.closed?.code, 4000);
  assert.equal(tracker.closed?.code, 4000);
  assert.equal(game.youFor("a")!.lastSession!.reason, "violation");
  assert.equal(game.credentials(), null);
});

test("staying disconnected past the grace period ends the session", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.detach(conn);
  assert.ok(game.youFor("a")!.session!.graceEndsAt);
  t.mock.timers.tick(59_000);
  const back = new FakeConn();
  game.attach(back);
  game.connected(back, "game", 1);
  assert.equal(game.youFor("a")!.session!.graceEndsAt, null);
  game.detach(back);
  t.mock.timers.tick(60_001);
  assert.equal(game.youFor("a")!.lastSession!.reason, "grace");
});

test("logging into a different slot is a violation", () => {
  game.join("a");
  game.start("a");
  const conn = new FakeConn();
  game.attach(conn);
  game.connected(conn, "game", 2);
  assert.equal(game.youFor("a")!.lastSession!.reason, "violation");
});

test("an offer that isn't taken passes on without using the attempt", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  game.join("a");
  game.join("b");
  t.mock.timers.tick(60_001);
  assert.equal(db.user("a")!.attempt_used, 0);
  assert.equal(game.youFor("a")!.offer, null);
  assert.ok(game.youFor("b")!.offer);
});

test("finds are recorded with the session and named by scouts", async () => {
  const conn = startA();
  game.checks(conn, [7]);
  observer.confirm([7]);
  observer.emit("scouted", [{ location: 7, item: "Surf", receiver: null }]);
  await tick();
  const finds = game.youFor("a")!.session!.finds;
  assert.deepEqual(finds.map((f) => [f.location, f.item]), [["Location 7", "Surf"]]);
  assert.deepEqual(game.publicState().recent.map((f) => f.who.id), ["a"]);
});

test("a running session survives a server restart", () => {
  const conn = startA();
  game.checks(conn, [1]);
  observer.confirm([1]);
  const creds = game.credentials()!;
  game.stop();
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  assert.deepEqual(game.credentials(), creds);
  assert.equal(game.youFor("a")!.session!.checks, 1);
});

test("banning a player ends their turn", () => {
  startA();
  game.setBanned("a", true);
  assert.equal(game.youFor("a")!.lastSession!.reason, "admin");
  assert.throws(() => game.join("a"), /can't take part/);
});

test("a goal from the game completes the event: the turn ends and nobody gets another", () => {
  const conn = startA();
  game.join("b");
  game.claimGoal(conn);
  assert.equal(game.youFor("a")!.lastSession!.reason, "goal");
  assert.equal(game.publicState().complete, true);
  assert.equal(game.youFor("b")!.offer, null);
  assert.equal(game.youFor("b")!.inQueue, false, "the queue is cleared");
  assert.throws(() => game.join("b"), /goal is complete/);
  assert.equal(observer.goalsReported, 1, "the goal reaches MultiServer too");
});

test("a goal still waiting for an admin from before carries on as complete", () => {
  startA();
  const id = game.youFor("a")!.session!.id;
  game.stop();
  db.endSession(id, "gave-up", null, Date.now());
  db.set("goal_claim", JSON.stringify({ sessionId: id, userId: "a", at: Date.now(), wasPaused: false }));
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  assert.equal(game.publicState().complete, true);
  assert.equal(game.youFor("a")!.lastSession!.reason, "goal");
  assert.equal(db.get("goal_claim"), null);
});

test("pausing withdraws an offer without using it, and blocks starting", () => {
  game.join("a");
  game.join("b");
  game.setPaused(true);
  assert.equal(game.youFor("a")!.offer, null);
  assert.equal(game.youFor("a")!.position, 1);
  assert.throws(() => game.start("a"), /isn't your turn|paused/);
  game.setPaused(false);
  assert.ok(game.youFor("a")!.offer);
  assert.equal(db.user("a")!.attempt_used, 0);
});

test("a late check from the previous turn isn't charged to the next one", () => {
  const conn = startA();
  game.checks(conn, [5]);
  game.giveUp("a");
  game.join("b");
  game.start("b");
  observer.confirm([5]);
  assert.equal(game.youFor("b")!.session!.checks, 0);
  assert.deepEqual(game.youFor("a")!.lastSession!.finds.map((f) => f.location), ["Location 5"]);
});

test("the grace period stops while the game server is down", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.detach(conn);
  observer.ready = false;
  observer.emit("change");
  assert.equal(game.youFor("a")!.session!.graceEndsAt, null);
  t.mock.timers.tick(10 * 60_000);
  assert.ok(game.youFor("a")!.session, "an outage doesn't end the turn");
  observer.ready = true;
  observer.emit("change");
  assert.ok(game.youFor("a")!.session!.graceEndsAt, "a fresh grace period once it's back");
  t.mock.timers.tick(60_001);
  assert.equal(game.youFor("a")!.lastSession!.reason, "grace");
});

test("once out of checks, only re-sends of counted checks go through", () => {
  const conn = startA();
  assert.deepEqual(game.checks(conn, [1, 2, 3]), [1, 2, 3]);
  // The server blipped before confirming: the reconnected client re-sends.
  const back = new FakeConn();
  game.attach(back);
  game.connected(back, "game", 1);
  assert.deepEqual(game.checks(back, [3, 4]), [3]);
});

test("a session restored at its limit ends on the quota", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const conn = startA();
  game.checks(conn, [1, 2, 3]);
  observer.confirm([1, 2, 3]);
  game.stop();
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  t.mock.timers.tick(2000);
  assert.equal(game.youFor("a")!.lastSession!.reason, "quota");
});

test("admin actions only hit the turn or offer they name", () => {
  const conn = startA();
  const id = game.credentials()!.sessionId;
  game.join("b");
  assert.throws(() => game.endSession("someone-else", "x"), /already ended/);
  game.endSession(id, "ended by admin");
  assert.equal(conn.closed?.code, 4000);
  assert.throws(() => game.skipOffer("a"), /already gone/);
  game.skipOffer("b");
  assert.equal(game.youFor("b")!.offer, null);
});

test("the quota wait doesn't end a turn while its last checks can't land", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.checks(conn, [1, 2, 3]);
  // The server goes down before confirming: the turn waits for it.
  game.detach(conn);
  observer.ready = false;
  observer.emit("change");
  t.mock.timers.tick(60_000);
  assert.ok(game.youFor("a")!.session);
  // Back up, the game reconnects and the checks land.
  observer.ready = true;
  observer.emit("change");
  const back = new FakeConn();
  game.attach(back);
  game.connected(back, "game", 1);
  observer.confirm([1, 2, 3]);
  t.mock.timers.tick(2000);
  assert.equal(game.youFor("a")!.lastSession!.reason, "quota");
  assert.equal(game.youFor("a")!.lastSession!.finds.length, 3);
});

test("checks the server lost in a restart are re-sent, not counted again", () => {
  const conn = startA();
  game.checks(conn, [1, 2]);
  observer.confirm([1, 2]);
  // MultiServer restarts from a save that predates check 2.
  observer.checked.delete(2);
  assert.deepEqual(game.checks(conn, [2, 4]), [2, 4]);
  assert.equal(game.gameOpen(conn), false, "2 counted once + 4 = the limit of 3");
});

test("checks that landed while the server was stopping are recorded on restart", () => {
  const conn = startA();
  game.checks(conn, [1]);
  observer.confirm([1]);
  game.stop();
  // Check 2 reached MultiServer, but this server never heard about it.
  observer.checked.add(2);
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  observer.emit("change");
  assert.equal(game.youFor("a")!.session!.checks, 2);
});

test("nothing new is accepted once the server is shutting down", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.stop();
  assert.equal(game.serverReady, false);
  assert.deepEqual(game.checks(conn, [1]), []);
  game.detach(conn);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(db.openSession()?.user_id, "a", "the session stays open for the restart");
});

test("an offered turn waits out a game server outage", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  game.join("a");
  game.join("b");
  observer.ready = false;
  observer.emit("change");
  assert.equal(game.youFor("a")!.offer, null);
  assert.equal(game.youFor("a")!.position, 1, "back at the head of the line");
  t.mock.timers.tick(10 * 60_000);
  observer.ready = true;
  observer.emit("change");
  assert.ok(game.youFor("a")!.offer, "offered again, with a fresh clock");
});

test("a previous turn's re-sent checks stay with that turn", () => {
  const conn = startA();
  game.checks(conn, [1, 2]);
  observer.confirm([1, 2]);
  observer.checked.delete(2); // lost in a MultiServer restart
  game.giveUp("a");
  game.join("b");
  game.start("b");
  observer.confirm([2]); // a's re-send lands now
  assert.equal(game.youFor("b")!.session!.checks, 0);
});

test("closing a connection that never logged in changes nothing", () => {
  const conn = startA();
  const stranger = new FakeConn();
  game.detach(stranger);
  assert.equal(game.youFor("a")!.session!.gameConnected, true);
  assert.equal(conn.closed, null);
});

test("an ended turn's unconfirmed check is its own however late it lands", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.checks(conn, [5]);
  game.giveUp("a");
  game.join("b");
  game.start("b");
  // Well past the old 10s allowance (and inside b's grace period).
  t.mock.timers.tick(30_000);
  observer.confirm([5]);
  assert.equal(game.youFor("b")!.session!.checks, 0);
  assert.deepEqual(game.youFor("a")!.lastSession!.finds.map((f) => f.location), ["Location 5"]);
});

test("a turn out of checks that loses its connection still ends on its quota", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.checks(conn, [1, 2, 3]);
  game.detach(conn);
  t.mock.timers.tick(60_001);
  assert.equal(game.youFor("a")!.lastSession!.reason, "quota");
});

test("a location an ended turn never got confirmed is the next player's once they check it", () => {
  const conn = startA();
  game.checks(conn, [5]);
  game.giveUp("a"); // 5 never landed: a's game is gone
  game.join("b");
  game.start("b");
  const b = new FakeConn();
  game.attach(b);
  game.connected(b, "game", 1);
  assert.deepEqual(game.checks(b, [5]), [5]);
  observer.confirm([5]);
  assert.equal(game.youFor("b")!.session!.checks, 1, "counted for b");
  assert.deepEqual(game.youFor("b")!.session!.finds.map((f) => f.location), ["Location 5"]);
});

test("a restored turn at its limit waits for the server before ending", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  game.checks(conn, [1, 2, 3]);
  observer.confirm([1, 2, 3]);
  game.stop();
  observer.ready = false;
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  t.mock.timers.tick(30_000);
  assert.ok(game.youFor("a")!.session, "not ended while the server can't be seen");
  observer.ready = true;
  observer.emit("change");
  t.mock.timers.tick(7_000);
  assert.equal(game.youFor("a")!.lastSession!.reason, "quota");
});

test("a login the server refuses doesn't knock the working connection off", () => {
  const working = startA();
  const refused = new FakeConn();
  game.attach(refused);
  game.detach(refused); // MultiServer said no; the proxy closed it
  assert.equal(working.closed, null);
  assert.equal(game.youFor("a")!.session!.gameConnected, true);
});

test("the running turn's join token is recognised, and only while it runs", async () => {
  const { joinToken } = await import("../src/game.ts");
  startA();
  const url = game.youFor("a")!.session!.credentials.apUrl;
  const token = new URL(url).searchParams.get("join");
  assert.ok(game.isJoinToken(token));
  assert.equal(token, joinToken(game.credentials()!.gamePassword));
  assert.ok(!game.isJoinToken("nope"));
  game.giveUp("a");
  assert.ok(!game.isJoinToken(token));
});

test("an ended turn's unconfirmed checks are still its own after a restart", () => {
  const conn = startA();
  game.checks(conn, [5]);
  game.giveUp("a");
  game.stop();
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  game.join("b");
  game.start("b");
  observer.confirm([5]);
  assert.equal(game.youFor("b")!.session!.checks, 0);
  assert.deepEqual(game.youFor("a")!.lastSession!.finds.map((f) => f.location), ["Location 5"]);
});

test("an offer withdrawn while its player's page is closed still lets the sweeper drop them", (t) => {
  // Stop the shared game while the real clock is still in place (its
  // intervals are real), then make one under the mocked clock so its sweeper
  // runs on it.
  game.stop();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  game.join("a");
  game.join("b");
  // a has no page open (nothing called addLive). The game server goes down.
  observer.ready = false;
  observer.emit("change");
  t.mock.timers.tick(61_000 + 5_000);
  assert.equal(game.youFor("a")!.position, null, "swept from the queue");
});

test("a goal report that fails is retried while the server stays up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const conn = startA();
  let answers = [false, true];
  observer.reportGoal = () => { observer.goalsReported++; return Promise.resolve(answers.shift()!); };
  game.claimGoal(conn);
  await tick();
  assert.equal(observer.goalsReported, 1);
  t.mock.timers.tick(30_000);
  await tick();
  assert.equal(observer.goalsReported, 2, "tried again without the observer reconnecting");
  assert.equal(db.get("goal_unreported"), null);
});

test("a check that landed during a shutdown goes to the ended turn that sent it", () => {
  observer.emit("change"); // the observer's first view at startup: the baseline
  const conn = startA();
  game.checks(conn, [5]);
  game.giveUp("a");
  game.join("b");
  game.start("b");
  game.stop();
  observer.checked.add(5); // landed while the server was down
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  observer.emit("change");
  assert.equal(game.youFor("b")!.session!.checks, 0);
  assert.deepEqual(game.youFor("a")!.lastSession!.finds.map((f) => f.location), ["Location 5"]);
});

test("joining the queue again doesn't restart the absence clock", (t) => {
  game.stop();
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  game = new Game(config, db, seed, observer as unknown as Observer, () => {});
  game.join("a");
  game.join("b");
  t.mock.timers.tick(40_000);
  game.join("b");
  t.mock.timers.tick(30_000);
  assert.equal(game.youFor("b")!.position, null, "dropped after 60s away, rejoin or not");
});

test("a turn gets longer to make its first connection than to come back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  game.join("a");
  game.start("a");
  t.mock.timers.tick(4 * 60_000); // setting up on a slow device
  assert.ok(game.youFor("a")!.session, "not over before the game ever connected");
  const conn = new FakeConn();
  game.attach(conn);
  game.connected(conn, "game", 1);
  game.detach(conn);
  t.mock.timers.tick(60_001); // the normal grace period, once it has connected
  assert.equal(game.youFor("a")!.lastSession!.reason, "grace");
});

test("only the device that last claimed the turn may log its game in", () => {
  startA();
  assert.ok(game.holdsPlay("anything"), "before any claim (e.g. after a restart), any device");
  const phone = game.claimPlay("a");
  const laptop = game.claimPlay("a");
  assert.ok(game.holdsPlay(laptop));
  assert.ok(!game.holdsPlay(phone), "the device it was taken from can't take it back");
  assert.throws(() => game.claimPlay("b"), /don't have a turn/);
});

test("a device resuming by itself only gets the turn back if nobody claimed it since", () => {
  startA();
  const first = game.claimPlay("a", null);
  assert.equal(game.claimPlay("a", first) !== first, true, "resuming with its own claim");
  const phone = game.claimPlay("a");
  const laptop = game.claimPlay("a");
  assert.throws(() => game.claimPlay("a", phone), /another device/, "the phone reloads after the laptop took over");
  assert.throws(() => game.claimPlay("a", null), /another device/, "a device that never had a claim");
  assert.ok(game.holdsPlay(laptop), "the laptop keeps it");
  assert.ok(game.holdsPlay(game.claimPlay("a")), "asking to play here still takes it over");
});
