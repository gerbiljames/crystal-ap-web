// Runs Archipelago's MultiServer.py as a child process, bound to localhost so
// the only way in is through the proxy (which authenticates every session
// itself, so MultiServer has no password of its own). Restarts it if it dies.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

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

  constructor(opts: MultiServerOptions) {
    this.opts = opts;
  }

  get url() { return `ws://127.0.0.1:${this.opts.port}`; }

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
      // Nothing may grant items or checks outside the proxy's count.
      "--disable_item_cheat",
      "--release_mode", "disabled",
      "--collect_mode", "disabled",
      "--remaining_mode", "goal",
      "--loglevel", "info",
    ];
    const child = this.child = spawn(o.python, args, {
      cwd: o.apDir,
      // Only what Python needs: none of this server's secrets.
      env: { ...pythonEnv(), SKIP_REQUIREMENTS_UPDATE: "1", PYTHONUNBUFFERED: "1" },
      // A pipe nothing is ever written to: MultiServer's console blocks on it
      // quietly (on /dev/null it would spin, reading end-of-file forever).
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const stream of [child.stdout!, child.stderr!]) {
      createInterface({ input: stream }).on("line", (line) => o.log(`[multiserver] ${line}`));
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
