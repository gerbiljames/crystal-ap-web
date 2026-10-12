// A permanent connection of our own to MultiServer, tagged as a tracker so it
// can never check anything. It is the server's view of the slot: which of its
// locations exist and which are checked, what was at each newly checked one,
// and the names of everything.

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { CLIENT_GOAL } from "./rules.ts";

export type ScoutResult = { location: number; item: string; receiver: string | null };


// A socket to MultiServer, as the observer, the goal report and the proxy
// all open one. Compressed, though it's loopback, because MultiServer warns
// every player whose connection isn't.
export function connectUpstream(url: string): WebSocket {
  return new WebSocket(url, { perMessageDeflate: true, maxPayload: 64 * 1024 * 1024 });
}

export type ObserverOptions = {
  url: () => string;
  slotName: string;
  game: string;
  log: (line: string) => void;
};

export class Observer extends EventEmitter {
  // Every location in the slot, and those checked so far.
  readonly allLocations = new Set<number>();
  readonly checked = new Set<number>();
  ready = false;
  // Why this seed can't be played here (seen on Connected), or null.
  problem: string | null = null;
  private everConnected = false;
  team = 0;
  slot = 0;

  private ws: WebSocket | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  // The server's RoomInfo and data packages, as it sent them: the proxy
  // answers clients that haven't logged in yet from these.
  roomInfo: any = null;
  readonly dataPackages = new Map<string, unknown>();
  private locationNames = new Map<number, string>();
  private itemNames = new Map<string, Map<number, string>>();
  private playerNames = new Map<number, string>();
  private playerGames = new Map<number, string>();

  private opts: ObserverOptions;

  constructor(opts: ObserverOptions) {
    super();
    this.opts = opts;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }

  // The server is about to come back from another save (a rollback): what it
  // has checked then is the new state of the game, not news of checks made
  // while we weren't looking.
  expectRestore() {
    this.everConnected = false;
  }

  locationName(id: number): string {
    return this.locationNames.get(id) ?? `location ${id}`;
  }

  // Ask what the given (just checked) locations held. Answers arrive as
  // "scouted" events.
  scout(locations: number[]) {
    if (!locations.length) return;
    this.send([{ cmd: "LocationScouts", locations, create_as_hint: 0 }]);
  }

