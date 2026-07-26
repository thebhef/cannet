"""Frame-kind seam between the driver ``Frame`` and the wire ``Frame``.

A frame has exactly one kind. The driver models it with a single
:class:`cannet_python_can.driver.FrameKind` instead of independent
``is_error`` / ``is_remote`` / ``fd`` booleans, so the error > remote >
fd priority ladder lives in one place (``FrameKind.from_flags``) rather
than being re-derived at every proto boundary.

The wire → driver decode (``_proto_to_frame``) rejects
``FRAME_KIND_UNSPECIFIED`` and unrecognised kind tags rather than
silently treating them as classic — mirroring the Rust decoder
(``crates/cannet-wire/src/convert.rs`` errors with ``UnknownKind``).
"""

from __future__ import annotations

import queue
import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


import pytest  # noqa: E402

from cannet_python_can import driver as drv  # noqa: E402
from cannet_python_can import server as srv  # noqa: E402
from cannet_python_can._proto import cannet_pb2 as pb  # noqa: E402


def test_from_flags_priority_ladder() -> None:
    K = drv.FrameKind
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
        (drv.FrameKind.CLASSIC, pb.FRAME_KIND_CLASSIC),
        (drv.FrameKind.FD, pb.FRAME_KIND_FD),
        (drv.FrameKind.REMOTE, pb.FRAME_KIND_REMOTE),
        (drv.FrameKind.ERROR, pb.FRAME_KIND_ERROR),
    ],
)
def test_frame_kind_round_trips_through_proto(kind, proto_kind) -> None:
    frame = drv.Frame(
        timestamp_ns=1,
        can_id=0x100,
        extended=False,
        is_rx=True,
        data=b"",
        kind=kind,
    )
    proto = srv._frame_to_proto(frame)
    assert proto.kind == proto_kind
    assert srv._proto_to_frame(proto).kind is kind


def test_proto_to_frame_rejects_unspecified_kind() -> None:
    """The silent-UNSPECIFIED-mapping gap: a wire frame with kind 0 used
    to decode into a *classic* driver frame and transmit silently. It
    must be rejected, matching convert.rs's ``UnknownKind`` error."""
    p = pb.Frame(can_id=0x100, kind=pb.FRAME_KIND_UNSPECIFIED)
    with pytest.raises(ValueError):
        srv._proto_to_frame(p)


def test_proto_to_frame_rejects_unknown_kind_tag() -> None:
    p = pb.Frame(can_id=0x100, kind=99)
    with pytest.raises(ValueError):
        srv._proto_to_frame(p)


def test_handle_tx_rejects_unspecified_kind_frame() -> None:
    """End-to-end: a TX batch carrying an unspecified-kind frame is
    rejected with CODE_TX_REJECTED instead of being silently sent as a
    classic frame."""
    from tests.test_shared_interface import _FakeDriver  # local import

    driver = _FakeDriver()
    svc = srv.CannetServerService(driver)
    outbox: "queue.Queue" = queue.Queue()
    svc._registry.subscribe("fake:0", outbox)
    # Drain the InterfaceState snapshot the subscribe pushed.
    while True:
        env = outbox.get(timeout=1.0)
        if env.WhichOneof("body") == "interface_state":
            break

    batch = pb.FrameBatch(
        interface_id="fake:0",
        frames=[pb.Frame(can_id=0x100, kind=pb.FRAME_KIND_UNSPECIFIED)],
    )
    svc._handle_tx(batch, {"fake:0"}, outbox)

    env = outbox.get(timeout=1.0)
    assert env.WhichOneof("body") == "error"
    assert env.error.code == pb.Error.CODE_TX_REJECTED
