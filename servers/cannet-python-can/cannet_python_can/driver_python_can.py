"""Default :mod:`cannet_python_can.driver` implementation, backed by
``python-can``.

Designed so the *module* imports cleanly even when ``python-can`` is
absent — the sidecar must boot and report zero interfaces on a
machine with no vendor SDK installed. The import fallback is checked
at module load; everything else degrades to "no channels available".

Channel id grammar
==================

Every enumerated channel id has the shape ``<vendor>:<body>(<meta>)``
where ``<meta>`` is a comma-separated ``key:value`` list. The body is
the vendor-specific routing key python-can needs; the parens are
metadata the GUI uses for identity (it never has to know what's in
them). :func:`_bus_kwargs_for` strips the parens before handing the
body off to python-can, so the open path stays simple.

Per-vendor shape:

- **Vector** — ``vector:<app_name>(SN:<serial>, ch:<hw_channel>)``
  (``SN:`` is omitted when the card doesn't report a serial).
- **Kvaser** — ``kvaser:<global_index>(SN:<card_serial>, ch:<per_card_channel>)``
  (``SN:`` is omitted when the card doesn't report a serial).
- **PEAK** — ``pcan:<slot>(h:<handle hex>, ch:<controller_number>[, uid:<device_id>])``
  where ``<slot>`` is the PCAN-Basic constant name
  (``PCAN_USBBUS1``…) or a ``handle=0xNN`` fallback for transports
  without a known constant; ``uid:`` appears only when the user has
  set a non-zero device id in PCAN-View.

If a vendor's SDK isn't installed on the host, that vendor simply
contributes zero channels and a one-line info log; the other vendors
still enumerate. The wire-level surface stays vendor-agnostic.
"""

from __future__ import annotations

import logging
import time
from typing import Iterable, List, Optional

from .driver import (
    Channel,
    ControllerState,
    Frame,
    OpenChannel,
    OpenConfig,
    STATE_ACTIVE,
    STATE_BUS_OFF,
    STATE_PASSIVE,
    TxRejected,
)

_log = logging.getLogger(__name__)


try:  # python-can may be absent in a fresh / replaced venv.
    import can  # type: ignore[import-untyped]

    _HAVE_PYTHON_CAN = True
    _IMPORT_ERROR = ""
except Exception as _e:  # noqa: BLE001 - swallow any import-time error.
    can = None  # type: ignore[assignment]
    _HAVE_PYTHON_CAN = False
    _IMPORT_ERROR = repr(_e)


class PythonCanDriver:
    """Default driver: enumerate + open via ``python-can``."""

    def __init__(self) -> None:
        if not _HAVE_PYTHON_CAN:
            _log.warning(
                "python-can not importable (%s); reporting zero channels",
                _IMPORT_ERROR,
            )

    def list_channels(self) -> Iterable[Channel]:
        if not _HAVE_PYTHON_CAN:
            return []
        out: List[Channel] = []
        out.extend(_list_vector())
        out.extend(_list_kvaser())
        out.extend(_list_pcan())
        return out

    def open(self, channel_id: str, config: OpenConfig) -> "PythonCanChannel":
        if not _HAVE_PYTHON_CAN:
            raise KeyError(channel_id)
        interface, kwargs = _bus_kwargs_for(channel_id, config)
        try:
            bus = can.interface.Bus(interface=interface, **kwargs)  # type: ignore[union-attr]
        except Exception as e:  # noqa: BLE001
            raise OSError(f"open {channel_id}: {e}") from e
        return PythonCanChannel(
            channel_id=channel_id,
            bus=bus,
            listen_only=config.listen_only,
            fd=config.fd,
        )


