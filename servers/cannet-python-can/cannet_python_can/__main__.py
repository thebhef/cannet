"""``uv run cannet-python-can`` entry point.

Boots the gRPC service, emits the discovered interfaces as
structured banner lines, and blocks until either Ctrl-C or the host
closes the process group.

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
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import traceback

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
        "--version",
        action="version",
        version=f"cannet-python-can {__version__}",
    )
    return parser.parse_args(argv)


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

    stop_requested = False

    def _on_signal(signum, _frame):
        nonlocal stop_requested
        if stop_requested:
            return
        stop_requested = True
        BANNER.info("sidecar\tshutdown\tsignal=%d", signum)
        server.stop(grace=2.0)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

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
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
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
