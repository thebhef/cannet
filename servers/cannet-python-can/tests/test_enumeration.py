"""Tests for the vendor enumeration helpers in :mod:`driver_python_can`.

The helpers do their vendor SDK ``from ... import ...`` inside the
function body, so we can substitute the SDKs by injecting fake modules
into ``sys.modules`` before calling them. This keeps the tests
hardware-free and side-effect-free.

What we lock down here:

- The ``Channel.id`` grammar — vendor-prefixed body with a paren
  ``key:value`` metadata list (``vector:VN1630A(SN:12345, ch:0)``).
- ``display_name`` includes the same paren chunk, dropping ``SN:``
  when the card doesn't report a serial.
- Two physically identical devices with different serials produce
  different ids and different labels (the regression that prevented a
  user from binding both PCAN-USBs to separate logical buses).
- ``_list_vector`` skips ``XL_HWTYPE_NONE`` slots so a 4-channel
  VN1630A doesn't show up as 6.
- ``_bus_kwargs_for`` round-trips the paren grammar, opening Vector
  via ``serial=`` so python-can never calls ``xlGetApplConfig``.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


# ---- Fake-module helpers ----------------------------------------------------


def _install_fake_module(name: str, attrs: dict) -> None:
    """Plant a synthetic module under *name* with the given attributes.

    Restore via :func:`_remove_fake_modules`.
    """
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod


def _remove_fake_modules(*names: str) -> None:
    for n in names:
        sys.modules.pop(n, None)


def _fresh_driver_module():
    """Reimport ``driver_python_can`` so module-level ``import can``
    state doesn't surprise us across tests."""
    import cannet_python_can.driver_python_can as m  # noqa: WPS433

    return importlib.reload(m)


# ---- Vector ----------------------------------------------------------------


class _VectorCfg:
    """Subset of ``VectorChannelConfig`` (a NamedTuple in real life)
    the enumerator reads. ``channel_capabilities`` is an int bitmask
    holding ``XL_ChannelCapabilities`` flags. ``hw_type`` defaults to a
    non-zero value so tests that don't set it aren't filtered as
    XL_HWTYPE_NONE slots."""

    def __init__(
        self,
        name,
        hw_channel,
        serial_number=None,
        channel_capabilities=0,
        hw_type=10,
    ):
        self.name = name
        self.hw_channel = hw_channel
        self.serial_number = serial_number
        self.channel_capabilities = channel_capabilities
        self.hw_type = hw_type


# Match the real XL_ChannelCapabilities flag values.
_XL_CANFD_BOSCH = 0x20000000
_XL_CANFD_ISO = 0x80000000


def _install_fake_vector(configs):
    mod_root = types.ModuleType("can.interfaces.vector")
    mod_canlib = types.ModuleType("can.interfaces.vector.canlib")
    mod_canlib.get_channel_configs = lambda: list(configs)
    sys.modules["can.interfaces.vector"] = mod_root
    sys.modules["can.interfaces.vector.canlib"] = mod_canlib

    # Provide a minimal xldefine.XL_ChannelCapabilities surface so the
    # enumerator's lazy import sees the same constants the real
    # library exposes.
    mod_xldefine = types.ModuleType("can.interfaces.vector.xldefine")

    class _Caps:
        XL_CHANNEL_FLAG_CANFD_BOSCH_SUPPORT = _XL_CANFD_BOSCH
        XL_CHANNEL_FLAG_CANFD_ISO_SUPPORT = _XL_CANFD_ISO

    mod_xldefine.XL_ChannelCapabilities = _Caps
    sys.modules["can.interfaces.vector.xldefine"] = mod_xldefine


def _uninstall_fake_vector() -> None:
    _remove_fake_modules(
        "can.interfaces.vector",
        "can.interfaces.vector.canlib",
        "can.interfaces.vector.xldefine",
    )


