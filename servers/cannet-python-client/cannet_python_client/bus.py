"""``CannetBus`` — a python-can bus backed by a cannet server.

Registered under python-can's ``can.interface`` entry-point group, so
an application opens one the way it opens any other bus::

    import can

    with can.Bus(interface="cannet", server="bench",
                 channel="pcan:PCAN_USBBUS1", bitrate=500_000) as bus:
        for message in bus:
            ...

``server`` names an entry in the machine's trust store (see
:mod:`cannet_python_client.trust`); ``channel`` is the interface id the
server publishes. Nothing from this package needs importing, and no
credential is ever pasted into an application.
"""

from __future__ import annotations

from typing import Any

import can
from cannet_python_can._proto import cannet_pb2 as pb

from . import session as _session
from .session import BusConfig, PerFrameErrors, Session, SessionError
from .trust import ServerTarget, TrustError, resolve

#: Wire ``ControllerState`` -> python-can ``BusState``.
#:
#: python-can's enum has three members and no "unknown", so a bus the
#: peer has not reported on reads as active — see
#: :attr:`CannetBus.controller_state`, which is where that difference
#: survives. Warning is a distinct fault-confinement state in ISO
#: 11898-1 but not one python-can models, and a controller with a high
#: counter is still error-active.
_BUS_STATES = {
    pb.CONTROLLER_STATE_ACTIVE: can.BusState.ACTIVE,
    pb.CONTROLLER_STATE_WARNING: can.BusState.ACTIVE,
    pb.CONTROLLER_STATE_PASSIVE: can.BusState.PASSIVE,
    pb.CONTROLLER_STATE_BUS_OFF: can.BusState.ERROR,
    pb.CONTROLLER_STATE_UNAVAILABLE: can.BusState.ERROR,
}


class CannetBus(can.BusABC):
    """A CAN bus on a trusted cannet server.

    :param channel:
        The interface id the server publishes (``pcan:PCAN_USBBUS1``,
        ``blf:0``, ``virtual:bus0``). A bare ``virtual:`` id is a
        factory: subscribing allocates a fresh participant, and this
        bus waits for the server to name it (ADR 0021).
    :param server:
        The server to open it on, named or as ``host:port``. Resolved
        against the machine's trust store, which supplies the pinned
        certificate and the bearer token.
    :param bitrate:
        Arbitration-phase bit rate. When given, a ``ConfigureBus`` goes
        out ahead of the subscribe, so the controller opens at this
        rate the first time round rather than being reopened at it.
    :param fd:
        Open in CAN-FD mode.
    :param data_bitrate:
        FD data-phase bit rate. Ignored unless ``fd``.
    :param timeout:
        How long to wait for a factory allocation, and for the
        certificate probe on a pinned server.
    """

    def __init__(
        self,
        channel: str,
        server: str = "localhost",
        bitrate: int | None = None,
        fd: bool = False,
        data_bitrate: int | None = None,
        timeout: float = _session.DEFAULT_OPEN_TIMEOUT_S,
        can_filters: Any = None,
        **kwargs: Any,
    ) -> None:
        try:
            target: ServerTarget = resolve(server)
        except TrustError as exc:
            raise can.CanInitializationError(str(exc)) from exc

        # Nothing to configure means no envelope: a zeroed
        # ``ConfigureBus`` would ask a hardware server to open at no
        # bit rate at all.
        config = (
            BusConfig(bitrate=bitrate, fd=fd, data_bitrate=data_bitrate)
            if bitrate is not None or fd
            else None
        )
        try:
            self._session = Session(target, channel, config=config, timeout=timeout)
        except SessionError as exc:
            raise can.CanInitializationError(
                f"could not open {channel!r} on {target.address}: {exc}"
            ) from exc
        except Exception as exc:
            # A refused pin, a fingerprint that is not one, a server
            # that is not there — everything that stops the channel
            # being dialled at all.
            raise can.CanInitializationError(
                f"could not reach {target.address}: {exc}"
            ) from exc

        super().__init__(channel=channel, can_filters=can_filters, **kwargs)
        self.channel_info = (
            f"cannet {self._session.effective_id} on {target.address}"
            f"{'' if target.plaintext else ' (pinned)'}"
        )

    # --- what a cannet session exposes beyond BusABC -------------------

    @property
    def allocated_id(self) -> str | None:
        """The participant a factory subscribe was given, else ``None``."""
        return self._session.allocated_id

    @property
    def rejections(self) -> PerFrameErrors:
        """What the peer said about frames it would not carry.

        A tally by code. These do not end the session and are not
        frames, so they have nowhere else to go: without this a
        rejected transmit looks identical to one the bus carried.
        """
        return self._session.rejections

    @property
    def controller_state(self) -> str | None:
        """The peer's own fault-confinement reading, or ``None`` when it
        has reported none.

        ``None`` is **not** the same as healthy, and this is the only
        place the difference survives: :attr:`state` has to answer with
        one of python-can's three members whatever the peer has said.
        """
        reading = self._session.controller_state
        if reading is None:
            return None
        return str(pb.ControllerState.Name(reading))

    # --- BusABC --------------------------------------------------------

    @property
    def state(self) -> can.BusState:
        reading = self._session.controller_state
        if reading is None:
            return can.BusState.ACTIVE
        return _BUS_STATES.get(reading, can.BusState.ACTIVE)

    @state.setter
    def state(self, new_state: can.BusState) -> None:
        # The wire has no envelope for it. `ConfigureBus` sets a rate
        # and a mode, not a fault-confinement state — a controller
        # reaches those by what happens on the bus, and a bus-off
        # recovery is the peer's own business.
        raise NotImplementedError(
            "a cannet bus reports its peer's controller state; it cannot set it"
        )

    def _recv_internal(self, timeout: float | None) -> tuple[can.Message | None, bool]:
        try:
            message = self._session.recv(timeout)
        except SessionError as exc:
            raise can.CanOperationError(str(exc)) from exc
        # `False`: the wire carries no filter envelope, so `can_filters`
        # is applied by BusABC in software.
        return message, False

    def send(self, msg: can.Message, timeout: float | None = None) -> None:
        try:
            self._session.send([msg])
        except SessionError as exc:
            raise can.CanOperationError(str(exc)) from exc

    def shutdown(self) -> None:
        super().shutdown()
        self._session.close()
