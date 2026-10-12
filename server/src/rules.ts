// What the Archipelago proxy lets through, as pure functions over packets. The
// proxy (proxy.ts) applies them; keeping them here makes the rules easy to
// read in one place and to test.

export type Role = "game" | "tracker";

// Parse a client's packet without losing precision: Archipelago clients send
// integers wider than a double (the Crystal client's event-sync bitfields run
// to ~85 bits), which plain JSON.parse would round, and which would reach
// MultiServer as floats. Those come back as raw JSON that JSON.stringify
// writes out exactly as received.
//
// Strings must be well-formed Unicode: a lone surrogate (which JSON escapes
// can spell) is a string Python can't encode, so MultiServer would fail to
// send it, or anything stored with it, to anyone ever again.
export function parsePacket(text: string): unknown {
  return JSON.parse(text, (key, value, context?: { source?: string }) => {
    if (!(key as any).isWellFormed() || (typeof value === "string" && !(value as any).isWellFormed())) {
      throw new SyntaxError("malformed Unicode");
    }
    return typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
      ? (JSON as any).rawJSON(context.source)
      : value;
  });
}

// Data storage: the keys the Crystal client writes, and what each holds.
// MultiServer keeps every write for good (in its save too) and serves it to
// every later player's game, so only these keys, with the operations and
// value shapes the client sends, go through. Anything else could stall it
// (`pow` on a big operand never finishes), grow what it stores without bound
// (`add` concatenates strings and lists, `update` merges), or store an
// integer too long for it to encode again, after which every client that
// reads the key is disconnected. The unit tests check this list against the
// vendored client, so a world update that adds a key fails them.
// Each key's shape, from how the client writes it and reads it back (the next
// player's game loads these into its RAM, so a value it couldn't handle would
// stop that game's client).
type StorageSpec =
  // `or` with a non-negative integer under 2^bits (flags).
  | { kind: "bitfield"; bits: number }
  // `update` (or `replace`) with a list of distinct ids in [min, max]. What's
  // stored is their union, so it never outgrows the range.
  | { kind: "ids"; min: number; max: number }
  // The same, with the world's sign names.
  | { kind: "signs" }
  // `replace` with a boolean.
  | { kind: "flag" }
  // EnergyLink's pool: `add` and `max` with integers (the client clamps
  // what it reads to the most money the game holds).
  | { kind: "energy" }
  // The wonder trade pool: a lock and numbered offers.
  | { kind: "trades" };
const bitfield = (bits: number): StorageSpec => ({ kind: "bitfield", bits });
const ids = (min: number, max: number): StorageSpec => ({ kind: "ids", min, max });
const SLOT_KEYS = new Map<string, StorageSpec>([
  // Read by PopTracker, or merged by the client through a fixed table of
  // flags; the widest it writes is ~66 bits.
  ...["events", "events_2", "events_3", "statics", "rockettraps", "seen_kanto_marts", "seen_johto_marts", "keys",
    "sync_events", "e4_door_sync_events", "sync_goal_events", "fly_unlocks"].map((k) => [k, bitfield(128)] as const),
  // Written back to the game as one byte.
  ["unlocked_unowns", bitfield(8)],
  // Pokédex numbers.
  ["seen_pokemon", ids(1, 256)], ["caught_pokemon", ids(1, 256)],
  // Written back to the game as the bytes of its 26-entry Unown dex.
  ["unowns", ids(1, 26)],
  // Bit numbers in the game's trade flags.
  ["trades", ids(0, 255)], ["trades_finished", ids(0, 255)],
  // Warp ids (the largest is ~8250).
  ["warps", ids(0, 16383)],
  // Bit numbers in the game's two bytes of completed tiers.
  ["battle_tower", ids(0, 15)],
  ["signs", { kind: "signs" }],
  ["all_pokemon_seen", { kind: "flag" }], ["tracker_slots_enabled", { kind: "flag" }],
]);
const KIND_OPERATIONS: Record<StorageSpec["kind"], ReadonlySet<string>> = {
  bitfield: new Set(["or"]),
  ids: new Set(["update", "replace"]),
  signs: new Set(["update", "replace"]),
  flag: new Set(["replace"]),
  energy: new Set(["add", "max"]),
  trades: new Set(["update", "pop"]),
};
// Every operation some key takes (for the tests' check against the client).
export const STORAGE_OPERATIONS: ReadonlySet<string> = new Set(["default", ...Object.values(KIND_OPERATIONS).flatMap((ops) => [...ops])]);
const MAX_OPERATIONS = 4;
// The pool's offers are numbered from 0 up, by whoever posts one next, as
// Python writes the number (the client reads them back with int() and pops
// str() of that: "05" would never match).
const TRADE_SLOT = /^(0|[1-9]\d{0,2})$/;
// Bounds the pool. Someone filling it on purpose (with offers others can
// take, so giving away that many Pokémon) makes the next post past the end
// drop: that one offer is lost, and the pool drains again as players trade.
const MAX_TRADE_SLOT = 255;
const isTradeSlot = (v: unknown) => typeof v === "string" && TRADE_SLOT.test(v) && Number(v) <= MAX_TRADE_SLOT;
const MAX_UUID_CHARS = 64;

