#!/usr/bin/env bash
# Build ap.tar — minimal Archipelago source needed for APProcedurePatch.
# We deliberately err toward MORE files rather than less; Pyodide is fine
# with unused modules sitting in the VFS. We'll trim only if the bundle
# turns out too big for first-visit UX.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AP="$HERE/vendor/archipelago"
PRE="$HERE/vendor/archipelago-prerelease"
OUT="$HERE/public/ap.tar"

if [ ! -d "$AP/worlds" ]; then
    echo "vendor/archipelago is empty — run: git submodule update --init" >&2
    exit 1
fi
if [ ! -d "$PRE/worlds/pokemon_crystal_prerelease" ]; then
    echo "vendor/archipelago-prerelease is empty — run: git submodule update --init" >&2
    exit 1
fi

# Stage everything under one root so a single tar carries both the stable
# AP source tree and the prerelease apworld layered on top.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$AP/." "$STAGE/"
# Drop the stable apworld's own pokemon_crystal_prerelease symlink/dir if any
# upstream ever ships one — the prerelease submodule is the source of truth.
rm -rf "$STAGE/worlds/pokemon_crystal_prerelease"
cp -R "$PRE/worlds/pokemon_crystal_prerelease" "$STAGE/worlds/pokemon_crystal_prerelease"

tar -cf "$OUT" -C "$STAGE" \
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
    worlds/pokemon_crystal \
    worlds/pokemon_crystal_prerelease

ls -lh "$OUT"
