import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { classifyConnect, filterBeforeConnect, filterCommand, parsePacket, selectNewChecks, STORAGE_OPERATIONS, storageKind } from "../src/rules.ts";
import { loadSignNames } from "../src/seed.ts";

const creds = { gamePassword: "game-pw", trackerPassword: "tracker-pw" };
const GAME = "Pokemon Crystal";
const SLOT = { name: "Player1", game: GAME };
// Data storage commands reach the logged-in slot: team 0, slot 1.
const SCOPE = { team: 0, slot: 1, signs: new Set(["Route32", "Route32Ruins"]) };
const set = (key: string, operations: object[], extra: object = {}) => ({ cmd: "Set", key, operations, ...extra });
// A wonder trade offer as pokemon_data_to_json writes it.
const offer = (over: object = {}) => JSON.stringify({
  version: "1", personality: 12345 << 16 | 25, nickname: "PIKACHU", language: "English", species: 25, experience: 1000,
  ability: 0, ivs: [31, 1, 3, 5, 7, 7], evs: [0, 0, 0, 0, 0, 0], conditions: [0, 0, 0, 0, 0, 0], pokerus: 0,
  location_met: 254, level_met: 5, game: 0, ball: 4, moves: [[84, 30, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
  trainer: { name: "GOLD", id: 12345, female: false }, item: 7, ...over,
});

// What the clients actually send (see the PopTracker and CommonClient sources).
const crystalConnect = (over: object = {}) => ({
  cmd: "Connect", password: "game-pw", game: GAME, name: "QVBDUllTVEFM", tags: ["AP"],
  items_handling: 3, uuid: "x", version: { major: 0, minor: 6, build: 8, class: "Version" }, slot_data: true, ...over,
});
const popTrackerConnect = (over: object = {}) => ({
  cmd: "Connect", password: "tracker-pw", game: "", name: "Player1", tags: ["PopTracker", "NoText", "Tracker"],
  items_handling: 7, uuid: "0123456789abcdef", version: { major: 0, minor: 5, build: 1, class: "Version" }, slot_data: true, ...over,
});

test("the game client is accepted with the game password", () => {
  assert.deepEqual(classifyConnect(crystalConnect(), creds, SLOT), { kind: "accept", role: "game" });
});

test("PopTracker is accepted with the tracker password", () => {
  assert.deepEqual(classifyConnect(popTrackerConnect(), creds, SLOT), { kind: "accept", role: "tracker" });
});

test("a mistyped slot in PopTracker is refused, not a violation", () => {
  assert.deepEqual(classifyConnect(popTrackerConnect({ name: "Player2" }), creds, SLOT), { kind: "refuse", error: "InvalidSlot" });
});

test("wrong or stale passwords are refused, not violations", () => {
  assert.equal(classifyConnect(crystalConnect({ password: "old" }), creds, SLOT).kind, "refuse");
  assert.equal(classifyConnect(crystalConnect({ password: null }), creds, SLOT).kind, "refuse");
  assert.equal(classifyConnect(crystalConnect(), null, SLOT).kind, "refuse");
});

test("other clients using the tracker password are violations", () => {
  // The Archipelago text client.
  assert.equal(classifyConnect(popTrackerConnect({ tags: ["AP", "TextOnly"] }), creds, SLOT).kind, "violation");
  // Universal Tracker.
  assert.equal(classifyConnect(popTrackerConnect({ tags: ["AP", "Tracker"] }), creds, SLOT).kind, "violation");
  // A real game client, e.g. BizHawk.
  assert.equal(classifyConnect(crystalConnect({ password: "tracker-pw" }), creds, SLOT).kind, "violation");
  // PopTracker with a manual pack, which can send checks.
  assert.equal(classifyConnect(popTrackerConnect({ tags: ["PopTracker", "NoText"], game: GAME }), creds, SLOT).kind, "violation");
});

test("non-game clients using the game password are violations", () => {
  assert.equal(classifyConnect(crystalConnect({ tags: ["AP", "Tracker"] }), creds, SLOT).kind, "violation");
  assert.equal(classifyConnect(crystalConnect({ game: "" }), creds, SLOT).kind, "violation");
  assert.equal(classifyConnect(crystalConnect({ game: "A Link to the Past" }), creds, SLOT).kind, "violation");
});

test("only GetDataPackage passes before Connect", () => {
  assert.equal(filterBeforeConnect({ cmd: "GetDataPackage", games: [GAME] }).action, "forward");
  for (const cmd of ["LocationChecks", "Say", "Sync", "Get"]) assert.equal(filterBeforeConnect({ cmd }).action, "drop");
});

test("nobody can chat, hint or run ! commands", () => {
  for (const role of ["game", "tracker"] as const) {
    for (const text of ["hello", "!hint Surf", "!release", "!collect", "!getitem Surf", "!admin login x", "!options"]) {
      assert.equal(filterCommand(role, { cmd: "Say", text }).action, "drop", `${role} ${text}`);
    }
    assert.equal(filterCommand(role, { cmd: "CreateHints", locations: [1] }).action === "forward", false);
    assert.equal(filterCommand(role, { cmd: "UpdateHint", player: 1, location: 1 }).action === "forward", false);
  }
});

test("the game client's scouts never create hints", () => {
  const v = filterCommand("game", { cmd: "LocationScouts", locations: [1, 2], create_as_hint: 2 });
  assert.equal(v.action, "forward");
  assert.equal((v as any).cmd.create_as_hint, 0);
  assert.deepEqual((v as any).cmd.locations, [1, 2]);
});

test("the game client's checks go through the quota", () => {
  assert.deepEqual(filterCommand("game", { cmd: "LocationChecks", locations: [5] }), { action: "checks", locations: [5] });
});

test("a goal from the game client is held for an admin, other statuses pass", () => {
  assert.deepEqual(filterCommand("game", { cmd: "StatusUpdate", status: 30 }), { action: "goal" });
  assert.equal(filterCommand("game", { cmd: "StatusUpdate", status: 20 }).action, "forward");
});

test("the game client may play normally", () => {
  for (const cmd of ["Sync", "Get", "Bounce", "GetDataPackage"]) {
    assert.equal(filterCommand("game", { cmd }).action, "forward", cmd);
  }
  // The Crystal client's own data storage writes (client*.py), as it sends them.
  const writes = [
    set("pokemon_crystal_events_0_1", [{ operation: "or", value: 5 }], { default: 0, want_reply: false }),
    set("pokemon_crystal_sync_events_0_1", [{ operation: "or", value: 5 }], { default: 0, want_reply: 2 }),
    set("pokemon_crystal_caught_pokemon_0_1", [{ operation: "update", value: [1, 4, 251] }], { default: [], want_reply: 2 }),
    set("pokemon_crystal_warps_0_1", [{ operation: "update", value: [8242] }], { default: [], want_reply: false }),
    set("pokemon_crystal_unowns_0_1", [{ operation: "replace", value: [3, 1] }], { default: [] }),
    set("pokemon_crystal_signs_0_1", [{ operation: "update", value: ["Route32"] }], { default: [] }),
    set("pokemon_crystal_all_pokemon_seen_0_1", [{ operation: "replace", value: true }], { default: false }),
    set("EnergyLink0", [{ operation: "add", value: -1200 }, { operation: "max", value: 0 }], { default: 0 }),
    set("pokemon_wonder_trades_0", [{ operation: "update", value: { _lock: 1760000000000 } }], { default: { _lock: 0 }, want_reply: true, uuid: "abc" }),
    set("pokemon_wonder_trades_0", [{ operation: "update", value: { _lock: 0, "3": [12345, offer()] } }], { default: { _lock: 0 } }),
    set("pokemon_wonder_trades_0", [{ operation: "update", value: { _lock: 0, "255": [12345, offer({ nickname: "♂é" })] } }], { default: { _lock: 0 } }),
    set("pokemon_crystal_battle_tower_0_1", [{ operation: "update", value: [0, 15] }], { default: [], want_reply: 2 }),
    set("pokemon_crystal_unlocked_unowns_0_1", [{ operation: "or", value: 255 }], { default: 0, want_reply: false }),
    set("pokemon_wonder_trades_0", [{ operation: "update", value: { _lock: 0 } }, { operation: "pop", value: "3" }], { default: { _lock: 0 } }),
    set("pokemon_wonder_trades_0", [{ operation: "default", value: null }], { default: { _lock: 0 } }),
  ];
  for (const write of writes) {
    const v = filterCommand("game", write, false, SCOPE);
    assert.deepEqual(v, { action: "forward", cmd: write }, JSON.stringify(write));
  }
  assert.deepEqual(filterCommand("game", { cmd: "SetNotify", keys: ["pokemon_crystal_warps_0_1", "EnergyLink0", "_read_hints_0_1"] }, false, SCOPE),
    { action: "forward", cmd: { cmd: "SetNotify", keys: ["pokemon_crystal_warps_0_1", "EnergyLink0", "_read_hints_0_1"] } });
  assert.equal(filterCommand("game", { cmd: "ConnectUpdate", tags: ["AP", "DeathLink"] }).action, "forward");
  assert.equal(filterCommand("game", { cmd: "ConnectUpdate", tags: ["AP", "Tracker"] }).action, "violation");
});

test("PopTracker may only read", () => {
  for (const cmd of ["Get", "Sync", "GetDataPackage"]) assert.equal(filterCommand("tracker", { cmd }).action, "forward", cmd);
  assert.equal(filterCommand("tracker", { cmd: "SetNotify", keys: ["pokemon_crystal_events_0_1", "_read_hints_0_1"] }, false, SCOPE).action, "forward");
  for (const cmd of ["LocationChecks", "StatusUpdate", "Set", "LocationScouts"]) assert.equal(filterCommand("tracker", { cmd }).action, "violation", cmd);
  for (const cmd of ["Bounce", "ConnectUpdate", "Unknown"]) assert.equal(filterCommand("tracker", { cmd }).action, "drop", cmd);
});

test("selectNewChecks keeps new, valid, unique checks within the remaining quota", () => {
  const valid = new Set([1, 2, 3, 4, 5, 6]);
  const checked = new Set([1]);
  const pending = new Set([2]);
  assert.deepEqual(selectNewChecks([1, 2, 3, 3, 99, 4, 5], { valid, checked, pending, remaining: 2 }), [3, 4]);
  assert.deepEqual(selectNewChecks([3, 4], { valid, checked, pending, remaining: 0 }), []);
  assert.deepEqual(selectNewChecks("nope", { valid, checked, pending, remaining: 5 }), []);
  assert.deepEqual(selectNewChecks([3.5, "4", null, 6], { valid, checked, pending, remaining: 5 }), [6]);
});

test("a malformed cookie is ignored rather than thrown", async () => {
  const { parseCookies } = await import("../src/auth.ts");
  const req = { headers: { cookie: "bad=%E0%A4%A; yogos_session=abc" } } as any;
  assert.deepEqual(parseCookies(req), { yogos_session: "abc" });
});

test("once a game's turn is out of checks, only reads, re-sends and a goal report go", () => {
  for (const cmd of ["Get", "Sync", "GetDataPackage"]) assert.equal(filterCommand("game", { cmd }, true).action, "forward", cmd);
  assert.equal(filterCommand("game", { cmd: "SetNotify", keys: ["EnergyLink0"] }, true, SCOPE).action, "forward");
  assert.equal(filterCommand("game", { cmd: "LocationChecks", locations: [1] }, true).action, "checks");
  assert.equal(filterCommand("game", { cmd: "StatusUpdate", status: 30 }, true).action, "goal");
  for (const cmd of ["Set", "Bounce", "LocationScouts", "ConnectUpdate"]) assert.equal(filterCommand("game", { cmd }, true).action, "drop", cmd);
  assert.equal(filterCommand("game", set("pokemon_crystal_events_0_1", [{ operation: "or", value: 1 }], { default: 0 }), true, SCOPE).action, "drop");
});

test("data storage writes outside what the Crystal client sends are dropped", () => {
  const drop = (cmd: object, why: string) => assert.equal(filterCommand("game", cmd, false, SCOPE).action, "drop", why);
  // Operations that never finish, or grow what's stored without bound.
  for (const operation of ["pow", "mul", "left_shift", "mod", "add", "nope"]) {
    drop(set("pokemon_crystal_events_0_1", [{ operation, value: 1e12 }], { default: 0 }), operation);
  }
  drop(set("EnergyLink0", [{ operation: "add", value: "x".repeat(1000) }], { default: 0 }), "string concatenation");
  drop(set("pokemon_crystal_warps_0_1", [{ operation: "add", value: [1, 2, 3] }], { default: [] }), "list concatenation");
  // Without a starting value MultiServer starts from 0, which `default`
  // would store in a list's key for good.
  drop(set("pokemon_crystal_battle_tower_0_1", [{ operation: "default", value: null }]), "default with no starting value");
  drop(set("pokemon_crystal_events_0_1", [{ operation: "or", value: 1 }]), "no starting value");
  // Keys it doesn't write, or another slot's.
  for (const key of ["x", "pokemon_crystal_events_0_2", "pokemon_crystal_madeup_0_1", "EnergyLink1", "pokemon_crystal___proto___0_1", "_read_client_status_0_1"]) {
    drop(set(key, [{ operation: "replace", value: true }], { default: false }), key);
  }
  assert.equal(filterCommand("game", set("pokemon_crystal_events_0_1", [{ operation: "or", value: 1 }], { default: 0 })).action, "drop", "no scope yet");
  // Integers too wide to store, ids out of range, names it doesn't have.
  const huge = parsePacket(`[${"9".repeat(41)}]`) as unknown[];
  const d0 = { default: 0 }, dl = { default: [] }, dt = { default: { _lock: 0 } };
  drop(set("pokemon_crystal_events_0_1", [{ operation: "or", value: huge[0] }], d0), "41 digits");
  drop(set("pokemon_crystal_events_0_1", [{ operation: "or", value: (parsePacket(`[${2n ** 128n}]`) as unknown[])[0] }], d0), "2^128");
  drop(set("pokemon_crystal_events_0_1", [{ operation: "or", value: -1 }], d0), "negative");
  drop(set("pokemon_crystal_events_0_1", [{ operation: "or", value: 1.5 }], d0), "fraction");
  drop(set("pokemon_crystal_unlocked_unowns_0_1", [{ operation: "or", value: 256 }], d0), "more than a byte");
  drop(set("pokemon_crystal_warps_0_1", [{ operation: "update", value: [16384] }], dl), "id out of range");
  drop(set("pokemon_crystal_warps_0_1", [{ operation: "update", value: [5, 5] }], dl), "repeated ids");
  drop(set("pokemon_crystal_battle_tower_0_1", [{ operation: "update", value: [16] }], dl), "a tier the game hasn't room for");
  drop(set("pokemon_crystal_unowns_0_1", [{ operation: "replace", value: [27] }], dl), "an Unown that doesn't exist");
  drop(set("pokemon_crystal_unowns_0_1", [{ operation: "update", value: [0] }], dl), "Unown 0");
  drop(set("pokemon_crystal_seen_pokemon_0_1", [{ operation: "update", value: [257] }], dl), "dex number out of range");
  drop(set("pokemon_crystal_signs_0_1", [{ operation: "update", value: ["NotASign"] }], dl), "unknown sign");
  drop(set("pokemon_crystal_signs_0_1", [{ operation: "update", value: ["Route32", "Route32"] }], dl), "repeated sign");
  drop(set("pokemon_crystal_all_pokemon_seen_0_1", [{ operation: "replace", value: 1 }], { default: false }), "not a boolean");
  drop(set("EnergyLink0", [{ operation: "add", value: 2 ** 60 }], d0), "unsafe integer");
  drop(set("pokemon_crystal_events_0_1", [{ operation: "or", value: 1 }], dl), "default of the wrong shape");
  // The wonder trade pool: a lock and a few numbered offers the receiver can read.
  const trade = (value: object) => set("pokemon_wonder_trades_0", [{ operation: "update", value }], dt);
  drop(trade({ "1": [1, "[]"] }), "an offer that isn't a Pokémon");
  drop(trade({ "1": [1, "{"] }), "an offer that isn't JSON");
  drop(trade({ "1": [1, offer({ moves: [["x"]] })] }), "a move that isn't a number");
  drop(trade({ "1": [1, offer({ species: 0 })] }), "a species nobody could take");
  drop(trade({ "1": [1, offer({ moves: [[0, 0, 0], [252, 5, 0]] })] }), "no move anybody could use");
  drop(trade({ "05": [1, offer()] }), "a slot number Python wouldn't write");
  drop(trade({ "256": [1, offer()] }), "a slot number past the pool's size");
  drop(trade({ "1": [1, offer().replace('"ivs":[31,', '"ivs":[31.0,')] }), "a number Python reads as a float");
  drop(trade({ "1": [1, offer().replace('"ivs":[31,', '"ivs":[3.1e1,')] }), "an exponent");
  drop(trade({ "1": [1, offer({ nickname: "A\ud800" })] }), "a lone surrogate in an offer");
  drop(trade({ "1": [1, offer({ extra: "x".repeat(100) })] }), "a field it doesn't write");
  drop(trade({ "1": [1, offer({ nickname: "x".repeat(65) })] }), "a long nickname");
  drop(trade({ "1": [1, JSON.stringify({ species: 25 })] }), "fields missing");
  drop(trade({ "1": [70000, offer()] }), "trainer id out of range");
  drop(trade({ "1": [1, offer()], "2": [1, offer()], "3": [1, offer()], "4": [1, offer()], "5": [1, offer()] }), "too many offers");
  drop(trade([1, 2]), "not a pool");
  drop(set("pokemon_wonder_trades_0", [{ operation: "pop", value: "_lock" }], dt), "popping the lock");
  drop(set("pokemon_crystal_events_0_1", Array(5).fill({ operation: "or", value: 1 }), d0), "too many operations");
  drop(set("pokemon_crystal_events_0_1", [], d0), "no operations");
  drop(set("pokemon_wonder_trades_0", [{ operation: "default", value: null }], { default: { "1": [1, "x".repeat(5000)] } }), "oversized default");
  assert.deepEqual((filterCommand("game", set("EnergyLink0", [{ operation: "default", value: "x".repeat(1000) }], d0), false, SCOPE) as any).cmd.operations,
    [{ operation: "default", value: null }], "default's value is ignored, so isn't passed on");
});

test("a forwarded write carries only the fields it checked", () => {
  const v = filterCommand("game", set("pokemon_crystal_events_0_1", [{ operation: "or", value: 1, junk: "x".repeat(1000) }], { default: 0, padding: "x".repeat(1000), uuid: "y".repeat(65) }), false, SCOPE);
  assert.deepEqual(v, { action: "forward", cmd: { cmd: "Set", key: "pokemon_crystal_events_0_1", default: 0, operations: [{ operation: "or", value: 1 }] } });
});

test("only the slot's own keys can be watched", () => {
  const v = filterCommand("tracker", { cmd: "SetNotify", keys: ["pokemon_crystal_events_0_1", "made_up_1", "pokemon_crystal_events_0_1", "_read_hints_0_2", 5] }, false, SCOPE);
  assert.deepEqual(v, { action: "forward", cmd: { cmd: "SetNotify", keys: ["pokemon_crystal_events_0_1"] } });
  assert.equal(filterCommand("tracker", { cmd: "SetNotify", keys: Array.from({ length: 1000 }, (_, i) => `k${i}`) }, false, SCOPE).action, "drop");
  assert.equal(filterCommand("tracker", { cmd: "SetNotify", keys: ["pokemon_crystal_events_0_1"] }).action, "drop", "no scope yet");
});

// The vendored world is the one MultiServer runs and players' browsers load:
// every key its client writes must be one the rules know (a world update that
// adds one fails here, not silently in play), and its sign names must load.
const WORLD = new URL("../../vendor/archipelago/worlds/pokemon_crystal/", import.meta.url);
const worldPresent = (() => { try { return readdirSync(WORLD).length > 0; } catch { return false; } })();
test("every data storage key the Crystal client writes is one the rules know", { skip: !worldPresent && "vendor/archipelago isn't checked out" }, () => {
  const sources = readdirSync(WORLD).filter((f) => /^client.*\.py$/.test(f)).map((f) => readFileSync(new URL(f, WORLD), "utf8")).join("\n");
  const scope = { team: 0, slot: 1, signs: loadSignNames(new URL("../..", WORLD).pathname) };
  const keys = new Set<string>();
  for (const [, name] of sources.matchAll(/f"(pokemon_crystal_[a-z0-9_]+?)_\{ctx\.team\}_\{ctx\.slot\}"/g)) keys.add(`${name}_0_1`);
  // The tracker flags' keys are built from a table of suffixes.
  const table = readFileSync(new URL("client_tracker_events.py", WORLD), "utf8");
  for (const [, suffix] of table.matchAll(/^\s*\(TRACKER_\w+, \w+, "\w+", "(\w+)"\),$/gm)) keys.add(`pokemon_crystal_${suffix}_0_1`);
  keys.delete("pokemon_crystal_{key_suffix}_0_1");
  for (const [, name] of sources.matchAll(/f"(EnergyLink|pokemon_wonder_trades_)\{ctx\.team\}"/g)) keys.add(`${name}0`);
  assert.ok(keys.size > 20, `found ${keys.size} keys`);
  for (const key of keys) assert.ok(storageKind(key, scope), `${key} isn't in rules.ts`);
  const operations = new Set([...sources.matchAll(/"operation":\s*"(\w+)"/g)].map((m) => m[1]));
  assert.ok(operations.size >= 5, `found operations ${[...operations]}`);
  for (const op of operations) assert.ok(STORAGE_OPERATIONS.has(op), `the client's "${op}" isn't in rules.ts`);
  assert.ok(scope.signs.size > 100, `${scope.signs.size} sign names`);
});

test("packets keep integers wider than a double exactly", () => {
  const text = '[{"cmd":"Set","key":"k","operations":[{"operation":"or","value":38685626227668133590597631}]},{"cmd":"LocationChecks","locations":[7,8]}]';
  const parsed = parsePacket(text) as any[];
  assert.equal(JSON.stringify(parsed), text);
  assert.deepEqual(parsed[1].locations, [7, 8], "ordinary numbers stay numbers");
  const events = filterCommand("game", { ...parsed[0], key: "pokemon_crystal_events_0_1", default: 0 }, false, SCOPE) as { cmd: object };
  assert.match(JSON.stringify(events.cmd), /"value":38685626227668133590597631\b/);
});

test("per-address limits count an IPv6 /48 as one address", async () => {
  const { addressGroup } = await import("../src/http.ts");
  assert.equal(addressGroup("203.0.113.9"), "203.0.113.9");
  assert.equal(addressGroup("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(addressGroup("2001:db8:1:2::1"), addressGroup("2001:0db8:0001:ffff:aaaa::9"));
  assert.notEqual(addressGroup("2001:db8:1::1"), addressGroup("2001:db8:2::1"));
  assert.equal(addressGroup("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(addressGroup("::1"), "0:0:0::/48");
  assert.equal(addressGroup("fe80::1%eth0"), addressGroup("fe80::2"));
});

test("packets with malformed Unicode are refused whole", () => {
  assert.throws(() => parsePacket('[{"cmd":"Get","keys":["\\ud800"]}]'));
  assert.throws(() => parsePacket('[{"\\udc00":1}]'));
  assert.deepEqual(parsePacket('[{"cmd":"Say","text":"\\ud83d\\ude00 é"}]'), [{ cmd: "Say", text: "😀 é" }]);
});
