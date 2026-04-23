#!/usr/bin/env bash
# Build ap.tar — minimal Archipelago source needed for APProcedurePatch.
# We deliberately err toward MORE files rather than less; Pyodide is fine
# with unused modules sitting in the VFS. We'll trim only if the bundle
# turns out too big for first-visit UX.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AP="$HERE/vendor/archipelago"
OUT="$HERE/public/ap.tar"

if [ ! -d "$AP/worlds" ]; then
    echo "vendor/archipelago is empty — run: git submodule update --init" >&2
    exit 1
fi

tar -cf "$OUT" -C "$AP" \
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
    worlds/pokemon_crystal

ls -lh "$OUT"
