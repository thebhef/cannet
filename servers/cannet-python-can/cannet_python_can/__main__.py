"""``uv run cannet-python-can`` entry point.

Boots the gRPC service, emits the discovered interfaces as
structured banner lines, and blocks until either Ctrl-C, a SIGTERM,
or the host closes our stdin (the cross-platform "parent went away"
contract — see :func:`_install_stdin_eof_watcher`).

All process output is routed through :mod:`logging`. Two logger
trees coexist:

- The default tree (root + per-module ``_log = logging.getLogger(__name__)``)
  writes free-form messages and tracebacks to **stderr** via
  :func:`logging.basicConfig`. The host's spawn bridge turns each
  line into a ``warn``-level System Message tagged
  ``sidecar:python-can``.
- The ``cannet_python_can.banner`` logger writes machine-parseable,
  tab-separated lines to **stdout** with its own handler and
  ``propagate=False``, so the banner channel does not double-emit on
  stderr. The host's classifier in ``sidecar.rs`` reads these and
  turns each into a typed System Message
  (``sidecar version …``, ``sidecar listening …``, etc.).

Those two trees feed **two sinks with deliberately different
levels** (:func:`_configure_logging`):

- **stderr** stays at ``--log-level``. It is what the user sees in the
  System Messages panel, so raising the file's detail must not make
  the panel noisier.
- **the ``--log-file`` rolling file** always records at ``debug``, and
  the banner lines are mirrored into it as well (enumeration results
  and the bound address belong in a hardware post-mortem). Without the
  flag no file is written at all, so a standalone ``uv run`` behaves
  exactly as before. Rotation is
  :class:`~logging.handlers.RotatingFileHandler` at
  :data:`LOG_FILE_MAX_BYTES` × (1 + :data:`LOG_FILE_BACKUP_COUNT`)
  generations — a bounded ~5 MB on disk.

**What the debug file does and does not record on streaming paths.**
The per-command detail (subscribe / unsubscribe / configure /
enumerate, with arguments, outcomes, and full tracebacks) is what
makes a per-channel connect failure diagnosable after the fact. The
frame streams are the deliberate exception: ``FrameBatch`` transmits
and the rx fan-out log their **lifecycle and faults only** — channel
open/close, reconfigure, rejections, pump crashes, and the existing
periodic rx/tx rate lines — never per-frame content. A bus at
100k frames/s would otherwise rotate the whole 5 MB budget away in
under a second and pay a logging call on the hot path for the
privilege.
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import signal
import sys
import threading
import traceback
from pathlib import Path
from typing import Optional

from . import __version__


# Banner logger — see module docstring. Configured once at import time
# so even pre-`main` failures (rare, but possible if a side-effect
# import in `srv` raises) still get a usable channel.
BANNER = logging.getLogger("cannet_python_can.banner")
BANNER.setLevel(logging.INFO)
BANNER.propagate = False
if not BANNER.handlers:
    _banner_handler = logging.StreamHandler(sys.stdout)
    _banner_handler.setFormatter(logging.Formatter("%(message)s"))
    BANNER.addHandler(_banner_handler)


#: Record layout shared by the stderr sink and the ``--log-file`` sink.
#: ``sidecar.rs``'s ``classify_stderr_line`` parses this exact shape, so
#: it is not free to change.
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"

#: Rolling-file budget: 1 MiB per generation …
LOG_FILE_MAX_BYTES = 1024 * 1024
#: … and four backups behind the live file, so the sidecar's logs cost
#: at most ~5 MB of disk however long the session runs.
LOG_FILE_BACKUP_COUNT = 4


def _configure_logging(level: str, log_file: Optional[str]) -> Optional[Path]:
    """Wire up the two sinks; return the logfile path actually opened.

    ``level`` governs **stderr only**. When ``log_file`` is given, the
    root logger has to drop to ``DEBUG`` for the file handler to see
    debug records, so ``level`` moves onto the stderr handler itself —
    that is what keeps the System Messages panel at the verbosity the
    user asked for while the file records everything.

    Returns ``None`` when no file was requested, and also when the file
    could not be opened: losing diagnostics must not stop the sidecar
    from serving hardware.
    """
    stderr_level = getattr(logging, level.upper())
    logging.basicConfig(level=stderr_level, format=LOG_FORMAT)
    if log_file is None:
        return None
    path = Path(log_file)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            path,
            maxBytes=LOG_FILE_MAX_BYTES,
            backupCount=LOG_FILE_BACKUP_COUNT,
            encoding="utf-8",
        )
    except OSError as e:
        logging.getLogger(__name__).warning(
            "could not open --log-file %s: %s; continuing without it", path, e
        )
        return None
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    root = logging.getLogger()
    for existing in root.handlers:
        existing.setLevel(stderr_level)
    root.setLevel(logging.DEBUG)
    root.addHandler(handler)
    # The banner tree has `propagate=False`, so it needs the file
    # handler attached directly — enumeration results and the bound
    # address only exist there.
    BANNER.addHandler(handler)
    return path


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="cannet-python-can",
        description="Auto-launched python-can sidecar for the cannet wire protocol.",
    )
    parser.add_argument(
        "--bind",
        default="127.0.0.1:0",
        help=(
            "Address to bind the gRPC service on (default: 127.0.0.1:0 — "
            "the OS picks a free ephemeral port and the actual address is "
            "emitted on the `sidecar\\tlistening\\t<addr>` banner line). "
            "Pinning a non-zero port is honoured first; on bind failure "
            "the sidecar falls back to a random port rather than exiting."
        ),
    )
    parser.add_argument(
        "--log-level",
        default="info",
        choices=("debug", "info", "warning", "error"),
        help="Python log level for stderr output.",
    )
    parser.add_argument(
        "--log-file",
        default=None,
        help=(
            "Also write a rolling, always-debug logfile at this path "
            "(1 MB × 5 generations). Every gRPC command, its arguments "
            "and outcome, and every driver traceback land here at full "
            "detail regardless of --log-level. Omitted by default: no "
            "flag, no file."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"cannet-python-can {__version__}",
    )
    return parser.parse_args(argv)


def _install_stdin_eof_watcher(shutdown_callback) -> None:
    """Trigger ``shutdown_callback`` when stdin closes.

    The GUI host pipes the sidecar's stdin and writes nothing to it;
    when the host process dies, the kernel closes the pipe and the
    blocking read below returns 0 bytes. That's our cue to shut down
    cleanly so we don't outlive our parent.

    No-op when stdin is a TTY (the developer is running the sidecar by
    hand and Ctrl-C is the expected shutdown path) or absent (some
    embedded launchers). Runs on a daemon thread so it never blocks
    interpreter exit if the watcher is still waiting on read at the
    moment the server stops for another reason.
    """
    if sys.stdin is None or not hasattr(sys.stdin, "buffer"):
        return
    try:
        if sys.stdin.isatty():
            return
    except (ValueError, OSError):
        # stdin already closed — treat as "no watcher", and let the
        # signal path handle shutdown.
        return

    def _watch() -> None:
        try:
            while True:
                chunk = sys.stdin.buffer.read(1)
                if not chunk:
                    break
        except (OSError, ValueError):
            # OSError on broken pipe; ValueError if stdin gets closed
            # underneath us during interpreter shutdown.
            pass
        shutdown_callback()

    threading.Thread(target=_watch, name="stdin-eof-watcher", daemon=True).start()


def _emit_startup_banner(driver) -> None:
    """One banner line per channel; the GUI host parses these.

    Format is deliberately stable: ``interface\t<id>\t<display_name>\t<fd?>``.
    """
    channels = list(driver.list_channels())
    BANNER.info("sidecar\tversion\t%s", __version__)
    BANNER.info("sidecar\tinterfaces\t%d", len(channels))
    for c in channels:
        fd = "fd" if c.fd_capable else "classic"
        BANNER.info("interface\t%s\t%s\t%s", c.id, c.display_name, fd)


def _run(args: argparse.Namespace) -> int:
    # Imported lazily so the top-level handler in `main` catches
    # import-time failures (missing grpc, protobuf gencode/runtime
    # mismatch, etc.) instead of crashing during module load.
    from . import server as srv

    driver = srv.load_driver()
    _emit_startup_banner(driver)

    server, bound_address = srv.serve(args.bind, driver=driver)
    BANNER.info("sidecar\tlistening\t%s", bound_address)

    stop_lock = threading.Lock()
    stop_requested = [False]

    def _request_stop(banner_line: str) -> None:
        with stop_lock:
            if stop_requested[0]:
                return
            stop_requested[0] = True
        BANNER.info(banner_line)
        server.stop(grace=2.0)

    def _on_signal(signum, _frame):
        _request_stop(f"sidecar\tshutdown\tsignal={signum}")

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    _install_stdin_eof_watcher(
        lambda: _request_stop("sidecar\tshutdown\treason=stdin-eof")
    )

    try:
        # Block on `wait_for_termination` so the process exits cleanly
        # when the server is stopped or the parent goes away.
        server.wait_for_termination()
    except KeyboardInterrupt:
        _on_signal(signal.SIGINT, None)
    BANNER.info("sidecar\texit\t0")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    log_path = _configure_logging(args.log_level, args.log_file)
    if log_path is not None:
        # Discoverability: the host classifies this into a System
        # Message, so the user can find the detailed log without
        # knowing the per-OS log directory.
        BANNER.info("sidecar\tlogfile\t%s", log_path)
    try:
        return _run(args)
    except Exception as e:  # noqa: BLE001 — top-level last-chance handler
        # Two records: a single-line structured error banner so the
        # host's classifier promotes it to Error level, and a
        # full multi-line traceback through the default logging tree
        # (stderr → Warn-level System Messages, but adjacent on screen).
        BANNER.info(
            "sidecar\terror\t%s",
            f"{type(e).__name__}: {e}".replace("\n", " "),
        )
        logging.getLogger("cannet_python_can").error(
            "sidecar fatal error\n%s", traceback.format_exc()
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