// Where data storage commands may reach: the turn's slot, and the names the
// world gives its signs.
export type StorageScope = { team: number; slot: number; signs: ReadonlySet<string> };

export function storageKind(key: unknown, scope: StorageScope): StorageSpec | null {
  if (typeof key !== "string") return null;
  if (key === `EnergyLink${scope.team}`) return { kind: "energy" };
  if (key === `pokemon_wonder_trades_${scope.team}`) return { kind: "trades" };
  const suffix = `_${scope.team}_${scope.slot}`;
  if (!key.startsWith("pokemon_crystal_") || !key.endsWith(suffix)) return null;
  return SLOT_KEYS.get(key.slice("pokemon_crystal_".length, -suffix.length)) ?? null;
}

const isRawJSON = (v: unknown): boolean => (JSON as any).isRawJSON?.(v) === true;
// A non-negative integer under 2^bits (a wide one arrives as raw JSON from
// parsePacket).
function isBitfield(v: unknown, bits: number): boolean {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 && v < 2 ** bits;
  if (!isRawJSON(v)) return false;
  const text = JSON.stringify(v);
  return /^\d{1,40}$/.test(text) && BigInt(text) < 1n << BigInt(bits);
}
const isInt = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const distinct = (list: unknown[]) => new Set(list).size === list.length;
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v) && !isRawJSON(v);
const isIntArray = (v: unknown, length: number, min: number, max: number) =>
  Array.isArray(v) && v.length === length && v.every((n) => isInt(n, min, max));
const isShortString = (v: unknown, max = 64) => typeof v === "string" && v.length <= max;

