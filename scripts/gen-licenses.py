#!/usr/bin/env python3
"""Generate the bundled third-party license manifest for the About view.

Produces ``apps/gui/src-tauri/licenses.json`` — the structured attribution
surface the host bundles as a Tauri resource and serves to the About view
at runtime (ADR 0036, LGPL-3.0 §4a-c). The manifest is *generated at build
time from the frozen deps' own dist-info license files*, never committed:
no license text lives in the repo.

Run inside the sidecar's pinned ``uv`` environment so ``importlib.metadata``
sees exactly the frozen dependency set::

    uv run --project servers/cannet-python-can --frozen python scripts/gen-licenses.py

All paths anchor on this file, never the cwd, so the run is reproducible
regardless of where it is invoked from. Nothing is fetched over the
network — every text is read from what the dependency already ships.
"""

from __future__ import annotations

import importlib.metadata as im
import json
import platform
import sys
from pathlib import Path

# Anchor on this script so no machine-local absolute path leaks in.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
OUT_PATH = REPO_ROOT / "apps" / "gui" / "src-tauri" / "licenses.json"

# SPDX ids from package metadata are unreliable, so pin the known ones.
# Dist names as they appear on PyPI / in importlib.metadata.
PYPI_PACKAGES = {
    "grpcio": "Apache-2.0",
    "protobuf": "BSD-3-Clause",
    "python-can": "LGPL-3.0-only",
    "uptime": "BSD-2-Clause",
}

# Filename fragments that mark a shipped license / notice file.
LICENSE_MARKERS = ("LICENSE", "COPYING", "NOTICE")


def _read_pypi_license(dist_name: str) -> str:
    """Concatenate the verbatim license/notice files a wheel ships.

    Reads every file in the package's dist-info whose name contains a
    license marker, in sorted order, joined by a form-feed separator when
    there is more than one.
    """
    dist = im.distribution(dist_name)
    files = dist.files or []
    texts: list[str] = []
    for entry in sorted({f for f in files}, key=lambda f: str(f)):
        name = entry.name.upper()
        if not any(marker in name for marker in LICENSE_MARKERS):
            continue
        located = Path(dist.locate_file(entry))
        if not located.is_file():
            continue
        texts.append(located.read_text(encoding="utf-8", errors="replace"))
    if not texts:
        raise SystemExit(f"no license/notice file found in dist-info for '{dist_name}'")
    return "\n\f\n".join(texts)


def _read_cpython_license() -> str:
    """Read the interpreter's own LICENSE text, or fail loudly."""
    base = Path(sys.base_prefix)
    ver = platform.python_version_tuple()
    candidates = [
        base / "LICENSE.txt",
        base / "LICENSE",
        base / "lib" / f"python{ver[0]}.{ver[1]}" / "LICENSE.txt",
        base / "lib" / f"python{ver[0]}.{ver[1]}" / "LICENSE",
    ]
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")
    raise SystemExit(
        "CPython LICENSE not found; tried: " + ", ".join(str(c) for c in candidates)
    )


def _dependencies() -> list[dict[str, str]]:
    deps: list[dict[str, str]] = [
        {
            "name": "CPython",
            "version": platform.python_version(),
            "spdx": "PSF-2.0",
            "origin": "python",
            "licenseText": _read_cpython_license(),
        }
    ]
    for dist_name, spdx in PYPI_PACKAGES.items():
        deps.append(
            {
                "name": dist_name,
                "version": im.version(dist_name),
                "spdx": spdx,
                "origin": "python",
                "licenseText": _read_pypi_license(dist_name),
            }
        )
    deps.sort(key=lambda d: d["name"].lower())
    return deps


def main() -> int:
    manifest = {
        "components": [
            {
                "component": "python-can sidecar",
                "dependencies": _dependencies(),
            }
        ]
    }
    text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(text, encoding="utf-8", newline="\n")
    count = len(manifest["components"][0]["dependencies"])
    print(f"wrote {OUT_PATH} ({count} dependencies)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