class PythonCanChannel:
    """One opened ``python-can`` ``Bus`` plus a small recv/send wrapper."""

    def __init__(
        self, *, channel_id: str, bus: object, listen_only: bool, fd: bool
    ) -> None:
        self.channel_id = channel_id
        self._bus = bus
        self._listen_only = listen_only
        self._fd = fd
        self._closed = False

    def recv(self, timeout_s: float) -> Optional[Frame]:
        if self._closed:
            return None
        msg = self._bus.recv(timeout=timeout_s)  # type: ignore[attr-defined]
        if msg is None:
            return None
        return _msg_to_frame(msg)

    def send(self, frame: Frame) -> None:
        if self._closed:
            raise TxRejected("channel closed")
        if self._listen_only:
            raise TxRejected("listen-only configuration")
        self._reject_if_incompatible(frame)
        msg = _frame_to_msg(frame)
        try:
            self._bus.send(msg)  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001
            raise TxRejected(str(e)) from e

    def _reject_if_incompatible(self, frame: Frame) -> None:
        """Refuse frame shapes that would make python-can raise inside a
        ctypes slice assignment.

        Backends like PCAN copy the payload into a fixed-size ``c_ubyte``
        array (8 bytes for classic, 64 for FD) with a slice assignment
        whose left and right halves must agree in length. When they
        don't — e.g. an FD frame with >8 bytes on a classic-mode bus, or
        a frame whose ``dlc`` disagrees with ``len(data)`` — the bus
        raises a bare ``ValueError("Can only assign sequence of same
        size")`` that's hard to interpret upstream. Reject here so the
        caller sees a precise ``TxRejected`` with the actual mismatch.
        """
        if frame.is_error:
            return
        if frame.fd and not self._fd:
            raise TxRejected(
                f"FD frame on classic-mode bus {self.channel_id}"
            )
        if frame.is_remote and self._fd:
            raise TxRejected(
                f"remote (RTR) frame not supported on FD-mode bus "
                f"{self.channel_id}"
            )
        if frame.is_remote:
            return
        max_bytes = 64 if self._fd else 8
        if len(frame.data) > max_bytes:
            raise TxRejected(
                f"payload {len(frame.data)} bytes exceeds {max_bytes}-byte "
                f"limit ({'FD' if self._fd else 'classic'} bus "
                f"{self.channel_id})"
            )
        if frame.dlc and frame.dlc != len(frame.data):
            raise TxRejected(
                f"dlc={frame.dlc} differs from data length "
                f"{len(frame.data)} (bus {self.channel_id})"
            )

    def state(self) -> ControllerState:
        """Read the controller's fault-confinement state.

        python-can exposes ``Bus.state`` (``BusState.ACTIVE`` /
        ``PASSIVE`` / ``ERROR``); we map ``ERROR`` to ``bus_off`` since
        that's the closest analog of an ISO 11898-1 fault state in
        python-can's three-value enum. TEC / REC aren't exposed
        uniformly across backends; reported as 0.
        """
        if self._closed or can is None:
            return ControllerState()
        try:
            raw = self._bus.state  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            return ControllerState()
        name = getattr(raw, "name", str(raw)).upper()
        if name == "PASSIVE":
            return ControllerState(state=STATE_PASSIVE)
        if name in ("ERROR", "BUS_OFF", "BUSOFF"):
            return ControllerState(state=STATE_BUS_OFF)
        return ControllerState(state=STATE_ACTIVE)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._bus.shutdown()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass


# ----- Vendor enumeration helpers --------------------------------------------


