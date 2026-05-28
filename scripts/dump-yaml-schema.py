#!/usr/bin/env python3
"""Dump a UI-friendly JSON schema of Pokemon Crystal Archipelago options.

We deliberately AST-parse the upstream options.py files instead of importing
them. Importing would pull in `schema`, `BaseClasses`, etc. — fine inside
Pyodide (where the worker already loads them), but a hassle at build time on
a host machine. AST parsing keeps `pack.sh` runnable with a stock Python.

Usage:
    dump-yaml-schema.py STAGE_DIR OUT_JSON

Where STAGE_DIR is the staged AP tree (so we can resolve both worlds'
options.py at `worlds/pokemon_crystal/options.py` and
`worlds/pokemon_crystal_prerelease/options.py`).
"""

from __future__ import annotations

import ast
import inspect
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Base-class taxonomy. Maps an upstream class name to a UI "kind". Subclasses
# of these get the same kind unless their own name overrides it.
# Override the display_name of locally-defined option classes when upstream
# leaves it as a verbose internal name. Applied after AST parsing.
DISPLAY_NAME_OVERRIDES = {
    "PokemonCrystalDeathLink": "Deathlink",
}

# Pokemon class names that inherit PokemonSet's runtime-computed valid_keys
# but don't redefine the attribute themselves. We propagate the extracted
# PokemonSet keys to each of these so the form can validate Pokemon names
# (plus _Legendaries / _Non-Legendaries / _<Type> shortcuts) directly.
POKEMON_SET_SUBCLASSES_INHERITED = {
    "StarterBlocklist", "WildEncounterBlocklist", "EvolutionBlocklist",
    "BreedingBlocklist", "StaticBlocklist", "TrainerPartyBlocklist",
}

# Display-name + docstring overrides for option classes imported from core
# Archipelago (so we don't have to walk core sources). These show up in the
# form as stubs without a local class body.
IMPORTED_STUB_INFO = {
    "StartInventoryPool": {
        "display_name": "Start Inventory from Pool",
        "docstring": (
            "Mapping of items added to the player's starting inventory and "
            "removed from the item pool. Useful for guaranteed early items "
            "without inflating the pool."
        ),
    },
}

# Docstrings for option base classes that local options concatenate onto
# via `__doc__ = SomeBase.__doc__ + "..."`. We can't walk Options.py at AST
# time without bringing along its imports, so the small handful that crystal
# extends are baked in here.
IMPORTED_BASE_DOCSTRINGS = {
    "DeathLink": (
        "When you die, everyone who enabled death link dies. Of course, "
        "the reverse is true too."
    ),
}

KIND_BY_BASE = {
    "Toggle": "toggle",
    "DefaultOnToggle": "toggle_on",
    "Choice": "choice",
    "Range": "range",
    "NamedRange": "named_range",
    "OptionSet": "option_set",
    "EnhancedOptionSet": "option_set",  # adds _All/_Random meta keys
    "PokemonSet": "pokemon_set",
    "OptionDict": "option_dict",
    "OptionList": "option_list",
    "OptionCounter": "option_counter",
    "FreeText": "free_text",
    "DeathLink": "toggle",  # DeathLink behaves as a toggle in YAMLs
    "PlandoConnections": "other",  # power-user list-of-mappings — textarea fallback, no weights
}

# Pokemon Crystal's locally-defined wrapper classes that should themselves be
# treated as bases (their subclasses are normal options, not the wrappers).
LOCAL_BASE_NAMES = {"EnhancedOptionSet", "PokemonSet", "PokemonSourceLogic"}


