// The run: the queue, whose turn is offered, the one session in progress, and
// everything that ends it. The proxy and the observer report in here; the live
// sockets get told about every change.

import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { toPublic } from "./db.ts";
import type { Seed } from "./seed.ts";
import type { Observer, ScoutResult } from "./observer.ts";
import { selectNewChecks, type Role, type SessionCredentials } from "./rules.ts";
import type { AdminState, EndReason, PublicState, ServerMessage, YouState, Credentials } from "../../shared/protocol.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// A proxied client connection, as the game sees it.
export interface ProxyConn {
  close(code: number, reason: string): void;
}

// The least time a new turn has to make its first game connection.
const FIRST_CONNECT_MS = 5 * 60 * 1000;
// How soon to try telling MultiServer about a confirmed goal again.
const GOAL_RETRY_MS = 30000;
// After the last check lands, how long the player keeps the connection so the
// item it gave reaches the game.
const QUOTA_LINGER_MS = 2000;
// Upper bound on waiting for the last checks to be confirmed.
const QUOTA_WAIT_MS = 6000;

type Active = {
  id: string;
  userId: string;
  startedAt: number;
  gamePassword: string;
  trackerPassword: string;
  // Each role's connection MultiServer has accepted (so: connected), if any.
  conns: Record<Role, ProxyConn | null>;
  // Connections whose login we've passed but MultiServer hasn't answered yet.
  logins: Set<ProxyConn>;
  newChecks: Set<number>;
  // Sent to the server, not confirmed yet. They count against the quota
  // until the server confirms them (or the session ends).
  pending: Set<number>;
  // The quota is used up: nothing more from the game is forwarded.
  closing: boolean;
  // The last check has landed and the session is about to end.
  lingering: boolean;
  // The game has connected at least once (this run of the server).
  everConnected: boolean;
  // The device (browser) playing the turn, from its latest claim. A game
  // login from any other is a device that was taken over and didn't hear:
  // it's turned away rather than taking the turn back. Null (after a server
  // restart, before anyone claims) lets any in.
  holder: string | null;
  graceEndsAt: number | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  endTimer: ReturnType<typeof setTimeout> | null;
};

type Live = { ws: WebSocket; userId: string | null; alive: boolean };

// Marks the game client's connection as the running turn's before it logs
// in, so it never waits behind sockets that haven't logged in. Derived from
// the game password (which the same browser holds), so nothing is stored.
export function joinToken(gamePassword: string): string {
  return createHash("sha256").update(`join\u0000${gamePassword}`).digest("hex").slice(0, 32);
}

function positionsOf(queue: string[]): Map<string, number> {
  return new Map(queue.map((id, i) => [id, i]));
}

export function randomPassword(): string {
  return randomBytes(12).toString("hex");
}

