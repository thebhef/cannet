#!/usr/bin/env python3
"""Block staged files that carry a machine-local absolute path.

A pre-commit hook (see .pre-commit-config.yaml). pre-commit passes the
staged filenames as arguments; this scans them and exits non-zero if any
line contains this machine's home directory or clone location, in either
slash form. Keying off the *real* home/clone paths — not a generic
``/home/<user>`` shape — avoids flagging the synthetic ``/home/u/...``
paths the test fixtures deliberately use.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path, PurePosixPath

# Machine-generated files whose path-shaped content (registry URLs, etc.)
# is noise, not a hand-authored leak.
SKIP_NAMES = {"Cargo.lock", "package-lock.json", "pnpm-lock.yaml", "uv.lock"}


def needles() -> list[str]:
    root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    bases = [root, str(Path.home())]
    for var in ("USERPROFILE", "HOME"):
        if os.environ.get(var):
            bases.append(os.environ[var])

    out: set[str] = set()
    for base in bases:
        if len(base) < 4:  # guard against a degenerate "/" or "C:\"
            continue
        out.add(base.replace("\\", "/").lower())
        out.add(base.replace("/", "\\").lower())
    return sorted(out)


def main(argv: list[str]) -> int:
    ns = needles()
    hits: list[str] = []
    for path in argv:
        if PurePosixPath(path).name in SKIP_NAMES:
            continue
        try:
            data = Path(path).read_bytes()
        except OSError:
            continue
        if b"\0" in data:  # binary
            continue
        for lineno, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            low = line.lower()
            if any(n in low for n in ns):
                hits.append(f"  {path}:{lineno}: {line.strip()[:120]}")

    if hits:
        print("Machine-local paths found in staged files:")
        print("\n".join(hits))
        print(
            "Replace them with a relative/portable path. "
            "(.cannet_prj files are auto-fixed by the relativize-project-paths hook.)"
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))