"""The SNTP probe wired into a live `Session`.

`tests/test_clock.py` pins the arithmetic in isolation; these prove it
is actually driven off the wire — a real peer's clock gets measured,
and a peer that never answers a probe (built before the envelopes
existed, per `cannet.proto`'s `ClockProbe` doc) degrades to raw
timestamps instead of holding the session up.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from concurrent import futures

import grpc
import pytest
from cannet_python_can._proto import cannet_pb2 as pb
from cannet_python_can._proto import cannet_pb2_grpc as pb_grpc

from cannet_python_client import clock, trust
from cannet_python_client.session import Session

FACTORY = "virtual:bus0"


def test_a_real_peer_answers_probes_and_the_session_measures_it(
    vbus_server: str,
) -> None:
    target = trust.resolve(vbus_server, servers={})
    session = Session(target, FACTORY)
    try:
        deadline = time.monotonic() + 5.0
        while not session.clock.ever_measured() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert session.clock.ever_measured(), "the debug server never answered a probe"
        record = session.clock.record()
        assert record.status == clock.STATUS_MEASURED
        # Same machine, same clock: the two are not literally the same
        # reading, but nothing legitimate puts them a second apart.
        assert abs(record.measured_offset_ns) < 1_000_000_000
    finally:
        session.close()


# --- a peer that never answers a clock probe ---------------------------


class _SilentClockServicer(pb_grpc.CannetServerServicer):
    """Answers `Subscribe` with one `FrameBatch` and drops every
    `ClockProbe` — the wire's own model of a peer built before the
    clock envelopes existed."""

    def __init__(self, interface_id: str, raw_timestamp_ns: int) -> None:
        self._interface_id = interface_id
        self._raw_timestamp_ns = raw_timestamp_ns

    def Session(
        self, request_iterator: Iterator[pb.Envelope], context: grpc.ServicerContext
    ) -> Iterator[pb.Envelope]:
        for envelope in request_iterator:
            if envelope.WhichOneof("body") == "subscribe":
                yield pb.Envelope(
                    frame_batch=pb.FrameBatch(
                        interface_id=self._interface_id,
                        frames=[
                            pb.Frame(
                                timestamp_ns=self._raw_timestamp_ns,
                                can_id=0x123,
                                extended=False,
                                direction=pb.DIRECTION_RX,
                                kind=pb.FRAME_KIND_CLASSIC,
                                data=b"\x01\x02",
                            )
                        ],
                    )
                )
            # clock_probe (and anything else): dropped in silence.


@pytest.fixture
def silent_clock_server() -> Iterator[tuple[str, int]]:
    raw_timestamp_ns = 1_700_000_000_000_000_000
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    pb_grpc.add_CannetServerServicer_to_server(
        _SilentClockServicer("fake:0", raw_timestamp_ns), server
    )
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield f"127.0.0.1:{port}", raw_timestamp_ns
    finally:
        server.stop(grace=None)


def test_a_peer_that_never_answers_probes_delivers_raw_timestamps_without_blocking(
    silent_clock_server: tuple[str, int],
) -> None:
    address, raw_timestamp_ns = silent_clock_server
    target = trust.resolve(address, servers={})

    session = Session(target, "fake:0")
    try:
        start = time.monotonic()
        message = None
        while message is None and time.monotonic() - start < 5.0:
            message = session.recv(timeout=0.2)
        elapsed = time.monotonic() - start
        assert message is not None, "the fake server never delivered its frame"
        assert elapsed < 2.0, "recv must not wait out the clock probe deadline"
        # No measurement ever landed, so the slew never moved off zero.
        assert message.timestamp == pytest.approx(raw_timestamp_ns / 1_000_000_000)
        assert session.clock.status() in (
            clock.STATUS_PENDING,
            clock.STATUS_UNSUPPORTED,
        )
    finally:
        close_start = time.monotonic()
        session.close()
        close_elapsed = time.monotonic() - close_start
    assert close_elapsed < 1.0, "close() must not wait out the clock probe deadline"
