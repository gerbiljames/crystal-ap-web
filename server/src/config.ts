// Server configuration, read once from the environment. See README for what
// each variable means.

import { resolve } from "node:path";

export type Config = {
  port: number;
  // Where players reach the site, e.g. https://yogos.example.com. Used for the
  // Discord redirect, origin checks, and the addresses handed to clients.
  publicUrl: URL;
  // What the browser's game client dials.
  apUrl: string;
  // What PopTracker users type in: host:port.
  apPublicAddress: string;
  discord: { clientId: string; clientSecret: string; guildId: string | null };
  sessionSecret: string;
  admins: Set<string>;
  checkLimit: number;
  graceMs: number;
  offerMs: number;
  // How long a queued player can be without an open page before losing their place.
  queueAbsentMs: number;
  dataDir: string;
  seedDir: string;
  staticDir: string | null;
  apDir: string;
  python: string;
  multiServerPort: number;
  // Sign in as anyone via /api/auth/dev — for local testing only.
  devLogin: boolean;
  // Behind a reverse proxy: take the client's address from the last
  // X-Forwarded-For entry (the one the proxy added).
  trustProxy: boolean;
};

function int(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}, got ${raw}`);
  return n;
}

function multiServerPort(port: number): number {
  const p = int("MULTISERVER_PORT", 38282, 1);
  if (p === port) throw new Error(`MULTISERVER_PORT must differ from PORT (both ${p})`);
  return p;
}

function required(name: string, devFallback?: string): string {
  const v = process.env[name];
  if (v) return v;
  if (devFallback !== undefined && process.env.DEV_LOGIN === "1") return devFallback;
  throw new Error(`${name} is required`);
}

export function loadConfig(): Config {
  const port = int("PORT", 8080, 1);
  const publicUrl = new URL(process.env.PUBLIC_URL || `http://127.0.0.1:${port}`);
  // Everything (the site, /api, the Discord callback, /archipelago) lives at
  // the root of its host.
  if (publicUrl.pathname !== "/") throw new Error(`PUBLIC_URL must be the root of a host (no path), got ${publicUrl}`);
  const secure = publicUrl.protocol === "https:";
  const publicPort = publicUrl.port || (secure ? "443" : "80");

  const apUrl = new URL("/archipelago", publicUrl);
  apUrl.protocol = secure ? "wss:" : "ws:";

  const devLogin = process.env.DEV_LOGIN === "1";
  const sessionSecret = required("SESSION_SECRET", "dev-only-session-secret-change-me");
  if (sessionSecret.length < 16) throw new Error("SESSION_SECRET must be at least 16 characters");

  const dataDir = resolve(process.env.DATA_DIR || "data");
  return {
    port,
    publicUrl,
    apUrl: apUrl.toString(),
    apPublicAddress: process.env.AP_PUBLIC_ADDRESS || `${publicUrl.hostname}:${publicPort}`,
    discord: {
      clientId: required("DISCORD_CLIENT_ID", ""),
      clientSecret: required("DISCORD_CLIENT_SECRET", ""),
      guildId: process.env.DISCORD_GUILD_ID || null,
    },
    sessionSecret,
    admins: new Set((process.env.ADMIN_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)),
    // Zero would end every turn (or offer) the moment it began.
    checkLimit: int("CHECK_LIMIT", 10, 1),
    graceMs: int("DISCONNECT_GRACE_SECONDS", 120, 1) * 1000,
    offerMs: int("READY_TIMEOUT_SECONDS", 180, 1) * 1000,
    queueAbsentMs: int("QUEUE_ABSENT_SECONDS", 60, 1) * 1000,
    dataDir,
    seedDir: resolve(process.env.SEED_DIR || `${dataDir}/seed`),
    staticDir: process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null,
    apDir: resolve(process.env.AP_DIR || "vendor/archipelago"),
    python: process.env.PYTHON || "python3",
    multiServerPort: multiServerPort(port),
    devLogin,
    trustProxy: process.env.TRUST_PROXY === "1",
  };
}
