// Persistent state in SQLite: who has signed in and used their turn, every
// turn and what it found, the queue, and a few settings. Everything the server
// needs to carry on after a restart lives here.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EndReason, Find, PublicUser, SessionSummary, AdminUserRow } from "../../shared/protocol.ts";

export type UserRow = {
  id: string;
  name: string;
  avatar: string | null;
  created_at: number;
  attempt_used: number;
  banned: number;
};

export type SessionRow = {
  id: string;
  user_id: string;
  started_at: number;
  ended_at: number | null;
  reason: EndReason | null;
  detail: string | null;
  game_pw: string | null;
  tracker_pw: string | null;
};

export class Db {
  private db: DatabaseSync;
  // Users are read on every broadcast (queue, spectators), and only change
  // through the methods below, which keep this in step.
  private users = new Map<string, UserRow>();
  // Each user's latest session as a summary: read for every signed-in viewer
  // on every broadcast, but it only changes through the session and find
  // writes below, which drop it.
  private lastSessionCache = new Map<string, SessionSummary | null>();
  // Finds per session: the running one's are read on every broadcast.
  private findsCache = new Map<string, Find[]>();
  // Who each session belongs to (it never changes), for cache invalidation.
  private sessionOwners = new Map<string, string>();
  private ownerOf(sessionId: string): string | null {
    let owner = this.sessionOwners.get(sessionId);
    if (owner === undefined) {
      owner = (this.q("SELECT user_id FROM sessions WHERE id = ?").get(sessionId) as { user_id: string } | undefined)?.user_id;
      if (owner === undefined) return null;
      this.sessionOwners.set(sessionId, owner);
    }
    return owner;
  }
  // A session changed: drop its player's summary.
  private sessionChanged(sessionId: string) {
    const owner = this.ownerOf(sessionId);
    if (owner) this.lastSessionCache.delete(owner);
  }
  // A session's finds changed: drop them and its player's summary.
  private findsChanged(sessionId: string) {
    this.findsCache.delete(sessionId);
    this.recentCache = null;
    this.sessionChanged(sessionId);
  }
  // Statements, prepared once each: several run on every broadcast.
  private statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private q(sql: string) {
    let st = this.statements.get(sql);
    if (!st) { st = this.db.prepare(sql); this.statements.set(sql, st); }
    return st;
  }

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT,
        created_at INTEGER NOT NULL,
        attempt_used INTEGER NOT NULL DEFAULT 0,
        banned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        reason TEXT,
        detail TEXT,
        -- The session's credentials, kept while it runs so a server restart
        -- doesn't cut the player off. Cleared when it ends.
        game_pw TEXT,
        tracker_pw TEXT
      );
      CREATE TABLE IF NOT EXISTS finds (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        location_id INTEGER NOT NULL,
        location TEXT NOT NULL,
        item TEXT,
        receiver TEXT,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, location_id)
      );
      CREATE INDEX IF NOT EXISTS finds_location ON finds (location_id);
      CREATE TABLE IF NOT EXISTS queue (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  transaction(fn: () => void) {
    this.db.exec("BEGIN");
    try { fn(); this.db.exec("COMMIT"); }
    catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  // --- kv ---
  get(key: string): string | null {
    const row = this.q("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  set(key: string, value: string | null) {
    if (value === null) this.q("DELETE FROM kv WHERE key = ?").run(key);
    else this.q("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // --- users ---
  upsertUser(u: PublicUser): UserRow {
    this.lastSessionCache.delete(u.id);
    this.recentCache = null;
    this.users.delete(u.id);
    this.q(`
      INSERT INTO users (id, name, avatar, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar
    `).run(u.id, u.name, u.avatar, Date.now());
    return this.user(u.id)!;
  }
  user(id: string): UserRow | null {
    const cached = this.users.get(id);
    if (cached) return cached;
    const row = (this.q("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
    if (row) this.users.set(id, row);
    return row;
  }
  // A user as others see them, even one missing from the table.
  publicUser(id: string): PublicUser {
    const u = this.user(id);
    return u ? toPublic(u) : { id, name: "unknown", avatar: null };
  }
  setAttemptUsed(id: string, used: boolean) {
    this.users.delete(id);
    this.q("UPDATE users SET attempt_used = ? WHERE id = ?").run(used ? 1 : 0, id);
  }
  setBanned(id: string, banned: boolean) {
    this.users.delete(id);
    this.q("UPDATE users SET banned = ? WHERE id = ?").run(banned ? 1 : 0, id);
  }
  adminUsers(): AdminUserRow[] {
    const rows = this.q("SELECT * FROM users ORDER BY created_at DESC").all() as UserRow[];
    return rows.map((r) => ({ user: toPublic(r), attemptUsed: !!r.attempt_used, banned: !!r.banned, createdAt: r.created_at }));
  }

  // --- queue ---
  queue(): string[] {
    return (this.q("SELECT user_id FROM queue ORDER BY joined_at, rowid").all() as { user_id: string }[]).map((r) => r.user_id);
  }
  isQueued(userId: string): boolean {
    return !!this.q("SELECT 1 FROM queue WHERE user_id = ?").get(userId);
  }
  enqueue(userId: string) {
    this.q("INSERT OR IGNORE INTO queue (user_id, joined_at) VALUES (?, ?)").run(userId, Date.now());
  }
  // Back to the head of the line (an offer withdrawn through no fault of theirs).
  enqueueFront(userId: string) {
    const first = this.q("SELECT MIN(joined_at) AS t FROM queue").get() as { t: number | null };
    this.q("INSERT OR REPLACE INTO queue (user_id, joined_at) VALUES (?, ?)").run(userId, (first.t ?? Date.now()) - 1);
  }
  dequeue(userId: string) {
    this.q("DELETE FROM queue WHERE user_id = ?").run(userId);
  }
  clearQueue() {
    this.q("DELETE FROM queue").run();
  }

  // --- sessions ---
  createSession(s: { id: string; userId: string; startedAt: number; gamePw: string; trackerPw: string }) {
    this.lastSessionCache.delete(s.userId);
    this.q("INSERT INTO sessions (id, user_id, started_at, game_pw, tracker_pw) VALUES (?, ?, ?, ?, ?)")
      .run(s.id, s.userId, s.startedAt, s.gamePw, s.trackerPw);
  }
  endSession(id: string, reason: EndReason, detail: string | null, endedAt: number) {
    this.sessionChanged(id);
    this.q("UPDATE sessions SET ended_at = ?, reason = ?, detail = ?, game_pw = NULL, tracker_pw = NULL WHERE id = ?")
      .run(endedAt, reason, detail, id);
  }
  // Settle how a finished session ended, once that's known (a reported goal).
  setSessionOutcome(id: string, reason: EndReason, detail: string | null) {
    this.sessionChanged(id);
    this.q("UPDATE sessions SET reason = ?, detail = ? WHERE id = ?").run(reason, detail, id);
  }
  // Locations recorded as found whose item isn't known yet (their scout was
  // lost with a connection).
  unnamedFindLocationIds(): number[] {
    return (this.q("SELECT DISTINCT location_id FROM finds WHERE item IS NULL").all() as { location_id: number }[]).map((r) => r.location_id);
  }
  latestSessionId(): string | null {
    return (this.q("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
  }
  openSession(): SessionRow | null {
    return (this.q("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get() as SessionRow | undefined) ?? null;
  }
  lastSessionFor(userId: string): SessionSummary | null {
    if (this.lastSessionCache.has(userId)) return this.lastSessionCache.get(userId)!;
    const summary = this.readLastSession(userId);
    this.lastSessionCache.set(userId, summary);
    return summary;
  }
  private readLastSession(userId: string): SessionSummary | null {
    const row = this.q("SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 1").get(userId) as SessionRow | undefined;
    return row ? this.summary(row) : null;
  }
  // The latest sessions with their finds: two queries however many there are
  // (the admin page polls this).
  sessions(limit = 200): SessionSummary[] {
    const rows = this.q(`
      SELECT s.*, u.name AS uname, u.avatar AS uavatar
      FROM sessions s LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.started_at DESC LIMIT ?
    `).all(limit) as (SessionRow & { uname: string | null; uavatar: string | null })[];
    const finds = new Map<string, Find[]>();
    const findRows = this.q(`
      SELECT * FROM finds WHERE session_id IN (SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?)
      ORDER BY at, rowid
    `).all(limit) as any[];
    for (const f of findRows) {
      if (!finds.has(f.session_id)) finds.set(f.session_id, []);
      finds.get(f.session_id)!.push(toFind(f));
    }
    return rows.map((r) => ({
      id: r.id,
      user: { id: r.user_id, name: r.uname ?? "unknown", avatar: r.uavatar ?? null },
      startedAt: r.started_at,
      endedAt: r.ended_at,
      reason: r.reason,
      detail: r.detail,
      finds: finds.get(r.id) ?? [],
    }));
  }
  private summary(row: SessionRow): SessionSummary {
    return {
      id: row.id,
      user: this.publicUser(row.user_id),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      reason: row.reason,
      detail: row.detail,
      finds: this.finds(row.id),
    };
  }

  // --- finds ---
  addFind(sessionId: string, locationId: number, location: string, at: number) {
    this.q("INSERT OR IGNORE INTO finds (session_id, location_id, location, at) VALUES (?, ?, ?, ?)")
      .run(sessionId, locationId, location, at);
    this.findsChanged(sessionId);
  }
  removeFind(sessionId: string, locationId: number) {
    this.q("DELETE FROM finds WHERE session_id = ? AND location_id = ?").run(sessionId, locationId);
    this.findsChanged(sessionId);
  }
  // Fill in what a location held once the scout comes back. Any session's row
  // for that location: the location can only have been checked once.
  setFindItem(locationId: number, item: string, receiver: string | null) {
    this.q("UPDATE finds SET item = ?, receiver = ? WHERE location_id = ?").run(item, receiver, locationId);
    for (const r of this.q("SELECT session_id FROM finds WHERE location_id = ?").all(locationId) as { session_id: string }[]) {
      this.findsChanged(r.session_id);
    }
  }
  finds(sessionId: string): Find[] {
    let finds = this.findsCache.get(sessionId);
    if (!finds) {
      finds = (this.q("SELECT * FROM finds WHERE session_id = ? ORDER BY at, rowid").all(sessionId) as any[]).map(toFind);
      this.findsCache.set(sessionId, finds);
    }
    return finds;
  }
  // A session's checked locations, or with no session every recorded one.
  findLocationIds(sessionId?: string): number[] {
    const rows = sessionId === undefined
      ? this.q("SELECT location_id FROM finds").all()
      : this.q("SELECT location_id FROM finds WHERE session_id = ?").all(sessionId);
    return (rows as { location_id: number }[]).map((r) => r.location_id);
  }
  // The latest finds across all sessions, for the public state on every
  // broadcast: kept until a find (or a name in it) changes.
  private recentCache: { limit: number; finds: (Find & { who: PublicUser })[] } | null = null;
  recentFinds(limit: number): (Find & { who: PublicUser })[] {
    if (this.recentCache?.limit === limit) return this.recentCache.finds;
    const finds = this.readRecentFinds(limit);
    this.recentCache = { limit, finds };
    return finds;
  }
  private readRecentFinds(limit: number): (Find & { who: PublicUser })[] {
    const rows = this.q(`
      SELECT f.*, u.id AS uid, u.name AS uname, u.avatar AS uavatar
      FROM finds f JOIN sessions s ON s.id = f.session_id JOIN users u ON u.id = s.user_id
      ORDER BY f.at DESC, f.rowid DESC LIMIT ?
    `).all(limit) as any[];
    return rows.map((r) => ({ ...toFind(r), who: { id: r.uid, name: r.uname, avatar: r.uavatar } }));
  }
}

export function toPublic(u: UserRow): PublicUser {
  return { id: u.id, name: u.name, avatar: u.avatar };
}

function toFind(r: any): Find {
  return { location: r.location, item: r.item ?? null, receiver: r.receiver ?? null, at: r.at };
}