  // Tell MultiServer the slot reached its goal (after an admin confirmed it).
  // The observer can't: it's a tracker, and the server ignores goals from
  // those. So log in briefly as the slot's game, report it and leave.
  reportGoal(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = connectUpstream(this.opts.url());
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(ok);
      };
      let statusKey = "";
      const timer = setTimeout(() => done(false), 15000);
      ws.on("message", (data) => {
        let msgs: any[];
        try { msgs = JSON.parse(data.toString()); } catch { return; }
        for (const msg of Array.isArray(msgs) ? msgs : []) {
          if (msg?.cmd === "RoomInfo") {
            ws.send(JSON.stringify([this.connectPacket(msg, { game: this.opts.game, uuid: "yogos-goal", tags: ["AP"], slot_data: false })]));
          } else if (msg?.cmd === "Connected") {
            // Report it, then read the slot's status back: done only once
            // MultiServer says the goal is recorded.
            statusKey = `_read_client_status_${msg.team}_${msg.slot}`;
            ws.send(JSON.stringify([
              { cmd: "StatusUpdate", status: CLIENT_GOAL },
              { cmd: "Get", keys: [statusKey] },
            ]));
          } else if (msg?.cmd === "Retrieved" && statusKey) {
            done(msg.keys?.[statusKey] === CLIENT_GOAL);
          } else if (msg?.cmd === "ConnectionRefused") {
            done(false);
          }
        }
      });
      ws.on("error", () => done(false));
      ws.on("close", () => done(false));
    });
  }

  // Our Connect for the slot, answering the server's RoomInfo. Never asks for
  // items: the observer and the goal report only look.
  private connectPacket(roomInfo: any, who: { game: string; uuid: string; tags: string[]; slot_data: boolean }) {
    return {
      cmd: "Connect", password: null, name: this.opts.slotName, version: roomInfo.version,
      items_handling: 0, ...who,
    };
  }

  private send(msgs: unknown[]) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msgs));
  }

  private connect() {
    if (this.stopped) return;
    const ws = this.ws = connectUpstream(this.opts.url());
    ws.on("message", (data) => {
      let msgs: any[];
      try { msgs = JSON.parse(data.toString()); } catch { return; }
      if (!Array.isArray(msgs)) return;
      for (const msg of msgs) this.handle(msg);
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ready) { this.ready = false; this.emit("change"); }
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), 2000);
    });
    ws.on("error", () => { /* close follows */ });
  }

  private handle(msg: any) {
    switch (msg?.cmd) {
      case "RoomInfo": {
        this.roomInfo = msg;
        const games: string[] = msg.games ?? [];
        this.send([
          { cmd: "GetDataPackage", games },
          this.connectPacket(msg, { game: "", uuid: "yogos-observer", tags: ["Tracker", "NoText"], slot_data: true }),
        ]);
        break;
      }
      case "DataPackage": {
        for (const [game, pkg] of Object.entries<any>(msg.data?.games ?? {})) {
          this.dataPackages.set(game, pkg);
          if (game === this.opts.game) {
            for (const [name, id] of Object.entries<number>(pkg.location_name_to_id ?? {})) this.locationNames.set(id, name);
          }
          const items = new Map<number, string>();
          for (const [name, id] of Object.entries<number>(pkg.item_name_to_id ?? {})) items.set(id, name);
          this.itemNames.set(game, items);
        }
        break;
      }
      case "Connected": {
        this.problem = null;
        this.team = msg.team;
        this.slot = msg.slot;
        // Back after a gap (MultiServer restarted, or our socket dropped):
        // anything checked meanwhile is news like any RoomUpdate would be.
        const before = this.everConnected ? new Set(this.checked) : null;
        this.everConnected = true;
        this.allLocations.clear();
        this.checked.clear();
        for (const id of msg.missing_locations ?? []) this.allLocations.add(id);
        for (const id of msg.checked_locations ?? []) { this.allLocations.add(id); this.checked.add(id); }
        const missed = before ? [...this.checked].filter((id) => !before.has(id)) : [];
        for (const [id, info] of Object.entries<any>(msg.slot_info ?? {})) {
          this.playerNames.set(Number(id), info.name);
          this.playerGames.set(Number(id), info.game);
        }
        // Only a one-slot Crystal seed with remote items can be relayed: no
        // one can ever connect to another slot (its items would be lost),
        // and without remote items the items a player finds stay in their
        // deleted save instead of going to the next player.
        const players = Object.keys(msg.slot_info ?? {}).length;
        this.problem = players > 1 ? `the seed has ${players} slots; it must be a single Crystal slot (nobody could play the others)`
          : !msg.slot_data?.remote_items ? "the seed was generated without remote_items; it must be on for items to pass from player to player"
          : msg.slot_data?.trap_link ? "the seed has trap_link on; it must be off"
          : null;
        if (this.problem) {
          this.opts.log(`[observer] this seed can't be played: ${this.problem}`);
          this.emit("change");
          break;
        }
        this.ready = true;
        this.opts.log(`[observer] watching ${this.opts.slotName}: ${this.checked.size}/${this.allLocations.size} locations checked`);
        if (missed.length) this.emit("checked", missed);
        this.emit("change");
        break;
      }
      case "ConnectionRefused": {
        // MultiServer won't let us watch the slot (the patch's slot name not
        // in the multidata, say): nothing can be played; say why.
        const errors = (msg.errors ?? []).join(", ") || "no reason given";
        const problem = `the game server refused the slot (${errors}); check the seed`;
        if (problem !== this.problem) {
          this.problem = problem;
          this.opts.log(`[observer] refused: ${errors}`);
          this.emit("change");
        }
        this.ws?.close();
        break;
      }
      case "RoomUpdate": {
        // Clients that haven't logged in get our copy of the RoomInfo: keep
        // its permissions current (they're set again after every start).
        if (msg.permissions && this.roomInfo) this.roomInfo = { ...this.roomInfo, permissions: msg.permissions };
        const fresh: number[] = [];
        for (const id of msg.checked_locations ?? []) {
          if (!this.checked.has(id)) { this.checked.add(id); this.allLocations.add(id); fresh.push(id); }
        }
        if (fresh.length) { this.emit("checked", fresh); this.emit("change"); }
        break;
      }
      case "LocationInfo": {
        const results: ScoutResult[] = [];
        for (const ni of msg.locations ?? []) {
          const receiverGame = this.playerGames.get(ni.player) ?? this.opts.game;
          const item = this.itemNames.get(receiverGame)?.get(ni.item) ?? `item ${ni.item}`;
          results.push({ location: ni.location, item, receiver: ni.player === this.slot ? null : (this.playerNames.get(ni.player) ?? `player ${ni.player}`) });
        }
        this.emit("scouted", results);
        break;
      }
    }
  }
}
