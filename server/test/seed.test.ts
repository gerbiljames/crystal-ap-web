import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { loadSeed } from "../src/seed.ts";

// A generator-style output zip: multidata plus one Crystal patch.
function seedZip(multidata: string, slot = "Player1") {
  const patch = zipSync({ "archipelago.json": strToU8(JSON.stringify({ player_name: slot, game: "Pokemon Crystal" })) });
  return zipSync({ "AP_1.archipelago": strToU8(multidata), [`AP_1_P1_${slot}.apcrystal`]: patch });
}

test("a seed loads, and a different seed under the same name is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "yogos-seed-"));
  try {
    const seedDir = join(root, "seed"), runDir = join(root, "run");
    mkdirSync(seedDir);
    writeFileSync(join(seedDir, "AP_1.zip"), seedZip("first"));
    const seed = loadSeed(seedDir, runDir);
    assert.equal(seed.slotName, "Player1");
    assert.equal(seed.game, "Pokemon Crystal");
    // Loading the same seed again is fine.
    assert.equal(loadSeed(seedDir, runDir).hash, seed.hash);
    // Regenerated with the same file names, different content.
    writeFileSync(join(seedDir, "AP_1.zip"), seedZip("second"));
    assert.throws(() => loadSeed(seedDir, runDir), /different seed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
