"""Hardware-free import + zero-interfaces smoke tests for the sidecar.

These are the only tests CI can run; per-vendor end-to-end smoke is
in `SMOKE.md`. Designed so they pass even on a machine with no
vendor SDKs installed (and even when `python-can` itself is absent
from the venv).
"""

from __future__ import annotations

import sys
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


def test_package_imports() -> None:
    import cannet_python_can  # noqa: F401

    assert cannet_python_can.__version__


def test_proto_stubs_importable() -> None:
    from cannet_python_can._proto import cannet_pb2, cannet_pb2_grpc  # noqa: F401

    # The proto file is the source of truth for the wire surface; if
    # we ever lose the LogMessage variant the host bridge stops
    # working silently.
    assert hasattr(cannet_pb2, "LogMessage")
    assert hasattr(cannet_pb2, "FrameBatch")
    assert hasattr(cannet_pb2, "Subscribe")


def test_driver_zero_interfaces_when_no_hardware() -> None:
    # The default python-can driver must not raise even if the SDK is
    # absent — it should just enumerate zero channels.
    from cannet_python_can import driver_python_can

    drv = driver_python_can.PythonCanDriver()
    channels = list(drv.list_channels())
    # We deliberately do not assert == 0 because a developer machine
    # *with* hardware should also pass; we only require the call to
    # succeed and return a list.
    assert isinstance(channels, list)


def test_load_driver_resolves_default_module() -> None:
    from cannet_python_can import server

    d = server.load_driver()
    # Default factory is `PythonCanDriver`.
    assert d.__class__.__name__ == "PythonCanDriver"


def test_subscribe_unknown_interface_yields_error_envelope() -> None:
    """Subscribing to a channel that does not exist produces an Error
    envelope on the response stream — the exact wire contract the
    Rust client relies on."""

    from cannet_python_can import server
    from cannet_python_can._proto import cannet_pb2 as pb

    class EmptyDriver:
        def list_channels(self):
            return []

        def open(self, channel_id, config):
            raise KeyError(channel_id)

    svc = server.CannetServerService(EmptyDriver())  # type: ignore[arg-type]

    # Feed a Subscribe envelope, then close the input stream.
    inbox = iter([pb.Envelope(subscribe=pb.Subscribe(interface_id="ghost"))])

    class _Ctx:
        def is_active(self) -> bool:  # pragma: no cover - unused
            return True

    out = list(svc.Session(inbox, _Ctx()))
    # Exact ordering: a session-opened log envelope, then the Error.
    assert out, "expected at least one envelope on response stream"
    error_envs = [e for e in out if e.WhichOneof("body") == "error"]
    assert error_envs, (
        f"expected an Error envelope, got: {[e.WhichOneof('body') for e in out]}"
    )
    assert error_envs[0].error.code == pb.Error.CODE_UNKNOWN_INTERFACE


def test_log_envelope_factory_tags_with_wire_source() -> None:
    """The sidecar's outgoing log envelopes must carry the
    `sidecar:python-can` source tag the GUI host watches for."""

    from cannet_python_can import server
    from cannet_python_can._proto import cannet_pb2 as pb

    env = server._log_envelope(pb.LOG_LEVEL_INFO, "hello")
    assert env.WhichOneof("body") == "log"
    assert env.log.source == server.WIRE_SOURCE
    assert env.log.source == "sidecar:python-can"
