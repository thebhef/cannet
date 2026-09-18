"""``cannet-client`` — the acceptance workflow, without the GUI.

Three subcommands over the model in :mod:`cannet_python_client.servers`
and :mod:`cannet_python_client.connect`:

``list``
    what is advertising on the subnet, merged with what this machine
    has accepted.
``connect``
    reach one server, answering whatever it asks, and store the
    decision where every client on the machine will find it.
``forget``
    take a server's entry back out.

**This module decides nothing.** It parses arguments, puts the model's
questions to the person at the terminal, and renders what comes back.
That is ADR 0003's contract — the model is owned by the model layer and
a view renders over it — applied to a terminal rather than a WebView:
anything that looks like a rule about trust, addresses or the store
belongs in the modules above, where it is tested without a terminal.
"""

from __future__ import annotations

import argparse
import dataclasses
import getpass
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TextIO

from . import connect as _connect
from . import servers as _servers
from . import tls, trust
from .browse import DEFAULT_BROWSE_TIMEOUT_S, Discover


def _yes_no(question: str) -> bool:
    """A yes-or-no question on stdin, where only an explicit yes is one."""
    return input(f"{question} [y/N] ").strip().lower() in ("y", "yes")


@dataclasses.dataclass
class Console:
    """Where the command reads its answers and writes its output."""

    out: TextIO = dataclasses.field(default_factory=lambda: sys.stdout)
    ask: Callable[[str], bool] = _yes_no
    #: Reads a credential without echoing it.
    secret: Callable[[str], str] = getpass.getpass

    def say(self, line: str = "") -> None:
        print(line, file=self.out)


@dataclasses.dataclass
class ConsoleOperator:
    """The person at the terminal, as the connect flow asks them."""

    console: Console

    def accept_identity(self, address: str, fingerprint: str) -> bool:
        self.console.say()
        self.console.say(f"{address} presented a certificate:")
        self.console.say(f"    {fingerprint}")
        self.console.say(
            "The server printed the same string when it started. Compare them."
        )
        return self.console.ask(f"Is {fingerprint} what {address} printed at startup?")

    def token_for(self, address: str) -> str:
        self.console.say(
            "The server printed a token beside that fingerprint. Leave this empty "
            "if it needs none."
        )
        return self.console.secret(f"token for {address}: ")

    def accept_unprotected(self, address: str, detail: str) -> bool:
        self.console.say()
        self.console.say(f"{address} did not answer with a certificate: {detail}")
        self.console.say(
            "It may be a server run --no-tls, or nothing at all. Nothing sent to it "
            "would be protected, and no token would go out."
        )
        return self.console.ask(f"Connect to {address} without protection?")


def build_parser() -> argparse.ArgumentParser:
    """The command line, as ``--help`` describes it."""
    parser = argparse.ArgumentParser(
        prog="cannet-client",
        description=(
            "Find cannet servers, accept one, and record the decision every "
            "client on this machine reads."
        ),
    )
    commands = parser.add_subparsers(dest="command", required=True)

    listing = commands.add_parser(
        "list", help="servers advertising on this subnet, and ones accepted here"
    )
    _add_timeout(listing, "how long to listen for advertisements")

    connecting = commands.add_parser(
        "connect", help="reach a server, accepting its identity if it is new"
    )
    connecting.add_argument(
        "server", help="host:port, or the name of a server advertising or accepted"
    )
    _add_timeout(connecting, "how long to listen when looking a name up")

    forgetting = commands.add_parser(
        "forget", help="drop a server's pin, token and unprotected choice"
    )
    forgetting.add_argument("server", help="host:port, or an accepted server's name")
    return parser


def _add_timeout(parser: argparse.ArgumentParser, help_text: str) -> None:
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_BROWSE_TIMEOUT_S,
        metavar="SECONDS",
        help=f"{help_text} (default: %(default)s)",
    )


def main(
    argv: Sequence[str] | None = None,
    *,
    console: Console | None = None,
    path: Path | str | None = None,
    discover: Discover | None = None,
    probe: _connect.Probe | None = None,
    verify: _connect.Verify | None = None,
) -> int:
    """Run one command, returning its exit status.

    Everything past ``argv`` is a seam: the store's location, the
    browse, the certificate fetch and the verifying RPC, so the command
    can be exercised without a terminal, a network or this machine's own
    trust store.
    """
    args = build_parser().parse_args(argv)
    console = console or Console()
    try:
        if args.command == "list":
            return _list(args, console, path, discover)
        if args.command == "connect":
            return _connect_to(args, console, path, discover, probe, verify)
        return _forget(args, console, path)
    except (trust.TrustError, tls.PinMismatch, tls.BadFingerprint) as exc:
        console.say(str(exc))
        return 1


def _list(
    args: argparse.Namespace,
    console: Console,
    path: Path | str | None,
    discover: Discover | None,
) -> int:
    rows = _servers.known_servers(timeout=args.timeout, path=path, discover=discover)
    if not rows:
        console.say(
            "no servers: nothing is advertising on this subnet, and nothing has "
            "been accepted on this machine"
        )
        return 0
    table = [("NAME", "ADDRESS", "TRUST", "PROTOCOL", "PRESENCE")] + [
        (
            row.name or "-",
            row.address,
            row.trust,
            _servers.protocol_label(row),
            "advertising" if row.online else "not answering",
        )
        for row in rows
    ]
    widths = [max(len(cell) for cell in column) for column in zip(*table, strict=True)]
    for cells in table:
        console.say(
            "  ".join(
                cell.ljust(width) for cell, width in zip(cells, widths, strict=True)
            ).rstrip()
        )
    return 0


def _connect_to(
    args: argparse.Namespace,
    console: Console,
    path: Path | str | None,
    discover: Discover | None,
    probe: _connect.Probe | None,
    verify: _connect.Verify | None,
) -> int:
    store = trust.read_servers(path)
    address = _servers.resolve_address(
        args.server, servers=store, discover=discover, timeout=args.timeout
    )
    connection = _connect.connect(
        address,
        operator=ConsoleOperator(console),
        servers=store,
        path=path,
        probe=probe,
        verify=verify,
    )

    console.say()
    if connection.stored == _connect.PIN:
        console.say(f"accepted {connection.target.fingerprint} for {address}")
    elif connection.stored == _connect.UNPROTECTED:
        console.say(f"recorded that {address} is reached without protection")
    if connection.stored is not None:
        console.say(f"stored in {trust.servers_file() if path is None else path}")

    protection = "unprotected" if connection.target.plaintext else "pinned"
    console.say(f"connected to {address} ({protection})")
    for interface in connection.interfaces:
        console.say(f"  {interface.id}")
    if not connection.interfaces:
        console.say("  (the server is offering no interfaces)")
    channel = connection.interfaces[0].id if connection.interfaces else "<interface id>"
    console.say()
    console.say("open a bus on it with:")
    console.say(
        f'    can.Bus(interface="cannet", server="{address}", channel="{channel}")'
    )
    return 0


def _forget(args: argparse.Namespace, console: Console, path: Path | str | None) -> int:
    forgotten = _servers.forget(args.server, path=path)
    if forgotten is None:
        console.say(
            f"nothing is stored for {args.server!r}, so there is nothing to forget"
        )
        return 1
    console.say(
        f"forgot {forgotten}; the next connection to it starts at trust on first use"
    )
    return 0


def run() -> None:
    """The ``cannet-client`` console script."""
    raise SystemExit(main())
