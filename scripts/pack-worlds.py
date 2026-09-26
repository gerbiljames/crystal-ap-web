#!/usr/bin/env python3
"""Bundle every configured Pokemon Crystal apworld version as its own tarball.

Reads apworlds.json, then for each channel:
  * copies the submodule's checked-out world into STAGE/worlds/<package> (the
    newest version; dump-yaml-schema.py and the core tar build read STAGE), and
    tars it as OUT/worlds/<package>-<world_version>.tar;
  * `git archive`s each ref in `older` and tars it the same way, fetching the
    ref first if a shallow submodule checkout lacks it.
Finally writes VERSIONS_JSON (src/generated/versions.json, imported by the app
at build time like yaml-schema.json) describing every bundled world, so the
main thread can pick a version per seed and tell the worker which tars to load.

Tar entries are rooted at worlds/<package>/ so unpacking one over /ap drops the
world into the core tree exactly where the monolithic tarball used to put it.

Usage:
    pack-worlds.py CONFIG_JSON STAGE_DIR OUT_DIR CORE_REPO VERSIONS_JSON
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

EXCLUDE_DIRS = {"__pycache__", "test", "docs"}
EXCLUDE_SUFFIXES = (".pyc",)


def run(args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, text=True, capture_output=True, **kw)


def ensure_ref(repo: Path, ref: str) -> str:
    """Resolve `ref` to a commit in `repo`, fetching it if the checkout is
    shallow or was cloned without tags (CI checkouts usually are). Returns the
    commit id: a fetched branch only lands in FETCH_HEAD, not under its name."""
    def commit(name: str) -> str:
        return run(["git", "-C", str(repo), "rev-parse", "--verify", f"{name}^{{commit}}"]).stdout.strip()
    try:
        return commit(ref)
    except subprocess.CalledProcessError:
        pass
    print(f"  fetching {ref} into {repo}", file=sys.stderr)
    try:
        run(["git", "-C", str(repo), "fetch", "--depth=1", "origin", f"refs/tags/{ref}:refs/tags/{ref}"])
        return commit(ref)
    except subprocess.CalledProcessError:
        run(["git", "-C", str(repo), "fetch", "--depth=1", "origin", ref])
        return commit("FETCH_HEAD")


def archive_world(repo: Path, ref: str, package: str, dest: Path) -> None:
    """Extract worlds/<package> at `ref` into dest/worlds/<package>."""
    proc = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", ref, f"worlds/{package}"],
                          check=True, capture_output=True)
    with tarfile.open(fileobj=io.BytesIO(proc.stdout)) as tf:
        tf.extractall(dest)


def excluded(rel: Path) -> bool:
    return any(part in EXCLUDE_DIRS for part in rel.parts) or rel.name.endswith(EXCLUDE_SUFFIXES)


def write_world_tar(world_dir: Path, package: str, out: Path) -> int:
    """Tar world_dir as worlds/<package>/... with stable metadata so identical
    sources produce byte-identical tars (friendly to HTTP caching)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in world_dir.rglob("*") if p.is_file() and not excluded(p.relative_to(world_dir)))
    with tarfile.open(out, "w", format=tarfile.PAX_FORMAT) as tf:
        for p in files:
            info = tf.gettarinfo(str(p), arcname=f"worlds/{package}/{p.relative_to(world_dir).as_posix()}")
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            with open(p, "rb") as fh:
                tf.addfile(info, fh)
    return out.stat().st_size


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def describe_world(channel: str, package: str, world_dir: Path, tar_rel: str, tar_size: int,
                   latest: bool, ref: str | None) -> dict:
    manifest = json.loads((world_dir / "archipelago.json").read_text(encoding="utf-8-sig"))
    data = json.loads((world_dir / "data" / "data.json").read_text(encoding="utf-8-sig"))
    basepatches = {}
    for name in ("basepatch.bsdiff4", "basepatch11.bsdiff4"):
        p = world_dir / "data" / name
        if p.is_file():
            basepatches[name] = sha256_file(p)
    return {
        "channel": channel,
        "package": package,
        "game": manifest["game"],
        "world_version": manifest["world_version"],
        # The user-facing version. Stable leaves pokemon_crystal_version unset
        # and uses world_version for both; the prerelease's world_version is
        # the patch-compat number and pokemon_crystal_version the release name.
        "display_version": manifest.get("pokemon_crystal_version", manifest["world_version"]),
        "minimum_patch_version": manifest.get("minimum_patch_version"),
        "minimum_ap_version": manifest.get("minimum_ap_version"),
        # ROM checksums the client demands at connect (data.json rom_version /
        # rom_version11). Two stable versions with equal checksums can play
        # each other's ROMs.
        "rom_version": data["rom_version"],
        "rom_version11": data["rom_version11"],
        # Stable patches carry their own basepatch; hashing it identifies the
        # generating version, since the stable manifest records none.
        "basepatch_sha256": basepatches,
        "tar": tar_rel,
        "size": tar_size,
        "latest": latest,
        "ref": ref,
    }


