#!/usr/bin/env bash
# Build the Archipelago bundles the Pyodide worker fetches at boot:
#   public/ap/core.tar          — minimal AP core + worlds/_bizhawk and generic
#                                 (no Crystal worlds)
#   public/ap/worlds/<pkg>-<version>.tar
#                               — the Crystal apworld: the vendor/archipelago
#                                 checkout, the world the server runs too
#   src/generated/versions.json — what got bundled (imported by the app at
#                                 build time)
# apworlds.json names the world. We deliberately err toward MORE core files
# rather than less; Pyodide is fine with unused modules sitting in the VFS.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
AP="$HERE/vendor/archipelago"
OUT="$HERE/public/ap"

if [ ! -d "$AP/worlds" ]; then
    echo "vendor/archipelago is empty — run: git submodule update --init" >&2
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required (world bundling)" >&2
    exit 1
fi

# Stage the core tree once. The Crystal worlds are stripped here and laid back
# in by pack-worlds.py, one tar per version.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$AP/." "$STAGE/"
rm -rf "$STAGE/worlds/pokemon_crystal"

mkdir -p "$OUT/worlds"
# Earlier layouts put the bundle at public/ap.tar and the manifest at
# public/ap/versions.json; drop both so stale copies can't be served.
rm -f "$HERE/public/ap.tar" "$OUT/versions.json"

echo "bundling apworlds:" >&2
python3 "$HERE/scripts/pack-worlds.py" "$HERE/apworlds.json" "$STAGE" "$OUT" "$AP" "$HERE/src/generated/versions.json"

# Fixed order, timestamps, ownership and modes (GNU tar) so identical sources
# give a byte-identical core.tar: its content hash busts the cache on deploy.
tar -cf "$OUT/core.tar" -C "$STAGE" \
    --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    --mode=u+rwX,go+rX,go-w \
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
    Launcher.py \
    apmw \
    CommonClient.py \
    MultiServer.py \
    rule_builder \
    worlds/__init__.py \
    worlds/AutoWorld.py \
    worlds/Files.py \
    worlds/LauncherComponents.py \
    worlds/_bizhawk \
    worlds/generic

ls -lh "$OUT" "$OUT/worlds"
