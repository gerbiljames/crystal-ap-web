// Save persistence types. SRAM and savestates are stored per seed, keyed by
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
// once, by the IndexedDB version-8 upgrade in idb.ts.

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
