"""The :class:`~cannet_python_wire.frame.Frame` ↔ ``can.Message`` seam.

Both sides of the wire in this repository are python-can shaped — the
sidecar reads hardware through python-can, the client presents a
``BusABC`` — so this pair is the other end of every frame that crosses
:mod:`cannet_python_wire.proto`.

``python-can`` is imported defensively: the sidecar must boot and
report zero interfaces on a machine with no vendor SDK installed, so a
missing ``can`` degrades to "no transmit path" rather than an import
error on the way in. Only :func:`frame_to_message` needs the library;
:func:`message_to_frame` reads whatever shape it is handed.
"""

from __future__ import annotations

import time

from .frame import Frame, FrameKind

try:  # python-can may be absent in a fresh / replaced venv.
    import can  # type: ignore[import-untyped]
except Exception:  # noqa: BLE001 - swallow any import-time error.
    can = None  # type: ignore[assignment]

#: How far from the current wall clock a driver-supplied timestamp may
#: sit before it is treated as garbage (a day, which is far more slack
#: than any real stamping error and far less than the values seen in
#: the field, which overflow the wire format's uint64 ns field).
_TS_PLAUSIBLE_SLACK_S = 86_400.0


def message_to_frame(msg) -> Frame:
    """python-can ``Message`` → wire :class:`~cannet_python_wire.frame.Frame`.

    The fallback for missing timestamps uses :func:`time.time_ns`
    (Unix-epoch ns), not :func:`time.monotonic_ns` — python-can's
    hardware-stamped path produces Unix-epoch ns too (boot epoch +
    PEAK's µs counter). Mixing those two clocks within one session
    produced timestamps three orders of magnitude apart, which broke
    the trace view's "first frame is the zero point" assumption and
    showed up as wildly-negative deltas the moment a fallback-stamped
    frame slipped in after a hardware-stamped one.

    Timestamps outside ``_TS_PLAUSIBLE_SLACK_S`` of the current wall
    clock take the same fallback: they are driver garbage, and passing
    them through either overflows the wire encode (killing the frame
    stream) or wrecks the trace view's timing the same way a
    mixed-clock stamp does.
    """
    ts_s = float(getattr(msg, "timestamp", 0.0) or 0.0)
    if ts_s and abs(ts_s - time.time()) <= _TS_PLAUSIBLE_SLACK_S:
        timestamp_ns = int(ts_s * 1_000_000_000)
    else:
        timestamp_ns = int(time.time_ns())
    data = bytes(getattr(msg, "data", b"") or b"")
    return Frame(
        timestamp_ns=timestamp_ns,
        can_id=int(getattr(msg, "arbitration_id", 0)),
        extended=bool(getattr(msg, "is_extended_id", False)),
        is_rx=not bool(getattr(msg, "is_tx", False)),
        data=data,
        kind=FrameKind.from_flags(
            is_error=bool(getattr(msg, "is_error_frame", False)),
            is_remote=bool(getattr(msg, "is_remote_frame", False)),
            is_fd=bool(getattr(msg, "is_fd", False)),
        ),
        brs=bool(getattr(msg, "bitrate_switch", False)),
        esi=bool(getattr(msg, "error_state_indicator", False)),
        dlc=int(getattr(msg, "dlc", len(data))),
    )


def frame_to_message(frame: Frame):
    """Wire :class:`~cannet_python_wire.frame.Frame` → python-can ``Message``.

    Note what this deliberately leaves unset: it is the transmit
    direction, where a received frame's timestamp and direction have no
    meaning. A consumer decoding *received* frames supplies both.
    """
    assert can is not None  # callable only after import succeeded
    return can.Message(  # type: ignore[union-attr]
        arbitration_id=frame.can_id,
        is_extended_id=frame.extended,
        is_fd=frame.kind == FrameKind.FD,
        bitrate_switch=frame.brs,
        error_state_indicator=frame.esi,
        is_remote_frame=frame.kind == FrameKind.REMOTE,
        is_error_frame=frame.kind == FrameKind.ERROR,
        data=frame.data,
        dlc=frame.dlc or len(frame.data),
    )
