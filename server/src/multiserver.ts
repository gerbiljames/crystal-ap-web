// Runs Archipelago's MultiServer.py as a child process, bound to localhost so
// the only way in is through the proxy (which authenticates every session
// itself, so MultiServer has no password of its own). Restarts it if it dies.
// Saves on demand (for checkpoints), and restarts it from another save (a
// rollback).

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { extname } from "node:path";

// How long MultiServer gets to answer /save.
const SAVE_TIMEOUT_MS = 15000;

// What MultiServer must run with. Its save keeps these and they override the
// command line on every start (a save from an earlier setup, or a checkpoint
// rolled back to), so they're set again through its console each time too.
const ENFORCED_OPTIONS = [
  // Nothing may grant items or checks outside the proxy's count.
  ["item_cheat", "false"],
  ["release_mode", "disabled"],
  ["collect_mode", "disabled"],
  ["remaining_mode", "disabled"],
  // No password of its own (the proxy holds each turn's), and no remote admin.
  ["password", "null"],
  ["server_password", "null"],
];

export type MultiServerOptions = {
  python: string;
  apDir: string;
  multidataPath: string;
  port: number;
  log: (line: string) => void;
};

export class MultiServer {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartDelay = 1000;
  private opts: MultiServerOptions;
  // Called with each line MultiServer prints (a /save waits for its answer).
  private lineWatchers = new Set<(line: string) => void>();

  constructor(opts: MultiServerOptions) {
    this.opts = opts;
  }

  get url() { return `ws://127.0.0.1:${this.opts.port}`; }

  // Where MultiServer keeps the game's progress: beside the multidata, named
  // the way MultiServer names it.
  get savePath(): string {
    const path = this.opts.multidataPath;
    const ext = extname(path);
    return [".archipelago", ".zip"].includes(ext.toLowerCase()) ? path.slice(0, -ext.length) + ".apsave" : `${path}_apsave`;
  }

  start() {
    this.stopping = false;
    this.spawnChild();
  }

  private spawnChild() {
    const o = this.opts;
    const args = [
      "MultiServer.py", o.multidataPath,
      "--host", "127.0.0.1",
      "--port", String(o.port),
      // As ENFORCED_OPTIONS, for a game with no save yet.
      "--disable_item_cheat",
      "--release_mode", "disabled",
      "--collect_mode", "disabled",
      "--remaining_mode", "disabled",
      "--loglevel", "info",
    ];
    const child = this.child = spawn(o.python, args, {
      cwd: o.apDir,
      // Only what Python needs: none of this server's secrets.
      env: { ...pythonEnv(), SKIP_REQUIREMENTS_UPDATE: "1", PYTHONUNBUFFERED: "1" },
      // MultiServer's console: only ENFORCED_OPTIONS and /save are ever
      // written to it. (A pipe, not /dev/null, where it would spin reading
      // end-of-file forever.)
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin!.on("error", () => { /* it exited; 'close' handles that */ });
    // Read once its console starts, which is after the save has loaded.
    child.stdin!.write(ENFORCED_OPTIONS.map(([name, value]) => `/option ${name} ${value}\n`).join(""));
    for (const stream of [child.stdout!, child.stderr!]) {
      createInterface({ input: stream }).on("line", (line) => {
        o.log(`[multiserver] ${line}`);
        for (const watch of this.lineWatchers) watch(line);
      });
    }
    // 'close' comes after the process exits, and also after a spawn that
    // failed outright (which never emits 'exit').
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = null;
      o.log(`[multiserver] exited (${signal ?? code})`);
      if (this.stopping) return;
      setTimeout(() => { if (!this.stopping) this.spawnChild(); }, this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    });
    child.on("error", (err) => o.log(`[multiserver] failed to start: ${err.message}`));
  }

  // Back to a short restart delay once a run has stayed up.
  markHealthy() { this.restartDelay = 1000; }

  // Have MultiServer write its save now; resolves once it says it has.
  saveNow(): Promise<void> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error("the game server isn't running"));
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.lineWatchers.delete(watch);
        child.off("close", onClose);
        if (err) reject(err); else resolve();
      };
      const watch = (line: string) => {
        if (line.trim() === "Game saved") done();
        else if (line.trim() === "Saving is disabled.") done(new Error("the game server has saving disabled"));
      };
      const onClose = () => done(new Error("the game server stopped while saving"));
      const timer = setTimeout(() => done(new Error("the game server didn't save in time")), SAVE_TIMEOUT_MS);
      this.lineWatchers.add(watch);
      child.once("close", onClose);
      child.stdin!.write("/save\n");
    });
  }

  // Stop MultiServer, run `swap` while it's down (it replaces the save), and
  // start it again. MultiServer saves as it exits, so the swap comes after.
  async restartWith(swap: () => void): Promise<void> {
    await this.stop();
    try { swap(); }
    finally {
      this.restartDelay = 1000;
      this.start();
    }
  }

  // SIGTERM makes MultiServer save before it exits.
  stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.once("close", () => { clearTimeout(kill); resolve(); });
      if (!child.kill("SIGTERM")) { clearTimeout(kill); resolve(); }
    });
  }
}

// The environment MultiServer runs with: the basics plus Python's own
// variables, never the server's (SESSION_SECRET, the Discord secret).
function pythonEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (["PATH", "HOME", "LANG", "TZ", "TMPDIR", "VIRTUAL_ENV"].includes(k) || k.startsWith("LC_") || k.startsWith("PYTHON")) out[k] = v;
  }
  return out;
}
