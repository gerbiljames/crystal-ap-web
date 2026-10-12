// Shared constants used across the app. Split out so modules don't have to
// reach into main.js for them.

export const GB_ROM_SIZE = 2097152;

// SHA-256 of the two vanilla Pokémon Crystal ROMs the Archipelago apworld
// accepts as a patch base (English 1.0 and English 1.1). The AU revision
// is not supported by the apworld, so we reject it here too.
export const VANILLA_ROM_HASHES: Record<string, string> = {
  "d6702e353dcbe2d2c69183046c878ef13a0dae4006e8cdff521cca83dd1582fe": "Crystal (English) 1.0",
  "fdcc3c8c43813cf8731fc037d2a6d191bac75439c34b24ba1c27526e6acdc8a2": "Crystal (English) 1.1",
};

// Pokemon Crystal WRAM offsets (from 0xC000). Drawn from
// worlds/pokemon_crystal/data/data.json.
export const WRAM_BASE = 0xC000;
export const RAM = {
  wArchipelagoOptions:          0xfc9,
  wArchipelagoTrackerSlot:      0xfd4,
  wMapEventStatus:              0x143a,
  wArchipelagoItemReceived:     0x1ca7,
  wArchipelagoItemIndex:        0x1ca8,
  wArchipelagoSafeWrite:        0x1caa,
  wArchipelagoFlagItemReceived: 0x1cb0,
  wStatusFlags:                 0x181f,
  wEventFlags:                  0x1a88,
};

// Not crystal.ap's database: this app purges its session stores, and must
// never touch that app's saves should both ever share an origin.
export const SAVE_DB_NAME    = "yogos-saves";
export const SAVE_STORE      = "sav";       // SRAM per session, keyed by session id
export const STATE_STORE     = "state";     // savestate envelope {romHash, state} per session
export const ROM_STORE       = "rom";       // patched ROM per session
export const VANILLA_STORE   = "vanilla";   // vanilla ROM, single key "rom"
export const DB_VERSION      = 1;

// Shared progress-phase labels for the worker pipeline.
export const PHASE_LABELS = {
  "pyodide-boot":        "booting runtime…",
  "install-deps":        "installing dependencies…",
  "bsdiff4-shim":        "preparing bsdiff4…",
  "fetch-ap-source":     "fetching AP source…",
  "unpack-ap-source":    "unpacking AP source…",
  "import-ap":           "importing Archipelago…",
  "ready":               "ready",
};
