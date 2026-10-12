#!/usr/bin/env bash
# Move the bundled Pokemon Crystal apworld to another release.
#
# The browser's patcher/game client (pack.sh) and the server's MultiServer
# (Dockerfile) are both built from the vendor/archipelago checkout, so this one
# move updates both. Seeds must be generated with the same version.
#
# Usage: scripts/bump-world.sh <tag-or-commit>     e.g. scripts/bump-world.sh 6.0.4
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
AP="$HERE/vendor/archipelago"
REF="${1:?usage: $0 <tag-or-commit>}"

git -C "$AP" fetch --tags origin
git -C "$AP" checkout --quiet "$REF"
echo "vendor/archipelago now at $(git -C "$AP" describe --tags --always)" >&2

# Regenerate the bundle and src/generated/versions.json from the new checkout.
"$HERE/pack.sh"

echo >&2
echo "Commit the submodule move and src/generated/versions.json, then rebuild the image." >&2