def test_vector_includes_serial_in_id_and_label() -> None:
    _install_fake_vector(
        [
            _VectorCfg("VN1640A", 0, serial_number=12345, channel_capabilities=_XL_CANFD_ISO),
            _VectorCfg("VN1640A", 1, serial_number=12345),
        ]
    )
    try:
        m = _fresh_driver_module()
        chans = m._list_vector()
        assert len(chans) == 2
        ids = sorted(c.id for c in chans)
        assert ids == [
            "vector:VN1640A(SN:12345, ch:0)",
            "vector:VN1640A(SN:12345, ch:1)",
        ]
        labels = sorted(c.display_name for c in chans)
        assert labels == [
            "Vector VN1640A (SN:12345, ch:0)",
            "Vector VN1640A (SN:12345, ch:1)",
        ]
        # First channel is FD-capable per the ISO flag in our fake.
        assert any(c.fd_capable for c in chans)
        assert not all(c.fd_capable for c in chans)
    finally:
        _uninstall_fake_vector()


def test_vector_omits_sn_chunk_when_serial_missing() -> None:
    _install_fake_vector([_VectorCfg("VN1640A", 0, serial_number=None)])
    try:
        m = _fresh_driver_module()
        chans = m._list_vector()
        assert len(chans) == 1
        assert chans[0].id == "vector:VN1640A(ch:0)"
        assert chans[0].display_name == "Vector VN1640A (ch:0)"
    finally:
        _uninstall_fake_vector()


def test_vector_skips_hw_type_none_slots() -> None:
    """The Vector XL driver pre-allocates channel slots and reports the
    unfilled ones with ``hw_type == XL_HWTYPE_NONE`` (0). A 4-channel
    VN1630A shows up alongside two such phantom slots; the enumerator
    must drop the phantoms so the GUI lists exactly four real
    channels."""
    _install_fake_vector(
        [
            _VectorCfg("VN1630A", 0, serial_number=12345, hw_type=10),
            _VectorCfg("VN1630A", 1, serial_number=12345, hw_type=10),
            _VectorCfg("VN1630A", 2, serial_number=12345, hw_type=10),
            _VectorCfg("VN1630A", 3, serial_number=12345, hw_type=10),
            _VectorCfg("", 4, serial_number=None, hw_type=0),
            _VectorCfg("", 5, serial_number=None, hw_type=0),
        ]
    )
    try:
        m = _fresh_driver_module()
        chans = m._list_vector()
        assert len(chans) == 4
        assert {c.id for c in chans} == {
            "vector:VN1630A(SN:12345, ch:0)",
            "vector:VN1630A(SN:12345, ch:1)",
            "vector:VN1630A(SN:12345, ch:2)",
            "vector:VN1630A(SN:12345, ch:3)",
        }
    finally:
        _uninstall_fake_vector()


def test_vector_two_identical_devices_disambiguate_by_serial() -> None:
    _install_fake_vector(
        [
            _VectorCfg("VN1640A", 0, serial_number=111),
            _VectorCfg("VN1640A", 0, serial_number=222),
        ]
    )
    try:
        m = _fresh_driver_module()
        chans = m._list_vector()
        ids = sorted(c.id for c in chans)
        assert ids == [
            "vector:VN1640A(SN:111, ch:0)",
            "vector:VN1640A(SN:222, ch:0)",
        ]
        # Labels differ too — the user can tell which device is which.
        assert len({c.display_name for c in chans}) == 2
    finally:
        _uninstall_fake_vector()


# ---- Kvaser ----------------------------------------------------------------


class _KvaserChannelData:
    def __init__(self, device_name, card_serial_no, channel_no_on_card):
        self.device_name = device_name
        self.card_serial_no = card_serial_no
        self.channel_no_on_card = channel_no_on_card


def _install_fake_kvaser(per_index):
    """`per_index` maps the global index -> _KvaserChannelData."""
    mod_canlib_pkg = types.ModuleType("canlib")
    mod_canlib = types.ModuleType("canlib.canlib")
    mod_canlib.getNumberOfChannels = lambda: len(per_index)
    mod_canlib.ChannelData = lambda i: per_index[i]
    mod_canlib_pkg.canlib = mod_canlib
    sys.modules["canlib"] = mod_canlib_pkg
    sys.modules["canlib.canlib"] = mod_canlib


