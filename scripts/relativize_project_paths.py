#!/usr/bin/env python3
"""Rewrite absolute paths in cannet project files to project-relative form.

A pre-commit hook (see .pre-commit-config.yaml). A ``.cannet_prj`` may
reference its DBCs and configs by a path relative to the project file's
own directory or by an absolute path (what the GUI writes through the
file picker) — see ADR 0030. The absolute ones carry a local, machine-
specific prefix, so committed examples must use the relative form.

For each staged ``.cannet_prj``, any quoted absolute path that resolves
inside the repository is rewritten to a path relative to that project
file's directory (forward slashes). Absolute paths pointing outside the
repo are left alone — the check-local-paths hook then blocks them. The
rewrite touches only the matched path strings, preserving the rest of
the file's formatting. Exits non-zero when it changed a file so the
commit stops for you to review and re-stage the fix.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
).resolve()

# A JSON string value that starts with a Windows drive (C:\ / C:/) or a
# POSIX root (/…).
ABS_PATH = re.compile(r'"((?:[A-Za-z]:[\\/]|/)[^"\n]+)"')


def relativize(project_file: str) -> list[tuple[str, str]]:
    proj = (ROOT / project_file).resolve()
    proj_dir = proj.parent
    text = proj.read_text(encoding="utf-8")
    changed: list[tuple[str, str]] = []

    def repl(match: re.Match[str]) -> str:
        raw = match.group(1)
        try:
            resolved = Path(raw.replace("\\", "/")).resolve()
        except (OSError, ValueError):
            return match.group(0)
        if resolved != ROOT and ROOT not in resolved.parents:
            return match.group(0)  # outside the repo — leave for the block hook
        try:
            rel = os.path.relpath(resolved, proj_dir).replace(os.sep, "/")
        except ValueError:  # different drive on Windows
            return match.group(0)
        replacement = f'"{rel}"'
        if replacement == match.group(0):
            return match.group(0)
        changed.append((raw, rel))
        return replacement

    new = ABS_PATH.sub(repl, text)
    if new != text:
        proj.write_text(new, encoding="utf-8")
    return changed


def main(argv: list[str]) -> int:
    any_changed = False
    for path in argv:
        for raw, rel in relativize(path):
            print(f"  {path}: {raw} -> {rel}")
            any_changed = True
    if any_changed:
        print("Rewrote machine-local paths to project-relative. Review and `git add`, then commit again.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