def core_version(core_repo: Path) -> str | None:
    m = re.search(r'^__version__\s*=\s*"([^"]+)"', (core_repo / "Utils.py").read_text(), re.M)
    return m.group(1) if m else None


def main() -> None:
    config_path, stage, out, core_repo, versions_out = (Path(a) for a in sys.argv[1:6])
    config = json.loads(config_path.read_text())
    root = config_path.parent

    worlds: list[dict] = []
    seen_tars: set[str] = set()
    for channel, spec in config["channels"].items():
        repo = root / spec["repo"]
        package = spec["package"]
        src = repo / "worlds" / package
        if not src.is_dir():
            sys.exit(f"{src} is empty — run: git submodule update --init")

        # Newest: the checked-out tree. Stage it for the schema dump, tar it.
        staged = stage / "worlds" / package
        if staged.exists():
            shutil.rmtree(staged)
        shutil.copytree(src, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        version = json.loads((staged / "archipelago.json").read_text(encoding="utf-8-sig"))["world_version"]
        tar_rel = f"worlds/{package}-{version}.tar"
        size = write_world_tar(staged, package, out / tar_rel)
        worlds.append(describe_world(channel, package, staged, tar_rel, size, latest=True, ref=None))
        seen_tars.add(tar_rel)
        print(f"  {channel}: {package} {version} (checkout) -> {tar_rel} ({size} bytes)", file=sys.stderr)

        for ref in spec.get("older", []):
            rev = ensure_ref(repo, ref)
            with tempfile.TemporaryDirectory() as tmp:
                archive_world(repo, rev, package, Path(tmp))
                world_dir = Path(tmp) / "worlds" / package
                version = json.loads((world_dir / "archipelago.json").read_text(encoding="utf-8-sig"))["world_version"]
                tar_rel = f"worlds/{package}-{version}.tar"
                if tar_rel in seen_tars:
                    sys.exit(f"{channel}: ref {ref} has world_version {version}, which is already bundled")
                size = write_world_tar(world_dir, package, out / tar_rel)
                worlds.append(describe_world(channel, package, world_dir, tar_rel, size, latest=False, ref=ref))
                seen_tars.add(tar_rel)
                print(f"  {channel}: {package} {version} ({ref}) -> {tar_rel} ({size} bytes)", file=sys.stderr)

    # Drop tars from versions no longer configured so public/ap/ doesn't
    # accumulate stale bundles across bumps.
    for stale in (out / "worlds").glob("*.tar"):
        rel = f"worlds/{stale.name}"
        if rel not in seen_tars:
            stale.unlink()
            print(f"  removed stale {rel}", file=sys.stderr)

    versions = {
        "core": {"tar": "core.tar", "ap_version": core_version(core_repo)},
        "worlds": worlds,
    }
    versions_out.parent.mkdir(parents=True, exist_ok=True)
    versions_out.write_text(json.dumps(versions, indent=2) + "\n")
    print(f"wrote {versions_out}", file=sys.stderr)


if __name__ == "__main__":
    main()
