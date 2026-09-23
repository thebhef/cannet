# Task 155 — The Kvaser Timer Wraps Without Losing Frames, and Drops Are Loud

Opened 2026-09-23 from ungroomed user feedback (items 11 and 12).
**Executes now, downstack of `doc-closeout-2`** (owner ruling
2026-09-23): the task's branches are based on `task149-units-surfaces`
and `doc-closeout-2` is restacked on top of the last of them.

## Why

A capture on a Kvaser Leaf v3 through the python-can sidecar lost
every received frame for 4 h 46 min and then carried on with RX
timestamps 11.93 h stale, while cannet's own TX frames kept landing
and the sidecar's rx stats showed a steady ~1100 frames/s. The bus
was fine; the operator spent a morning deciding whether the ECU or the
file was broken.

Three things combined:

1. **python-can's Kvaser backend reads a 32-bit timer.** `canReadWait`
   returns the stamp as a 32-bit count of `TIMESTAMP_RESOLUTION` = 10 µs
   ticks (Kvaser: "timestamps are stored in 32 bits"), so the value
   wraps every 2^32 × 10 µs = 42,949.67 s. python-can 4.6.1 (and its
   `main` as of 2026-09-23) does `timestamp.value * TIMESTAMP_FACTOR +
   self._timestamp_offset` with no wrap handling; the sidecar's mapper
   (`libs/cannet-python-wire` `message_to_frame`) converts that float
   to ns unchanged. At the wrap every RX stamp jumps back 11.93 h.
2. **The trace store drops a frame stamped before the session start
   silently.** `TraceStore::append` returns `None` and bumps
   `dropped_before_session`; the count rides `trace-grew` to the
   frontend, which writes a DIAG gauge (`drop.before_session`) and
   nothing else. No system-log line, no chip. The drop itself is
   right — it rejects stale pipeline frames after a clear/reconnect
   race — but 20 million frames left through it unannounced.
3. **The logger's clamp is quiet.** A logger started a few minutes
   after the capture wrote the post-wrap RX frames that fell before
   its own anchor *at* the anchor (the writer's designed clamp,
   reported in `FinishedCapture::clamped_count` / `worst_clamp`).
   Save Capture turns that report into a system-log warning
   (`capture.rs` `clamped_timestamp_warning`); the logger's finish
   path (`logger.rs`) logs only the frame count.

Sequence, for the record: wrap at T; RX stamps fall 11.93 h before
the session start and are dropped until the wrapped clock climbs back
past it (T + 11.93 h − elapsed-at-wrap); from then on RX is accepted
with stamps 11.93 h stale, overlapping the capture's first hours.

## Rulings (owner, 2026-09-23)

- **Two tasks, not one or three.** This task carries items 11 and 12;
  the restore-from-cache crash (item 13) is task 156. Different
  modules, independently shippable.
- **The sidecar unwraps.** In `driver_python_can.py`, per open
  channel on the kvaser backend: keep the last raw stamp; a jump back
  of more than half the wrap period (21,474.8 s) adds one period to a
  running wrap count applied to every later stamp. Hardware stamps
  keep their precision; other backends are untouched; the fix is
  unit-testable with synthetic `can.Message`s. One WARNING log
  envelope per wrap, so the system log records that it happened. An
  upstream python-can issue is filed alongside (link in the status
  log). Rejected: restamping RX with the host clock (throws away
  Vector/PCAN hardware stamps); a host-side guess at the period (the
  wire would still carry wrong stamps to every other consumer).
- **Before-session drops become a coalesced system-log warning.**
  First drop of an episode: WARN naming the bus, the frame's stamp
  and how far before the session start it fell. While the episode
  continues: one line per emitter tick with the count, rate-limited
  the way ADR 0035 coalesces bus errors. When it stops: a closing
  line with the episode total. The counter and the DIAG gauge stay.
  Rejected: a status-strip chip (task 140 is reworking the strip);
  moving the session origin back (a wrapped clock would rewrite the
  whole timeline).
- **Logger clamps get Save Capture's warning.** Parity, not design:
  the logger's finish (and each size-cap split part, task 137) runs
  the same `clamped_timestamp_warning` and logs it at WARN.
- **Verification:** the unit tests gate; one ≥ 12 h live Kvaser
  capture after landing, scheduled with the owner (the hardware is
  shared), confirms — no before-session drops, continuous RX stamps.
  Confirmation, not an exit criterion.
- **Repairing an already-recorded wrapped file is out of scope.**

## Phases

1. **`task155-kvaser-unwrap`** (base `task149-units-surfaces`) — the
   sidecar's python-can driver unwraps the Kvaser 32-bit timer per
   channel and logs one WARNING envelope per wrap; tests feed
   synthetic Messages across a wrap (and across two); a python-can
   issue is filed; `README`/sidecar docs note the behaviour;
   `plans/technology-inventory.md`'s python-can entry records the
   defect and the workaround.
2. **`task155-drops-loud`** (base phase 1) — `TraceStore` exposes the
   first-drop detail (bus, stamp, distance before origin) alongside
   the count; the emitter turns an episode into the coalesced WARN
   lines above; tests cover open / continue / close of an episode
   and the rate limit.
3. **`task155-logger-clamp`** (base phase 2) — the logger's finish and
   split paths log `clamped_timestamp_warning`; a test drives frames
   before the anchor through a logger and asserts the warning.

Phase 1 is Opus (driver behaviour, upstream filing); 2 and 3 are
Sonnet-shaped. All three share the main tree, strictly sequential.

## Exit criteria

- A synthetic Kvaser channel whose raw stamps cross 2^32 ticks yields
  monotonic, continuous `timestamp_ns` on the wire; two wraps yield
  two periods; a non-kvaser backend's stamps are untouched
  (sidecar unit tests).
- Each wrap produces exactly one WARNING `LogMessage` envelope naming
  the channel.
- The upstream python-can issue is filed and linked from the status
  log; `technology-inventory.md`'s python-can entry names the defect.
- A frame appended before the session start opens a drop episode with
  one WARN naming bus, stamp and distance; continued drops produce at
  most one line per emitter tick; the episode closes with a total
  (host tests).
- A logger whose input contains frames before its anchor logs the
  same clamp warning Save Capture does, at finish and at each split
  part (host tests).
- Confirmation (not gating): a ≥ 12 h live Kvaser capture after
  landing shows zero before-session drops and continuous RX stamps
  across the wrap; recorded in the status log with the date.

## Status log

- 2026-09-23 — opened from ungroomed items 11 and 12; grooming
  complete (rulings above); three phases cut.
