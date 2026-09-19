"""Frame-kind seam between the wire ``Frame`` and the generated proto.

A frame has exactly one kind. :class:`cannet_python_wire.FrameKind`
models it with a single value instead of independent ``is_error`` /
``is_remote`` / ``fd`` booleans, so the error > remote > fd priority
ladder lives in one place (``FrameKind.from_flags``) rather than being
re-derived at every proto boundary.

The wire → frame decode (``proto_to_frame``) rejects
``FRAME_KIND_UNSPECIFIED`` and unrecognised kind tags rather than
silently treating them as classic — mirroring the Rust decoder
(``crates/cannet-wire/src/convert.rs`` errors with ``UnknownKind``).
"""

from __future__ import annotations

import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


import pytest  # noqa: E402

from cannet_python_wire import Frame, FrameKind  # noqa: E402
from cannet_python_wire import frame_to_proto, proto_to_frame  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402


def test_from_flags_priority_ladder() -> None:
    K = FrameKind
    # error wins over everything
    assert K.from_flags(is_error=True, is_remote=True, is_fd=True) is K.ERROR
    # remote wins over fd
    assert K.from_flags(is_error=False, is_remote=True, is_fd=True) is K.REMOTE
    # fd next
    assert K.from_flags(is_error=False, is_remote=False, is_fd=True) is K.FD
    # nothing set → classic
    assert K.from_flags(is_error=False, is_remote=False, is_fd=False) is K.CLASSIC


@pytest.mark.parametrize(
    ("kind", "proto_kind"),
    [
        (FrameKind.CLASSIC, pb.FRAME_KIND_CLASSIC),
        (FrameKind.FD, pb.FRAME_KIND_FD),
        (FrameKind.REMOTE, pb.FRAME_KIND_REMOTE),
        (FrameKind.ERROR, pb.FRAME_KIND_ERROR),
    ],
)
def test_frame_kind_round_trips_through_proto(kind, proto_kind) -> None:
    frame = Frame(
        timestamp_ns=1,
        can_id=0x100,
        extended=False,
        is_rx=True,
        data=b"",
        kind=kind,
    )
    proto = frame_to_proto(frame)
    assert proto.kind == proto_kind
    assert proto_to_frame(proto).kind is kind


def test_proto_to_frame_rejects_unspecified_kind() -> None:
    """The silent-UNSPECIFIED-mapping gap: a wire frame with kind 0 used
    to decode into a *classic* frame and transmit silently. It must be
    rejected, matching convert.rs's ``UnknownKind`` error."""
    p = pb.Frame(can_id=0x100, kind=pb.FRAME_KIND_UNSPECIFIED)
    with pytest.raises(ValueError):
        proto_to_frame(p)


def test_proto_to_frame_rejects_unknown_kind_tag() -> None:
    p = pb.Frame(can_id=0x100, kind=99)
    with pytest.raises(ValueError):
        proto_to_frame(p)