def literal(node: ast.AST):
    """Best-effort literal evaluation. Returns None for non-literal exprs."""
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def eval_doc_expr(node: ast.AST) -> str | None:
    """Evaluate an expression that builds a __doc__ string. Supports plain
    constants, `Name.__doc__` references (looked up in IMPORTED_BASE_DOCSTRINGS),
    and BinOp `+` concatenations of the above. Returns None if any operand is
    unresolvable.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Attribute) and node.attr == "__doc__" \
            and isinstance(node.value, ast.Name):
        return IMPORTED_BASE_DOCSTRINGS.get(node.value.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = eval_doc_expr(node.left)
        right = eval_doc_expr(node.right)
        if left is None or right is None:
            return None
        return left + right
    return None


def _collect_named_call_args(tree: ast.AST, list_names: set[str], arg_index: int) -> dict[str, list[str]]:
    """Find module-level assignments `name = [SomeCall(arg0, arg1, ...), ...]`
    for each `name` in `list_names`, and return the string at `arg_index`
    inside each call. Used to harvest the static Python lists in data.py.
    """
    out: dict[str, list[str]] = {n: [] for n in list_names}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id in list_names
                and isinstance(node.value, ast.List)):
            continue
        target = node.targets[0].id
        for elt in node.value.elts:
            if not isinstance(elt, ast.Call):
                continue
            if len(elt.args) <= arg_index:
                continue
            v = elt.args[arg_index]
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                out[target].append(v.value)
    return out


def compute_dynamic_valid_keys(world_dir: Path) -> dict[str, list[str]]:
    """Reproduce, against the JSON data + a couple of AST-parsed Python lists,
    the valid_keys that upstream options.py builds at import time. Lets the
    UI validate entries that would otherwise be free-text."""
    out: dict[str, list[str]] = {}

    items_path = world_dir / "data" / "items.json"
    data_path = world_dir / "data" / "data.json"
    maps_path = world_dir / "maps.py"
    data_py_path = world_dir / "data.py"
    entrance_types_path = world_dir / "data" / "entrance_types.json"

    # BuildAMart — items.json names tagged "CustomShop".
    if items_path.is_file():
        items = json.loads(items_path.read_text())
        shop = sorted({v["name"] for v in items.values() if "CustomShop" in v.get("tags", [])})
        if shop:
            out["BuildAMart"] = shop

    if data_path.is_file():
        data_json = json.loads(data_path.read_text())

        # MoveBlocklist / TMBlocklist — `move.name.title()` for every move
        # except NO_MOVE and STRUGGLE.
        moves = data_json.get("moves", {})
        move_names = sorted({
            move["name"].title()
            for mid, move in moves.items()
            if mid not in ("NO_MOVE", "STRUGGLE") and move.get("name")
        })
        if move_names:
            out["MoveBlocklist"] = move_names
            out["TMBlocklist"] = move_names

        # PokemonSet — Pokemon friendly_names + _Legendaries/_Non-Legendaries
        # + _<Type> shortcuts (matching the runtime construction in options.py).
        pokemon = data_json.get("pokemon", {})
        pkmn_names = sorted({p["friendly_name"] for p in pokemon.values() if p.get("friendly_name")})
        types = sorted({t for p in pokemon.values() for t in p.get("types", [])})
        type_shortcuts = sorted(
            f"_{'Psychic' if t == 'PSYCHIC_TYPE' else t.title()}" for t in types
        )
        if pkmn_names:
            out["PokemonSet"] = pkmn_names + ["_Legendaries", "_Non-Legendaries"] + type_shortcuts

    # FLASH_MAP_GROUPS keys from maps.py — needed for DarkAreas.
    if maps_path.is_file():
        tree = ast.parse(maps_path.read_text())
        for node in tree.body:
            target_name = None
            value = None
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                target_name = node.target.id
                value = node.value
            elif isinstance(node, ast.Assign) and len(node.targets) == 1 \
                    and isinstance(node.targets[0], ast.Name):
                target_name = node.targets[0].id
                value = node.value
            if target_name == "FLASH_MAP_GROUPS" and isinstance(value, ast.Dict):
                keys = [k.value for k in value.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)]
                if keys:
                    out["DarkAreas"] = sorted(keys)
                break

    # starting_towns and fly_regions are hand-built Python lists inside
    # `_load(...)` in data.py. AST-walk to pull the second positional arg of
    # each StartingTown / FlyRegion constructor.
    if data_py_path.is_file():
        tree = ast.parse(data_py_path.read_text())
        harvested = _collect_named_call_args(tree, {"starting_towns", "fly_regions"}, arg_index=1)
        if harvested["starting_towns"]:
            out["StartingTownBlocklist"] = sorted(set(harvested["starting_towns"])) + ["_Johto", "_Kanto"]
        if harvested["fly_regions"]:
            out["FlyLocationBlocklist"] = sorted(set(harvested["fly_regions"])) + ["_Johto", "_Kanto"]

    # entrance_types.json — prerelease only. The categories drive both
    # RandomizeEntrances and MixEntrances.
    if entrance_types_path.is_file():
        mapping = json.loads(entrance_types_path.read_text())
        categories = sorted(set(mapping.values()))
        if categories:
            out["RandomizeEntrances"] = categories
            out["MixEntrances"] = categories

    return out


def parse_options_module(path: Path) -> tuple[dict, list, list]:
    """Returns:
      classes:    {class_name: parsed_class}
      groups:     [(group_name, [class_name, ...]), ...]   from OPTION_GROUPS
      yaml_keys:  [(yaml_key, class_name), ...]            from PokemonCrystalOptions dataclass
    """
    src = path.read_text()
    tree = ast.parse(src)

    classes: dict[str, dict] = {}
    groups: list[tuple[str, list[str]]] = []
    yaml_keys: list[tuple[str, str]] = []

    # Pass 1: collect classes
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            classes[node.name] = parse_class(node)

    # Resolve effective kind by walking inheritance among locally-known classes
    def resolve_kind(name: str, seen: set[str]) -> str | None:
        if name in seen:
            return None
        seen.add(name)
        cls = classes.get(name)
        if cls is None:
            return KIND_BY_BASE.get(name)
        if cls.get("kind"):
            return cls["kind"]
        for base in cls["bases"]:
            kind = KIND_BY_BASE.get(base) or resolve_kind(base, seen)
            if kind:
                return kind
        return None

    for name, cls in classes.items():
        if not cls.get("kind"):
            cls["kind"] = resolve_kind(name, set()) or "other"

    # Options that don't declare their own `default =` inherit one from their
    # base class (e.g. Choice/Toggle inherit NumericOption's `default = 0`,
    # DefaultOnToggle has `default = 1`). The AST only sees attributes in the
    # class body, so fill in these inherited scalar defaults by kind. Without
    # this a choice like LockKantoGyms serializes to an empty string, which
    # fails generation with `Could not find option "" for ...`.
    DEFAULT_BY_KIND = {"choice": 0, "toggle": 0, "toggle_on": 1}
    for cls in classes.values():
        if cls.get("default") is None and cls.get("kind") in DEFAULT_BY_KIND:
            cls["default"] = DEFAULT_BY_KIND[cls["kind"]]

    # Pass 2: find OPTION_GROUPS = [OptionGroup(...), ...]
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 \
                and isinstance(node.targets[0], ast.Name) \
                and node.targets[0].id == "OPTION_GROUPS" \
                and isinstance(node.value, ast.List):
            for elt in node.value.elts:
                if not (isinstance(elt, ast.Call) and isinstance(elt.func, ast.Name)
                        and elt.func.id == "OptionGroup"):
                    continue
                if len(elt.args) < 2:
                    continue
                name_node, members_node = elt.args[0], elt.args[1]
                gname = literal(name_node)
                if not isinstance(gname, str):
                    continue
                if not isinstance(members_node, (ast.List, ast.Tuple)):
                    continue
                members = []
                for m in members_node.elts:
                    if isinstance(m, ast.Name):
                        members.append(m.id)
                groups.append((gname, members))
            break

    # Pass 3: find the PokemonCrystalOptions dataclass for yaml-key → class.
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "PokemonCrystalOptions":
            for stmt in node.body:
                # `field_name: ClassName` — AnnAssign with no value.
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) \
                        and isinstance(stmt.annotation, ast.Name):
                    yaml_keys.append((stmt.target.id, stmt.annotation.id))
            break

    return classes, groups, yaml_keys


def parse_class(node: ast.ClassDef) -> dict:
    bases = [b.id for b in node.bases if isinstance(b, ast.Name)]
    info: dict = {
        "name": node.name,
        "bases": bases,
        "docstring": inspect.cleandoc(ast.get_docstring(node) or ""),
        "default": None,
        "display_name": None,
        "range_start": None,
        "range_end": None,
        "choices": None,        # list[str] for Choice
        "special_range_names": None,
        "valid_keys": None,
        "valid_keys_computed": False,
        "hidden": False,        # `visibility = Visibility.none` → keep out of UI
    }
    choices: list[str] = []

    # First pass: collect plain scalar literals so later expressions can
    # resolve `Name` nodes (e.g. `valid_keys = [ELITE_FOUR, RED, ...]` or
    # `special_range_names = {"none": default, "full": range_end}`).
    locals_ns: dict[str, object] = {}
    for stmt in node.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 \
                and isinstance(stmt.targets[0], ast.Name):
            v = literal(stmt.value)
            if isinstance(v, (str, int, float, bool)) or v is None:
                locals_ns[stmt.targets[0].id] = v

    def resolve(n: ast.AST):
        """literal_eval with class-local Name resolution."""
        try:
            return ast.literal_eval(n)
        except Exception:
            pass
        if isinstance(n, ast.Name):
            return locals_ns.get(n.id)
        if isinstance(n, (ast.List, ast.Tuple, ast.Set)):
            out = []
            for e in n.elts:
                r = resolve(e)
                if r is None and not isinstance(e, ast.Constant):
                    return None  # unresolved
                out.append(r)
            return out if isinstance(n, ast.List) else (tuple(out) if isinstance(n, ast.Tuple) else set(out))
        if isinstance(n, ast.Dict):
            out = {}
            for k, v in zip(n.keys, n.values):
                rk = resolve(k) if k is not None else None
                rv = resolve(v)
                if rk is None or (rv is None and not isinstance(v, ast.Constant)):
                    return None
                out[rk] = rv
            return out
        return None

    # Recover `__doc__ = SomeBase.__doc__ + "..."` style overrides — these
    # don't show up as a regular docstring, so ast.get_docstring missed them.
    for stmt in node.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 \
                and isinstance(stmt.targets[0], ast.Name) and stmt.targets[0].id == "__doc__":
            text = eval_doc_expr(stmt.value)
            if text:
                info["docstring"] = inspect.cleandoc(text)
            break

    for stmt in node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
            continue
        attr = stmt.targets[0].id
        val_node = stmt.value
        if attr.startswith("option_"):
            choices.append(attr[len("option_"):])
        elif attr == "default":
            info["default"] = resolve(val_node)
        elif attr == "display_name":
            info["display_name"] = resolve(val_node)
        elif attr == "range_start":
            info["range_start"] = resolve(val_node)
        elif attr == "range_end":
            info["range_end"] = resolve(val_node)
        elif attr == "special_range_names":
            v = resolve(val_node)
            if isinstance(v, dict):
                info["special_range_names"] = {str(k): v[k] for k in v}
            elif isinstance(val_node, ast.Dict):
                # Capture keys even when some values reference computed attrs
                # (e.g. range_end is `len(...)`). UI can still show the named
                # presets and let the user type a numeric value.
                names = {}
                for k, val in zip(val_node.keys, val_node.values):
                    rk = resolve(k) if k is not None else None
                    rv = resolve(val)
                    if isinstance(rk, str):
                        names[rk] = rv
                if names:
                    info["special_range_names"] = names
        elif attr == "valid_keys":
            v = resolve(val_node)
            if isinstance(v, (list, tuple, set)):
                info["valid_keys"] = sorted({str(x) for x in v})
            else:
                info["valid_keys_computed"] = True
        elif attr == "visibility":
            # Treat `visibility = Visibility.none` (or any expression that
            # bottoms out at the bare attribute "none") as "don't show in the
            # YAML template". Other Visibility combinations always include
            # the template bit in crystal's options, so we leave them alone.
            if isinstance(val_node, ast.Attribute) and val_node.attr == "none":
                info["hidden"] = True
    if choices:
        info["choices"] = choices
    return info


def build_world_schema(options_path: Path, manifest_path: Path) -> dict:
    classes, groups, yaml_keys = parse_options_module(options_path)
    manifest = json.loads(manifest_path.read_text())
    game = manifest.get("game") or options_path.parent.name
    dynamic_keys = compute_dynamic_valid_keys(options_path.parent)

    # PokemonSet subclasses inherit valid_keys at runtime. Propagate to each
    # known subclass so the form validates Pokemon entries everywhere they're
    # allowed, not just on the base class.
    pokemon_keys = dynamic_keys.get("PokemonSet")
    if pokemon_keys:
        for subclass in POKEMON_SET_SUBCLASSES_INHERITED:
            dynamic_keys.setdefault(subclass, pokemon_keys)

    # DexsanityLogic adds a "Trades" option on top of its base class. The
    # base PokemonSourceLogic carries a static list literal, so the AST
    # already captured it on that class — copy + extend here.
    if "DexsanityLogic" not in dynamic_keys:
        base = classes.get("PokemonSourceLogic")
        if base and base.get("valid_keys"):
            dynamic_keys["DexsanityLogic"] = sorted(set(base["valid_keys"]) | {"Trades"})

    # Reverse map: class name → yaml key.
    yaml_key_by_class: dict[str, str] = {}
    for yk, cls_name in yaml_keys:
        # Same class can be reused for multiple keys (e.g. _TrapWeight in prod).
        # Keep the first; UI doesn't need every alias.
        yaml_key_by_class.setdefault(cls_name, yk)

    grouped: set[str] = set()
    out_groups = []

    def make_opt(cls_name: str) -> dict | None:
        yk = yaml_key_by_class.get(cls_name)
        if yk is None:
            return None  # class isn't part of this world's YAML (helper only)
        cls = classes.get(cls_name)
        if cls is None:
            stub = IMPORTED_STUB_INFO.get(cls_name, {})
            return {
                "name": cls_name,
                "yaml_key": yk,
                "kind": "other",
                "docstring": stub.get("docstring", ""),
                "default": None,
                "display_name": stub.get("display_name", cls_name),
            }
        if cls.get("hidden"):
            return None  # `Visibility.none` — keep out of the form entirely
        valid_keys = cls["valid_keys"]
        valid_keys_computed = cls["valid_keys_computed"]
        if cls_name in dynamic_keys:
            valid_keys = sorted(dynamic_keys[cls_name])
            valid_keys_computed = False
        return {
            "name": cls["name"],
            "yaml_key": yk,
            "kind": cls["kind"],
            "docstring": cls["docstring"],
            "default": cls["default"],
            "display_name": DISPLAY_NAME_OVERRIDES.get(cls_name, cls["display_name"] or cls["name"]),
            "range_start": cls["range_start"],
            "range_end": cls["range_end"],
            "choices": cls["choices"],
            "special_range_names": cls["special_range_names"],
            "valid_keys": valid_keys,
            "valid_keys_computed": valid_keys_computed,
        }

    for gname, members in groups:
        opts = []
        for m in members:
            opt = make_opt(m)
            if opt is None:
                continue
            grouped.add(m)
            opts.append(opt)
        if opts:
            out_groups.append({"name": gname, "options": opts})

    # Surface dataclass members that OPTION_GROUPS doesn't mention so the form
    # exposes the full YAML surface (e.g. prod's Goal lives outside the groups).
    leftover_opts = []
    for yk, cls_name in yaml_keys:
        if cls_name in grouped:
            continue
        opt = make_opt(cls_name)
        if opt is None:
            continue
        grouped.add(cls_name)
        leftover_opts.append(opt)
    if leftover_opts:
        out_groups.insert(0, {"name": "Other", "options": leftover_opts})

    return {"game": game, "groups": out_groups}


def main():
    if len(sys.argv) != 3:
        print("usage: dump-yaml-schema.py STAGE_DIR OUT_JSON", file=sys.stderr)
        sys.exit(2)
    stage = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    worlds = [
        ("Pokemon Crystal",
         stage / "worlds" / "pokemon_crystal" / "options.py",
         stage / "worlds" / "pokemon_crystal" / "archipelago.json"),
        ("Pokemon Crystal Prerelease",
         stage / "worlds" / "pokemon_crystal_prerelease" / "options.py",
         stage / "worlds" / "pokemon_crystal_prerelease" / "archipelago.json"),
    ]

    payload = {}
    for game, opts_path, manifest_path in worlds:
        if not opts_path.is_file():
            print(f"missing {opts_path}", file=sys.stderr)
            sys.exit(1)
        schema = build_world_schema(opts_path, manifest_path)
        payload[game] = schema

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
