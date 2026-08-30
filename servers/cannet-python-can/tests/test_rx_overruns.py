"""Receive-overrun counting: the per-vendor status the ingest discarded.

Every other number the tool shows about a capture is read as though the
capture were the whole of what the bus sent. Nothing said whether it
was. Both vendors that report receive loss report it as a *flag* --
PEAK sets two bits in its channel status word, Vector sets a
queue-overflow flag on an event -- and neither says how many frames went
missing, so what is counted here is occasions; a backend that watches
for none of it reports nothing rather than zero.

Hardware-free throughout: the PEAK leg drives a bus shaped like
``PcanBus`` (the live ``status()`` read plus python-can's own backend
marker) and the Vector leg drives the sidecar's chip-state subclass
against faked ``XLevent``s, the same seam ``test_vector_chip_state.py``
uses.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path


def _ensure_on_path() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


_ensure_on_path()

from cannet_python_can import driver_python_can as dpc  # noqa: E402
from cannet_python_can.driver_python_can import PythonCanChannel  # noqa: E402


class _PlainBus:
    """A backend with no notion of receive loss -- python-can's own
    ``BusABC`` surface and nothing more."""

    def __init__(self) -> None:
        self.state = "ACTIVE"

    def recv(self, timeout: float) -> None:
        return None

    def shutdown(self) -> None:
        pass


class _PcanShapedBus(_PlainBus):
    """A bus with PEAK's live ``CAN_GetStatus`` read, whose answer the
    test steps through a sequence of status words."""

    m_objPCANBasic = object()

    def __init__(self, statuses: list[int]) -> None:
        super().__init__()
        self._statuses = list(statuses)
        self._last = 0

    def status(self) -> int:
        if self._statuses:
            self._last = self._statuses.pop(0)
        return self._last


class _VectorShapedBus(_PlainBus):
    """The sidecar's chip-state ``VectorBus`` subclass, minus python-can:
    the counter and the marker :class:`PythonCanChannel` gates the
    Vector leg on."""

    overrun_events = 0
    chip_state = None

    def request_chip_state(self) -> None:
        pass


def _channel(bus: object, *, fd: bool = False) -> PythonCanChannel:
    return PythonCanChannel(channel_id="ch0", bus=bus, listen_only=False, fd=fd)


# ----- A backend that does not watch reports nothing, not zero ---------------


def test_a_backend_that_does_not_report_receive_loss_answers_absent() -> None:
    # The control for everything below. Absent and zero are different
    # answers: zero is "we watched and saw none", absent is "nobody
    # watched". A readout that showed them alike would promise a
    # completeness nobody measured, which is the defect this counter
    # exists to close rather than to repeat.
    assert _channel(_PlainBus()).rx_loss() is None


def test_a_closed_channel_reports_absent() -> None:
    ch = _channel(_PcanShapedBus([0]))
    ch.close()
    assert ch.rx_loss() is None


# ----- PEAK -----------------------------------------------------------------


def test_pcan_starts_at_zero_not_absent() -> None:
    # PEAK does watch, so before anything goes wrong its answer is a
    # number -- and that number is what says the capture is whole.
    ch = _channel(_PcanShapedBus([0]))
    ch.state()
    assert ch.rx_loss() == 0


def test_pcan_counts_the_controller_and_the_queue_overrun_alike() -> None:
    # Two different bits, one meaning: frames reached the adapter and
    # did not reach us. 0x2 is the controller read too late, 0x40 the
    # driver's receive queue read too late.
    for bit in (dpc._PCAN_ERROR_OVERRUN, dpc._PCAN_ERROR_QOVERRUN):
        ch = _channel(_PcanShapedBus([0, bit]))
        ch.state()
        ch.state()
        assert ch.rx_loss() == 1, f"bit {bit:#x} went uncounted"


def test_pcan_counts_an_episode_once_however_long_it_lasts() -> None:
    # The bits stay set for as long as the condition lasts. Counting
    # every poll that sees them would report one stall as a figure
    # climbing at the poll rate -- a number about the poll, not about
    # the wire.
    ch = _channel(_PcanShapedBus([0] + [dpc._PCAN_ERROR_QOVERRUN] * 20))
    for _ in range(21):
        ch.state()
    assert ch.rx_loss() == 1


def test_pcan_counts_a_second_episode_after_the_bus_recovers() -> None:
    # The control for the test above: a run that ends and starts again
    # is two occasions, and a counter that only ever latched once would
    # go quiet through every fault after the first.
    q = dpc._PCAN_ERROR_QOVERRUN
    ch = _channel(_PcanShapedBus([0, q, q, 0, 0, q]))
    for _ in range(6):
        ch.state()
    assert ch.rx_loss() == 2


def test_pcan_does_not_count_a_fault_confinement_bit_as_lost_traffic() -> None:
    # BUSWARNING / BUSPASSIVE / BUSOFF ride the same word. They say the
    # controller is unwell, not that anything was dropped, and the panel
    # already reports them as the state.
    ch = _channel(
        _PcanShapedBus(
            [
                0,
                dpc._PCAN_ERROR_BUSWARNING,
                dpc._PCAN_ERROR_BUSPASSIVE,
                dpc._PCAN_ERROR_BUSOFF,
            ]
        )
    )
    for _ in range(4):
        ch.state()
    assert ch.rx_loss() == 0


def test_pcan_counts_an_overrun_that_arrives_with_a_fault_bit_set() -> None:
    # They are flags in one word and a real reading combines them: a bus
    # bad enough to overrun is usually bad enough to be error-passive
    # too, and a test for equality would miss every overrun that matters.
    ch = _channel(
        _PcanShapedBus([0, dpc._PCAN_ERROR_BUSPASSIVE | dpc._PCAN_ERROR_OVERRUN])
    )
    ch.state()
    ch.state()
    assert ch.rx_loss() == 1


# ----- Vector ---------------------------------------------------------------


class _Event:
    """``XLevent``: the driver sets ``flags`` to ``XL_EVENT_FLAG_OVERRUN``
    when its event queue overflowed."""

    def __init__(self, flags: int = 0, tag: int = 0) -> None:
        self.flags = flags
        self.tag = tag


def _chip_state_bus_class() -> type:
    """The real subclass the driver builds, over a stand-in base -- the
    XL library is absent wherever these run, so python-can's own
    ``VectorBus`` cannot be imported."""
    base = type("VectorBus", (), {"handle_can_event": lambda self, e: None})
    mod = types.ModuleType("can.interfaces.vector")
    mod.VectorBus = base  # type: ignore[attr-defined]
    sys.modules["can.interfaces.vector"] = mod
    dpc._vector_bus_class = None
    try:
        return dpc._chip_state_vector_bus_class()
    finally:
        sys.modules.pop("can.interfaces.vector", None)
        dpc._vector_bus_class = None


def test_vector_counts_every_event_the_driver_flags_as_an_overflow() -> None:
    cls = _chip_state_bus_class()
    bus = cls.__new__(cls)
    assert bus.overrun_events == 0
    bus.handle_can_event(_Event(flags=dpc._XL_EVENT_FLAG_OVERRUN))
    bus.handle_can_event(_Event(flags=0))
    bus.handle_can_event(_Event(flags=dpc._XL_EVENT_FLAG_OVERRUN))
    assert bus.overrun_events == 2


def test_vector_reports_the_count_through_the_channel() -> None:
    bus = _VectorShapedBus()
    bus.overrun_events = 7
    assert _channel(bus).rx_loss() == 7


def test_vector_on_an_fd_channel_reports_absent_rather_than_a_guess() -> None:
    # The FD event struct carries its overflow flag in `flagsChip`, a
    # bit python-can's own `xldefine` does not define. Reporting the
    # classic queue's zero for an FD channel would say "nothing was
    # lost" about a queue nobody is watching.
    bus = _VectorShapedBus()
    assert _channel(bus, fd=True).rx_loss() is None
    assert _channel(bus, fd=False).rx_loss() == 0


def test_the_overrun_flag_matches_python_cans_own_definition() -> None:
    # Same pinning the chip-state constants get: the value is copied out
    # of the vendored enum so this module loads without the XL library,
    # and a copy that drifts is a copy that lies.
    from can.interfaces.vector import xldefine

    assert dpc._XL_EVENT_FLAG_OVERRUN == int(
        xldefine.XL_EventFlags.XL_EVENT_FLAG_OVERRUN
    )
