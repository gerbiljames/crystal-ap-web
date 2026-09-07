// Save persistence. SRAM and savestates are stored per seed, keyed by seed id,
// so a re-patch (an apworld upgrade, a changed option override) keeps the
// player's battery save instead of orphaning it under the old ROM's hash.
//
// A savestate is different from SRAM: it is a mid-execution snapshot that only
// makes sense against the exact ROM bytes it was captured on. The stored
// envelope records that ROM's hash, and a boot on a different ROM discards the
// state and falls back to SRAM (Crystal's own battery save, which the apworld
// keeps compatible across versions).

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

// Before seed keying, both stores were keyed by the patched ROM's SHA-1, which
// the session recorded as `romHash` (kept as `legacyRomHash` once it has served
// here). Copy those entries under the seed id the first time the seed boots.
// One-shot: as soon as *anything* lives under the seed id the legacy keys are
// ignored — an SRAM row alone means a later state deletion was deliberate
// (importSaveFile drops the savestate so the imported SRAM wins), not a gap to
// backfill. The legacy entries are copied, not moved: two sessions built from
// the same patch share a ROM hash and so used to share a save, and each should
// still find it. forgetSession deletes the legacy keys once no session
// references them.
export async function migrateLegacySave(dbc: IDBDatabase, seedId: string, legacyRomHash: string | undefined | null): Promise<void> {
  if (!legacyRomHash || legacyRomHash === seedId) return;
  try {
    const [hasSram, hasState] = await Promise.all([idbHas(dbc, seedId, SAVE_STORE), idbHas(dbc, seedId, STATE_STORE)]);
    if (hasSram || hasState) return;
    let copied = false;
    const sram = await idbGet<ArrayBuffer>(dbc, legacyRomHash, SAVE_STORE);
    if (sram) { await idbPut(dbc, seedId, sram, SAVE_STORE); copied = true; }
    const state = await idbGet<unknown>(dbc, legacyRomHash, STATE_STORE);
    if (isBytes(state)) {
      await idbPut(dbc, seedId, { romHash: legacyRomHash, state } satisfies SavestateEnvelope, STATE_STORE);
      copied = true;
    }
    if (copied) log(`adopted save data for ${seedId} from its ROM-hash key`);
  } catch (err) {
    logWarn(`legacy save migration failed for ${seedId}: ${err}`);
  }
}
