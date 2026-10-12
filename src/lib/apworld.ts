// The bundled Crystal apworld, and whether it can play a seed's patch.
//
// pack.sh bundles the vendor/archipelago world (the same one the server's
// MultiServer runs) and describes it in src/generated/versions.json (see
// scripts/pack-worlds.py), imported here at build time so the app and the tars
// it points the worker at always come from the same pack.

import { readPatchManifest } from "./zip.js";
import versionsJson from "../generated/versions.json";

export type BundledWorld = {
  channel: string;
  package: string;
  game: string;
  world_version: string;
  display_version: string;
  minimum_patch_version: string | null;
  tar: string;
  size: number;
};

export type BundledVersions = {
  core: { tar: string; ap_version: string | null };
  worlds: BundledWorld[];
};

export const VERSIONS: BundledVersions = versionsJson as BundledVersions;

// What the worker needs to assemble a runtime: the core tar plus one world per
// package, as paths under public/ap/. Sent to the worker when it is spawned.
export type RuntimeConfig = { coreTar: string; worlds: BundledWorld[] };

// The runtime: the core plus the bundled world of every package.
export function bundledRuntime(): RuntimeConfig {
  return { coreTar: VERSIONS.core.tar, worlds: bundledWorlds() };
}

// Numeric dotted-prefix compare, matching Utils.tuplize_version for the
// plain "1.30.11" strings the manifests carry. Any non-numeric suffix is
// ignored.
export function parseVersion(v: string): number[] {
  const m = /^\d+(\.\d+)*/.exec(v.trim());
  return m ? m[0].split(".").map(Number) : [];
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// The bundled world of every package: what the runtime boots.
export function bundledWorlds(): BundledWorld[] {
  return VERSIONS.worlds;
}

// Whether the bundled world can play a patch. A patch whose manifest names
// its generator's version is checked against the compatibility window the
// apworld itself enforces (rom.py assert_version_compat); one that doesn't is
// left to the worker's check of the patched ROM's checksum.
export type PatchCheck = { ok: true; world: BundledWorld } | { ok: false; reason: string };

export async function checkPatch(patchBytes: Uint8Array): Promise<PatchCheck> {
  const manifest = await readPatchManifest(patchBytes);
  const game: string = manifest.game || "Pokemon Crystal";
  const world = bundledWorlds().find((w) => w.game === game);
  if (!world) return { ok: false, reason: `this site doesn't play ${game}` };
  const patchVersion: string | undefined = manifest.world_version;
  if (patchVersion && world.minimum_patch_version) {
    const patchMin: string = manifest.minimum_patch_version || patchVersion;
    const fits = compareVersions(world.world_version, patchMin) >= 0
      && compareVersions(patchVersion, world.minimum_patch_version) >= 0;
    if (!fits) return { ok: false, reason: `this seed was made with ${game} apworld ${patchVersion}, which the bundled ${world.display_version} can't play` };
  }
  return { ok: true, world };
}
