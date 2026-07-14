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
        if interface == "pcan":
            _disable_pcan_status_frames(bus)
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
            raise TxRejected(f"FD frame on classic-mode bus {self.channel_id}")
        if frame.is_remote and self._fd:
            raise TxRejected(
                f"remote (RTR) frame not supported on FD-mode bus {self.channel_id}"
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
      hardware fills; we skip those.
    - ``channel_bus_capabilities`` — ``XL_BusCapabilities`` flags. We
      keep only channels whose ``XL_BUS_COMPATIBLE_CAN`` bit is set,
      which drops the non-CAN slots the XL driver enumerates next to
      the CAN ports — e.g. a VN1630A's on-board D/A I/O channel, which
      otherwise shows up as a bogus fifth "CAN" channel.
    - ``hw_channel`` — 0-based per-card channel number, and the open
      key python-can's vector backend wants as ``channel=``. The
      ``ch:`` in the id is this raw value; the *display* shows
      ``hw_channel + 1`` so the channel number matches the device's
      own 1-based "Channel N" label (the hardware silkscreen and
      Vector Hardware Config both count from 1).
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
    # ``XL_BUS_COMPATIBLE_CAN`` bit, used to keep only CAN channels.
    # Left at 0 if the lookup fails, in which case we don't filter on
    # bus capability — better to over-list than to hide a real channel.
    can_cap_mask = 0
    try:
        from can.interfaces.vector import xldefine  # type: ignore[import-untyped]

        fd_mask = int(
            getattr(
                xldefine.XL_ChannelCapabilities,
                "XL_CHANNEL_FLAG_CANFD_BOSCH_SUPPORT",
                0,
            )
        ) | int(
            getattr(
                xldefine.XL_ChannelCapabilities, "XL_CHANNEL_FLAG_CANFD_ISO_SUPPORT", 0
            )
        )
        can_cap_mask = int(
            getattr(
                getattr(xldefine, "XL_BusCapabilities", None),
                "XL_BUS_COMPATIBLE_CAN",
                0,
            )
        )
    except Exception:  # noqa: BLE001
        fd_mask = 0
        can_cap_mask = 0
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
        # Keep only CAN channels. A VN1630A enumerates its on-board
        # D/A I/O slot right after the CAN ports; it shares the CAN
        # ports' hardware type but its bus capability is DAIO, not CAN,
        # so without this it leaks through as a phantom CAN channel.
        # Skip the test only when we couldn't resolve the CAN bit or
        # the config doesn't report capabilities — never hide a channel
        # we can't classify.
        if can_cap_mask:
            bus_caps = getattr(cfg, "channel_bus_capabilities", None)
            if bus_caps is not None and not (int(bus_caps) & can_cap_mask):
                continue
        app_name = getattr(cfg, "name", None) or "vector"
        hw_channel = getattr(cfg, "hw_channel", None)
        if hw_channel is None:
            continue
        sn = getattr(cfg, "serial_number", None)
        sn_chunk = f"SN:{sn}, " if sn else ""
        # The id carries the raw 0-based ``hw_channel`` python-can opens
        # with; the display counts from 1 to match the device's own
        # channel labelling, so the two never disagree in front of the
        # user.
        cid = f"vector:{app_name}({sn_chunk}ch:{hw_channel})"
        label = f"Vector {app_name} ({sn_chunk}ch:{hw_channel + 1})"
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


def _pcan_read_int(api, handle, pcan_basic, *param_names: str, default: int = 0) -> int:
    """Read the first available integer PCAN-Basic parameter from
    ``param_names`` for ``handle``, unwrapping ctypes values. Returns
    ``default`` if none is present or readable."""
    for pname in param_names:
        param = getattr(pcan_basic, pname, None)
        if param is None:
            continue
        try:
            err, val = api.GetValue(handle, param)
        except Exception:  # noqa: BLE001
            continue
        if err == 0 and val is not None:
            return int(getattr(val, "value", val))
    return default


def _pcan_read_str(api, handle, pcan_basic, *param_names: str) -> str:
    """Read the first available string PCAN-Basic parameter from
    ``param_names`` for ``handle``, decoded to ``str``. Returns ``""``
    if none is present or readable."""
    for pname in param_names:
        param = getattr(pcan_basic, pname, None)
        if param is None:
            continue
        try:
            err, val = api.GetValue(handle, param)
        except Exception:  # noqa: BLE001
            continue
        if err == 0 and val:
            return _decode_pcan_bytes(val)
    return ""


def _list_pcan() -> List[Channel]:
    """PEAK PCAN-Basic channels.

    Channel *discovery* is delegated to python-can's own detector
    (:func:`can.detect_available_configs`). That call branches on the
    OS: on macOS the PCBUSB driver doesn't implement the bulk
    ``PCAN_ATTACHED_CHANNELS`` query (it returns PCAN_ERROR_ILLOPERATION),
    so python-can probes each candidate handle individually with
    ``PCAN_CHANNEL_CONDITION`` instead. Reimplementing that
    platform-specific probe here is what previously made PEAK adapters
    invisible on macOS — delegating keeps the single, maintained code
    path working on every OS.

    Each detected channel is then *enriched* with the identity metadata
    the GUI needs, via per-handle ``GetValue`` (which works uniformly on
    Windows/Linux/macOS): the ``controller_number`` (the per-card channel
    on multi-channel devices like PCAN-USB Pro FD), the user-settable
    ``device_id`` from PCAN-View (``uid:``), and the model name. The id
    body is the named slot constant (``PCAN_USBBUS1`` …) python-can
    reports and opens with; the paren metadata carries the raw hex
    handle, controller number, and device id.
    """
    if not _HAVE_PYTHON_CAN:
        return []
    try:
        from can.interfaces.pcan import basic as pcan_basic  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    PCANBasic = getattr(pcan_basic, "PCANBasic", None)
    if PCANBasic is None:
        return []
    try:
        detected = can.detect_available_configs(interfaces=["pcan"])
        api = PCANBasic()
    except Exception as e:  # noqa: BLE001
        _log.info("pcan enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for cfg in detected:
        # `channel` is the slot constant name python-can opens with
        # (e.g. "PCAN_USBBUS1"); resolve it back to the numeric handle
        # for the per-handle enrichment reads and the `h:` metadata.
        name = cfg.get("channel")
        if not isinstance(name, str):
            continue
        handle = getattr(pcan_basic, name, None)
        if handle is None:
            continue
        handle_int = int(getattr(handle, "value", handle))

        ctrl = _pcan_read_int(api, handle, pcan_basic, "PCAN_CONTROLLER_NUMBER")
        dev_id = _pcan_read_int(
            api, handle, pcan_basic, "PCAN_DEVICE_ID", "PCAN_DEVICE_NUMBER"
        )
        model = _pcan_read_str(api, handle, pcan_basic, "PCAN_HARDWARE_NAME") or "PCAN"

        # `uid:` is the user-settable PCAN-View device id. It's always
        # shown, including the factory-default 0 — having it always
        # present makes the format predictable and tells the user
        # whether anyone has set a non-zero id on this adapter.
        meta = [f"h:0x{handle_int:X}", f"ch:{ctrl}", f"uid:{dev_id}"]
        meta_str = ", ".join(meta)

        # The display prepends the named slot to the meta list, so the
        # user sees both "which port" (slot) and the underlying handle
        # integer / controller in one paren group.
        display_meta = f"{name}, {meta_str}"

        cid = f"pcan:{name}({meta_str})"
        label = f"PEAK {model} ({display_meta})"
        out.append(
            Channel(
                id=cid,
                display_name=label,
                fd_capable=bool(cfg.get("supports_fd", False)),
            )
        )
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


#: ``f_clock`` value passed to :meth:`BitTimingFd.from_sample_point`.
#: 80 MHz is the only value accepted by every FD-capable backend we
#: support (PEAK, Kvaser, Vector all advertise 80 MHz as a valid
#: CAN-FD reference clock).
_FD_F_CLOCK_HZ = 80_000_000

#: Default sample point percentage for the nominal (arbitration) phase
#: when the user hasn't pinned bit-level timing. 80 % matches the
#: CiA-recommended midpoint for 500 kbps – 1 Mbps and is the value
#: python-can's own ``Bus`` constructor implicitly aims for.
_FD_NOM_SAMPLE_POINT_PCT = 80

#: Default data-phase sample point percentage. 70 % is a CiA-recommended
#: value for the faster data phase where ringing matters more.
_FD_DATA_SAMPLE_POINT_PCT = 70

#: Nominal bitrate used when FD is enabled but no ``bitrate_bps`` is
#: configured. Pinned to 500 kbps (the python-can default for classic
#: buses) so an FD-enabled bus opened from a project with no explicit
#: bitrate still has *some* sensible value to compute timing against.
_FD_DEFAULT_NOMINAL_BITRATE_BPS = 500_000


def _bus_kwargs_for(channel_id: str, config: OpenConfig):
    """Translate ``vendor:<body>(<meta>)`` + ``OpenConfig`` into the
    arguments python-can's ``Bus`` constructor takes.

    The paren metadata is identity information for the GUI — the open
    path only needs the body plus, for Vector, the ``ch:`` field from
    the parens (since python-can's ``vector`` backend wants ``app_name``
    and ``channel`` as separate kwargs).

    FD configuration is normalised to a :class:`can.BitTimingFd` via
    :meth:`BitTimingFd.from_sample_point`. Routing through ``timing=``
    rather than ``fd=True`` + ``data_bitrate=N`` matters for PEAK: its
    python-can backend has no ``data_bitrate`` kwarg, so the only way
    to pick a data-phase rate uniformly across PEAK, Kvaser, and
    Vector is to hand all three a fully-computed BitTimingFd instance.
    """
    vendor, _, rest = channel_id.partition(":")
    body, meta = _split_meta(rest)
    common = {}
    if config.fd:
        common["timing"] = _build_fd_timing(config)
    elif config.bitrate_bps is not None:
        common["bitrate"] = config.bitrate_bps
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


def _disable_pcan_status_frames(bus) -> None:
    """Turn off PCAN-Basic's status-frame queue immediately after open.

    PCAN-Basic emits side-band notifications (channel initialised,
    bus-light, bus-heavy, bus-passive, ...) as queued "status frames"
    whose ``MSGTYPE`` has the ``PCAN_MESSAGE_STATUS`` bit set. python-can's
    PCAN backend reads ``MSGTYPE`` for the bits it knows about
    (``EXTENDED`` / ``RTR`` / ``FD`` / ``ECHO`` / ``BRS`` / ``ESI`` /
    ``ERRFRAME``) but never branches on ``STATUS``, so the status frame
    is built into a regular :class:`can.Message` with ``arbitration_id =
    pcan_msg.ID`` (a small status code, typically 1), ``dlc = 4``, and
    the 4-byte status word as payload. The result is indistinguishable
    from a real ``can_id=1, dlc=4`` wire frame.

    PCAN-Basic exposes the same fault-confinement information through
    ``CAN_GetStatus``, which the sidecar already polls every 500 ms (see
    :class:`cannet_python_can.server._SharedInterface._state_pump`), so
    disabling the queued status frames loses no observable signal — it
    only stops the synthetic frame.
    """
    from can.interfaces.pcan.basic import (  # type: ignore[import-untyped]
        PCAN_ALLOW_STATUS_FRAMES,
        PCAN_PARAMETER_OFF,
    )

    bus.m_objPCANBasic.SetValue(
        bus.m_PcanHandle,
        PCAN_ALLOW_STATUS_FRAMES,
        PCAN_PARAMETER_OFF,
    )


def _build_fd_timing(config: OpenConfig):
    """Build a :class:`can.BitTimingFd` from an FD-enabled
    :class:`OpenConfig`. The data-phase rate defaults to the nominal
    rate when unset (matching python-can's classic ``data_bitrate``
    fallback). Nominal defaults to :data:`_FD_DEFAULT_NOMINAL_BITRATE_BPS`
    when unset so the FD-mode open path always has *some* value to
    compute timing against.
    """
    from can import BitTimingFd  # type: ignore[import-untyped]

    nom_bps = config.bitrate_bps or _FD_DEFAULT_NOMINAL_BITRATE_BPS
    data_bps = config.data_bitrate_bps or nom_bps
    return BitTimingFd.from_sample_point(
        f_clock=_FD_F_CLOCK_HZ,
        nom_bitrate=int(nom_bps),
        nom_sample_point=_FD_NOM_SAMPLE_POINT_PCT,
        data_bitrate=int(data_bps),
        data_sample_point=_FD_DATA_SAMPLE_POINT_PCT,
    )


#: Hardware timestamps further than this from the current wall clock
#: are treated as garbage and replaced with the wall-clock fallback.
#: Generous enough for any real buffering delay or clock skew; tight
#: enough to reject driver garbage (PEAK's macOS PCBUSB library has
#: been seen handing python-can classic-CAN timestamps millennia in
#: the future, which overflow the wire format's uint64 ns field).
_TS_PLAUSIBLE_SLACK_S = 86_400.0


def _msg_to_frame(msg) -> Frame:
    """python-can ``Message`` → driver ``Frame``.

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
