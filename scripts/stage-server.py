#!/usr/bin/env python3
"""Build ``cannet-server`` (release) and stage it as a Tauri resource.

Every GUI install carries the server binary, so that a machine with the
GUI on it is already a potential hardware host: the bundled server sits
beside the frozen ``cannet-python-can`` onedir the GUI ships anyway, and
the server's own exe-adjacent sidecar probe finds it there unchanged.

The staging directory is ``apps/gui/src-tauri/server-dist/``, declared
in ``tauri.conf.json`` as a resource whose contents land at the bundle's
resource root — beside ``cannet-python-can/``. It is gitignored build
output, exactly like ``sidecar-dist/``.

Usage (run from anywhere — all paths derive from this file's location)::

    uv run --no-project scripts/stage-server.py
    python scripts/stage-server.py            # same; no Python deps
    CANNET_SERVER_TARGET=aarch64-apple-darwin python scripts/stage-server.py

``tauri build`` runs this automatically via its ``beforeBuildCommand``
hook, so a release bundle always contains a server built from the same
tree. Rebuilds are cargo-incremental: an already-built server restages
in seconds.

``CANNET_SERVER_TARGET`` names a Rust target triple to build for and
take the binary from (``target/<triple>/release/``); without it the
host's default (``target/release/``) is used. CI sets it so the release
workflow's own ``--target`` build and this staging step agree on one
artifact instead of building the server twice.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# All paths anchor on this script, never the cwd, so staging is
# reproducible regardless of where it is invoked from.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
STAGE_DIR = REPO_ROOT / "apps" / "gui" / "src-tauri" / "server-dist"
SERVER_NAME = "cannet-server.exe" if sys.platform == "win32" else "cannet-server"
TARGET_ENV = "CANNET_SERVER_TARGET"


def target_triple() -> str | None:
    """The triple to build for, or ``None`` for the host default."""
    triple = os.environ.get(TARGET_ENV, "").strip()
    return triple or None


def build(triple: str | None) -> Path:
    """Build the release server and return the path to its binary."""
    cmd = ["cargo", "build", "--release", "-p", "cannet-server"]
    if triple:
        cmd += ["--target", triple]
    print(f"building server: {' '.join(cmd)}", file=sys.stderr)
    subprocess.run(cmd, check=True, cwd=str(REPO_ROOT))

    out_dir = REPO_ROOT / "target"
    if triple:
        out_dir = out_dir / triple
    binary = out_dir / "release" / SERVER_NAME
    if not binary.is_file():
        raise SystemExit(f"cargo reported success but {binary} is missing")
    return binary


def stage(binary: Path) -> Path:
    """Copy ``binary`` into the resource staging directory.

    ``copy2`` rather than ``copy``: the mode bits carry the exec bit that
    makes the staged file runnable once the bundler has placed it, and
    the mtime keeps an unchanged binary from looking freshly built.
    """
    STAGE_DIR.mkdir(parents=True, exist_ok=True)
    staged = STAGE_DIR / binary.name
    shutil.copy2(binary, staged)
    size_mb = staged.stat().st_size / (1024 * 1024)
    print(f"staged server: {staged} ({size_mb:.1f} MB)", file=sys.stderr)
    return staged


def main() -> int:
    stage(build(target_triple()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
