// Pokemon Crystal patch-time option overrides.
//
// The Crystal apworld reads `pokemon_crystal_settings.option_overrides` from
// host.yaml during its `apply_overrides` ROM patch step (worlds/pokemon_crystal/
// rom.py). Those overrides are applied purely at patch time on each player's own
// ROM — they don't touch generation, logic, or the multidata, so it's safe to
// expose them per-player in the web client. This module defines the documented
// override set (worlds/pokemon_crystal/world.py + options.py), turns the UI's
// flat pref map into the nested dict the apworld expects, and hashes it so the
// patched-ROM cache can be invalidated when the overrides change.

// A single override control. `kind` drives both the form widget (Settings.tsx)
// and the coercion in buildOverrides:
//   toggle  → <select> on/off,        emitted as "on"/"off"
//   choice  → <select> of `choices`,  emitted as the chosen string
//   number  → numeric input,          emitted as an integer
//   text    → text input,             emitted as a string
//   list    → comma-separated input,  emitted as a string[]
export type OverrideField = {
  key: string;
  label: string;
  kind: "toggle" | "choice" | "number" | "text" | "list";
  help?: string;
  choices?: string[];      // choice
  min?: number;            // number
  max?: number;            // number
  maxLen?: number;         // text
  validKeys?: string[];    // list (for the form's hint / validation)
};

// Prefs are stored flat. Top-level override keys map directly; game_options
// sub-keys are namespaced "go:<name>". An empty string means "unset" — leave
// the seed's own value in place rather than overriding it.
export type OverridePrefs = Record<string, string>;

const ON_OFF = ["on", "off"];

// `game_options` sub-settings. Names + value sets mirror GameOptions in
// options.py. Only presentation and convenience: everyone in this event plays
// the same slot in turn, so options that change difficulty or what can be
// reached (catching, EXP, encounters, trainers, HMs, time of day) are left out,
// as are death_link / trap_link / tracker_slot.
export const GAME_OPTION_FIELDS: OverrideField[] = [
  { key: "text_speed",       label: "Text speed",        kind: "choice", choices: ["instant", "fast", "mid", "slow"] },
  { key: "text_frame",       label: "Text frame",        kind: "choice", choices: ["1", "2", "3", "4", "5", "6", "7", "8", "random"] },
  { key: "battle_shift",     label: "Battle style",      kind: "choice", choices: ["shift", "set"] },
  { key: "battle_animations",label: "Battle animations", kind: "choice", choices: ["all", "no_scene", "no_bars", "speedy"] },
  { key: "battle_move_stats",label: "Show move stats",   kind: "toggle", choices: ON_OFF },
  { key: "sound",            label: "Sound",             kind: "choice", choices: ["mono", "stereo"] },
  { key: "menu_account",     label: "Menu account",      kind: "toggle", choices: ON_OFF },
  { key: "bike_music",       label: "Bike music",        kind: "toggle", choices: ON_OFF },
  { key: "surf_music",       label: "Surf music",        kind: "toggle", choices: ON_OFF },
  { key: "short_fanfares",   label: "Short fanfares",    kind: "toggle", choices: ON_OFF },
  { key: "skip_nicknames",   label: "Skip nicknames",    kind: "toggle", choices: ON_OFF },
  { key: "auto_run",         label: "Auto run",          kind: "toggle", choices: ON_OFF, help: "Hold B to walk when on" },
  { key: "turbo_button",     label: "Turbo button",      kind: "choice", choices: ["none", "a", "b", "a_or_b"] },
  { key: "fast_surf",        label: "Fast surf",         kind: "toggle", choices: ON_OFF },
  { key: "fast_egg_hatch",   label: "Fast egg hatch",    kind: "toggle", choices: ON_OFF },
  { key: "fast_egg_make",    label: "Fast egg make",     kind: "toggle", choices: ON_OFF },
  { key: "poison_flicker",   label: "Poison flicker",    kind: "toggle", choices: ON_OFF },
  { key: "low_hp_beep",      label: "Low HP beep",       kind: "toggle", choices: ON_OFF },
  { key: "dex_area_beep",    label: "Dex area beep",     kind: "toggle", choices: ON_OFF },
  { key: "skip_dex_registration", label: "Skip dex registration", kind: "toggle", choices: ON_OFF },
  { key: "ap_item_sound",    label: "AP item sound",     kind: "toggle", choices: ON_OFF },
  { key: "item_notification",label: "Item notification", kind: "choice", choices: ["popup", "sound", "none"] },
  { key: "trainersanity_indication", label: "Trainersanity indication", kind: "toggle", choices: ON_OFF },
];

const FIELD_MOVE_KEYS = ["Cut", "Fly", "Surf", "Strength", "Flash", "Whirlpool",
  "Waterfall", "Rock Smash", "Headbutt", "Dig", "Teleport", "Sweet Scent"];

// Top-level overrides. Only the presentational ones: everyone in this event
// plays the same slot, so nothing that changes difficulty, economy, logic or
// the goal (experience, money, catch rates, marts, TMs, skipping the Elite
// Four) is offered.
export const TOP_LEVEL_FIELDS: OverrideField[] = [
  { key: "trainer_name", label: "Trainer name", kind: "text", maxLen: 7,
    help: "Presets your name and skips the prompt. First 7 characters only" },
  { key: "default_pokedex_mode", label: "Default Pokédex mode", kind: "choice",
    choices: ["new", "old", "a_to_z"] },
  { key: "field_move_menu_order", label: "Field move menu order", kind: "list", validKeys: FIELD_MOVE_KEYS,
    help: "Comma-separated. Listed moves appear on top in this order; omitted ones follow in the default order" },
];

export const ALL_FIELDS = [...TOP_LEVEL_FIELDS, ...GAME_OPTION_FIELDS];

function coerce(field: OverrideField, raw: string): any {
  switch (field.kind) {
    case "toggle": return raw;                 // "on" / "off"
    case "choice": return raw;
    case "number": return parseInt(raw, 10);
    case "text":   return raw;
    case "list":   return raw.split(",").map(s => s.trim()).filter(Boolean);
  }
}

// Turn the flat pref map into the nested override dict the apworld reads. Unset
// (empty-string / absent) fields are omitted so the seed's own values survive.
export function buildOverrides(prefs: OverridePrefs): Record<string, any> {
  const out: Record<string, any> = {};

  const gameOptions: Record<string, any> = {};
  for (const f of GAME_OPTION_FIELDS) {
    const raw = prefs[`go:${f.key}`];
    if (raw == null || raw === "") continue;
    gameOptions[f.key] = coerce(f, raw);
  }
  if (Object.keys(gameOptions).length > 0) out.game_options = gameOptions;

  for (const f of TOP_LEVEL_FIELDS) {
    const raw = prefs[f.key];
    if (raw == null || raw === "") continue;
    const v = coerce(f, raw);
    if (f.kind === "number" && !Number.isFinite(v)) continue;
    if (f.kind === "list" && (v as any[]).length === 0) continue;
    out[f.key] = v;
  }

  return out;
}

// Deterministic JSON (sorted keys, one level of nesting) so equal override sets
// hash identically regardless of insertion order.
function stableStringify(obj: Record<string, any>): string {
  const norm = (v: any): any => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(norm(obj));
}

// Short stable hash of an override dict for cache tagging. Empty dict → "" so
// the common "no overrides" case keeps a clean, comparable tag.
export function overridesHash(dict: Record<string, any>): string {
  if (!dict || Object.keys(dict).length === 0) return "";
  const s = stableStringify(dict);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}
