"""Stateless helpers shared across the sidecar's gRPC service modules.

Driver resolution, the self-stamp clock, the driver ``Frame`` ↔ wire
``Frame`` conversion seam, envelope builders, and the small
``ConfigureBus`` / controller-state translators. Nothing here holds
session or interface state; the stateful pieces live in
:mod:`.shared_interface`, :mod:`.enumeration`, and :mod:`.service`.
"""

from __future__ import annotations

import importlib
import logging
import os
import time

from .. import driver as drv
from .._proto import cannet_pb2 as pb

_log = logging.getLogger(__name__)

#: The sidecar wire log tag. The GUI host watches for this exact prefix
#: when bridging incoming ``LogMessage`` envelopes into the System
#: Messages panel.
WIRE_SOURCE = "sidecar:python-can"

#: Environment variable that lets the user pick an alternative driver
#: module (must expose a top-level ``Driver()`` callable returning a
#: :class:`cannet_python_can.driver.Driver`-shaped object).
DRIVER_MODULE_ENV = "CANNET_DRIVER_MODULE"
DEFAULT_DRIVER_MODULE = "cannet_python_can.driver_python_can"


def load_driver() -> drv.Driver:
    """Resolve the active driver module and instantiate it.

    Falls back to the python-can-backed default. Looks for a top-level
    callable named ``Driver`` (or its lower-case ``driver``); a module
    that exposes the protocol directly works too.
    """
    name = os.environ.get(DRIVER_MODULE_ENV, DEFAULT_DRIVER_MODULE)
    mod = importlib.import_module(name)
    factory = (
        getattr(mod, "Driver", None)
        or getattr(mod, "PythonCanDriver", None)
        or getattr(mod, "driver", None)
    )
    if factory is None:
        raise RuntimeError(
            f"driver module {name!r} exposes no Driver/PythonCanDriver/driver"
        )
    return factory()


def _now_ns() -> int:
    # Wall clock, not monotonic: self-stamped envelopes (TX-frame
    # fallback, log messages) must share the Unix-epoch ns scale of
    # hardware-stamped RX frames, or consumers that anchor on the
    # first frame's timestamp see the streams ~3 orders of magnitude
    # apart.
    return time.time_ns()


#: The frame-kind seam. A driver :class:`~cannet_python_can.driver.FrameKind`
#: maps 1:1 onto a wire ``FrameKind``; the priority ladder that collapses
#: a backend's independent booleans lives in ``FrameKind.from_flags``, so
#: both directions here are a straight lookup with no re-derivation.
_KIND_TO_PROTO: dict[drv.FrameKind, int] = {
    drv.FrameKind.CLASSIC: pb.FRAME_KIND_CLASSIC,
    drv.FrameKind.FD: pb.FRAME_KIND_FD,
    drv.FrameKind.REMOTE: pb.FRAME_KIND_REMOTE,
    drv.FrameKind.ERROR: pb.FRAME_KIND_ERROR,
}
_PROTO_TO_KIND: dict[int, drv.FrameKind] = {v: k for k, v in _KIND_TO_PROTO.items()}


def _frame_to_proto(frame: drv.Frame) -> pb.Frame:
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


def _proto_to_frame(p: pb.Frame) -> drv.Frame:
    """Decode a wire ``Frame`` into a driver :class:`~cannet_python_can.driver.Frame`.

    Raises :class:`ValueError` on ``FRAME_KIND_UNSPECIFIED`` or an
    unrecognised kind tag rather than silently coercing it to classic —
    mirroring the Rust decoder (``crates/cannet-wire/src/convert.rs``,
    which errors with ``UnknownKind``). The ``_handle_tx`` path turns the
    raise into a ``CODE_TX_REJECTED`` for the submitting session.
    """
    kind = _PROTO_TO_KIND.get(p.kind)
    if kind is None:
        raise ValueError(f"unspecified or unrecognised frame kind {p.kind}")
    return drv.Frame(
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


def _log_envelope(level: "pb.LogLevel.V", message: str) -> pb.Envelope:
    return pb.Envelope(
        log=pb.LogMessage(
            timestamp_ns=_now_ns(),
            level=level,
            source=WIRE_SOURCE,
            message=message,
        )
    )


def _clock_reply_envelope(t1: int, t2: int) -> pb.Envelope:
    """Answer one ``ClockProbe`` received at ``t2``, echoing its ``t1``.

    ``t3`` is stamped here, as late as this queue-based server can
    manage: whatever handling time sits between ``t2`` and ``t3`` shows
    up in the client's *delay* estimate rather than its *offset*
    estimate, which is why the exchange carries both (RFC 4330 § 5).

    Both stamps come from :func:`_now_ns` — the same wall clock that
    stamps hardware RX frames — because that is the clock the client is
    measuring against. A ``time.monotonic_ns()`` reading here would
    answer about a clock that never reaches the wire.
    """
    return pb.Envelope(clock_reply=pb.ClockReply(t1=t1, t2=t2, t3=_now_ns()))


def _error_envelope(code: "pb.Error.Code.V", message: str) -> pb.Envelope:
    return pb.Envelope(error=pb.Error(code=code, message=message))


def _configure_to_open_config(cfg: pb.ConfigureBus) -> drv.OpenConfig:
    """Translate a wire ``ConfigureBus`` into an :class:`OpenConfig`.

    ``speed_bps`` / ``fd_data_speed_bps`` of 0 are taken as "unset";
    the OpenConfig field becomes ``None`` so the driver picks its own
    default.
    """
    return drv.OpenConfig(
        bitrate_bps=int(cfg.speed_bps) if cfg.speed_bps else None,
        data_bitrate_bps=(
            int(cfg.fd_data_speed_bps) if cfg.fd_data_speed_bps else None
        ),
        fd=bool(cfg.fd_enabled),
    )


def _state_name_to_proto(name: str) -> "pb.ControllerState.V":
    if name == drv.STATE_PASSIVE:
        return pb.CONTROLLER_STATE_PASSIVE
    if name == drv.STATE_BUS_OFF:
        return pb.CONTROLLER_STATE_BUS_OFF
    return pb.CONTROLLER_STATE_ACTIVE