// A wonder trade offer's Pokémon, as the Crystal client writes it (see
// pokemon_data_to_json in the world's util_wonder_trade.py): every field the
// receiving client reads, of the type and range it expects, and nothing
// else. The receiving client trusts it, and one it can't read stops it.
// Only offers some player could take (trade_is_eligible: a Crystal species
// and a Crystal move), so nothing sits in the pool for good. Numbers must be
// written as integers: Python reads 31.0 as a float, which the receiver's
// bit arithmetic rejects.
const OFFER_FIELDS: Record<string, (v: unknown) => boolean> = {
  version: (v) => isShortString(v),
  personality: (v) => isInt(v, 0, 2 ** 32 - 1),
  nickname: (v) => isShortString(v),
  language: (v) => isShortString(v),
  species: (v) => isInt(v, 0, 255),
  experience: (v) => isInt(v, 0, 0xffffff),
  ability: (v) => isInt(v, 0, 1),
  ivs: (v) => isIntArray(v, 6, 0, 31),
  evs: (v) => isIntArray(v, 6, 0, 255),
  conditions: (v) => isIntArray(v, 6, 0, 255),
  pokerus: (v) => isInt(v, 0, 255),
  location_met: (v) => isInt(v, 0, 0xffff),
  level_met: (v) => isInt(v, 0, 127),
  game: (v) => isInt(v, 0, 255),
  ball: (v) => isInt(v, 0, 255),
  moves: (v) => Array.isArray(v) && v.length <= 4 && v.every((m) =>
    Array.isArray(m) && m.length === 3 && isInt(m[0], 0, 255) && isInt(m[1], 0, 63) && isInt(m[2], 0, 3)),
  trainer: (v) => isPlainObject(v) && Object.keys(v).length === 3
    && isShortString(v.name) && isInt(v.id, 0, 0xffff) && typeof v.female === "boolean",
  item: (v) => isInt(v, 0, 0xffff),
};
const REQUIRED_OFFER_FIELDS = Object.keys(OFFER_FIELDS).filter((k) => k !== "item");
function isOfferBlob(blob: unknown): boolean {
  if (typeof blob !== "string" || blob.length > 1024) return false;
  let mon: any;
  try { mon = parsePacket(blob); } catch { return false; }
  let integral = true;
  try {
    JSON.parse(blob, (_key, value, context?: { source?: string }) => {
      if (typeof value === "number" && !/^-?\d+$/.test(context?.source ?? "")) integral = false;
      return value;
    });
  } catch { return false; }
  if (!integral || !isPlainObject(mon)) return false;
  return REQUIRED_OFFER_FIELDS.every((k) => k in mon)
    && Object.entries(mon).every(([k, v]) => Object.hasOwn(OFFER_FIELDS, k) && OFFER_FIELDS[k](v))
    && isInt(mon.species, 1, 251)
    && (mon.moves as number[][]).some((m) => isInt(m[0], 1, 251));
}
// Part of the wonder trade pool: its lock (a timestamp) and offers.
function isTrades(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const entries = Object.entries(v);
  return entries.length <= MAX_OPERATIONS && entries.every(([k, item]) => k === "_lock"
    ? isInt(item, 0, Number.MAX_SAFE_INTEGER)
    : isTradeSlot(k) && Array.isArray(item) && item.length === 2 && isInt(item[0], 0, 0xffff) && isOfferBlob(item[1]));
}

function validValue(spec: StorageSpec, operation: string, v: unknown, scope: StorageScope): boolean {
  switch (spec.kind) {
    case "bitfield": return isBitfield(v, spec.bits);
    case "ids": return Array.isArray(v) && distinct(v) && v.every((n) => isInt(n, spec.min, spec.max));
    case "signs": return Array.isArray(v) && distinct(v) && v.every((n) => typeof n === "string" && scope.signs.has(n));
    case "flag": return typeof v === "boolean";
    case "energy": return Number.isSafeInteger(v);
    case "trades": return operation === "pop" ? isTradeSlot(v) : isTrades(v);
  }
}

// A game client's Set, rebuilt from only what checks out (MultiServer echoes
// every field back to whoever's watching the key), or null to drop it.
export function checkSet(cmd: any, scope: StorageScope | null): object | null {
  const spec = scope && storageKind(cmd?.key, scope);
  if (!scope || !spec) return null;
  const ops = cmd.operations;
  if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPERATIONS) return null;
  for (const op of ops) {
    if (!isPlainObject(op) || typeof op.operation !== "string") return null;
    // `default` (create the key if it's missing) ignores its value.
    if (op.operation === "default") continue;
    if (!KIND_OPERATIONS[spec.kind].has(op.operation) || !validValue(spec, op.operation, op.value, scope)) return null;
  }
  // The starting value, used when the key has none yet, always given (as
  // the client does): without one MultiServer starts from 0, which a `default`
  // operation would store, making a list's key a number for good.
  if (cmd.default === undefined || !validValue(spec, "default", cmd.default, scope)) return null;
  const out: Record<string, unknown> = {
    cmd: "Set", key: cmd.key,
    operations: ops.map((op) => ({ operation: op.operation, value: op.operation === "default" ? null : op.value })),
  };
  out.default = cmd.default;
  if (typeof cmd.want_reply === "boolean" || Number.isSafeInteger(cmd.want_reply)) out.want_reply = cmd.want_reply;
  if (typeof cmd.uuid === "string" && cmd.uuid.length <= MAX_UUID_CHARS) out.uuid = cmd.uuid;
  return out;
}

