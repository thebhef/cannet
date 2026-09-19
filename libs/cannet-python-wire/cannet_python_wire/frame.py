"""The wire ``Frame`` and its kind, as Python dataclasses.

This is the in-process shape of a CAN frame that everything in this
repository's Python speaks: the sidecar's driver adapters produce and
consume it, and :mod:`cannet_python_wire.proto` is the only place it
meets the generated protobuf type. Keeping it free of generated proto
types is what lets an alternative-driver author work without touching
gencode.
"""

from __future__ import annotations

import dataclasses
import enum


class FrameKind(enum.Enum):
    """The kind of a CAN frame — exactly one per frame.

    Replaces the independent ``is_error`` / ``is_remote`` / ``fd``
    booleans a driver backend reports: those allowed contradictory
    combinations and forced an error > remote > fd priority ladder to be
    re-derived at every boundary. Mirrors the wire ``FrameKind`` enum;
    :mod:`cannet_python_wire.proto` maps between the two directly.
    """

    CLASSIC = "classic"
    FD = "fd"
    REMOTE = "remote"
    ERROR = "error"

    @classmethod
    def from_flags(cls, *, is_error: bool, is_remote: bool, is_fd: bool) -> "FrameKind":
        """Collapse a backend's independent frame-type booleans (e.g.
        python-can's ``Message.is_error_frame`` / ``is_remote_frame`` /
        ``is_fd``) into a single kind, applying the
        error > remote > fd > classic priority ladder. This is the one
        place the ladder lives."""
        if is_error:
            return cls.ERROR
        if is_remote:
            return cls.REMOTE
        if is_fd:
            return cls.FD
        return cls.CLASSIC


@dataclasses.dataclass(frozen=True)
class Frame:
    """One CAN frame in either direction.

    Mirrors the fields the wire-level ``Frame`` message carries;
    :mod:`cannet_python_wire.proto` translates between this dataclass
    and the proto.

    ``kind`` is the single source of truth for the frame's type;
    ``brs`` / ``esi`` are meaningful only when ``kind`` is
    :attr:`FrameKind.FD`.
    """

    timestamp_ns: int
    can_id: int
    extended: bool
    is_rx: bool
    data: bytes
    kind: FrameKind = FrameKind.CLASSIC
    brs: bool = False
    esi: bool = False
    dlc: int = 0