def test_kvaser_includes_serial_and_per_card_channel() -> None:
    _install_fake_kvaser(
        [
            _KvaserChannelData("Memorator Pro 2xHS v2", 67890, 0),
            _KvaserChannelData("Memorator Pro 2xHS v2", 67890, 1),
        ]
    )
    try:
        m = _fresh_driver_module()
        chans = m._list_kvaser()
        assert len(chans) == 2
        assert chans[0].id == "kvaser:0(SN:67890, ch:0)"
        assert chans[1].id == "kvaser:1(SN:67890, ch:1)"
        assert chans[0].display_name == (
            "Kvaser Memorator Pro 2xHS v2 (SN:67890, ch:0)"
        )
        assert chans[1].display_name == (
            "Kvaser Memorator Pro 2xHS v2 (SN:67890, ch:1)"
        )
    finally:
        _remove_fake_modules("canlib", "canlib.canlib")


def test_kvaser_omits_sn_chunk_when_serial_missing() -> None:
    _install_fake_kvaser([_KvaserChannelData("Leaf Light v2", 0, 0)])
    try:
        m = _fresh_driver_module()
        chans = m._list_kvaser()
        assert chans[0].id == "kvaser:0(ch:0)"
        assert chans[0].display_name == "Kvaser Leaf Light v2 (ch:0)"
    finally:
        _remove_fake_modules("canlib", "canlib.canlib")


# ---- PCAN -------------------------------------------------------------------


class _PcanInfo:
    """Mirrors the subset of ``TPCANChannelInformation`` the enumerator
    reads. Notably absent: there is no ``channel_name`` attribute on
    the real struct, and ``device_name`` is a bytes buffer."""

    def __init__(
        self,
        channel_handle: int,
        device_name=b"PCAN-USB FD",
        device_id: int = 0,
        controller_number: int = 0,
    ):
        self.channel_handle = channel_handle
        self.device_name = device_name
        self.device_id = device_id
        self.controller_number = controller_number


def _install_fake_pcan(channels):
    PCAN_ATTACHED_CHANNELS = object()

    class _Api:
        def GetValue(self, handle, what):  # noqa: N802 - matches PCANBasic
            if what is PCAN_ATTACHED_CHANNELS:
                return (0, list(channels))
            return (1, None)

    mod_pcan = types.ModuleType("can.interfaces.pcan")
    mod_basic = types.ModuleType("can.interfaces.pcan.basic")
    mod_basic.PCANBasic = _Api
    mod_basic.PCAN_ATTACHED_CHANNELS = PCAN_ATTACHED_CHANNELS
    # Plant the standard USB bus handle constants so the reverse
    # lookup in _pcan_handle_name can find them.
    for i in range(1, 9):
        setattr(mod_basic, f"PCAN_USBBUS{i}", 0x50 + i)
    sys.modules["can.interfaces.pcan"] = mod_pcan
    sys.modules["can.interfaces.pcan.basic"] = mod_basic


def test_pcan_two_factory_default_devices_get_distinct_ids() -> None:
    """The regression we're fixing: two PCAN-USB FDs at handles
    PCAN_USBBUS1 / PCAN_USBBUS2, both with factory-default ``device_id=0``,
    must produce distinct ids (and visibly distinct labels) so the
    GUI's one-bus-per-interface constraint doesn't block the second.
    The id body is the named slot constant (so python-can can open it
    via the same string it always has); the paren metadata carries
    the raw hex handle and the controller number."""
    chs = [
        _PcanInfo(channel_handle=0x51, device_name=b"PCAN-USB FD"),
        _PcanInfo(channel_handle=0x52, device_name=b"PCAN-USB FD"),
    ]
    _install_fake_pcan(chs)
    try:
        m = _fresh_driver_module()
        chans = m._list_pcan()
        assert len(chans) == 2
        ids = sorted(c.id for c in chans)
        assert ids == [
            "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:0)",
            "pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:0)",
        ]
        labels = sorted(c.display_name for c in chans)
        assert labels == [
            "PEAK PCAN-USB FD (PCAN_USBBUS1, h:0x51, ch:0, uid:0)",
            "PEAK PCAN-USB FD (PCAN_USBBUS2, h:0x52, ch:0, uid:0)",
        ]
    finally:
        _remove_fake_modules("can.interfaces.pcan", "can.interfaces.pcan.basic")