// Server-managed keys a client may watch, besides the ones it writes.
const MAX_NOTIFY_KEYS = 64;
function readKeys(scope: StorageScope): string[] {
  return [`_read_hints_${scope.team}_${scope.slot}`, `_read_client_status_${scope.team}_${scope.slot}`];
}

// A SetNotify cut down to the keys above: MultiServer keeps an entry for
// every key ever watched, so watching a stream of made-up ones would fill
// its memory. Null when none are left.
export function checkSetNotify(cmd: any, scope: StorageScope | null): object | null {
  if (!scope || !Array.isArray(cmd?.keys)) return null;
  const reads = readKeys(scope);
  const keys = [...new Set(cmd.keys)].filter((k) => storageKind(k, scope) || reads.includes(k as string)).slice(0, MAX_NOTIFY_KEYS);
  return keys.length ? { cmd: "SetNotify", keys } : null;
}

// Tags that make MultiServer treat a connection as not a game client.
const NON_GAME_TAGS = ["Tracker", "TextOnly", "HintGame"];

export type SessionCredentials = { gamePassword: string; trackerPassword: string };

export type ConnectVerdict =
  // Refuse the login, as MultiServer would: no running session uses this
  // password (InvalidPassword), or PopTracker named another slot (InvalidSlot).
  | { kind: "refuse"; error: "InvalidPassword" | "InvalidSlot" }
  // The session's credentials, used by something that isn't allowed to.
  | { kind: "violation"; detail: string }
  | { kind: "accept"; role: Role };

function tagsOf(cmd: any): string[] {
  return Array.isArray(cmd?.tags) ? cmd.tags.filter((t: unknown) => typeof t === "string") : [];
}

// Classify a Connect. The game password belongs to the browser's game client;
// the tracker password is the one the player was shown, for PopTracker only.
export function classifyConnect(cmd: any, creds: SessionCredentials | null, slot: { name: string; game: string }): ConnectVerdict {
  const password = cmd?.password;
  const slotGame = slot.game;
  if (!creds || typeof password !== "string") return { kind: "refuse", error: "InvalidPassword" };
  const tags = tagsOf(cmd);
  if (password === creds.gamePassword) {
    if (cmd.game !== slotGame) return { kind: "violation", detail: `the game connection claimed to be "${cmd.game}"` };
    const bad = tags.filter((t) => NON_GAME_TAGS.includes(t));
    if (bad.length) return { kind: "violation", detail: `the game connection was tagged ${bad.join(", ")}` };
    return { kind: "accept", role: "game" };
  }
  if (password === creds.trackerPassword) {
    // PopTracker 0.27+ always tags itself PopTracker, and an ordinary
    // tracker pack (Crystal's) connects as a Tracker with no game.
    if (!tags.includes("PopTracker") || !tags.includes("Tracker") || cmd.game !== "") {
      const client = tags.length ? `tags ${tags.join(", ")}` : "no tags";
      return { kind: "violation", detail: `something other than PopTracker connected with the PopTracker password (${client}${cmd.game ? `, game "${cmd.game}"` : ""})` };
    }
    // A typo in the slot box: tell PopTracker, don't end the turn over it.
    if (cmd.name !== slot.name) return { kind: "refuse", error: "InvalidSlot" };
    return { kind: "accept", role: "tracker" };
  }
  return { kind: "refuse", error: "InvalidPassword" };
}

export type CommandVerdict =
  | { action: "forward"; cmd: any }
  | { action: "drop" }
  | { action: "checks"; locations: unknown }
  // The game says the slot reached its goal. That ends the event for everyone,
  // so it waits for an admin instead of going to the server.
  | { action: "goal" }
  | { action: "violation"; detail: string };

// ClientStatus.CLIENT_GOAL in Archipelago's NetUtils.
export const CLIENT_GOAL = 30;

