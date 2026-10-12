// Save persistence. SRAM and savestates are stored per seed, keyed by
// seed id, so a re-patch (an apworld upgrade, a changed option override) keeps
// the player's battery save instead of orphaning it under the old ROM's hash.
//
// A savestate is different from SRAM: it is a mid-execution snapshot that only
// makes sense against the exact ROM bytes it was captured on. The stored
// envelope records that ROM's hash, and a boot on a different ROM discards the
// state and falls back to SRAM (Crystal's own battery save, which the apworld
// keeps compatible across versions).

// `state` is whatever the emulator's extractState() produced (a Uint8Array),
// but accept a bare ArrayBuffer too so structured-clone round-trips can't
// invalidate a stored envelope.
// sramHash: sramDigest() of the cart RAM inside `state` when it was taken.
// Boot applies the state over the stored SRAM, so one taken before the stored
// SRAM was last written would undo that write (an in-game save); the hash
// tells boot to skip it. Absent on envelopes from before it was recorded.
export type SavestateEnvelope = { romHash: string; state: Uint8Array | ArrayBuffer; sramHash?: string };

// FNV-1a over the bytes: cheap on 32KB, and only compared against itself.
export function sramDigest(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + bytes.length;
}

const isBytes = (v: unknown): v is Uint8Array | ArrayBuffer => v instanceof Uint8Array || v instanceof ArrayBuffer;

export function isSavestateEnvelope(v: unknown): v is SavestateEnvelope {
  return !!v && typeof v === "object"
    && typeof (v as any).romHash === "string"
    && isBytes((v as any).state);
}