def test_pcan_device_id_set_by_user_appears_in_id_paren_list_and_label() -> None:
    chs = [
        _PcanInfo(
            channel_handle=0x51,
            device_name=b"PCAN-USB FD",
            device_id=42,
            controller_number=0,
        ),
    ]
    _install_fake_pcan(chs)
    try:
        m = _fresh_driver_module()
        chans = m._list_pcan()
        assert len(chans) == 1
        assert chans[0].id == "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:42)"
        assert chans[0].display_name == (
            "PEAK PCAN-USB FD (PCAN_USBBUS1, h:0x51, ch:0, uid:42)"
        )
    finally:
        _remove_fake_modules("can.interfaces.pcan", "can.interfaces.pcan.basic")


def test_pcan_unknown_handle_falls_back_to_hex_body() -> None:
    """If the handle doesn't match any planted PCAN_*BUS constant, the
    id body uses a stable hex fallback rather than colliding on a
    default name; the paren list still carries the same hex handle."""
    chs = [_PcanInfo(channel_handle=0xFF, device_name=b"PCAN-Mystery")]
    _install_fake_pcan(chs)
    try:
        m = _fresh_driver_module()
        chans = m._list_pcan()
        assert chans[0].id == "pcan:handle=0xFF(h:0xFF, ch:0, uid:0)"
        # No named slot for this handle → the display drops the
        # would-be slot prefix and shows just the paren metadata.
        assert chans[0].display_name == (
            "PEAK PCAN-Mystery (h:0xFF, ch:0, uid:0)"
        )
    finally:
        _remove_fake_modules("can.interfaces.pcan", "can.interfaces.pcan.basic")


# ---- _bus_kwargs_for round-trip --------------------------------------------


def test_bus_kwargs_for_parses_paren_metadata() -> None:
    from cannet_python_can.driver import OpenConfig

    m = _fresh_driver_module()
    cfg = OpenConfig(bitrate_bps=500_000)

    # Vector with a serial: open by ``serial=`` + ``channel=hw_channel``
    # so python-can's vector backend bypasses ``xlGetApplConfig`` and
    # never trips over an unmapped Vector-Hardware-Config slot.
    assert m._bus_kwargs_for("vector:VN1630A(SN:12345, ch:0)", cfg) == (
        "vector",
        {"serial": 12345, "channel": 0, "bitrate": 500_000},
    )
    # Vector with no serial (XL virtual bus): fall back to app_name.
    assert m._bus_kwargs_for("vector:Virtual(ch:1)", cfg) == (
        "vector",
        {"app_name": "Virtual", "channel": 1, "bitrate": 500_000},
    )
    assert m._bus_kwargs_for("kvaser:3(SN:67890, ch:1)", cfg) == (
        "kvaser",
        {"channel": 3, "bitrate": 500_000},
    )
    assert m._bus_kwargs_for("pcan:PCAN_USBBUS1(h:0x51, ch:0)", cfg) == (
        "pcan",
        {"channel": "PCAN_USBBUS1", "bitrate": 500_000},
    )
    assert m._bus_kwargs_for(
        "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:42)", cfg
    ) == ("pcan", {"channel": "PCAN_USBBUS1", "bitrate": 500_000})
    # PCAN unknown-handle fallback parses to int for python-can.
    assert m._bus_kwargs_for("pcan:handle=0xFF(h:0xFF, ch:0)", cfg) == (
        "pcan",
        {"channel": 0xFF, "bitrate": 500_000},
    )
