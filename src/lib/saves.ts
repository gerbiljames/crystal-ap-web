// Save persistence. SRAM and savestates are stored per seed, keyed by
// seed id, so a re-patch (an apworld upgrade, a changed option override) keeps
// the player's battery save instead of orphaning it under the old ROM's hash.
//
// A savestate is different from SRAM: it is a mid-execution snapshot that only
// makes sense against the exact ROM bytes it was captured on. The stored
// envelope records that ROM's hash, and a boot on a different ROM discards the
// state and falls back to SRAM (Crystal's own battery save, which the apworld
// keeps compatible across versions).
//
// Rows written before seed keying (under the ROM hash) are moved to seed ids
// once, by the IndexedDB version-8 upgrade in idb.ts. adoptLegacySave below is
// the fallback for rows that upgrade couldn't move.

import { idbGet, idbPut, idbHas } from "./idb.js";
import { SAVE_STORE, STATE_STORE } from "./constants.js";
import { log, logWarn } from "./log.js";

// `state` is whatever the emulator's extractState() produced (a Uint8Array),
// but accept a bare ArrayBuffer too so structured-clone round-trips can't
// invalidate a stored envelope.
export type SavestateEnvelope = { romHash: string; state: Uint8Array | ArrayBuffer };

const isBytes = (v: unknown): v is Uint8Array | ArrayBuffer => v instanceof Uint8Array || v instanceof ArrayBuffer;

export function isSavestateEnvelope(v: unknown): v is SavestateEnvelope {
  return !!v && typeof v === "object"
    && typeof (v as any).romHash === "string"
    && isBytes((v as any).state);
}

// The version-8 upgrade is best effort and runs once: a row whose copy failed,
// or whose session wasn't in the list at the time, stays under the ROM hash the
// session recorded. Copy it under the seed id on the seed's next boot, before
// the emulator looks there. Only fills a slot that is still empty, so it never
// overwrites a save made since. Copied rather than moved: sessions built from
// the same patch shared a ROM hash and so a save, and each should find it;
// forgetSession drops the legacy keys once no session references them.
//
// Resolves true once the legacy key no longer matters (nothing to adopt, the
// slot was already in use, or the copy landed) and false on an error, in which
// case the caller must keep the legacy hash recorded so a later boot retries.
export async function adoptLegacySave(dbc: IDBDatabase, seedId: string, legacyRomHash: string | undefined | null): Promise<boolean> {
  if (!legacyRomHash || legacyRomHash === seedId) return true;
  try {
    // All or nothing: an old savestate next to a newer SRAM would resume to
    // the older moment, so anything already under the seed id wins outright.
    const [hasSram, hasState] = await Promise.all([idbHas(dbc, seedId, SAVE_STORE), idbHas(dbc, seedId, STATE_STORE)]);
    if (hasSram || hasState) return true;
    let copied = false;
    const sram = await idbGet<ArrayBuffer>(dbc, legacyRomHash, SAVE_STORE);
    if (sram) { await idbPut(dbc, seedId, sram, SAVE_STORE); copied = true; }
    const state = await idbGet<unknown>(dbc, legacyRomHash, STATE_STORE);
    if (isBytes(state)) {
      await idbPut(dbc, seedId, { romHash: legacyRomHash, state } satisfies SavestateEnvelope, STATE_STORE);
      copied = true;
    }
    if (copied) log(`recovered save data for ${seedId} from its old ROM-hash key`);
    return true;
  } catch (err) {
    logWarn(`couldn't recover old save data for ${seedId}: ${err}`);
    return false;
  }
}
