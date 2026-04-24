// Shared constants used across the app. Split out so modules don't have to
// reach into main.js for them.

export const GEN_BASE = "https://crystal-ap-host.gerbiljames.workers.dev";
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

export const SAVE_DB_NAME    = "crystal-ap-saves";
export const SAVE_STORE      = "sav";       // SRAM per seed, keyed by ROM SHA-1
export const STATE_STORE     = "state";     // full emulator savestate per seed, keyed by ROM SHA-1
export const ROM_STORE       = "rom";       // patched ROM per seed, keyed by seed_id
export const VANILLA_STORE   = "vanilla";   // vanilla ROM, single key "rom"
export const ARTIFACTS_STORE = "artifacts"; // gen artifacts per seed, keyed by seed_id
export const YAML_STORE      = "yaml";      // saved YAML text, keyed by sha256 hex
export const DB_VERSION      = 6;

export const SESSIONS_KEY = "crystal-ap-sessions";
export const SESSIONS_MAX = 20;
export const YAMLS_KEY    = "crystal-ap-yamls";
export const YAMLS_MAX    = 50;

export const HOST_PREF_KEY = "crystal-ap-host-pref";

// Shared progress-phase labels for the worker pipeline.
export const PHASE_LABELS = {
  "pyodide-boot":        "booting runtime…",
  "install-deps":        "installing dependencies…",
  "bsdiff4-shim":        "preparing bsdiff4…",
  "fetch-ap-source":     "fetching AP source…",
  "unpack-ap-source":    "unpacking AP source…",
  "import-ap":           "importing Archipelago…",
  "ready":               "ready",
  "rolling-seed":        "rolling seed…",
  "collecting-artifacts":"collecting artifacts…",
};