export class Game {
  private active: Active | null = null;
  private offer: { userId: string; expiresAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private paused: boolean;
  private goalPending: boolean;
  private complete: boolean;
  // Ended sessions' checks the server hadn't confirmed when they ended, by
  // session: whenever one lands, it's that session's, not the one running.
  private unconfirmed = new Map<string, Set<number>>();
  private lives = new Set<Live>();
  private liveCount = new Map<string, number>();
  private absentSince = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval>;
  private pinger: ReturnType<typeof setInterval>;
  private broadcastQueued = false;
  private lastPublic: { state: string; positions: Map<string, number> } | null = null;
  private stopped = false;
  private config: Config;
  private db: Db;
  private seed: Seed;
  private observer: Observer;
  private log: (line: string) => void;

  constructor(
    config: Config,
    db: Db,
    seed: Seed,
    observer: Observer,
    log: (line: string) => void,
  ) {
    this.config = config;
    this.db = db;
    this.seed = seed;
    this.observer = observer;
    this.log = log;
    this.paused = db.get("paused") === "1";
    this.complete = db.get("complete") === "1";
    this.goalPending = db.get("goal_claim") !== null;
    this.restore();
    // Everyone queued (including an offered player restore() put back) gets
    // the absence allowance from now: nobody had a chance to reconnect while
    // the server was down.
    const now = Date.now();
    for (const id of db.queue()) this.absentSince.set(id, now);

    observer.on("change", () => {
      if (this.stopped) return;
      this.reconcile();
      if (this.observer.ready && !this.wasReady) {
        // Back (or up for the first time): anything that needed the server
        // while it was away.
        this.pruneUnconfirmed();
        this.reportGoal();
        const unnamed = this.db.unnamedFindLocationIds();
        if (unnamed.length) this.observer.scout(unnamed);
      }
      this.wasReady = this.observer.ready;
      this.updateGrace();
      // Nobody can start a turn while the game server is down; an offer
      // that's running waits it out at the head of the line.
      if (!this.observer.ready && this.offer) {
        this.requeueFront(this.offer.userId);
        this.clearOffer();
      }
      this.advance();
      this.broadcast();
    });
    observer.on("checked", (ids: number[]) => this.onChecked(ids));
    observer.on("scouted", (results: ScoutResult[]) => this.onScouted(results));

    this.sweeper = setInterval(() => this.sweepQueue(), 5000);
    this.pinger = setInterval(() => this.pingLives(), 30000);
  }

  stop() {
    this.stopped = true;
    if (this.goalRetry) clearTimeout(this.goalRetry);
    // Nothing more reaches MultiServer from a player once we stop watching
    // it, or a check could land that this server never hears about.
    for (const conn of [this.active?.conns.game, this.active?.conns.tracker, ...(this.active?.logins ?? [])]) conn?.close(1012, "the server is restarting");
    clearInterval(this.sweeper);
    clearInterval(this.pinger);
    if (this.offer) clearTimeout(this.offer.timer);
    if (this.active) {
      if (this.active.graceTimer) clearTimeout(this.active.graceTimer);
      if (this.active.endTimer) clearTimeout(this.active.endTimer);
    }
    for (const l of this.lives) l.ws.close(1001, "server shutting down");
  }

  // A session that was running when the server stopped carries on with the
  // same credentials; the player has the grace period to reconnect.
  private restore() {
    this.loadUnconfirmed();
    const row = this.db.openSession();
    if (row) {
      if (!row.game_pw || !row.tracker_pw) {
        this.db.endSession(row.id, "server", "the server lost the session's details", Date.now());
      } else {
        this.active = this.newActive(row.id, row.user_id, row.started_at, row.game_pw, row.tracker_pw);
        for (const id of this.db.findLocationIds(row.id)) this.active.newChecks.add(id);
        this.log(`resumed session ${row.id} after restart`);
        // Stopped between its last check and ending on the quota.
        this.armLinger(this.active);
        this.updateGrace();
      }
    }
    const offer = this.db.get("offer");
    if (offer) {
      try {
        const { userId } = JSON.parse(offer);
        // The server was down for (part of) the offer, so nobody could have
        // started: back to the head of the line, for a fresh offer.
        this.db.set("offer", null);
        if (!this.active) this.requeueFront(userId);
      } catch { this.db.set("offer", null); }
    }
  }

  // Once per run, when the observer first sees the slot: anything checked
  // that this server hadn't seen by the time it stopped landed while it
  // wasn't listening (in flight as it shut down). Checks from before this
  // server ever ran (its first start) are only noted as seen.
  private reconciled = false;
  private wasReady = false;
  private reconcile() {
    if (this.reconciled || !this.observer.ready) return;
    this.reconciled = true;
    // Seen: what was checked when this server last started, plus every check
    // it recorded since (each one becomes a find).
    let raw = this.db.get("seen_checks");
    let seen = new Set<number>();
    try { if (raw) seen = new Set<number>(JSON.parse(raw)); }
    catch {
      // Unreadable: no baseline to judge by, so (as on a first start) nothing
      // is taken as having landed during a shutdown.
      this.log("the saved list of seen checks is unreadable — starting it afresh");
      raw = null;
    }
    for (const id of this.db.findLocationIds()) seen.add(id);
    const unknown = raw ? [...this.observer.checked].filter((id) => !seen.has(id)) : [];
    this.db.set("seen_checks", JSON.stringify([...this.observer.checked]));
    if (!unknown.length) return;
    // Only a game connection could have checked them: an ended turn's own
    // unconfirmed check is that turn's (as in onChecked); otherwise they're
    // the restored session's, or, with none running, the last one to end.
    const s = this.active;
    const fallback = s?.id ?? this.db.latestSessionId();
    this.log(`recording ${unknown.length} check(s) that landed while the server was stopping`);
    const now = Date.now();
    let claimsChanged = false;
    this.db.transaction(() => {
      for (const id of unknown) {
        const claimed = this.claimUnconfirmed(id);
        if (claimed) claimsChanged = true;
        const owner = claimed ?? fallback;
        if (!owner) continue;
        this.db.addFind(owner, id, this.observer.locationName(id), now);
        if (s && owner === s.id) s.newChecks.add(id);
      }
    });
    if (claimsChanged) this.saveUnconfirmed();
    this.observer.scout(unknown);
    if (s) this.armLinger(s);
  }


  // Take a location off whichever ended session was still waiting on it;
  // returns that session (a location is only ever waited on by one).
  private claimUnconfirmed(id: number): string | null {
    for (const [sessionId, set] of this.unconfirmed) {
      if (!set.delete(id)) continue;
      if (!set.size) this.unconfirmed.delete(sessionId);
      return sessionId;
    }
    return null;
  }

  // Ended sessions can't be owed what the server has: drop those.
  private pruneUnconfirmed() {
    let changed = false;
    for (const [sessionId, set] of this.unconfirmed) {
      for (const id of set) if (this.observer.checked.has(id)) { set.delete(id); changed = true; }
      if (!set.size) this.unconfirmed.delete(sessionId);
    }
    if (changed) this.saveUnconfirmed();
  }

  private saveUnconfirmed() {
    this.db.set("unconfirmed", JSON.stringify([...this.unconfirmed].map(([id, set]) => [id, [...set]])));
  }
  private loadUnconfirmed() {
    try {
      for (const [id, ids] of JSON.parse(this.db.get("unconfirmed") ?? "[]")) this.unconfirmed.set(id, new Set(ids));
    } catch { this.log("the saved unconfirmed checks are unreadable — dropping them"); }
  }

  private newActive(id: string, userId: string, startedAt: number, gamePassword: string, trackerPassword: string): Active {
    return {
      id, userId, startedAt, gamePassword, trackerPassword,
      conns: { game: null, tracker: null },
      logins: new Set(),
      newChecks: new Set(), pending: new Set(),
      closing: false,
      lingering: false,
      everConnected: false,
      holder: null,
      graceEndsAt: null, graceTimer: null, endTimer: null,
    };
  }

  // ---------------------------------------------------------------------------
  // queue + turns
  // ---------------------------------------------------------------------------
  private requireUser(userId: string) {
    const user = this.db.user(userId);
    if (!user) throw new HttpError(401, "sign in first");
    if (user.banned) throw new HttpError(403, "you can't take part in this event");
    return user;
  }

  join(userId: string) {
    const user = this.requireUser(userId);
    if (this.complete) throw new HttpError(409, "the goal is complete — there are no more turns");
    if (user.attempt_used) throw new HttpError(409, "you've already had your turn");
    if (this.active?.userId === userId || this.offer?.userId === userId) return;
    // Already queued: joining again mustn't restart the absence clock.
    if (!this.db.isQueued(userId)) {
      this.db.enqueue(userId);
      if (!this.hasLive(userId)) this.absentSince.set(userId, Date.now());
      this.log(`${user.name} joined the queue`);
    }
    this.advance();
    this.broadcast();
  }

  leave(userId: string) {
    this.db.dequeue(userId);
    this.absentSince.delete(userId);
    if (this.offer?.userId === userId) {
      this.log(`${this.db.user(userId)?.name ?? userId} passed on their turn`);
      this.clearOffer();
    }
    this.advance();
    this.broadcast();
  }

  start(userId: string) {
    const user = this.requireUser(userId);
    if (this.active?.userId === userId) return;
    if (this.offer?.userId !== userId) throw new HttpError(409, "it isn't your turn");
    if (this.paused) throw new HttpError(409, "the queue is paused — wait for an admin to resume it");
    if (user.attempt_used) throw new HttpError(409, "you've already had your turn");
    if (!this.observer.ready) throw new HttpError(503, "the game server isn't ready — try again in a moment");
    const id = randomBytes(8).toString("hex");
    const now = Date.now();
    const s = this.newActive(id, userId, now, randomPassword(), randomPassword());
    // Together or not at all: a session whose player still had their turn
    // would hand them a second one. (If it fails, the offer still stands.)
    this.db.transaction(() => {
      this.db.createSession({ id, userId, startedAt: now, gamePw: s.gamePassword, trackerPw: s.trackerPassword });
      this.db.setAttemptUsed(userId, true);
    });
    this.clearOffer();
    this.active = s;
    this.log(`session ${id} started for ${user.name}`);
    this.updateGrace();
    this.broadcast();
  }

  giveUp(userId: string) {
    if (this.active?.userId !== userId) throw new HttpError(409, "you don't have a turn running");
    this.end("gave-up", null);
  }

  // Back to the head of the line (an offer withdrawn through no fault of
  // theirs), on the same terms as anyone queued: no page open, and the
  // absence clock starts.
  private requeueFront(userId: string) {
    this.db.enqueueFront(userId);
    if (!this.hasLive(userId)) this.absentSince.set(userId, Date.now());
  }

  private makeOffer(userId: string, expiresAt: number) {
    const timer = setTimeout(() => {
      if (this.offer?.userId !== userId) return;
      this.log(`${this.db.user(userId)?.name ?? userId} didn't start their turn in time`);
      this.clearOffer();
      this.advance();
      this.broadcast();
    }, Math.max(0, expiresAt - Date.now()));
    this.offer = { userId, expiresAt, timer };
    this.db.set("offer", JSON.stringify({ userId }));
  }

  private clearOffer() {
    if (!this.offer) return;
    clearTimeout(this.offer.timer);
    this.offer = null;
    this.db.set("offer", null);
  }

  // Offer the next turn, when there's nobody playing or offered.
  private advance() {
    if (this.active || this.offer || this.paused || this.complete || !this.observer.ready) return;
    for (const userId of this.db.queue()) {
      this.db.dequeue(userId);
      const user = this.db.user(userId);
      if (!user || user.attempt_used || user.banned) continue;
      this.makeOffer(userId, Date.now() + this.config.offerMs);
      this.log(`offered the turn to ${user.name}`);
      return;
    }
  }

  // Queued players must keep the page open; drop the ones who've been gone
  // for too long.
  private sweepQueue() {
    if (!this.absentSince.size) return;
    const now = Date.now();
    let changed = false;
    const queued = new Set(this.db.queue());
    for (const [userId, since] of this.absentSince) {
      // Left the queue some other way (offered, banned, the queue cleared).
      if (!queued.has(userId)) { this.absentSince.delete(userId); continue; }
      if (now - since > this.config.queueAbsentMs) {
        this.db.dequeue(userId);
        this.absentSince.delete(userId);
        this.log(`${this.db.user(userId)?.name ?? userId} left the queue (page closed)`);
        changed = true;
      }
    }
    if (changed) { this.advance(); this.broadcast(); }
  }

  // ---------------------------------------------------------------------------
  // ending a session
  // ---------------------------------------------------------------------------
  end(reason: EndReason, detail: string | null) {
    const s = this.active;
    if (!s) return;
    this.active = null;
    if (s.graceTimer) clearTimeout(s.graceTimer);
    if (s.endTimer) clearTimeout(s.endTimer);
    const now = Date.now();
    this.db.endSession(s.id, reason, detail, now);
    // Its checks the server hasn't confirmed. Without a current view of the
    // server, any of them might be lost: keep them all, and the ones the
    // server does have are dropped once it's seen again (pruneUnconfirmed).
    const unconfirmed = this.observer.ready ? this.owed(s) : new Set([...s.pending, ...s.newChecks]);
    if (unconfirmed.size) { this.unconfirmed.set(s.id, unconfirmed); this.saveUnconfirmed(); }
    // The session's credentials die with it: nothing can log in with them
    // again, and every connection that used them is closed here.
    for (const conn of [s.conns.game, s.conns.tracker, ...s.logins]) conn?.close(4000, `session ended: ${reason}`);
    this.log(`session ${s.id} ended: ${reason}${detail ? ` (${detail})` : ""}`);
    this.sendTo(s.userId, { type: "session-ended", sessionId: s.id, reason, detail });
    this.advance();
    this.broadcast();
  }

  // The grace period runs while the game is disconnected and could connect.
  // While the game server itself is down nobody can, so the clock stops, and
  // the player gets a full period again once it's back.
  private updateGrace() {
    const s = this.active;
    if (!s || this.stopped) return;
    if (!!s.conns.game || !this.observer.ready) {
      if (s.graceTimer) clearTimeout(s.graceTimer);
      s.graceTimer = null;
      s.graceEndsAt = null;
      return;
    }
    if (s.graceTimer) return;
    // Before the game has connected at all (booting, patching on a slow
    // device), a longer allowance: setting up shouldn't cost a turn.
    const ms = s.everConnected ? this.config.graceMs : Math.max(this.config.graceMs, FIRST_CONNECT_MS);
    s.graceEndsAt = Date.now() + ms;
    s.graceTimer = setTimeout(() => {
      // Out of checks and only waiting to hear the last ones landed: that
      // turn ended on its quota, whatever the connection did after.
      if (this.active === s) this.end(s.closing ? "quota" : "grace", null);
    }, ms);
  }

  // ---------------------------------------------------------------------------
  // proxy hooks
  // ---------------------------------------------------------------------------
  get slot() { return { name: this.seed.slotName, game: this.seed.game }; }

  // What a client sees before logging in, from the observer's copies: the
  // server's RoomInfo (null until we've seen it), and its data packages.
  get roomInfo(): unknown { return this.serverReady ? this.observer.roomInfo : null; }
  dataPackageGames(): string[] {
    return [...this.observer.dataPackages.keys()];
  }

  // The data package answer, as the JSON frame to send: built once per set of
  // games asked for (and again only when the observer's copy changes).
  private dataPackageFrames = new Map<string, string>();
  private dataPackageSource: unknown = null;
  dataPackage(games: unknown): string {
    if (this.dataPackageSource !== this.observer.roomInfo) {
      this.dataPackageSource = this.observer.roomInfo;
      this.dataPackageFrames.clear();
    }
    // Only names the server has: made-up ones can't make new cache entries.
    const wanted = (Array.isArray(games) ? games : [...this.observer.dataPackages.keys()])
      .filter((g): g is string => typeof g === "string" && this.observer.dataPackages.has(g));
    const names = [...new Set(wanted)].sort();
    const key = names.join("\u0000");
    let frame = this.dataPackageFrames.get(key);
    if (!frame) {
      const out: Record<string, unknown> = {};
      for (const g of names) out[g] = this.observer.dataPackages.get(g);
      frame = JSON.stringify([{ cmd: "DataPackage", data: { games: out } }]);
      this.dataPackageFrames.set(key, frame);
    }
    return frame;
  }

  credentials(): (SessionCredentials & { sessionId: string }) | null {
    const s = this.active;
    return s ? { sessionId: s.id, gamePassword: s.gamePassword, trackerPassword: s.trackerPassword } : null;
  }

  // A device starts playing the turn: it holds it from now on.
  // Taking the turn over for this device. A device resuming by itself names
  // the claim it last had (null: none yet), and only gets the turn back if
  // no other device has claimed it since; without one, it's the player
  // asking to play here, which takes it over.
  claimPlay(userId: string, resumeFrom?: string | null): string {
    const s = this.active;
    if (!s || s.userId !== userId) throw new HttpError(409, "you don't have a turn running");
    if (resumeFrom !== undefined && s.holder && s.holder !== resumeFrom) throw new HttpError(409, "this turn is being played on another device");
    s.holder = randomBytes(8).toString("hex");
    // The player's other pages learn the turn moved here.
    this.broadcast();
    return s.holder;
  }

  // Whether a game login from this device may take the turn.
  holdsPlay(holder: string | null): boolean {
    const s = this.active;
    return !s?.holder || s.holder === holder;
  }

  // Whether a connection's join token is the running turn's.
  isJoinToken(token: string | null): boolean {
    return !!token && !!this.active && token === joinToken(this.active.gamePassword);
  }

  isCurrent(sessionId: string | null) {
    return !!sessionId && this.active?.id === sessionId;
  }

  // A connection passed our login check as the game or PopTracker; it's sent
  // on to MultiServer, which still has to accept it.
  attach(conn: ProxyConn) {
    this.active?.logins.add(conn);
  }

  // The server accepted the connection's Connect. Resolves whether it
  // logged into our slot (anything else is a violation and ends the session).
  // Only now does it replace the role's previous connection (a reload, or a
  // reconnect over a half-dead socket), so a login the server goes on to
  // refuse can't knock the working one off. Never more than one of each.
  connected(conn: ProxyConn, role: Role, slot: number): boolean {
    const s = this.active;
    if (!s || (!s.logins.has(conn) && s.conns[role] !== conn)) return false;
    s.logins.delete(conn);
    if (slot !== this.observer.slot) {
      this.violation(`a connection logged into a different slot (${slot})`);
      return false;
    }
    const old = s.conns[role];
    s.conns[role] = conn;
    if (role === "game") s.everConnected = true;
    if (old && old !== conn) old.close(4001, "replaced by a newer connection");
    this.updateGrace();
    this.broadcast();
    return true;
  }

  detach(conn: ProxyConn) {
    const s = this.active;
    if (!s) return;
    s.logins.delete(conn);
    if (s.conns.game !== conn && s.conns.tracker !== conn) return;
    for (const role of ["game", "tracker"] as Role[]) {
      if (s.conns[role] !== conn) continue;
      s.conns[role] = null;
    }
    this.updateGrace();
    this.broadcast();
  }

  violation(detail: string) {
    this.end("violation", detail);
  }

  // The locations from a game client's LocationChecks that may go to the
  // server: new checks within what's left of the quota, plus re-sends of ones
  // already counted but not yet confirmed (the client repeats a check until
  // the server confirms it, e.g. after the server restarted under it).
  checks(conn: ProxyConn, locations: unknown): number[] {
    const s = this.active;
    if (!s || s.conns.game !== conn || this.stopped) return [];
    // Already counted for this session and not on the server (still pending,
    // or lost when it restarted from an older save): send again, don't count.
    const counted = (id: unknown) => typeof id === "number" && (s.pending.has(id) || (s.newChecks.has(id) && !this.observer.checked.has(id)));
    const resent = Array.isArray(locations) ? [...new Set(locations)].filter(counted) as number[] : [];
    // Out of checks: only the counted-but-unconfirmed ones may still go.
    if (s.closing) return resent;
    const remaining = this.config.checkLimit - s.newChecks.size - s.pending.size;
    const fresh = selectNewChecks(locations, {
      valid: this.observer.allLocations,
      checked: { has: (id: number) => this.observer.checked.has(id) || s.newChecks.has(id) },
      pending: s.pending,
      remaining,
    });
    let claimsMoved = false;
    for (const id of fresh) {
      s.pending.add(id);
      // An ended session never got this one confirmed (the server lost it);
      // now this player has checked it, so it's theirs, not a find of both.
      const from = this.claimUnconfirmed(id);
      if (from) { claimsMoved = true; this.db.removeFind(from, id); }
    }
    if (claimsMoved) this.saveUnconfirmed();
    if (s.newChecks.size + s.pending.size >= this.config.checkLimit && !s.endTimer) this.quotaReached(s, QUOTA_WAIT_MS);
    return [...resent, ...fresh];
  }

  // No checks left: stop counting new ones and end the session after `ms`.
  // Checks still unconfirmed while the game can't reach the server (it's
  // down, or the game is reconnecting) are owed to the player, so the wait
  // starts over instead; the grace period bounds a game that never returns.
  private quotaReached(s: Active, ms: number) {
    // (Shutting down: the session resumes, with this, after the restart.)
    if (this.stopped) return;
    s.closing = true;
    if (s.endTimer) clearTimeout(s.endTimer);
    s.endTimer = setTimeout(() => {
      if (this.active !== s) return;
      // Until the server is being watched again, what's confirmed is unknown;
      // and checks still owed to the player (unconfirmed, or lost when the
      // server restarted from an older save) wait for the game to resend them.
      if (!this.observer.ready || (this.owed(s).size > 0 && !s.conns.game)) { this.quotaReached(s, QUOTA_WAIT_MS); return; }
      this.end("quota", null);
    }, ms);
  }

  // A session's checks the server doesn't have (yet): sent and unconfirmed,
  // or counted and then lost when MultiServer restarted from an older save.
  // Only meaningful while the observer has a current view.
  private owed(s: Active): Set<number> {
    const owed = new Set(s.pending);
    for (const id of s.newChecks) if (!this.observer.checked.has(id)) owed.add(id);
    return owed;
  }

  // The last check has landed: end shortly (once; later confirmations don't
  // keep pushing the end back).
  private armLinger(s: Active) {
    if (s.lingering || s.newChecks.size < this.config.checkLimit) return;
    s.lingering = true;
    this.quotaReached(s, QUOTA_LINGER_MS);
  }

  // Whether the game connection should still be forwarded anything.
  gameOpen(conn: ProxyConn): boolean {
    const s = this.active;
    return !!s && s.conns.game === conn && !s.closing;
  }

  // ---------------------------------------------------------------------------
  // observer hooks
  // ---------------------------------------------------------------------------
  private onChecked(ids: number[]) {
    const now = Date.now();
    const s = this.active;
    // With no session running, only the most recent one's game could have
    // sent these.
    const fallback = s ? null : this.db.latestSessionId();
    const mine: number[] = [];
    let unconfirmedChanged = false;
    this.db.transaction(() => {
      for (const id of ids) {
        // An ended session's own check: theirs, even with another running now.
        let owner = this.claimUnconfirmed(id);
        if (owner) unconfirmedChanged = true;
        owner ??= s?.id ?? fallback;
        if (!owner) continue;
        this.db.addFind(owner, id, this.observer.locationName(id), now);
        if (s && owner === s.id) mine.push(id);
      }
    });
    if (unconfirmedChanged) this.saveUnconfirmed();
    this.observer.scout(ids);
    if (s) {
      for (const id of mine) { s.newChecks.add(id); s.pending.delete(id); }
      this.armLinger(s);
    }
    this.broadcast();
  }

  private onScouted(results: ScoutResult[]) {
    this.db.transaction(() => { for (const r of results) this.db.setFindItem(r.location, r.item, r.receiver); });
    this.broadcast();
  }

  // The game said it reached the goal. Nothing a player sends can end the
  // event by itself: the turn ends, the queue pauses, and an admin decides.
  claimGoal(conn: ProxyConn) {
    const s = this.active;
    if (!s || s.conns.game !== conn) return;
    // Remember whether an admin had paused already, so dismissing the claim
    // puts the queue back how it was.
    this.db.set("goal_claim", JSON.stringify({ sessionId: s.id, userId: s.userId, at: Date.now(), wasPaused: this.paused }));
    this.goalPending = true;
    this.log(`${this.db.user(s.userId)?.name ?? s.userId}'s game reported the goal — waiting for an admin to confirm`);
    this.paused = true;
    this.db.set("paused", "1");
    this.end("goal-reported", null);
  }

  // Tell MultiServer about the confirmed goal; until it has heard, try again
  // whenever the game server is back.
  private reportingGoal = false;
  private goalRetry: ReturnType<typeof setTimeout> | null = null;
  private reportGoal() {
    if (this.reportingGoal || !this.db.get("goal_unreported") || !this.observer.ready) return;
    this.reportingGoal = true;
    void this.observer.reportGoal().then((ok) => {
      this.reportingGoal = false;
      if (ok) { this.db.set("goal_unreported", null); this.log("reported the goal to the game server"); return; }
      this.log("couldn't report the goal to the game server yet — trying again shortly");
      if (!this.stopped) this.goalRetry = setTimeout(() => this.reportGoal(), GOAL_RETRY_MS);
    });
  }

  private goalClaim(): (NonNullable<AdminState["goalClaim"]> & { wasPaused: boolean }) | null {
    const raw = this.db.get("goal_claim");
    if (!raw) return null;
    try {
      const { sessionId, userId, at, wasPaused } = JSON.parse(raw);
      return { sessionId, at, user: this.db.publicUser(userId), wasPaused: !!wasPaused };
    } catch { return null; }
  }

  confirmGoal() {
    const claim = this.goalClaim();
    if (!claim) throw new HttpError(409, "no goal is waiting to be confirmed");
    this.complete = true;
    this.db.set("complete", "1");
    this.db.set("goal_claim", null);
    this.goalPending = false;
    this.db.setSessionOutcome(claim.sessionId, "goal", null);
    this.log("the goal is complete");
    this.db.set("goal_unreported", "1");
    this.reportGoal();
    this.clearOffer();
    this.db.clearQueue();
    this.broadcast();
  }

  dismissGoal() {
    const claim = this.goalClaim();
    if (!claim) throw new HttpError(409, "no goal is waiting to be confirmed");
    this.db.set("goal_claim", null);
    this.goalPending = false;
    this.db.setSessionOutcome(claim.sessionId, "goal-dismissed", null);
    this.log("goal claim dismissed");
    this.setPaused(claim.wasPaused);
  }

  endSession(sessionId: string, detail: string) {
    if (this.active?.id !== sessionId) throw new HttpError(409, "that turn has already ended");
    this.end("admin", detail);
  }

  // ---------------------------------------------------------------------------
  // admin
  // ---------------------------------------------------------------------------
  setPaused(paused: boolean) {
    if (!paused && this.db.get("goal_claim")) throw new HttpError(409, "confirm or dismiss the reported goal first");
    this.paused = paused;
    // A turn on offer waits too: back to the head of the line, not used up.
    if (paused && this.offer) {
      this.requeueFront(this.offer.userId);
      this.clearOffer();
    }
    this.db.set("paused", paused ? "1" : "0");
    this.advance();
    this.broadcast();
  }

  skipOffer(userId: string) {
    if (this.offer?.userId !== userId) throw new HttpError(409, "that offer has already gone");
    this.clearOffer();
    this.advance();
    this.broadcast();
  }

  resetUser(userId: string) {
    if (this.active?.userId === userId) throw new HttpError(409, "that user's turn is still running");
    this.db.setAttemptUsed(userId, false);
    this.broadcast();
  }

  setBanned(userId: string, banned: boolean) {
    this.db.setBanned(userId, banned);
    if (banned) {
      this.db.dequeue(userId);
      if (this.offer?.userId === userId) this.clearOffer();
      if (this.active?.userId === userId) this.end("admin", "banned");
      this.advance();
    }
    this.broadcast();
  }

  // ---------------------------------------------------------------------------
  // state for clients
  // ---------------------------------------------------------------------------
  publicState(queue: string[] = this.db.queue()): PublicState {
    const s = this.active;
    const user = (id: string) => this.db.publicUser(id);
    return {
      seed: this.seed.hash.slice(0, 16),
      checkLimit: this.config.checkLimit,
      paused: this.paused,
      complete: this.complete,
      goalPending: this.goalPending,
      queueAbsentSeconds: Math.round(this.config.queueAbsentMs / 1000),
      serverReady: this.observer.ready,
      serverProblem: this.observer.problem,
      current: s ? {
        sessionId: s.id,
        user: user(s.userId),
        startedAt: s.startedAt,
        checks: s.newChecks.size,
        gameConnected: !!s.conns.game,
        trackerConnected: !!s.conns.tracker,
      } : null,
      offered: this.offer ? { user: user(this.offer.userId), expiresAt: this.offer.expiresAt } : null,
      queue: queue.map(user),
      recent: this.db.recentFinds(15),
      totals: { checked: this.observer.checked.size, total: this.observer.allLocations.size },
    };
  }

  // `positions` (user → place in the queue) lets a broadcast work the queue
  // out once for everyone.
  youFor(userId: string, positions: Map<string, number> = positionsOf(this.db.queue())): YouState | null {
    const u = this.db.user(userId);
    if (!u) return null;
    const s = this.active?.userId === userId ? this.active : null;
    const idx = positions.get(userId) ?? -1;
    const credentials: Credentials | null = s ? {
      apUrl: `${this.config.apUrl}?join=${joinToken(s.gamePassword)}`,
      apAddress: this.config.apPublicAddress,
      slot: this.seed.slotName,
      gamePassword: s.gamePassword,
      trackerPassword: s.trackerPassword,
    } : null;
    return {
      user: toPublic(u),
      admin: this.config.admins.has(userId),
      banned: !!u.banned,
      attemptUsed: !!u.attempt_used,
      inQueue: idx >= 0,
      position: idx >= 0 ? idx + 1 : null,
      offer: this.offer?.userId === userId ? { expiresAt: this.offer.expiresAt } : null,
      session: s ? {
        id: s.id,
        startedAt: s.startedAt,
        checks: s.newChecks.size,
        finds: this.db.finds(s.id),
        gameConnected: !!s.conns.game,
        trackerConnected: !!s.conns.tracker,
        graceEndsAt: s.graceEndsAt,
        holder: s.holder,
        credentials: credentials!,
      } : null,
      lastSession: !s && u.attempt_used ? this.db.lastSessionFor(userId) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // live sockets
  // ---------------------------------------------------------------------------
  addLive(ws: WebSocket, userId: string | null) {
    const live: Live = { ws, userId, alive: true };
    this.lives.add(live);
    if (userId) {
      this.absentSince.delete(userId);
      this.liveCount.set(userId, (this.liveCount.get(userId) ?? 0) + 1);
    }
    ws.on("pong", () => { live.alive = true; });
    ws.on("close", () => {
      this.lives.delete(live);
      if (!userId) return;
      const n = (this.liveCount.get(userId) ?? 1) - 1;
      if (n > 0) { this.liveCount.set(userId, n); return; }
      this.liveCount.delete(userId);
      // Only queued players lose their place for having no page open.
      if (this.db.isQueued(userId)) this.absentSince.set(userId, Date.now());
    });
    ws.on("message", () => { /* nothing is accepted from clients here */ });
    // The latest broadcast's state, rather than rebuilding it for every page
    // that connects (all of them at once, after a restart); the time is this
    // send's own.
    if (!this.lastPublic) this.cachePublic();
    if (ws.readyState === WebSocket.OPEN) ws.send(this.publicFrame());
    if (userId) this.sendLive(live, { type: "you", you: this.youFor(userId, this.lastPublic!.positions) });
  }

  private hasLive(userId: string) {
    return this.liveCount.has(userId);
  }

  // How many live sockets a user has open (for the per-user cap).
  liveSocketsOf(userId: string): number {
    return this.liveCount.get(userId) ?? 0;
  }

  private pingLives() {
    for (const l of this.lives) {
      if (!l.alive) { l.ws.terminate(); continue; }
      l.alive = false;
      try { l.ws.ping(); } catch {}
    }
  }

  private sendLive(l: Live, msg: ServerMessage) {
    if (l.ws.readyState === WebSocket.OPEN) l.ws.send(JSON.stringify(msg));
  }

  private sendTo(userId: string, msg: ServerMessage) {
    for (const l of this.lives) if (l.userId === userId) this.sendLive(l, msg);
  }

  // Push the public state to everyone and each user's own state to them.
  // Coalesced: several changes in one tick go out once.
  // The public state (as JSON) and queue positions, kept from the last build.
  private cachePublic() {
    const queue = this.db.queue();
    this.lastPublic = { state: JSON.stringify(this.publicState(queue)), positions: positionsOf(queue) };
    return this.lastPublic;
  }
  // A public message: the cached state, stamped with the server's time now.
  private publicFrame(): string {
    return `{"type":"public","now":${Date.now()},"state":${this.lastPublic!.state}}`;
  }

  broadcast() {
    // Stale from now until the coalesced broadcast below rebuilds it.
    this.lastPublic = null;
    if (this.broadcastQueued) return;
    this.broadcastQueued = true;
    setImmediate(() => {
      this.broadcastQueued = false;
      if (this.stopped) return;
      const { positions } = this.cachePublic();
      const pub = this.publicFrame();
      const yous = new Map<string, string>();
      for (const l of this.lives) {
        if (l.ws.readyState !== WebSocket.OPEN) continue;
        l.ws.send(pub);
        if (!l.userId) continue;
        let y = yous.get(l.userId);
        if (y === undefined) {
          y = JSON.stringify({ type: "you", you: this.youFor(l.userId, positions) } satisfies ServerMessage);
          yous.set(l.userId, y);
        }
        l.ws.send(y);
      }
    });
  }

  adminState(): AdminState {
    const claim = this.goalClaim();
    return {
      sessions: this.db.sessions(),
      users: this.db.adminUsers(),
      goalClaim: claim && { sessionId: claim.sessionId, at: claim.at, user: claim.user },
    };
  }

  // A user's name or avatar changed (they signed in again).
  userChanged() {
    this.broadcast();
  }

  // Whether players can log in: the slot is being watched and we're not
  // shutting down.
  get serverReady() { return !this.stopped && this.observer.ready; }
}
