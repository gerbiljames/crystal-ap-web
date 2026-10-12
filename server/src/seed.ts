// The seed the server runs: the generator's output (its .zip, or the loose
// .archipelago and patch files) dropped into the seed directory. MultiServer
// writes its .apsave next to the multidata, so the multidata is copied into a
// writable run directory first.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";

export type Seed = {
  // The multidata MultiServer loads, in the run directory.
  multidataPath: string;
  // The slot's patch, served to players.
  patchName: string;
  patchBytes: Uint8Array;
  slotName: string;
  game: string;
  // Identifies the seed across restarts (sha256 of the multidata).
  hash: string;
};

// The stable Crystal world's patches; that's the world the browser bundles.
const isPatch = (n: string) => /\.apcrystal$/i.test(n);
const isMultidata = (n: string) => /\.archipelago$/i.test(n);

export function loadSeed(seedDir: string, runDir: string): Seed {
  if (!existsSync(seedDir)) throw new Error(`seed directory ${seedDir} doesn't exist — put the generator's output .zip there`);
  const files: Record<string, Uint8Array> = {};
  for (const name of readdirSync(seedDir)) {
    const path = join(seedDir, name);
    if (name.toLowerCase().endsWith(".zip")) {
      const entries = unzipSync(readFileSync(path));
      for (const [entry, bytes] of Object.entries(entries)) {
        const base = basename(entry);
        if (isMultidata(base) || isPatch(base)) files[base] = bytes;
      }
    } else if (isMultidata(name) || isPatch(name)) {
      files[name] = readFileSync(path);
    }
  }

  const multis = Object.keys(files).filter((n) => isMultidata(n));
  if (multis.length !== 1) throw new Error(`expected one .archipelago in ${seedDir}, found ${multis.length ? multis.join(", ") : "none"}`);
  const multiName = multis[0];

  const patches = Object.keys(files).filter(isPatch).map((name) => ({ name, manifest: readManifest(files[name], name) }));
  if (patches.length === 0) throw new Error(`no .apcrystal patch in ${seedDir}`);
  // One slot, played by everyone in turn: nobody could connect to another.
  if (patches.length !== 1) throw new Error(`the seed has ${patches.length} Crystal slots; it must have exactly one`);
  const patch = patches[0];

  mkdirSync(runDir, { recursive: true });
  const multidataPath = join(runDir, multiName);
  const hash = sha256(files[multiName]);
  // Only copied once: from then on MultiServer's .apsave beside it holds the
  // progress, and the multidata itself never changes. One already there must
  // be this seed's (a regenerated seed can reuse the file name).
  if (!existsSync(multidataPath)) {
    writeFileSync(multidataPath, files[multiName]);
  } else if (sha256(readFileSync(multidataPath)) !== hash) {
    throw new Error(`${multidataPath} is from a different seed than ${seedDir}. Start the new seed with an empty data directory (keep the seed directory), or put the old seed back.`);
  }

  return {
    multidataPath,
    patchName: patch.name,
    patchBytes: files[patch.name],
    slotName: patch.manifest.player_name,
    game: patch.manifest.game || "Pokemon Crystal",
    hash,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readManifest(bytes: Uint8Array, name: string): { player_name: string; game?: string } {
  let manifest: any;
  try { manifest = JSON.parse(strFromU8(unzipSync(bytes, { filter: (f) => f.name === "archipelago.json" })["archipelago.json"])); }
  catch (err) { throw new Error(`couldn't read the manifest in ${name}: ${err}`); }
  if (typeof manifest?.player_name !== "string") throw new Error(`${name} has no player_name in its manifest`);
  return manifest;
}

// The names the Crystal world gives its Unown signs, which the game client
// keeps in data storage: only these are let through (see rules.ts). Read from
// the world MultiServer runs, so they always match it.
export function loadSignNames(apDir: string): Set<string> {
  const path = join(apDir, "worlds", "pokemon_crystal", "data", "data.json");
  const signs = JSON.parse(readFileSync(path, "utf8"))?.unown_signs;
  if (!Array.isArray(signs) || !signs.length || !signs.every((s) => typeof s?.name === "string")) {
    throw new Error(`${path} has no unown_signs list: has the Crystal world changed its data format?`);
  }
  return new Set(signs.map((s: { name: string }) => s.name));
}