// Before Connect, only what a client needs to get as far as connecting.
export function filterBeforeConnect(cmd: any): CommandVerdict {
  return cmd?.cmd === "GetDataPackage" ? { action: "forward", cmd } : { action: "drop" };
}

// What a game connection may still send once its turn has no checks left (or
// it was replaced): reads, re-sends of counted checks, a goal report. Not data
// storage writes, scouts or bounces: they'd carry progress past the quota into
// the next player's game.
const AFTER_QUOTA = new Set(["LocationChecks", "Get", "SetNotify", "Sync", "GetDataPackage", "StatusUpdate"]);

// After Connect. Nobody gets hints, chat or the server's ! commands; the game
// client's checks go through the quota; PopTracker only reads. `closing`: the
// game's turn is out of checks.
// `scope`: the slot the connection logged into (null before the server said).
export function filterCommand(role: Role, cmd: any, closing = false, scope: StorageScope | null = null): CommandVerdict {
  const name = cmd?.cmd;
  if (role === "game" && closing && !AFTER_QUOTA.has(name)) return { action: "drop" };
  if (role === "game") {
    switch (name) {
      case "LocationChecks":
        return { action: "checks", locations: cmd.locations };
      case "LocationScouts":
        // The client scouts to show what's in shops and the like; without the
        // hint flag that's all it does. Scouting reveals nothing new: with
        // remote_items the patched ROM already names every location's item
        // for its in-game text, and every player has the patch.
        return { action: "forward", cmd: { ...cmd, create_as_hint: 0 } };
      case "ConnectUpdate": {
        const bad = tagsOf(cmd).filter((t) => NON_GAME_TAGS.includes(t));
        if (bad.length) return { action: "violation", detail: `the game connection re-tagged itself ${bad.join(", ")}` };
        return { action: "forward", cmd };
      }
      case "StatusUpdate":
        return cmd.status === CLIENT_GOAL ? { action: "goal" } : { action: "forward", cmd };
      case "Set": {
        // Dropped, not a violation: a future client might write something
        // not listed here, and that shouldn't cost a turn.
        const set = checkSet(cmd, scope);
        return set ? { action: "forward", cmd: set } : { action: "drop" };
      }
      case "SetNotify": {
        const notify = checkSetNotify(cmd, scope);
        return notify ? { action: "forward", cmd: notify } : { action: "drop" };
      }
      case "Sync":
      case "Get":
      case "Bounce":
      case "GetDataPackage":
        return { action: "forward", cmd };
      default:
        // Say (chat, !hint, !release, !getitem, !admin…), CreateHints,
        // UpdateHint, and anything unknown.
        return { action: "drop" };
    }
  }
  switch (name) {
    case "SetNotify": {
      const notify = checkSetNotify(cmd, scope);
      return notify ? { action: "forward", cmd: notify } : { action: "drop" };
    }
    case "Get":
    case "Sync":
    case "GetDataPackage":
      return { action: "forward", cmd };
    case "LocationChecks":
    case "StatusUpdate":
    case "Set":
    case "LocationScouts":
      // PopTracker's Crystal pack never sends these: whatever did isn't it.
      return { action: "violation", detail: `the PopTracker connection sent ${name}` };
    default:
      return { action: "drop" };
  }
}

// From a LocationChecks list, the locations that would be new checks for the
// slot, capped at what the session has left. Duplicates, unknown ids, already
// checked locations and ones still awaiting the server are left out.
type Has = { has(id: number): boolean };

export function selectNewChecks(locations: unknown, opts: {
  valid: Has;
  checked: Has;
  pending: Has;
  remaining: number;
}): number[] {
  if (!Array.isArray(locations) || opts.remaining <= 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of locations) {
    if (out.length >= opts.remaining) break;
    if (typeof raw !== "number" || !Number.isInteger(raw) || seen.has(raw)) continue;
    seen.add(raw);
    if (!opts.valid.has(raw) || opts.checked.has(raw) || opts.pending.has(raw)) continue;
    out.push(raw);
  }
  return out;
}
