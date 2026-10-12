// YOGOS server: loads the seed, runs MultiServer behind the proxy, and serves
// the site and API. Run with `node server/src/main.ts` (Node 24 strips the
// types itself).

import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { loadSeed, loadSignNames } from "./seed.ts";
import { MultiServer } from "./multiserver.ts";
import { Checkpoints } from "./checkpoints.ts";
import { Observer } from "./observer.ts";
import { Game } from "./game.ts";
import { startHttp } from "./http.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

function main() {
  const config = loadConfig();
  if (config.devLogin) log("WARNING: DEV_LOGIN is on — anyone can sign in as anyone via /api/auth/dev. Never use this in production.");
  if (!config.admins.size) log("no ADMIN_DISCORD_IDS set — nobody can use the admin page");

  const db = new Db(join(config.dataDir, "yogos.db"));
  const seed = loadSeed(config.seedDir, join(config.dataDir, "run"));
  const signs = loadSignNames(config.apDir);

  // One database per seed: its turns, finds and used attempts only make sense
  // for the game they were played in.
  const knownSeed = db.get("seed_hash");
  if (knownSeed && knownSeed !== seed.hash) {
    throw new Error(`${config.seedDir} holds a different seed than the one ${config.dataDir}/yogos.db was used with. `
      + "Start the new seed with an empty data directory (keep the seed directory), or put the old seed back.");
  }
  db.set("seed_hash", seed.hash);
  log(`seed ${seed.hash.slice(0, 12)}: slot ${seed.slotName} (${seed.game}), patch ${seed.patchName}`);

  const multiServer = new MultiServer({
    python: config.python,
    apDir: config.apDir,
    multidataPath: seed.multidataPath,
    port: config.multiServerPort,
    log,
  });
  const observer = new Observer({
    url: () => multiServer.url,
    slotName: seed.slotName,
    game: seed.game,
    log,
  });
  observer.on("change", () => { if (observer.ready) multiServer.markHealthy(); });

  const game = new Game(config, db, seed, observer, log);
  game.useCheckpoints(
    new Checkpoints(db, join(config.dataDir, "checkpoints"), multiServer),
    (swap) => multiServer.restartWith(swap),
  );

  multiServer.start();
  observer.start();
  const server = startHttp({
    config, db, seed, game,
    multiServerUrl: () => multiServer.url,
    log,
    signs,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal}: shutting down`);
    // The running session stays open in the database and resumes when the
    // server comes back.
    game.stop();
    // Players are cut off now; give checks already on their way a moment to
    // land, so the observer hears about them before it stops listening.
    await new Promise((r) => setTimeout(r, 1500));
    observer.stop();
    server.close();
    await multiServer.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

try {
  main();
} catch (err) {
  console.error(`${new Date().toISOString()} fatal: ${(err as Error)?.message || err}`);
  process.exit(1);
}
