"""`cannet-client` itself: argument parsing, the prompts, and what
reaches the terminal.

Everything the subcommands decide lives in
:mod:`cannet_python_client.servers` and
:mod:`cannet_python_client.connect` and is tested there. What is left
here is the wrapper — that a name reaches the model, that a question
reaches the person, and that what comes back is rendered.
"""

from __future__ import annotations

import dataclasses
import io
import ssl
import types
from pathlib import Path
from typing import Any

from cannet_python_client import cli, tls, trust
from cannet_python_client.browse import DiscoveredServer

DER = b"the certificate the server presented"
FINGERPRINT = tls.fingerprint_of(DER)
TOKEN = "KMGqFEndqRji-y-f4Ej48LJZBu7Bjg2IfmRVMv-jHZE"


@dataclasses.dataclass
class Terminal:
    """A console whose answers are scripted and whose output is kept."""

    yes: bool = True
    token: str = TOKEN
    questions: list[str] = dataclasses.field(default_factory=list)
    text: io.StringIO = dataclasses.field(default_factory=io.StringIO)

    def console(self) -> cli.Console:
        return cli.Console(out=self.text, ask=self.ask, secret=self.secret)

    def ask(self, question: str) -> bool:
        self.questions.append(question)
        return self.yes

    def secret(self, question: str) -> str:
        self.questions.append(question)
        return self.token

    @property
    def printed(self) -> str:
        return self.text.getvalue()


def probe(host: str, port: int, timeout: float) -> tuple[bytes, list[str]]:
    return DER, ["bench.local"]


def interfaces(target: trust.ServerTarget, timeout: float) -> list[Any]:
    return [types.SimpleNamespace(id="virtual:bus0"), types.SimpleNamespace(id="blf:0")]


def run(
    *argv: str,
    terminal: Terminal,
    path: Path,
    discovered: list[DiscoveredServer] | None = None,
) -> int:
    return cli.main(
        argv,
        console=terminal.console(),
        path=path,
        discover=lambda timeout: list(discovered or []),
        probe=probe,
        verify=interfaces,
    )


# --- list -------------------------------------------------------------


def test_list_renders_the_browse_over_the_store_one_row_per_server(
    tmp_path: Path,
) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    trust.accept_insecure("old-rig:50051", path=path)
    terminal = Terminal()

    code = run(
        "list",
        terminal=terminal,
        path=path,
        discovered=[
            DiscoveredServer(
                name="bench",
                address="bench:50051",
                host="bench.local",
                version="0.4.0",
                protocols=["cannet.v1"],
            ),
            DiscoveredServer(name="fresh", address="10.0.0.9:50051"),
        ],
    )

    assert code == 0
    printed = terminal.printed
    assert "bench:50051" in printed
    assert "trusted" in printed
    assert "new" in printed and "10.0.0.9:50051" in printed
    assert "unprotected" in printed
    # A known server that is not answering still has a row, marked.
    assert "old-rig:50051" in printed
    assert "not answering" in printed
    # The token is stored for `bench`, and must not be anywhere near the
    # terminal.
    assert TOKEN not in printed


def test_list_shows_what_each_server_says_it_speaks(tmp_path: Path) -> None:
    # ADR 0059: the wire's version is its package, and the `proto=` TXT
    # key is how a server states it before anything dials it. A server
    # advertising nothing says nothing — it is dialled normally and
    # `ServerInfo` decides — while one serving another major is called
    # out, because it otherwise looks reachable and refuses every
    # connect.
    terminal = Terminal()
    code = run(
        "list",
        terminal=terminal,
        path=tmp_path / "servers.json",
        discovered=[
            DiscoveredServer(
                name="ours", address="ours:50051", protocols=["cannet.v1"]
            ),
            DiscoveredServer(
                name="future", address="future:50051", protocols=["cannet.v2"]
            ),
            DiscoveredServer(name="quiet", address="quiet:50051"),
        ],
    )

    assert code == 0
    printed = terminal.printed
    assert "PROTOCOL" in printed
    rows = {line.split()[1]: line for line in printed.splitlines() if ":50051" in line}
    assert "cannet.v1" in rows["ours:50051"]
    assert "not spoken here" not in rows["ours:50051"]
    assert "cannet.v2 (not spoken here)" in rows["future:50051"]
    assert "not spoken here" not in rows["quiet:50051"]


