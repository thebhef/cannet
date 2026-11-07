"""The fault-recovery bench, end to end on the fake wire.

Each scenario runs the bench as the CLI does: the real sidecar
in-process behind loopback gRPC, a PEAK-shaped fake under the real
``PythonCanChannel``, the fault injected once traffic runs and cleared
after it is found. Each asserts what the bench recorded -- the found and
recovered events and the table's rows -- so the scenarios check the
bench's plumbing and the sidecar's recovery together.

Where the shipped recovery fails a scenario the test is
``xfail(strict=True)`` with the reason: the record of what the sidecar
does today, which flips to a pass (and so a failure here) when the
recovery changes.

The last test drives real PEAK hardware and is marked ``hardware``:
deselected by default, it skips unless ``CANNET_BENCH_UNDER_TEST`` and
``CANNET_BENCH_PARTNER`` name two channels on one wire, and it waits for
someone to pull and plug the cable.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

from cannet_local_sidecar.bench import fake  # noqa: E402
from cannet_local_sidecar.bench.fault_recovery import (  # noqa: E402
    Bench,
    BenchConfig,
    run_trial,
    wait_for_event,
)

#: Lighter than the live default; the fake has no bus timing to fill.
_RATE = 400.0
#: Long enough for the sidecar's 1 s bus-off threshold, its reset and a
#: recovery window; the bench's 10 s default bounds the fault wait. A
#: run that is not meant to recover waits the shorter one.
_RECOVERY_TIMEOUT_S = 5.0
_NO_RECOVERY_TIMEOUT_S = 3.0


def _run(
    tmp_path: Path, scenario: str, strategy: str, *, recovery_timeout: float
) -> Bench:
    wire = fake.FakeWire()
    bench = Bench(
        fake.FakeDriver(wire),
        BenchConfig(
            under_test=wire.handles[0],
            partner=wire.handles[1],
            strategy=strategy,
            rate=_RATE,
            out=tmp_path,
            recovery_window_s=0.5,
            driver_label=f"fake ({scenario})",
        ),
    )
    try:
        run_trial(
            bench,
            recovery_timeout=recovery_timeout,
            wire=wire,
            scenario=fake.SCENARIOS[scenario],
        )
    finally:
        wire.close()
    return bench


def _events(bench: Bench) -> list[dict]:
    lines = (bench.run_dir / "events.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines]


def _table(bench: Bench) -> str:
    return (bench.run_dir / "table.md").read_text(encoding="utf-8")


def _episode_rows(bench: Bench) -> list[dict]:
    found = bench.found
    assert found is not None
    return [r for r in bench.rows if r["t"] >= found["t"]]


def _assert_recovered(bench: Bench) -> None:
    assert bench.recovered is not None, bench.verdict()
    assert bench.recovered["run_start_t"] > bench.found["t"]  # type: ignore[index]
    assert "recovered" in _table(bench).splitlines()[-1]


_SHIPPED_REOPEN_FAILS = (
    "the shipped recovery reopens a PEAK channel before closing the one it "
    "holds, and PCAN-Basic refuses a second CAN_Initialize on a held handle "
    "(PCAN_ERROR_INITIALIZE), every pass"
)


@pytest.mark.parametrize(
    "strategy",
    [
        pytest.param(
            "sidecar",
            marks=pytest.mark.xfail(strict=True, reason=_SHIPPED_REOPEN_FAILS),
        ),
        "close_then_open",
    ],
)
def test_bus_off(tmp_path: Path, strategy: str) -> None:
    timeout = _NO_RECOVERY_TIMEOUT_S if strategy == "sidecar" else _RECOVERY_TIMEOUT_S
    bench = _run(tmp_path, "bus_off", strategy, recovery_timeout=timeout)
    rows = _episode_rows(bench)
    assert any(r["state"] == "bus_off" and r["status"] == "0x00010" for r in rows)
    assert any(r["refused"].get("other") for r in rows)
    # The state poll called the recovery under test on the channel.
    assert any(f"ut: {strategy} ->" in e for r in rows for e in r["strategy"])
    _assert_recovered(bench)


def test_error_passive(tmp_path: Path) -> None:
    bench = _run(
        tmp_path, "error_passive", "sidecar", recovery_timeout=_RECOVERY_TIMEOUT_S
    )
    rows = _episode_rows(bench)
    assert any(r["state"] == "passive" and r["tec"] >= 128 for r in rows)
    assert any(r["status"] == "0x40000" for r in rows)
    _assert_recovered(bench)


def test_stuck_tx_queue(tmp_path: Path) -> None:
    bench = _run(
        tmp_path, "stuck_tx_queue", "sidecar", recovery_timeout=_RECOVERY_TIMEOUT_S
    )
    rows = _episode_rows(bench)
    assert bench.found["via"] == "refusal"  # type: ignore[index]
    assert any(r["refused"].get("queue_full") for r in rows)
    # Nothing accepted for a second, so the sidecar flushed the queue.
    assert sum(r["flushes"] for r in rows) >= 1
    _assert_recovered(bench)


def test_refusal_storm(tmp_path: Path) -> None:
    bench = _run(
        tmp_path, "refusal_storm", "sidecar", recovery_timeout=_RECOVERY_TIMEOUT_S
    )
    rows = _episode_rows(bench)
    refused = sum(r["refused"].get("queue_full", 0) for r in rows)
    # Every send through the 1.5 s storm was refused and counted.
    assert refused >= 1.2 * _RATE, refused
    assert all(r["accepted"] == 0 for r in rows[1:4])
    _assert_recovered(bench)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "a reopen that fails after the channel was closed leaves the closed "
        "channel current; it reads active, which clears the bus-off run, so "
        "the reset is never tried again"
    ),
)
def test_reopen_fails(tmp_path: Path) -> None:
    bench = _run(
        tmp_path,
        "reopen_fails",
        "close_then_open",
        recovery_timeout=_NO_RECOVERY_TIMEOUT_S,
    )
    rows = _episode_rows(bench)
    assert any("ut: open raised:" in e for r in rows for e in r["strategy"])
    assert fake.INITIALIZE_TEXT in _table(bench)
    _assert_recovered(bench)


@pytest.mark.xfail(
    strict=True,
    reason=(
        "the bus-off reset is armed only by a bus-off state reading; a send "
        "refused as bus-off does not arm it"
    ),
)
def test_status_word_clears_while_writes_refuse(tmp_path: Path) -> None:
    bench = _run(
        tmp_path,
        "status_word_clears_while_writes_refuse",
        "close_then_open",
        recovery_timeout=_NO_RECOVERY_TIMEOUT_S,
    )
    rows = _episode_rows(bench)
    assert any(
        r["status"] == "0x00000" and r["refused"].get("other") and not r["accepted"]
        for r in rows
    )
    _assert_recovered(bench)


@pytest.mark.parametrize(
    "strategy, recovers",
    [
        ("state_active", False),
        ("bus_reset", False),
        ("auto_reset", True),
        ("uninit_init_same_handle", True),
    ],
)
def test_each_strategy_is_swapped_in(
    tmp_path: Path, strategy: str, recovers: bool
) -> None:
    """The ladder's other rungs on ``bus_off``. What each does on the
    fake mirrors PCAN-Basic as its docstring describes it: setting the
    state and ``CAN_Reset`` leave the controller bus-off, re-initialising
    the handle brings it back, and auto-reset brings it back inside the
    status read -- so the sidecar may never read bus-off long enough to
    call the strategy at all."""
    timeout = _RECOVERY_TIMEOUT_S if recovers else _NO_RECOVERY_TIMEOUT_S
    bench = _run(tmp_path, "bus_off", strategy, recovery_timeout=timeout)
    called = [
        e for r in bench.rows for e in r["strategy"] if e.startswith(f"ut: {strategy}")
    ]
    if strategy != "auto_reset":
        assert called, bench.rows
    assert (bench.recovered is not None) == recovers, bench.verdict()


def test_a_refused_open_stops_the_bench_and_names_the_error(tmp_path: Path) -> None:
    from cannet_local_sidecar.bench.fault_recovery import BenchRefused

    wire = fake.FakeWire()
    wire.open_failures[wire.handles[0]] = 1
    bench = Bench(
        fake.FakeDriver(wire),
        BenchConfig(under_test=wire.handles[0], partner=wire.handles[1], out=tmp_path),
    )
    try:
        with pytest.raises(BenchRefused, match="initialization process has failed"):
            bench.start()
    finally:
        wire.close()
    assert any(e["event"] == "refused" for e in _events(bench))


def test_wait_returns_the_event_from_the_newest_run(tmp_path: Path) -> None:
    old = tmp_path / "20261005T000000Z-sidecar"
    new = tmp_path / "20261006T000000Z-sidecar"
    for d, event in ((old, "found"), (new, "armed")):
        d.mkdir()
        (d / "events.jsonl").write_text(json.dumps({"event": event}) + "\n")
    assert wait_for_event("found", out=tmp_path, timeout=0.3) is None
    with open(new / "events.jsonl", "a") as f:
        f.write(json.dumps({"event": "found", "via": "state"}) + "\n")
    assert wait_for_event("found", out=tmp_path, timeout=1.0) == {
        "event": "found",
        "via": "state",
    }


@pytest.mark.hardware
def test_recovers_on_a_peak_pair() -> None:
    under_test = os.environ.get("CANNET_BENCH_UNDER_TEST")
    partner = os.environ.get("CANNET_BENCH_PARTNER")
    if not (under_test and partner):
        pytest.skip(
            "set CANNET_BENCH_UNDER_TEST and CANNET_BENCH_PARTNER to two PEAK "
            "channel ids on one wire (and CANNET_BENCH_STRATEGY to pick a "
            "strategy), then pull and plug the cable"
        )
    from cannet_local_sidecar.driver_python_can import PythonCanDriver

    bench = Bench(
        PythonCanDriver(),
        BenchConfig(
            under_test=under_test,
            partner=partner,
            strategy=os.environ.get("CANNET_BENCH_STRATEGY", "sidecar"),
        ),
    )
    run_trial(bench, fault_timeout=None, recovery_timeout=None)
    assert bench.recovered is not None, bench.verdict()
