"""Tests for the wire-layer timestamp clock contract.

Everything the sidecar stamps itself must be on the same Unix-epoch
nanosecond clock as hardware-stamped RX frames (python-can's
``msg.timestamp`` scale) and the GUI's own wall-clock stamps. A
``time.monotonic_ns()`` stamp is a third clock ~3 orders of magnitude
smaller; a capture mixing it with wall-clock frames breaks every
consumer that anchors on the first frame's timestamp (the plot's
x-axis lands off-canvas — the same bug the virtual bus had).

Covers the self-stamped envelopes the sidecar builds: ``_log_envelope``
and ``_clock_reply_envelope``. The frame path is the shared wire
package's and is covered in its suite.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path


def _ensure_on_path() -> None:
    pkg_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg_root))


_ensure_on_path()


from cannet_local_sidecar import server as srv  # noqa: E402
from cannet_python_wire._proto import cannet_pb2 as pb  # noqa: E402


def test_log_envelope_timestamp_is_wall_clock() -> None:
    before = time.time_ns()
    env = srv._log_envelope(pb.LOG_LEVEL_INFO, "hello")
    after = time.time_ns()
    assert before <= env.log.timestamp_ns <= after, (
        f"log timestamp {env.log.timestamp_ns} is outside the wall-clock "
        f"window [{before}, {after}] — likely on a different clock."
    )


def test_clock_reply_envelope_stamps_are_wall_clock() -> None:
    """The clock probe answers about the clock that stamps frames.

    ``t2`` / ``t3`` on a ``ClockReply`` are the two server-side stamps
    a client subtracts against its own ``t1`` / ``t4`` (RFC 4330 § 5).
    If they came off ``time.monotonic_ns()`` the client would compute a
    ~55-year offset against a clock no frame is ever stamped with — the
    same class of bug the two tests above guard for frames and logs.
    """
    before = time.time_ns()
    env = srv._clock_reply_envelope(t1=1_760_000_000_000_000_000, t2=time.time_ns())
    after = time.time_ns()
    assert env.clock_reply.t1 == 1_760_000_000_000_000_000, (
        "the probe's t1 must come back untouched — it is the client's "
        "only correlation handle"
    )
    for name in ("t2", "t3"):
        stamp = getattr(env.clock_reply, name)
        assert before <= stamp <= after, (
            f"clock reply {name}={stamp} is outside the wall-clock window "
            f"[{before}, {after}] — likely on a different clock."
        )
    assert env.clock_reply.t2 <= env.clock_reply.t3, (
        "the receive stamp must not follow the send stamp"
    )
