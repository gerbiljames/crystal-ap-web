// Bundled apworld versions and the rule for picking one per seed.
//
// pack.sh bundles one or more versions of each Crystal apworld and describes
// them in public/ap/versions.json (see scripts/pack-worlds.py). A seed is
// pinned to a *minimum*, not an exact version: upstream keeps newer apworlds
// able to play older seeds within a compatibility window, so the app always
// picks the newest bundled version that can still take the seed, and only
// falls back to an older bundle when the newest one can't.
//
// Two channels, two rules, both mirroring what the apworld itself enforces:
//   prerelease — the patch manifest carries world_version and
//                minimum_patch_version; an installed version I plays a patch P
//                when I >= P.minimum_patch_version and P >= I.minimum_patch_version
//                (rom.py assert_version_compat).
//   stable     — the manifest carries no version, but the patch embeds the
//                generating apworld's basepatch.bsdiff4. Hashing it identifies
//                the generator; any bundled stable with the same ROM checksum
//                (data.json rom_version) can then play the ROM, because that
//                checksum is what the client demands at connect.

import { readPatchManifest, readZipEntry } from "./zip.js";

export type BundledWorld = {
  channel: string;
  package: string;
  game: string;
  world_version: string;
  display_version: string;
  minimum_patch_version: string | null;
  minimum_ap_version: string | null;
  rom_version: number;
  rom_version11: number;
  basepatch_sha256: Record<string, string>;
  tar: string;
  size: number;
  latest: boolean;
  ref: string | null;
};

export type BundledVersions = {
  core: { tar: string; ap_version: string | null };
  worlds: BundledWorld[];
};

let versionsPromise: Promise<BundledVersions> | null = null;

export function loadVersions(): Promise<BundledVersions> {
  if (!versionsPromise) {
    versionsPromise = fetch(`${import.meta.env.BASE_URL}ap/versions.json`).then(async (res) => {
      if (!res.ok) throw new Error(`versions.json: HTTP ${res.status}`);
      return res.json() as Promise<BundledVersions>;
    });
    // Let a transient fetch failure retry on the next call instead of
    // poisoning every later resolution.
    versionsPromise.catch(() => { versionsPromise = null; });
  }
  return versionsPromise;
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

const newest = (worlds: BundledWorld[]): BundledWorld | null =>
  worlds.reduce<BundledWorld | null>((best, w) => (!best || compareVersions(w.world_version, best.world_version) > 0 ? w : best), null);

// The `latest` entry of every package: what generation uses, and the worker's
// own default when nothing is selected.
export async function latestWorlds(): Promise<BundledWorld[]> {
  const { worlds } = await loadVersions();
  return worlds.filter((w) => w.latest);
}

export async function latestWorldForGame(game: string): Promise<BundledWorld | null> {
  const { worlds } = await loadVersions();
  return worlds.find((w) => w.game === game && w.latest) ?? newest(worlds.filter((w) => w.game === game));
}

export async function bundledWorld(pkg: string, worldVersion: string): Promise<BundledWorld | null> {
  const { worlds } = await loadVersions();
  return worlds.find((w) => w.package === pkg && w.world_version === worldVersion) ?? null;
}

// The per-package selection the worker's select-worlds command takes.
export function selectionFor(worlds: BundledWorld[]): Record<string, string> {
  return Object.fromEntries(worlds.map((w) => [w.package, w.world_version]));
}

export type WorldResolution =
  // A bundled version can play this seed. `generator` is the version that
  // produced it when known; `upgraded` when the pick is newer than that.
  | { kind: "resolved"; world: BundledWorld; generator: string | null; upgraded: boolean }
  // Stable patch whose basepatch matches no bundled version: the generator
  // can't be identified, so compatibility can't be checked either.
  | { kind: "unknown"; game: string; candidates: BundledWorld[]; reason: string }
  // Identified, but no bundled version is inside its compatibility window.
  | { kind: "incompatible"; game: string; candidates: BundledWorld[]; reason: string }
  // The patch targets a game nothing bundled provides.
  | { kind: "unsupported"; game: string; reason: string };

export async function resolveWorldForPatch(patchBytes: Uint8Array): Promise<WorldResolution> {
  const manifest = await readPatchManifest(patchBytes);
  const game: string = manifest.game || "Pokemon Crystal";
  const { worlds } = await loadVersions();
  const candidates = worlds.filter((w) => w.game === game);
  if (candidates.length === 0) return { kind: "unsupported", game, reason: `no bundled apworld for ${game}` };

  const versioned = candidates.some((w) => w.minimum_patch_version);
  if (versioned) {
    const patchVersion: string | undefined = manifest.world_version;
    if (!patchVersion) {
      return { kind: "incompatible", game, candidates,
        reason: `this ${game} patch predates versioned manifests — regenerate it with a current apworld` };
    }
    const patchMin: string = manifest.minimum_patch_version || patchVersion;
    const compatible = candidates.filter((w) =>
      compareVersions(w.world_version, patchMin) >= 0
      && compareVersions(patchVersion, w.minimum_patch_version || "0") >= 0);
    const pick = newest(compatible);
    if (!pick) {
      const have = candidates.map((w) => w.display_version).join(", ");
      return { kind: "incompatible", game, candidates,
        reason: `this ${game} patch was made with apworld ${patchVersion}, and no bundled version is compatible with it (bundled: ${have})` };
    }
    return { kind: "resolved", world: pick, generator: patchVersion,
      upgraded: compareVersions(pick.world_version, patchVersion) !== 0 };
  }

  // Stable: identify the generator by the basepatch the patch carries.
  let hash: string | null = null;
  try {
    const base = await readZipEntry(patchBytes, "basepatch.bsdiff4");
    const digest = await crypto.subtle.digest("SHA-256", base.slice());
    hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    hash = null;
  }
  const generator = hash ? candidates.find((w) => w.basepatch_sha256["basepatch.bsdiff4"] === hash) ?? null : null;
  if (!generator) {
    return { kind: "unknown", game, candidates,
      reason: hash
        ? `this ${game} patch's base ROM patch matches no bundled apworld version`
        : `this ${game} patch carries no basepatch.bsdiff4` };
  }
  const compatible = candidates.filter((w) =>
    w.rom_version === generator.rom_version && w.rom_version11 === generator.rom_version11);
  const pick = newest(compatible) ?? generator;
  return { kind: "resolved", world: pick, generator: generator.display_version,
    upgraded: pick.world_version !== generator.world_version };
}
