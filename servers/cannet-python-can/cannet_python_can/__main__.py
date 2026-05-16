"""``uv run cannet-python-can`` entry point.

Boots the gRPC service, prints discovered interfaces (one per line on
stdout so the host's spawn bridge can pick them up as info-level
System Messages), and blocks until either Ctrl-C or the host closes
the process group.
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time

from . import __version__
from . import server as srv


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="cannet-python-can",
        description="Auto-launched python-can sidecar for the cannet wire protocol.",
    )
    parser.add_argument(
        "--bind",
        default="127.0.0.1:50061",
        help="Address to bind the gRPC service on (default: 127.0.0.1:50061).",
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


def _print_startup_banner(driver) -> None:
    """One stdout line per channel; the GUI host parses these.

    Format is deliberately stable: ``interface\t<id>\t<display_name>\t<fd?>``.
    Other lines (anything not starting with ``interface\t``) are info-
    level System Messages.
    """
    channels = list(driver.list_channels())
    print(f"sidecar\tversion\t{__version__}", flush=True)
    print(f"sidecar\tinterfaces\t{len(channels)}", flush=True)
    for c in channels:
        fd = "fd" if c.fd_capable else "classic"
        print(f"interface\t{c.id}\t{c.display_name}\t{fd}", flush=True)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv if argv is not None else sys.argv[1:])
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    driver = srv.load_driver()
    _print_startup_banner(driver)

    server = srv.serve(args.bind, driver=driver)
    print(f"sidecar\tlistening\t{args.bind}", flush=True)

    stop_requested = False

    def _on_signal(signum, _frame):
        nonlocal stop_requested
        if stop_requested:
            return
        stop_requested = True
        print(f"sidecar\tshutdown\tsignal={signum}", flush=True)
        server.stop(grace=2.0)

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    try:
        # Block on `wait_for_termination` so the process exits cleanly
        # when the server is stopped or the parent goes away.
        server.wait_for_termination()
    except KeyboardInterrupt:
        _on_signal(signal.SIGINT, None)
    print("sidecar\texit\t0", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
