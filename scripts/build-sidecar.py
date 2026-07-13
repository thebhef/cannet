#!/usr/bin/env python3
"""Build the frozen ``cannet-python-can`` sidecar (PyInstaller onedir).

Encodes the reproducible per-OS freeze recipe from ADR 0036. Runs
PyInstaller inside the sidecar's pinned ``uv`` environment so the
committed ``.python-version`` chooses CPython and the runtime deps
(grpcio / protobuf / python-can) are available for collection.

Usage (run from anywhere — all paths derive from this file's location)::

    uv run scripts/build-sidecar.py          # build + smoke-test
    python scripts/build-sidecar.py          # same, if PyInstaller can
                                             # already be resolved by uv
    uv run scripts/build-sidecar.py --no-smoke   # build only

The onedir lands at
``apps/gui/src-tauri/sidecar-dist/cannet-python-can/`` with the launcher
``cannet-python-can[.exe]`` beside its ``_internal/`` directory. By
default the freshly built launcher is smoke-tested: it is spawned with
its stdin held open (the parent-death contract) and must emit the
``sidecar\tlistening\t<addr>`` banner within 30 s. The process exit code
reflects both the build and the smoke result.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

# All paths anchor on this script, never the cwd, so the build is
# reproducible regardless of where it is invoked from.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
SIDECAR_PROJECT = REPO_ROOT / "servers" / "cannet-python-can"
ENTRY = SIDECAR_PROJECT / "pyinstaller_entry.py"
DIST_DIR = REPO_ROOT / "apps" / "gui" / "src-tauri" / "sidecar-dist"
# Scratch dirs for PyInstaller's intermediate work and spec file; kept
# out of git (see .gitignore) and out of the shipped onedir.
BUILD_DIR = DIST_DIR / "_build"
ONEDIR = DIST_DIR / "cannet-python-can"
LAUNCHER_NAME = (
    "cannet-python-can.exe" if sys.platform == "win32" else "cannet-python-can"
)
LAUNCHER = ONEDIR / LAUNCHER_NAME

SMOKE_BANNER_PREFIX = "sidecar\tlistening\t"
SMOKE_TIMEOUT_S = 30.0


def _clean() -> None:
    """Remove stale build output so a collection change can't leave cruft."""
    for path in (ONEDIR, BUILD_DIR):
        if path.exists():
            shutil.rmtree(path)


def build() -> None:
    """Invoke PyInstaller in the sidecar's pinned uv environment."""
    _clean()
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    pyinstaller_flags = [
        "--noconfirm",
        "--onedir",
        "--name",
        "cannet-python-can",
        # Our importlib-loaded driver — invisible to the static graph.
        "--collect-submodules",
        "cannet_python_can",
        # python-can discovers backends via entry points.
        "--collect-submodules",
        "can",
        "--copy-metadata",
        "python-can",
        "--collect-all",
        "grpc",
        "--copy-metadata",
        "grpcio",
        "--copy-metadata",
        "protobuf",
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR / "work"),
        "--specpath",
        str(BUILD_DIR),
        str(ENTRY),
    ]
    cmd = [
        "uv",
        "run",
        "--project",
        str(SIDECAR_PROJECT),
        "--frozen",
        "--with",
        "pyinstaller",
        "pyinstaller",
        *pyinstaller_flags,
    ]
    print(f"building frozen sidecar: {' '.join(cmd)}", file=sys.stderr)
    subprocess.run(cmd, check=True)

    if not LAUNCHER.exists():
        raise SystemExit(f"build finished but launcher is missing: {LAUNCHER}")
    print(f"built: {LAUNCHER}", file=sys.stderr)

    _macos_finalize()


def _macos_finalize() -> None:
    """Guarantee the launcher's exec bit and ad-hoc signature (macOS only)."""
    if sys.platform != "darwin":
        return
    LAUNCHER.chmod(0o755)
    # Apple Silicon refuses to execute any mach-o lacking at least an
    # ad-hoc signature; PyInstaller ad-hoc-signs its output. Assert it so
    # a toolchain change that drops the signature fails the build here.
    result = subprocess.run(
        ["codesign", "-dv", str(LAUNCHER)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            "frozen launcher is not signed (codesign -dv failed):\n"
            f"{result.stderr.strip()}"
        )
    print("macOS: launcher is +x and carries an ad-hoc signature", file=sys.stderr)


def smoke() -> None:
    """Spawn the frozen launcher and wait for the ``listening`` banner."""
    if not LAUNCHER.exists():
        raise SystemExit(f"cannot smoke-test: launcher missing at {LAUNCHER}")

    print(f"smoke-testing: {LAUNCHER}", file=sys.stderr)
    proc = subprocess.Popen(
        [str(LAUNCHER)],
        cwd=str(ONEDIR),
        stdin=subprocess.PIPE,  # held open: parent-death contract
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    deadline = time.monotonic() + SMOKE_TIMEOUT_S
    listening_addr: str | None = None
    try:
        assert proc.stdout is not None
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line == "":  # child exited / stdout closed
                break
            if line.startswith(SMOKE_BANNER_PREFIX):
                listening_addr = line[len(SMOKE_BANNER_PREFIX) :].strip()
                break
    finally:
        if proc.stdin is not None:
            proc.stdin.close()  # signal parent-death → clean shutdown
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    if listening_addr is None:
        raise SystemExit(
            f"smoke test failed: no '{SMOKE_BANNER_PREFIX.strip()}' banner "
            f"within {SMOKE_TIMEOUT_S:.0f}s"
        )
    print(f"smoke ok: sidecar listening on {listening_addr}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="build-sidecar.py",
        description="Build (and by default smoke-test) the frozen python-can sidecar.",
    )
    parser.add_argument(
        "--no-smoke",
        action="store_true",
        help="Build only; skip running the frozen launcher.",
    )
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    build()
    if not args.no_smoke:
        smoke()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
