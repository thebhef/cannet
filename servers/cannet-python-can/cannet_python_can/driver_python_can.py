"""Default :mod:`cannet_python_can.driver` implementation, backed by
``python-can``.

Designed so the *module* imports cleanly even when ``python-can`` is
absent — the sidecar must boot and report zero interfaces on a
machine with no vendor SDK installed. The import fallback is checked
at module load; everything else degrades to "no channels available".

Vendor enumeration:

- **Vector** — ``can.interfaces.vector.canlib.get_channel_configs``;
  channels are returned as ``vector:<hw_name>/ch<hw_channel>``.
- **Kvaser** — ``canlib.canlib`` (``getNumberOfChannels`` +
  ``ChannelData``); channels are returned as ``kvaser:<n>``.
- **PEAK** — ``can.interfaces.pcan.basic.PCANBasic``; channels are
  returned as ``pcan:<channel_name>``.

If a vendor's SDK isn't installed on the host, that vendor simply
contributes zero channels and a one-line info log; the other vendors
still enumerate. The wire-level surface stays vendor-agnostic.
"""

from __future__ import annotations

import logging
import time
from typing import Iterable, List, Optional

from .driver import Channel, Frame, OpenChannel, OpenConfig, TxRejected

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
            channel_id=channel_id, bus=bus, listen_only=config.listen_only
        )


class PythonCanChannel:
    """One opened ``python-can`` ``Bus`` plus a small recv/send wrapper."""

    def __init__(self, *, channel_id: str, bus: object, listen_only: bool) -> None:
        self.channel_id = channel_id
        self._bus = bus
        self._listen_only = listen_only
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
        msg = _frame_to_msg(frame)
        try:
            self._bus.send(msg)  # type: ignore[attr-defined]
        except Exception as e:  # noqa: BLE001
            raise TxRejected(str(e)) from e

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
    """Vector XL channels via python-can's ``vector`` backend."""
    try:
        from can.interfaces.vector import canlib as vector_canlib  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
        return []
    try:
        configs = vector_canlib.get_channel_configs()
    except Exception as e:  # noqa: BLE001
        _log.info("vector enumeration failed (%s); skipping", e)
        return []
    out: List[Channel] = []
    for cfg in configs or []:
        hw_name = getattr(cfg, "hw_name", None) or getattr(cfg, "name", "vector")
        hw_channel = getattr(cfg, "hw_channel", None)
        if hw_channel is None:
            continue
        cid = f"vector:{hw_name}/ch{hw_channel}"
        fd = bool(getattr(cfg, "can_fd_conf", None))
        out.append(
            Channel(id=cid, display_name=f"Vector {hw_name} ch{hw_channel}", fd_capable=fd)
        )
    return out


def _list_kvaser() -> List[Channel]:
    """Kvaser CANlib channels."""
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
            name = kvaser.ChannelData(i).device_name
        except Exception:  # noqa: BLE001
            name = f"Kvaser ch{i}"
        out.append(Channel(id=f"kvaser:{i}", display_name=f"{name} ch{i}", fd_capable=True))
    return out


def _list_pcan() -> List[Channel]:
    """PEAK PCAN-Basic channels."""
    try:
        from can.interfaces.pcan.basic import PCANBasic, PCAN_ATTACHED_CHANNELS  # type: ignore[import-untyped]
    except Exception:  # noqa: BLE001
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
        name = getattr(ch, "channel_name", None) or "PCAN_USBBUS1"
        out.append(Channel(id=f"pcan:{name}", display_name=f"PEAK {name}", fd_capable=True))
    return out


def _bus_kwargs_for(channel_id: str, config: OpenConfig):
    """Translate ``vendor:<rest>`` + ``OpenConfig`` to python-can kwargs."""
    vendor, _, rest = channel_id.partition(":")
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
        hw_name, _, ch = rest.partition("/ch")
        return ("vector", {"app_name": hw_name, "channel": int(ch), **common})
    if vendor == "kvaser":
        return ("kvaser", {"channel": int(rest), **common})
    if vendor == "pcan":
        return ("pcan", {"channel": rest, **common})
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
