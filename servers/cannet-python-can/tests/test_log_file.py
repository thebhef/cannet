"""The ``--log-file`` rolling debug logfile.

Two sinks, deliberately asymmetric: stderr keeps ``--log-level`` (it is
what the GUI host turns into System Messages, which must not get
noisier), while the file always records at ``debug``. These tests pin
the split, the rotation budget, and the "no flag → no file" default.
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_python_can import __main__ as entry  # noqa: E402


@pytest.fixture(autouse=True)
def _restore_logging():
    """Undo whatever a test did to the process-wide logging trees."""
    root = logging.getLogger()
    saved_root = (list(root.handlers), root.level)
    saved_banner = (list(entry.BANNER.handlers), entry.BANNER.level)
    yield
    for h in list(root.handlers):
        if h not in saved_root[0]:
            h.close()
    root.handlers[:] = saved_root[0]
    root.setLevel(saved_root[1])
    entry.BANNER.handlers[:] = saved_banner[0]
    entry.BANNER.setLevel(saved_banner[1])


def _file_handlers(logger: logging.Logger) -> list[RotatingFileHandler]:
    return [h for h in logger.handlers if isinstance(h, RotatingFileHandler)]


def test_log_file_defaults_to_none() -> None:
    """Standalone ``uv run`` behaviour is unchanged: no flag, no file."""
    assert entry._parse_args([]).log_file is None
    assert entry._parse_args(["--log-file", "x.log"]).log_file == "x.log"


def test_no_flag_writes_no_file(tmp_path: Path) -> None:
    root = logging.getLogger()
    root.handlers[:] = []
    assert entry._configure_logging("info", None) is None
    assert _file_handlers(root) == []
    assert list(tmp_path.iterdir()) == []


def test_flag_creates_the_file_and_records_debug_while_stderr_stays_quiet(
    tmp_path: Path,
) -> None:
    root = logging.getLogger()
    root.handlers[:] = []
    path = tmp_path / "logs" / "sidecar-python-can.log"

    assert entry._configure_logging("warning", str(path)) == path
    assert path.is_file(), "the parent directory must be created too"

    log = logging.getLogger("cannet_python_can.test")
    log.debug("a debug detail")
    log.warning("a warning")
    for h in root.handlers:
        h.flush()

    text = path.read_text(encoding="utf-8")
    assert "a debug detail" in text, "the file always records at debug"
    assert "a warning" in text

    # stderr keeps `--log-level` exactly: the level moved onto the
    # stderr handler when the root had to drop to DEBUG for the file.
    stderr_handlers = [
        h for h in root.handlers if not isinstance(h, RotatingFileHandler)
    ]
    assert stderr_handlers, "basicConfig's stderr handler must survive"
    assert all(h.level == logging.WARNING for h in stderr_handlers)


def test_rotation_stays_inside_the_five_megabyte_budget(tmp_path: Path) -> None:
    root = logging.getLogger()
    root.handlers[:] = []
    entry._configure_logging("info", str(tmp_path / "s.log"))
    (handler,) = _file_handlers(root)
    assert handler.maxBytes == entry.LOG_FILE_MAX_BYTES
    assert handler.backupCount == entry.LOG_FILE_BACKUP_COUNT
    generations = 1 + entry.LOG_FILE_BACKUP_COUNT
    assert handler.maxBytes * generations <= 5 * 1024 * 1024


def test_banner_lines_are_mirrored_into_the_file(tmp_path: Path) -> None:
    """The banner carries enumeration and the bound address; the file
    is useless for a hardware post-mortem without them."""
    root = logging.getLogger()
    root.handlers[:] = []
    path = tmp_path / "s.log"
    entry._configure_logging("error", str(path))
    entry.BANNER.info("interface\tvector:VN1670(SN:1, ch:1)\tVector ch1\tfd")
    for h in entry.BANNER.handlers:
        h.flush()
    assert "vector:VN1670(SN:1, ch:1)" in path.read_text(encoding="utf-8")


def test_an_unopenable_log_file_does_not_stop_the_sidecar(tmp_path: Path) -> None:
    """A bad ``--log-file`` is a diagnostics loss, not a boot failure."""
    root = logging.getLogger()
    root.handlers[:] = []
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("", encoding="utf-8")
    assert entry._configure_logging("info", str(blocker / "s.log")) is None
    assert _file_handlers(root) == []
