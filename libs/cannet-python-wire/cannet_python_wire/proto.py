"""The :class:`~cannet_python_wire.frame.Frame` ↔ generated-proto seam.

One encoding of the wire in Python, used by both directions of it: the
sidecar encodes what it reads off hardware, the client decodes what a
server sends it.
"""

from __future__ import annotations

import time

from ._proto import cannet_pb2 as pb
from .frame import Frame, FrameKind

#: The frame-kind seam. A :class:`~cannet_python_wire.frame.FrameKind`
#: maps 1:1 onto a wire ``FrameKind``; the priority ladder that collapses
#: a backend's independent booleans lives in ``FrameKind.from_flags``, so
#: both directions here are a straight lookup with no re-derivation.
_KIND_TO_PROTO: dict[FrameKind, int] = {
    FrameKind.CLASSIC: pb.FRAME_KIND_CLASSIC,
    FrameKind.FD: pb.FRAME_KIND_FD,
    FrameKind.REMOTE: pb.FRAME_KIND_REMOTE,
    FrameKind.ERROR: pb.FRAME_KIND_ERROR,
}
_PROTO_TO_KIND: dict[int, FrameKind] = {v: k for k, v in _KIND_TO_PROTO.items()}


def _now_ns() -> int:
    # Wall clock, not monotonic: a self-stamped frame must share the
    # Unix-epoch ns scale of hardware-stamped RX frames, or consumers
    # that anchor on the first frame's timestamp see the streams ~3
    # orders of magnitude apart.
    return time.time_ns()


def frame_to_proto(frame: Frame) -> pb.Frame:
    """Encode a :class:`~cannet_python_wire.frame.Frame` for the wire."""
    return pb.Frame(
        timestamp_ns=frame.timestamp_ns,
        can_id=frame.can_id,
        extended=frame.extended,
        direction=pb.DIRECTION_RX if frame.is_rx else pb.DIRECTION_TX,
        kind=_KIND_TO_PROTO[frame.kind],
        data=frame.data,
        brs=frame.brs,
        esi=frame.esi,
        dlc=frame.dlc,
    )


def proto_to_frame(p: pb.Frame) -> Frame:
    """Decode a wire ``Frame`` into a :class:`~cannet_python_wire.frame.Frame`.

    Raises :class:`ValueError` on ``FRAME_KIND_UNSPECIFIED`` or an
    unrecognised kind tag rather than silently coercing it to classic —
    mirroring the Rust decoder (``crates/cannet-wire/src/convert.rs``,
    which errors with ``UnknownKind``). The sidecar's ``_handle_tx``
    path turns the raise into a ``CODE_TX_REJECTED`` for the submitting
    session.
    """
    kind = _PROTO_TO_KIND.get(p.kind)
    if kind is None:
        raise ValueError(f"unspecified or unrecognised frame kind {p.kind}")
    return Frame(
        timestamp_ns=p.timestamp_ns or _now_ns(),
        can_id=p.can_id,
        extended=p.extended,
        is_rx=p.direction == pb.DIRECTION_RX,
        data=bytes(p.data),
        kind=kind,
        brs=p.brs,
        esi=p.esi,
        dlc=p.dlc,
    )
