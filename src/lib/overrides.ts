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
// options.py. death_link / trap_link / tracker_slot are intentionally omitted:
// they are multiworld- or co-op-affecting and not appropriate as per-player
// patch-time tweaks (and the apworld never writes them from this dict anyway).
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
  { key: "rods_always_work", label: "Rods always work",  kind: "toggle", choices: ON_OFF },
  { key: "catch_exp",        label: "Catch EXP",         kind: "toggle", choices: ON_OFF },
  { key: "exp_distribution", label: "EXP distribution",  kind: "choice", choices: ["gen2", "gen6", "gen8", "no_exp"] },
  { key: "guaranteed_catch", label: "Guaranteed catch",  kind: "toggle", choices: ON_OFF },
  { key: "blind_trainers",   label: "Blind trainers",    kind: "toggle", choices: ON_OFF },
  { key: "spinners",         label: "Spinners",          kind: "choice", choices: ["normal", "rotators", "heck", "hell"] },
  { key: "poison_flicker",   label: "Poison flicker",    kind: "toggle", choices: ON_OFF },
  { key: "low_hp_beep",      label: "Low HP beep",       kind: "toggle", choices: ON_OFF },
  { key: "time_of_day",      label: "Time of day",       kind: "choice", choices: ["auto", "morn", "day", "nite", "random"] },
  { key: "dex_area_beep",    label: "Dex area beep",     kind: "toggle", choices: ON_OFF },
  { key: "skip_dex_registration", label: "Skip dex registration", kind: "toggle", choices: ON_OFF },
  { key: "ap_item_sound",    label: "AP item sound",     kind: "toggle", choices: ON_OFF },
  { key: "item_notification",label: "Item notification", kind: "choice", choices: ["popup", "sound", "none"] },
  { key: "trainersanity_indication", label: "Trainersanity indication", kind: "toggle", choices: ON_OFF },
  { key: "more_uncaught_encounters", label: "More uncaught encounters", kind: "toggle", choices: ON_OFF },
  { key: "auto_hms",         label: "Auto HMs",          kind: "toggle", choices: ON_OFF },
  { key: "hms_require_teaching", label: "HMs require teaching", kind: "toggle", choices: ON_OFF },
];

const FIELD_MOVE_KEYS = ["Cut", "Fly", "Surf", "Strength", "Flash", "Whirlpool",
  "Waterfall", "Rock Smash", "Headbutt", "Dig", "Teleport", "Sweet Scent"];

// Top-level overrides. The race-mode-restricted set (see world.py) is included;
// the local web client never generates in race mode, so they always apply.
export const TOP_LEVEL_FIELDS: OverrideField[] = [
  { key: "trainer_name", label: "Trainer name", kind: "text", maxLen: 7,
    help: "Presets your name and skips the prompt. First 7 characters only" },
  { key: "experience_modifier", label: "Experience modifier", kind: "number", min: 1, max: 255,
    help: "20 = normal, 40 = double, 10 = half. Adjustable in-game" },
  { key: "starting_money", label: "Starting money", kind: "number", min: 0, max: 999999 },
  { key: "minimum_catch_rate", label: "Minimum catch rate", kind: "number", min: 0, max: 255 },
  { key: "reusable_tms", label: "Reusable TMs", kind: "toggle", choices: ON_OFF },
  { key: "skip_elite_four", label: "Skip Elite Four", kind: "toggle", choices: ON_OFF,
    help: "Ignored if any Elite Four member is a trainersanity check" },
  { key: "better_marts", label: "Better marts", kind: "toggle", choices: ON_OFF },
  // all_pokemon_seen is documented as an override but its patch-time writer is
  // commented out in the apworld (rom.py write_customizable_options), so setting
  // it here would have no effect — omitted until the apworld actually applies it.
  { key: "shopsanity_restrict_rare_candies", label: "Restrict shop rare candies", kind: "toggle", choices: ON_OFF },
  // encounter_slot_distribution is listed in the override docstring but has no
  // must_write_option branch in write_customizable_options — it's a generation-
  // time option (it changes which wild encounters are rolled) and can't be
  // applied by a patch-time ROM tweak, so setting it here would do nothing.
  { key: "default_pokedex_mode", label: "Default Pokédex mode", kind: "choice",
    choices: ["new", "old", "a_to_z"] },
  { key: "field_move_menu_order", label: "Field move menu order", kind: "list", validKeys: FIELD_MOVE_KEYS,
    help: "Comma-separated. Listed moves appear on top in this order; omitted ones follow in the default order" },
  { key: "build_a_mart", label: "Build-a-mart", kind: "list",
    help: "Comma-separated item names (max 14) for the final Pokécenter 2F mart" },
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
