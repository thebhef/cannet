"""The frozen sidecar names itself in a Windows process list.

Windows shows a process's identity in Task Manager / Process Explorer
from the binary's ``VERSIONINFO`` resource, not from its file name.
PyInstaller emits no such resource unless it is handed one, so the
frozen launcher shipped with a blank *Description* — the process read
as an anonymous ``cannet-python-can.exe`` with nothing saying what it
is. ``scripts/build-sidecar.py`` now renders a version file and passes
it to PyInstaller with ``--version-file``.

The resource is Windows-only (ELF and Mach-O have no equivalent), so
the flag is passed only when freezing on Windows; elsewhere the file
name *is* the process name and already carries both halves.

These tests cover the rendering and the flag plumbing. That the
resource actually lands in the built ``.exe`` is only observable by
building it and reading the resource back — recorded in the task file,
not asserted here.
"""

from __future__ import annotations

import importlib.util
import sys
import tomllib
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
BUILD_SIDECAR = REPO_ROOT / "scripts" / "build-sidecar.py"


def _load_build_sidecar() -> ModuleType:
    """Import the (hyphenated, stdlib-only) build script as a module."""
    spec = importlib.util.spec_from_file_location("build_sidecar", BUILD_SIDECAR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


bs = _load_build_sidecar()


def test_version_resource_says_whose_process_it_is_and_which_part() -> None:
    text = bs.render_version_info("0.1.0")
    # Every field a process list can surface has to carry `cannet`, and
    # the description has to say which part of cannet this is.
    assert "cannet CAN hardware sidecar (python-can)" in text
    assert "StringStruct('FileDescription'" in text
    assert "StringStruct('ProductName', 'cannet')" in text
    assert "StringStruct('CompanyName', 'cannet')" in text
    # A version resource whose OriginalFilename disagrees with the
    # launcher is worse than none — it is what tooling reports when a
    # binary has been renamed.
    assert f"StringStruct('OriginalFilename', '{bs.LAUNCHER_NAME}')" in text
    assert f"StringStruct('InternalName', '{bs.SIDECAR_NAME}')" in text


def test_version_resource_carries_the_sidecar_version() -> None:
    text = bs.render_version_info("1.2.3")
    assert "filevers=(1, 2, 3, 0)" in text
    assert "prodvers=(1, 2, 3, 0)" in text
    assert "StringStruct('FileVersion', '1.2.3')" in text
    assert "StringStruct('ProductVersion', '1.2.3')" in text


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("0.1.0", (0, 1, 0, 0)),
        ("2.5", (2, 5, 0, 0)),
        ("1.2.3.4", (1, 2, 3, 4)),
        ("1.2.0rc1", (1, 2, 0, 0)),
    ],
)
def test_version_tuple_pads_to_four_parts(version: str, expected: tuple) -> None:
    # `FixedFileInfo` takes exactly four numbers; a PEP 440 version has
    # as few as one.
    assert bs.version_tuple(version) == expected


def test_the_sidecar_version_comes_from_its_own_pyproject() -> None:
    # Not hard-coded in the build script: a version bump in
    # `pyproject.toml` has to reach the frozen artifact.
    pyproject = tomllib.loads(
        (REPO_ROOT / "servers" / "cannet-python-can" / "pyproject.toml").read_text(
            encoding="utf-8"
        )
    )
    assert bs.sidecar_version() == pyproject["project"]["version"]


def test_windows_freeze_passes_the_version_file_and_others_do_not() -> None:
    version_file = Path("C:/tmp/version_info.txt")
    flags = bs.pyinstaller_flags(version_file)
    assert "--version-file" in flags
    assert flags[flags.index("--version-file") + 1] == str(version_file)

    # ELF / Mach-O have no VERSIONINFO equivalent, and PyInstaller
    # rejects the flag off Windows.
    assert "--version-file" not in bs.pyinstaller_flags(None)


def test_the_launcher_is_still_named_for_cannet_and_its_role() -> None:
    # The file name is the process name on every platform (and on
    # Windows it is what a renamed-binary check compares against), so
    # the `--name` PyInstaller is given is part of this contract.
    flags = bs.pyinstaller_flags(None)
    assert flags[flags.index("--name") + 1] == bs.SIDECAR_NAME
    assert bs.SIDECAR_NAME.startswith("cannet-")
