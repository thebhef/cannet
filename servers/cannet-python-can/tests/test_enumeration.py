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
- ``_list_vector`` skips ``XL_HWTYPE_NONE`` slots and non-CAN slots
  (e.g. a VN1630A's on-board D/A I/O channel) so a 4-channel VN1630A
  lists exactly four CAN channels, numbered to match the device's own
  1-based "Channel N" labels.
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


# Match the real XL_ChannelCapabilities flag values.
_XL_CANFD_BOSCH = 0x20000000
_XL_CANFD_ISO = 0x80000000

# Match the real XL_BusCapabilities flag values.
_XL_BUS_COMPATIBLE_CAN = 1
_XL_BUS_COMPATIBLE_DAIO = 64


class _VectorCfg:
    """Subset of ``VectorChannelConfig`` (a NamedTuple in real life)
    the enumerator reads. ``channel_capabilities`` is an int bitmask
    holding ``XL_ChannelCapabilities`` flags. ``hw_type`` defaults to a
    non-zero value so tests that don't set it aren't filtered as
    XL_HWTYPE_NONE slots. ``channel_bus_capabilities`` defaults to a
    CAN-compatible bitmask so tests that don't set it aren't filtered
    as non-CAN slots."""

    def __init__(
        self,
        name,
        hw_channel,
        serial_number=None,
        channel_capabilities=0,
        hw_type=10,
        channel_bus_capabilities=_XL_BUS_COMPATIBLE_CAN,
    ):
        self.name = name
        self.hw_channel = hw_channel
        self.serial_number = serial_number
        self.channel_capabilities = channel_capabilities
        self.hw_type = hw_type
        self.channel_bus_capabilities = channel_bus_capabilities


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

    class _BusCaps:
        XL_BUS_COMPATIBLE_CAN = _XL_BUS_COMPATIBLE_CAN

    mod_xldefine.XL_ChannelCapabilities = _Caps
    mod_xldefine.XL_BusCapabilities = _BusCaps
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
            _VectorCfg(
                "VN1640A", 0, serial_number=12345, channel_capabilities=_XL_CANFD_ISO
            ),
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
        # Display counts channels from 1 (the device's own labelling),
        # so hw_channel 0/1 read as ch:1/ch:2 — while the ids above keep
        # the raw 0-based hw_channel python-can opens with.
        labels = sorted(c.display_name for c in chans)
        assert labels == [
            "Vector VN1640A (SN:12345, ch:1)",
            "Vector VN1640A (SN:12345, ch:2)",
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
        assert chans[0].display_name == "Vector VN1640A (ch:1)"
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


def test_vector_skips_non_can_channels() -> None:
    """A VN1630A enumerates its four CAN ports plus an on-board D/A I/O
    channel that shares the CAN ports' hardware type but reports a DAIO
    bus capability with no CAN bit. The enumerator must drop it so the
    GUI doesn't offer a fifth, un-openable "CAN" channel — and must
    keep the I/O channel's index from shifting the CAN ports' numbers
    (here the I/O channel is hw_channel 4, displayed as the would-be
    ch:5)."""
    _install_fake_vector(
        [
            _VectorCfg("VN1630A Channel 1", 0, serial_number=585855),
            _VectorCfg("VN1630A Channel 2", 1, serial_number=585855),
            _VectorCfg("VN1630A Channel 3", 2, serial_number=585855),
            _VectorCfg("VN1630A Channel 4", 3, serial_number=585855),
            _VectorCfg(
                "VN1630A Channel 5",
                4,
                serial_number=585855,
                channel_bus_capabilities=_XL_BUS_COMPATIBLE_DAIO,
            ),
        ]
    )
    try:
        m = _fresh_driver_module()
        chans = m._list_vector()
        assert len(chans) == 4
        assert {c.id for c in chans} == {
            "vector:VN1630A Channel 1(SN:585855, ch:0)",
            "vector:VN1630A Channel 2(SN:585855, ch:1)",
            "vector:VN1630A Channel 3(SN:585855, ch:2)",
            "vector:VN1630A Channel 4(SN:585855, ch:3)",
        }
        # 1-based display matches each port's own "Channel N" name.
        assert {c.display_name for c in chans} == {
            "Vector VN1630A Channel 1 (SN:585855, ch:1)",
            "Vector VN1630A Channel 2 (SN:585855, ch:2)",
            "Vector VN1630A Channel 3 (SN:585855, ch:3)",
            "Vector VN1630A Channel 4 (SN:585855, ch:4)",
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


def _install_fake_pcan(devices, detected=None):
    """Plant a fake PCAN-Basic module and stub python-can's channel
    detector.

    ``devices`` maps a channel handle int (e.g. ``0x51``) to a dict with
    optional keys ``controller``, ``device_id``, ``hardware_name``
    (bytes), and ``supports_fd``. The fake ``PCANBasic`` answers
    per-handle ``GetValue`` for those fields — mirroring how the
    enumerator enriches each detected channel (and how the macOS PCBUSB
    driver *does* support per-handle reads even though it rejects the
    bulk ``PCAN_ATTACHED_CHANNELS`` query).

    The stubbed ``can.detect_available_configs`` reports one channel per
    device by default; pass ``detected`` to override the reported list.
    Notably, this fake exposes **no** ``PCAN_ATTACHED_CHANNELS`` attribute
    — the enumerator must not depend on it.

    Returns the original ``can.detect_available_configs`` for restoration
    via :func:`_uninstall_fake_pcan`.
    """
    import can  # noqa: WPS433

    PCAN_CONTROLLER_NUMBER = "controller_number"
    PCAN_DEVICE_ID = "device_id"
    PCAN_HARDWARE_NAME = "hardware_name"

    class _Api:
        def GetValue(self, handle, what):  # noqa: N802 - matches PCANBasic
            h = int(getattr(handle, "value", handle))
            dev = devices.get(h)
            if dev is None:
                return (1, None)
            if what == PCAN_CONTROLLER_NUMBER:
                return (0, dev.get("controller", 0))
            if what == PCAN_DEVICE_ID:
                return (0, dev.get("device_id", 0))
            if what == PCAN_HARDWARE_NAME:
                return (0, dev.get("hardware_name", b"PCAN"))
            return (1, None)

    mod_pcan = types.ModuleType("can.interfaces.pcan")
    mod_basic = types.ModuleType("can.interfaces.pcan.basic")
    mod_basic.PCANBasic = _Api
    mod_basic.PCAN_CONTROLLER_NUMBER = PCAN_CONTROLLER_NUMBER
    mod_basic.PCAN_DEVICE_ID = PCAN_DEVICE_ID
    mod_basic.PCAN_HARDWARE_NAME = PCAN_HARDWARE_NAME
    # Plant the standard USB bus handle constants so a channel name
    # ("PCAN_USBBUS1") reported by the detector resolves back to its
    # handle int.
    handle_to_name = {}
    for i in range(1, 9):
        val = 0x50 + i
        setattr(mod_basic, f"PCAN_USBBUS{i}", val)
        handle_to_name[val] = f"PCAN_USBBUS{i}"
    sys.modules["can.interfaces.pcan"] = mod_pcan
    sys.modules["can.interfaces.pcan.basic"] = mod_basic

    if detected is None:
        detected = [
            {
                "interface": "pcan",
                "channel": handle_to_name[h],
                "supports_fd": dev.get("supports_fd", False),
            }
            for h, dev in devices.items()
        ]
    original = can.detect_available_configs
    can.detect_available_configs = lambda interfaces=None: list(detected)
    return original


def _uninstall_fake_pcan(original_detect) -> None:
    import can  # noqa: WPS433

    can.detect_available_configs = original_detect
    _remove_fake_modules("can.interfaces.pcan", "can.interfaces.pcan.basic")


def test_pcan_enumerates_via_python_can_detector() -> None:
    """Regression (macOS): the PCBUSB driver doesn't implement the bulk
    ``PCAN_ATTACHED_CHANNELS`` query — it returns PCAN_ERROR_ILLOPERATION
    — so an enumerator that relies on that call finds zero channels on a
    Mac even with a PEAK adapter plugged in. Discovery is delegated to
    python-can's detector (which probes each handle individually on
    Darwin); the enumerator surfaces what it reports and enriches it via
    per-handle GetValue. The fake here exposes no ATTACHED_CHANNELS
    surface at all, so this only passes if the enumerator doesn't use
    it."""
    original = _install_fake_pcan(
        {0x51: {"hardware_name": b"PCAN-USB", "controller": 0, "device_id": 14}}
    )
    try:
        m = _fresh_driver_module()
        import can.interfaces.pcan.basic as basic  # noqa: WPS433

        assert not hasattr(basic, "PCAN_ATTACHED_CHANNELS")
        chans = m._list_pcan()
        assert len(chans) == 1
        assert chans[0].id == "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:14)"
        assert chans[0].display_name == (
            "PEAK PCAN-USB (PCAN_USBBUS1, h:0x51, ch:0, uid:14)"
        )
        assert chans[0].fd_capable is False
    finally:
        _uninstall_fake_pcan(original)


def test_pcan_two_factory_default_devices_get_distinct_ids() -> None:
    """Two PCAN-USB FDs at handles PCAN_USBBUS1 / PCAN_USBBUS2, both with
    factory-default ``device_id=0``, must produce distinct ids (and
    visibly distinct labels) so the GUI's one-bus-per-interface
    constraint doesn't block the second. The id body is the named slot
    constant (so python-can can open it via the same string it always
    has); the paren metadata carries the raw hex handle and the
    controller number."""
    original = _install_fake_pcan(
        {
            0x51: {"hardware_name": b"PCAN-USB FD", "supports_fd": True},
            0x52: {"hardware_name": b"PCAN-USB FD", "supports_fd": True},
        }
    )
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
        _uninstall_fake_pcan(original)


def test_pcan_device_id_set_by_user_appears_in_id_paren_list_and_label() -> None:
    original = _install_fake_pcan(
        {0x51: {"hardware_name": b"PCAN-USB FD", "device_id": 42}}
    )
    try:
        m = _fresh_driver_module()
        chans = m._list_pcan()
        assert len(chans) == 1
        assert chans[0].id == "pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:42)"
        assert chans[0].display_name == (
            "PEAK PCAN-USB FD (PCAN_USBBUS1, h:0x51, ch:0, uid:42)"
        )
    finally:
        _uninstall_fake_pcan(original)


def test_pcan_fd_capability_follows_detector() -> None:
    """``fd_capable`` reflects python-can's own ``supports_fd``
    determination rather than being assumed true — a classic PCAN-USB is
    not FD-capable."""
    original = _install_fake_pcan(
        {
            0x51: {"hardware_name": b"PCAN-USB", "supports_fd": False},
            0x52: {"hardware_name": b"PCAN-USB FD", "supports_fd": True},
        }
    )
    try:
        m = _fresh_driver_module()
        chans = {c.id: c for c in m._list_pcan()}
        assert chans["pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:0)"].fd_capable is False
        assert chans["pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:0)"].fd_capable is True
    finally:
        _uninstall_fake_pcan(original)


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
    assert m._bus_kwargs_for("pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:42)", cfg) == (
        "pcan",
        {"channel": "PCAN_USBBUS1", "bitrate": 500_000},
    )
    # PCAN unknown-handle fallback parses to int for python-can.
    assert m._bus_kwargs_for("pcan:handle=0xFF(h:0xFF, ch:0)", cfg) == (
        "pcan",
        {"channel": 0xFF, "bitrate": 500_000},
    )


def test_bus_kwargs_for_fd_routes_through_bit_timing() -> None:
    """FD configuration is normalised to a ``BitTimingFd`` and passed
    via ``timing=`` for every backend — PEAK in particular has no
    ``data_bitrate`` kwarg, so the only uniform path is through a
    pre-computed timing instance.
    """
    from can import BitTimingFd  # type: ignore[import-untyped]

    from cannet_python_can.driver import OpenConfig

    m = _fresh_driver_module()
    cfg = OpenConfig(
        bitrate_bps=500_000,
        fd=True,
        data_bitrate_bps=2_000_000,
    )

    for channel_id, expected_backend, expected_extra in (
        ("vector:VN1630A(SN:12345, ch:0)", "vector", {"serial": 12345, "channel": 0}),
        ("kvaser:3(SN:67890, ch:1)", "kvaser", {"channel": 3}),
        ("pcan:PCAN_USBBUS1(h:0x51, ch:0)", "pcan", {"channel": "PCAN_USBBUS1"}),
    ):
        backend, kwargs = m._bus_kwargs_for(channel_id, cfg)
        assert backend == expected_backend
        # `timing=` carries the FD config — no separate fd / data_bitrate /
        # bitrate kwargs (they'd be ignored anyway when timing is present
        # but their absence is what makes PEAK happy).
        assert "fd" not in kwargs
        assert "data_bitrate" not in kwargs
        assert "bitrate" not in kwargs
        timing = kwargs["timing"]
        assert isinstance(timing, BitTimingFd)
        assert timing.nom_bitrate == 500_000
        assert timing.data_bitrate == 2_000_000
        # Vendor-specific extras still flow through.
        for k, v in expected_extra.items():
            assert kwargs[k] == v


def test_bus_kwargs_for_fd_defaults_data_bitrate_to_nominal() -> None:
    """When FD is enabled but only the nominal bitrate is configured,
    the data phase falls back to the same rate (matching python-can's
    own classic ``data_bitrate`` fallback)."""
    from cannet_python_can.driver import OpenConfig

    m = _fresh_driver_module()
    cfg = OpenConfig(bitrate_bps=500_000, fd=True)
    _, kwargs = m._bus_kwargs_for("pcan:PCAN_USBBUS1(h:0x51, ch:0)", cfg)
    timing = kwargs["timing"]
    assert timing.nom_bitrate == 500_000
    assert timing.data_bitrate == 500_000


def test_bus_kwargs_for_fd_defaults_nominal_when_unset() -> None:
    """An FD-enabled bus with no explicit bitrate uses the python-can
    classic default of 500 kbps so the open path still has *some* rate
    to compute timing against."""
    from cannet_python_can.driver import OpenConfig

    m = _fresh_driver_module()
    cfg = OpenConfig(fd=True)
    _, kwargs = m._bus_kwargs_for("pcan:PCAN_USBBUS1(h:0x51, ch:0)", cfg)
    timing = kwargs["timing"]
    assert timing.nom_bitrate == 500_000
    assert timing.data_bitrate == 500_000


# ---- PCAN status-frame suppression -----------------------------------------


def _stub_can_interface_bus(bus_factory):
    """Monkey-patch ``can.interface.Bus`` to ``bus_factory`` and return
    the original so the caller can restore it. Used by the open-path
    tests to substitute a stub bus without involving any real hardware
    SDK."""
    import can.interface  # noqa: WPS433 - ensure submodule attribute exists

    original = can.interface.Bus
    can.interface.Bus = bus_factory
    return original


def _restore_can_interface_bus(original) -> None:
    import can.interface  # noqa: WPS433

    can.interface.Bus = original


def test_open_pcan_disables_status_frames() -> None:
    """python-can's PCAN backend forwards PCAN-Basic STATUS messages
    through ``_recv_internal`` unfiltered (the STATUS bit is read off
    the ``MSGTYPE`` but never branched on), so what should be a
    side-band notification arrives as a classic CAN frame with
    ``can_id=1, dlc=4`` and the status code as the 4-byte payload —
    indistinguishable from real wire traffic. The driver disables the
    status-frame queue immediately after open via
    ``PCAN_ALLOW_STATUS_FRAMES`` → ``PCAN_PARAMETER_OFF``. Bus state
    transitions (passive / bus-off) are still observable through the
    sidecar's 500 ms ``GetStatus`` poll, so no information is lost."""
    orig_detect = _install_fake_pcan({0x51: {}})
    fake_param = object()
    fake_off = object()
    mod_basic = sys.modules["can.interfaces.pcan.basic"]
    mod_basic.PCAN_ALLOW_STATUS_FRAMES = fake_param
    mod_basic.PCAN_PARAMETER_OFF = fake_off

    setvalue_calls: list[tuple[object, object, object]] = []

    class _PcanApi:
        def SetValue(self, handle, param, value):  # noqa: N802 - matches PCANBasic
            setvalue_calls.append((handle, param, value))
            return 0

    class _FakePcanBus:
        def __init__(self, **kwargs):
            self.m_objPCANBasic = _PcanApi()
            self.m_PcanHandle = "handle-stub"

    def factory(interface, **kwargs):
        assert interface == "pcan"
        return _FakePcanBus(**kwargs)

    original = _stub_can_interface_bus(factory)
    try:
        m = _fresh_driver_module()
        from cannet_python_can.driver import OpenConfig

        m.PythonCanDriver().open(
            "pcan:PCAN_USBBUS1(h:0x51, ch:0)",
            OpenConfig(bitrate_bps=500_000),
        )
    finally:
        _restore_can_interface_bus(original)
        _uninstall_fake_pcan(orig_detect)

    assert setvalue_calls == [("handle-stub", fake_param, fake_off)]


def test_open_non_pcan_does_not_touch_pcan_basic() -> None:
    """The status-frame suppression is PEAK-only. Vector and Kvaser
    buses have no ``m_objPCANBasic`` attribute — if the driver ever
    tried to apply the PCAN setting unconditionally, open() would
    crash with ``AttributeError`` on those backends. This test pins
    the vendor gate by opening a Vector bus stub that deliberately
    lacks every PCAN-specific attribute and asserting open() returns
    cleanly."""
    _install_fake_vector([_VectorCfg("Virtual", 0, serial_number=None)])

    class _FakeVectorBus:
        def __init__(self, **kwargs):
            pass  # intentionally no m_objPCANBasic / m_PcanHandle

    def factory(interface, **kwargs):
        assert interface == "vector"
        return _FakeVectorBus(**kwargs)

    original = _stub_can_interface_bus(factory)
    try:
        m = _fresh_driver_module()
        from cannet_python_can.driver import OpenConfig

        # Would raise AttributeError if the PCAN suppression ran here.
        m.PythonCanDriver().open(
            "vector:Virtual(ch:0)",
            OpenConfig(bitrate_bps=500_000),
        )
    finally:
        _restore_can_interface_bus(original)
        _uninstall_fake_vector()
