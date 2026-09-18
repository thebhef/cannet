"""A transmit carrying an unspecified frame kind is rejected, not sent.

The decode itself is the shared wire package's and is tested there
(``cannet_python_wire.proto_to_frame`` raises on
``FRAME_KIND_UNSPECIFIED`` and on an unrecognised tag, mirroring
``crates/cannet-wire/src/convert.rs``). What this test holds is the
sidecar's end of it: that the raise becomes a ``CODE_TX_REJECTED`` for
the submitting session rather than a frame silently sent as classic.
"""

from __future__ import annotations

import queue
import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_local_sidecar import server as srv  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402


def test_handle_tx_rejects_unspecified_kind_frame() -> None:
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
