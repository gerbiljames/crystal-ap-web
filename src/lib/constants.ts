// Shared constants used across the app. Split out so modules don't have to
// reach into main.js for them.

export const GEN_BASE = "https://crystal-ap-host.gerbiljames.workers.dev";
export const GB_ROM_SIZE = 2097152;

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
export const ROM_STORE       = "rom";       // patched ROM per seed, keyed by seed_id
export const VANILLA_STORE   = "vanilla";   // vanilla ROM, single key "rom"
export const ARTIFACTS_STORE = "artifacts"; // gen artifacts per seed, keyed by seed_id
export const DB_VERSION      = 4;

export const SESSIONS_KEY = "crystal-ap-sessions";
export const SESSIONS_MAX = 20;

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
