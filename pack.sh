#!/usr/bin/env bash
# Build the Archipelago bundles the Pyodide worker fetches at boot:
#   public/ap/core.tar          — minimal AP core + worlds/_bizhawk, generic,
#                                 and Universal Tracker (no Crystal worlds)
#   public/ap/worlds/<pkg>-<version>.tar
#                               — one tar per bundled Crystal apworld version
#   public/ap/versions.json     — what got bundled, with the version metadata
#                                 needed to pick a world per seed
# Which versions get bundled is configured in apworlds.json; the newest of each
# channel is always the submodule checkout. We deliberately err toward MORE core
# files rather than less; Pyodide is fine with unused modules sitting in the VFS.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AP="$HERE/vendor/archipelago"
UT="$HERE/vendor/archipelago-tracker"
OUT="$HERE/public/ap"

if [ ! -d "$AP/worlds" ]; then
    echo "vendor/archipelago is empty — run: git submodule update --init" >&2
    exit 1
fi
if [ ! -d "$UT/worlds/tracker" ]; then
    echo "vendor/archipelago-tracker is empty — run: git submodule update --init" >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required (world bundling + src/generated/yaml-schema.json)" >&2
    exit 1
fi

# Stage the core tree once. The Crystal worlds are stripped here and laid back
# in by pack-worlds.py (newest version only) so the schema dump sees the same
# tree the worker will assemble at runtime.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$AP/." "$STAGE/"
rm -rf "$STAGE/worlds/pokemon_crystal" "$STAGE/worlds/pokemon_crystal_prerelease"
# Overlay Universal Tracker's worlds/tracker on top.
rm -rf "$STAGE/worlds/tracker"
cp -R "$UT/worlds/tracker" "$STAGE/worlds/tracker"

mkdir -p "$OUT/worlds"
# Pre-versioning builds produced a single public/ap.tar; drop it so a stale
# copy can't be served alongside the split bundles.
rm -f "$HERE/public/ap.tar"

echo "bundling apworlds:" >&2
python3 "$HERE/scripts/pack-worlds.py" "$HERE/apworlds.json" "$STAGE" "$OUT" "$AP"

# Dump option metadata for the YAML creator UI. Runs against the staged tree
# (core + the newest world of each channel), so the form stays in lockstep
# with the vendor submodules.
python3 "$HERE/scripts/dump-yaml-schema.py" "$STAGE" "$HERE/src/generated/yaml-schema.json"

tar -cf "$OUT/core.tar" -C "$STAGE" \
    --exclude="__pycache__" \
    --exclude="*.pyc" \
    --exclude="test" \
    --exclude="docs" \
    --exclude="**/docs" \
    LICENSE \
    BaseClasses.py \
    Options.py \
    NetUtils.py \
    Utils.py \
    settings.py \
    ModuleUpdate.py \
    entrance_rando.py \
    Patch.py \
    Fill.py \
    Main.py \
    Generate.py \
    CommonClient.py \
    MultiServer.py \
    rule_builder \
    worlds/__init__.py \
    worlds/AutoWorld.py \
    worlds/Files.py \
    worlds/LauncherComponents.py \
    worlds/_bizhawk \
    worlds/generic \
    worlds/tracker

ls -lh "$OUT" "$OUT/worlds"