def _list_vector() -> List[Channel]:
    """Vector XL channels via python-can's ``vector`` backend.

    ``VectorChannelConfig`` (the NamedTuple python-can returns from
    ``get_channel_configs``) carries:

    - ``name`` — application-visible channel name, used as the
      ``app_name`` python-can needs to reopen the channel.
    - ``hw_type`` — ``XL_HardwareType``. ``XL_HWTYPE_NONE`` (0) marks
      a channel slot the XL driver pre-allocated but no physical
      hardware fills; we skip those, otherwise a 4-port VN1630A
      reports six slots.
    - ``hw_channel`` — per-card channel number.
    - ``serial_number`` — card serial; the disambiguator for two
      physically identical VN devices, and the open-path key (see
      :func:`_bus_kwargs_for`).
    - ``channel_capabilities`` — ``XL_ChannelCapabilities`` flags; we
      OR the two CAN-FD support flags to decide ``fd_capable``.
    """
    try:
        from can.interfaces.vector import canlib as vector_canlib  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    # CAN-FD capability flags from xldefine.XL_ChannelCapabilities.
    # Looked up lazily because importing xldefine pulls the vxlapi
    # native library on some platforms; if the lookup fails we just
    # report fd_capable=False, which is the right default.
    fd_mask = 0
    try:
        from can.interfaces.vector import xldefine  # type: ignore[import-untyped]

        fd_mask = int(
            getattr(xldefine.XL_ChannelCapabilities, "XL_CHANNEL_FLAG_CANFD_BOSCH_SUPPORT", 0)
        ) | int(
            getattr(xldefine.XL_ChannelCapabilities, "XL_CHANNEL_FLAG_CANFD_ISO_SUPPORT", 0)
        )
    except Exception:  # noqa: BLE001
        fd_mask = 0
    try:
        configs = vector_canlib.get_channel_configs()
    except Exception as e:  # noqa: BLE001
        _log.info("vector enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for cfg in configs or []:
        hw_type = getattr(cfg, "hw_type", None)
        if hw_type is not None and int(hw_type) == 0:
            continue
        app_name = getattr(cfg, "name", None) or "vector"
        hw_channel = getattr(cfg, "hw_channel", None)
        if hw_channel is None:
            continue
        sn = getattr(cfg, "serial_number", None)
        meta = []
        if sn:
            meta.append(f"SN:{sn}")
        meta.append(f"ch:{hw_channel}")
        meta_str = ", ".join(meta)
        cid = f"vector:{app_name}({meta_str})"
        label = f"Vector {app_name} ({meta_str})"
        fd = False
        if fd_mask:
            caps = int(getattr(cfg, "channel_capabilities", 0) or 0)
            fd = bool(caps & fd_mask)
        out.append(Channel(id=cid, display_name=label, fd_capable=fd))
    return out


def _list_kvaser() -> List[Channel]:
    """Kvaser CANlib channels.

    ``ChannelData(i)`` exposes ``card_serial_no`` (the card's hardware
    serial) and ``channel_no_on_card`` (the per-card channel number).
    The id body is the global index ``i`` python-can's kvaser backend
    takes as its ``channel`` kwarg; the paren metadata carries the
    card serial (when known) and the per-card channel the user reads
    off the device, so two identical cards always produce distinct
    ids and the label shows the per-card channel number.
    """
    try:
        from canlib import canlib as kvaser  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    try:
        n = kvaser.getNumberOfChannels()
    except Exception as e:  # noqa: BLE001
        _log.info("kvaser enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for i in range(int(n)):
        try:
            data = kvaser.ChannelData(i)
            device_name = getattr(data, "device_name", None) or f"ch{i}"
            sn = getattr(data, "card_serial_no", None)
            per_card = getattr(data, "channel_no_on_card", i)
        except Exception:  # noqa: BLE001
            device_name = f"ch{i}"
            sn = None
            per_card = i
        meta = []
        if sn:
            meta.append(f"SN:{sn}")
        meta.append(f"ch:{per_card}")
        meta_str = ", ".join(meta)
        cid = f"kvaser:{i}({meta_str})"
        label = f"Kvaser {device_name} ({meta_str})"
        out.append(Channel(id=cid, display_name=label, fd_capable=True))
    return out


def _decode_pcan_bytes(value) -> str:
    """PCAN-Basic returns ``c_char`` arrays — decode to ``str`` once."""
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace").rstrip("\x00").strip()
    return str(value)


def _pcan_handle_name(pcan_basic, handle: int) -> Optional[str]:
    """Reverse-lookup a PCAN channel handle to its module constant name
    (e.g. ``0x51`` → ``"PCAN_USBBUS1"``).

    Iterates the ``PCAN-Basic`` module for ``PCAN_*BUS<N>`` attributes
    whose value matches ``handle``. The constants are typically
    ``ctypes.c_ushort`` (so we unwrap ``.value``); plain ints are also
    accepted. Returns ``None`` if no constant matches — which happens
    on exotic transports we don't have a name for, in which case the
    caller substitutes a raw-hex fallback.
    """
    for name in dir(pcan_basic):
        if not name.startswith("PCAN_") or "BUS" not in name:
            continue
        try:
            value = getattr(pcan_basic, name)
        except Exception:  # noqa: BLE001
            continue
        if hasattr(value, "value"):
            value = value.value
        if isinstance(value, int) and value == handle:
            return name
    return None


def _list_pcan() -> List[Channel]:
    """PEAK PCAN-Basic channels.

    Identifies each attached channel by its ``channel_handle`` (the
    integer ``TPCANHandle`` python-can uses internally), reverse-mapped
    to its readable constant name (``PCAN_USBBUS1`` etc.) for the id
    body. This is the only field on ``TPCANChannelInformation`` that's
    actually unique per attached channel slot — earlier versions of
    this enumerator keyed on ``channel_name``, which doesn't exist on
    the struct, so every device collapsed onto the same id.

    PCAN-Basic doesn't standardly expose a per-device factory serial
    (``PCAN_DEVICE_PART_NUMBER`` returns the model SKU, not a serial),
    so the disambiguator inside the paren metadata is the channel
    handle integer, the ``controller_number`` (the per-card channel on
    multi-channel devices like PCAN-USB Pro FD), and the user-settable
    ``device_id`` from PCAN-View when set non-zero (``uid:``).
    """
    try:
        from can.interfaces.pcan import basic as pcan_basic  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    PCANBasic = getattr(pcan_basic, "PCANBasic", None)
    PCAN_ATTACHED_CHANNELS = getattr(pcan_basic, "PCAN_ATTACHED_CHANNELS", None)
    if PCANBasic is None or PCAN_ATTACHED_CHANNELS is None:
        return []
    try:
        api = PCANBasic()
        result, channels = api.GetValue(0, PCAN_ATTACHED_CHANNELS)
        if result != 0 or not channels:
            return []
    except Exception as e:  # noqa: BLE001
        _log.info("pcan enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for ch in channels:
        handle = int(getattr(ch, "channel_handle", 0) or 0)
        ctrl = int(getattr(ch, "controller_number", 0) or 0)
        dev_id = int(getattr(ch, "device_id", 0) or 0)
        model = _decode_pcan_bytes(getattr(ch, "device_name", b"")) or "PCAN"

        handle_name = _pcan_handle_name(pcan_basic, handle)
        # `body` is what python-can opens the channel with. When we
        # have a named slot constant, use it (string); otherwise fall
        # back to a stable hex form keyed back to int on open.
        body = handle_name or f"handle=0x{handle:X}"

        # `uid:` is the user-settable PCAN-View device id. It's always
        # shown, including the factory-default 0 — having it always
        # present makes the format predictable and tells the user
        # whether anyone has set a non-zero id on this adapter.
        meta = [f"h:0x{handle:X}", f"ch:{ctrl}", f"uid:{dev_id}"]
        meta_str = ", ".join(meta)

        # The display prepends the named slot to the meta list, so the
        # user sees both "which port" (slot) and the underlying handle
        # integer / controller in one paren group. When there's no
        # named slot, the hex handle in `h:` already covers it.
        display_meta = (
            f"{handle_name}, {meta_str}" if handle_name else meta_str
        )

        cid = f"pcan:{body}({meta_str})"
        label = f"PEAK {model} ({display_meta})"
        out.append(Channel(id=cid, display_name=label, fd_capable=True))
    return out


def _split_meta(rest: str) -> tuple[str, dict]:
    """Split ``<body>(k:v, k:v, …)`` into ``(body, {k: v, ...})``.

    Values are returned as raw strings; callers do their own typing.
    """
    meta: dict[str, str] = {}
    body = rest
    paren_open = body.rfind("(")
    if paren_open >= 0 and body.endswith(")"):
        inner = body[paren_open + 1 : -1]
        body = body[:paren_open]
        for part in inner.split(","):
            if ":" in part:
                k, _, v = part.partition(":")
                meta[k.strip()] = v.strip()
    return body, meta


def _bus_kwargs_for(channel_id: str, config: OpenConfig):
    """Translate ``vendor:<body>(<meta>)`` + ``OpenConfig`` into the
    arguments python-can's ``Bus`` constructor takes.

    The paren metadata is identity information for the GUI — the open
    path only needs the body plus, for Vector, the ``ch:`` field from
    the parens (since python-can's ``vector`` backend wants ``app_name``
    and ``channel`` as separate kwargs).
    """
    vendor, _, rest = channel_id.partition(":")
    body, meta = _split_meta(rest)
    common = {}
    if config.bitrate_bps is not None:
        common["bitrate"] = config.bitrate_bps
    if config.fd:
        common["fd"] = True
        if config.data_bitrate_bps is not None:
            common["data_bitrate"] = config.data_bitrate_bps
    if config.listen_only:
        common["receive_own_messages"] = False
    if vendor == "vector":
        # Open by ``serial`` + hw_channel when we have it: python-can's
        # vector backend then resolves the physical channel directly
        # via ``get_channel_configs`` and never calls
        # ``xlGetApplConfig``, so an unmapped slot in Vector Hardware
        # Config's "application" view can't break open or close. When
        # there's no serial (the always-present XL virtual bus reports
        # ``serial_number == 0``) we fall back to ``app_name``.
        ch = int(meta["ch"])
        sn = meta.get("SN")
        if sn:
            return ("vector", {"serial": int(sn), "channel": ch, **common})
        return ("vector", {"app_name": body, "channel": ch, **common})
    if vendor == "kvaser":
        return ("kvaser", {"channel": int(body), **common})
    if vendor == "pcan":
        # Known handle constants (PCAN_USBBUS1, etc.) go through as
        # strings — python-can looks them up. The ``handle=0xNN``
        # fallback (used when the enumerator can't reverse-map the
        # numeric handle to a constant name) is parsed to int here so
        # python-can's pcan accepts it as a raw TPCANHandle.
        if body.startswith("handle=0x"):
            return (
                "pcan",
                {"channel": int(body.removeprefix("handle="), 16), **common},
            )
        return ("pcan", {"channel": body, **common})
    raise KeyError(channel_id)


def _msg_to_frame(msg) -> Frame:
    """python-can ``Message`` → driver ``Frame``."""
    ts_s = float(getattr(msg, "timestamp", 0.0) or 0.0)
    timestamp_ns = int(ts_s * 1_000_000_000) if ts_s else int(time.monotonic_ns())
    data = bytes(getattr(msg, "data", b"") or b"")
    return Frame(
        timestamp_ns=timestamp_ns,
        can_id=int(getattr(msg, "arbitration_id", 0)),
        extended=bool(getattr(msg, "is_extended_id", False)),
        is_rx=not bool(getattr(msg, "is_tx", False)),
        data=data,
        fd=bool(getattr(msg, "is_fd", False)),
        brs=bool(getattr(msg, "bitrate_switch", False)),
        esi=bool(getattr(msg, "error_state_indicator", False)),
        is_remote=bool(getattr(msg, "is_remote_frame", False)),
        is_error=bool(getattr(msg, "is_error_frame", False)),
        dlc=int(getattr(msg, "dlc", len(data))),
    )


def _frame_to_msg(frame: Frame):
    """driver ``Frame`` → python-can ``Message``."""
    assert can is not None  # callable only after import succeeded
    return can.Message(  # type: ignore[union-attr]
        arbitration_id=frame.can_id,
        is_extended_id=frame.extended,
        is_fd=frame.fd,
        bitrate_switch=frame.brs,
        error_state_indicator=frame.esi,
        is_remote_frame=frame.is_remote,
        is_error_frame=frame.is_error,
        data=frame.data,
        dlc=frame.dlc or len(frame.data),
    )


__all__ = ["PythonCanChannel", "PythonCanDriver"]
