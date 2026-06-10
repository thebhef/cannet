"""Stdin-EOF → shutdown behaviour for the sidecar.

The GUI host pipes stdin to the sidecar and writes nothing on it. When
the host dies, the OS closes the pipe; the sidecar reads EOF and exits
cleanly. This contract is what keeps an orphaned sidecar from outliving
its parent — without it, a host crash would leave the gRPC server
running and holding hardware open.

The end-to-end test spawns the sidecar as a child process, waits for its
``sidecar\tlistening`` banner, then closes the child's stdin and
asserts the process exits within a short timeout.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path


_PKG_ROOT = Path(__file__).resolve().parents[1]


def _spawn_sidecar() -> subprocess.Popen[bytes]:
    """Start the sidecar with stdin piped, banner on stdout, errors on stderr.

    Uses the same interpreter pytest is running under so the sidecar's
    deps (grpc, protobuf) are guaranteed to be importable.
    """
    env = os.environ.copy()
    env["PYTHONPATH"] = str(_PKG_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.Popen(
        [sys.executable, "-m", "cannet_python_can", "--bind", "127.0.0.1:0"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        cwd=_PKG_ROOT,
    )


def _wait_for_listening(proc: subprocess.Popen[bytes], timeout_s: float) -> str:
    """Block until we see the ``sidecar\tlistening\t<addr>`` banner, return ``<addr>``."""
    deadline = time.monotonic() + timeout_s
    assert proc.stdout is not None
    while time.monotonic() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        text = line.decode().rstrip("\n")
        if text.startswith("sidecar\tlistening\t"):
            return text.split("\t", 2)[2]
    raise AssertionError(
        "sidecar never printed `listening` banner within "
        f"{timeout_s}s; stderr={proc.stderr.read().decode() if proc.stderr else ''!r}"
    )


def test_sidecar_exits_when_stdin_closes() -> None:
    proc = _spawn_sidecar()
    try:
        _wait_for_listening(proc, timeout_s=10.0)
        # Closing stdin is what mimics the host process dying — the OS
        # then signals EOF on the pipe the sidecar is reading from.
        assert proc.stdin is not None
        proc.stdin.close()
        try:
            exit_code = proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise AssertionError(
                "sidecar did not exit within 5s of stdin EOF — the "
                "watcher is not wired up or is blocked"
            )
        assert exit_code == 0, f"sidecar exited non-zero ({exit_code})"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2.0)


def test_sidecar_shutdown_banner_marks_stdin_eof_reason() -> None:
    """The shutdown banner names stdin-EOF as the reason.

    Lets the host's stdout classifier surface "sidecar shut down because
    the GUI closed" as a distinct message instead of the generic signal
    path — which on a clean GUI exit isn't being sent.
    """
    proc = _spawn_sidecar()
    try:
        _wait_for_listening(proc, timeout_s=10.0)
        assert proc.stdin is not None
        proc.stdin.close()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            raise
        assert proc.stdout is not None
        remaining = proc.stdout.read().decode()
        assert "sidecar\tshutdown\treason=stdin-eof" in remaining, (
            f"expected stdin-eof shutdown banner, saw: {remaining!r}"
        )
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2.0)