def test_list_says_so_rather_than_printing_an_empty_table(tmp_path: Path) -> None:
    terminal = Terminal()
    assert run("list", terminal=terminal, path=tmp_path / "servers.json") == 0
    assert "no servers" in terminal.printed.lower()


# --- connect ----------------------------------------------------------


def test_connect_puts_the_fingerprint_in_front_of_the_operator_and_asks_for_the_token(
    tmp_path: Path,
) -> None:
    path = tmp_path / "servers.json"
    terminal = Terminal(yes=True, token=TOKEN)

    code = run("connect", "bench:50051", terminal=terminal, path=path)

    assert code == 0
    # The question carries the string the operator compares against the
    # server's startup banner.
    assert any(FINGERPRINT in question for question in terminal.questions)
    assert trust.read_servers(path)["bench:50051"].token == TOKEN
    # What it proved, and how to open a bus on it now.
    printed = terminal.printed
    assert "virtual:bus0" in printed
    assert 'can.Bus(interface="cannet", server="bench:50051"' in printed
    assert TOKEN not in printed


def test_connect_reports_a_refusal_and_exits_non_zero(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    terminal = Terminal(yes=False)

    code = run("connect", "bench:50051", terminal=terminal, path=path)

    assert code == 1
    assert not path.exists()
    assert "not" in terminal.printed.lower()


def test_connect_reports_a_pin_mismatch_without_offering_a_way_round_it(
    tmp_path: Path,
) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint(
        "bench:50051", tls.fingerprint_of(b"another"), None, path=path
    )
    terminal = Terminal()

    code = run("connect", "bench:50051", terminal=terminal, path=path)

    assert code == 1
    assert FINGERPRINT in terminal.printed
    assert terminal.questions == []


def test_connect_asks_before_anything_goes_out_in_the_clear(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    terminal = Terminal(yes=True)

    def refusing(host: str, port: int, timeout: float) -> tuple[bytes, list[str]]:
        raise ssl.SSLError("wrong version number")

    code = cli.main(
        ("connect", "old-rig:50051"),
        console=terminal.console(),
        path=path,
        discover=lambda timeout: [],
        probe=refusing,
        verify=interfaces,
    )

    assert code == 0
    assert any("without protection" in q for q in terminal.questions)
    assert trust.read_servers(path)["old-rig:50051"].insecure


def test_connect_reaches_a_real_loopback_server_with_nothing_faked(
    vbus_server: str, tmp_path: Path
) -> None:
    # The whole path for real, against `cannet-server debug vbus`: no
    # probe, no question, and the interfaces come back over gRPC. A
    # loopback server is never accepted, so nothing is written.
    path = tmp_path / "servers.json"
    terminal = Terminal()

    code = cli.main(("connect", vbus_server), console=terminal.console(), path=path)

    assert code == 0
    assert "virtual:bus0" in terminal.printed
    assert f'server="{vbus_server}"' in terminal.printed
    assert not path.exists()


# --- forget -----------------------------------------------------------


def test_forget_removes_the_entry_and_says_which_one(tmp_path: Path) -> None:
    path = tmp_path / "servers.json"
    trust.accept_fingerprint("bench:50051", FINGERPRINT, TOKEN, path=path)
    terminal = Terminal()

    assert run("forget", "bench", terminal=terminal, path=path) == 0
    assert "bench:50051" in terminal.printed
    assert trust.read_servers(path) == {}


def test_forgetting_a_server_nobody_accepted_is_reported_not_silent(
    tmp_path: Path,
) -> None:
    terminal = Terminal()
    code = run("forget", "bench", terminal=terminal, path=tmp_path / "servers.json")
    assert code == 1
    assert "bench" in terminal.printed


# --- the console script ------------------------------------------------


def test_the_distribution_declares_the_console_script() -> None:
    # `cannet-client` on the PATH is the whole point of the package
    # shipping a CLI; an entry point that names a function that has
    # moved fails only when someone runs it.
    from importlib.metadata import entry_points

    scripts = entry_points(group="console_scripts")
    target = {e.name: e.value for e in scripts}.get("cannet-client")
    assert target == "cannet_python_client.cli:run"
    assert callable(cli.run)
