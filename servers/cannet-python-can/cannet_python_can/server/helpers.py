"""Stateless helpers shared across the sidecar's gRPC service modules.

Driver resolution, the self-stamp clock, envelope builders, and the
small ``ConfigureBus`` / controller-state translators. Nothing here
holds session or interface state; the stateful pieces live in
:mod:`.shared_interface`, :mod:`.enumeration`, and :mod:`.service`.
The ``Frame`` ↔ wire ``Frame`` conversion is not the sidecar's own —
it is :mod:`cannet_python_wire.proto`, shared with every other speaker
of the protocol in this repository.
"""

from __future__ import annotations

import importlib
import logging
import os
import time
from typing import Optional

from cannet_python_wire._proto import cannet_pb2 as pb

from .. import driver as drv

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
    # Wall clock, not monotonic: self-stamped envelopes (log messages,
    # clock replies) must share the Unix-epoch ns scale of
    # hardware-stamped RX frames, or consumers that anchor on the
    # first frame's timestamp see the streams ~3 orders of magnitude
    # apart.
    return time.time_ns()


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
    if name == drv.STATE_WARNING:
        return pb.CONTROLLER_STATE_WARNING
    if name == drv.STATE_PASSIVE:
        return pb.CONTROLLER_STATE_PASSIVE
    if name == drv.STATE_BUS_OFF:
        return pb.CONTROLLER_STATE_BUS_OFF
    if name == drv.STATE_UNAVAILABLE:
        return pb.CONTROLLER_STATE_UNAVAILABLE
    return pb.CONTROLLER_STATE_ACTIVE


def _interface_state(
    *,
    channel_id: str,
    state: "pb.ControllerState.V",
    tec: int,
    rec: int,
    rx_overruns: Optional[int],
) -> pb.InterfaceState:
    """One ``InterfaceState`` message, leaving ``rx_overruns`` **unset**
    where the backend reports no receive loss at all.

    Zero and absent are different answers there — a backend that watches
    for loss and has seen none says zero, a backend that does not watch
    says nothing — and the difference only survives the encoding if the
    optional field is genuinely left unset.
    """
    msg = pb.InterfaceState(
        interface_id=channel_id,
        state=state,
        tec=tec,
        rec=rec,
    )
    if rx_overruns is not None:
        msg.rx_overruns = rx_overruns
    return msg
