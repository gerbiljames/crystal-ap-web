// Bundled apworld versions. The patched ROM is produced by the apworld patch
// code shipped inside Pyodide (apply_bsdiff4 / apply_tokens / apply_overrides),
// so a cached ROM is only valid while the bundled apworld matches the one that
// produced it. We tag each cached ROM with the version below and re-patch on
// mismatch (see resumeSession in actions.ts).

import crystalManifest    from "../../vendor/archipelago/worlds/pokemon_crystal/archipelago.json";
import prereleaseManifest from "../../vendor/archipelago-prerelease/worlds/pokemon_crystal_prerelease/archipelago.json";

// The version string that bumps whenever the bundled patch code changes. The
// prerelease tracks a finer-grained pokemon_crystal_version (e.g. alpha.N);
// stable uses world_version. These mirror what Nav.tsx surfaces to the user.
const STABLE_VERSION     = crystalManifest.world_version;
const PRERELEASE_VERSION = prereleaseManifest.pokemon_crystal_version;

// Resolve the bundled apworld version for the game a patch targets (the `game`
// field in its archipelago.json). Returns null for unknown games; resume treats
// a null bundled version as "differs from the recorded tag" and re-patches,
// which is the safe choice (re-patch rather than serve a possibly-stale ROM).
export function bundledApworldVersion(game: string | undefined | null): string | null {
  if (game === crystalManifest.game)    return STABLE_VERSION;
  if (game === prereleaseManifest.game) return PRERELEASE_VERSION;
  return null;
}
