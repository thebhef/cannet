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
  unit-testable with synthetic `can.Message`s. One WARN log
  envelope per wrap (`pb.LOG_LEVEL_WARN`; the proto has no `WARNING`), so the system log records that it happened. An
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
- Each wrap produces exactly one WARN `LogMessage` envelope naming
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

- 2026-09-23 — **phase 1 (`task155-kvaser-unwrap`) landed**, one
  commit on base `task149-units-surfaces`. The sidecar's python-can
  driver unwraps Kvaser's 32-bit receive timer per open channel; the
  interface emits one WARN `LogMessage` per rollover; 13 new tests
  (10 driver, 3 interface), 230 pass in the sidecar suite.

  **Confirming the arithmetic against the installed library**, rather
  than from the report: `.venv/.../can/interfaces/kvaser/canlib.py`
  (python-can 4.6.1, the pinned and frozen version) reads the stamp
  into a `ctypes.c_ulong` that `canReadWait` fills, and returns
  `timestamp.value * TIMESTAMP_FACTOR + self._timestamp_offset` —
  `TIMESTAMP_RESOLUTION = 10`, `TIMESTAMP_FACTOR = 10/1e6`. No
  rollover handling anywhere in the file. Period = `2**32 * 10 µs` =
  **42,949.67296 s** (11 h 55 m 49.67 s); half-period threshold
  **21,474.83648 s**. `_timestamp_offset` is set once, at the end of
  `__init__`, from `kvReadTimer` — itself a 32-bit read — so it is
  *re-derived per open*.

  **Where the correction is applied, and why not where the ruling
  said.** The ruling says the `Frame`'s `timestamp_ns`. It is applied
  one step earlier, to `msg.timestamp` on the message python-can just
  returned, before `message_to_frame` reads it. Reason: the shared
  mapper rejects a stamp more than `_TS_PLAUSIBLE_SLACK_S` = 86,400 s
  from the wall clock as driver garbage and substitutes
  `time.time_ns()`. One rollover stale is 42,950 s (inside the
  window), two is 85,899 s (still inside, barely), three is 128,849 s
  (outside). Correcting after the mapper would therefore have the
  third rollover silently take the wall-clock fallback and then get
  three periods *added* to it — a stamp 35 h in the future. Correcting
  before means the mapper only ever judges a stamp meant to be
  believable. Same observable behaviour the ruling asked for, one
  function earlier; the logic stays in the sidecar driver, not in
  `libs/cannet-python-wire`, as ruled. Flagged to the owner (queue § 1).

  **Backend gate:** `hasattr(bus, "_timestamp_offset")`, matching the
  existing `_is_pcan` (`m_objPCANBasic`) and `_is_vector`
  (`request_chip_state`) markers. `_timestamp_offset` is the only
  attribute of that name anywhere in python-can 4.6.1 (grepped), and
  it is exactly the one whose arithmetic is wrong.

  **Threshold vs. ordinary reordering:** half a period is 5 h 58 m.
  Receive-queue reordering is microseconds wide. A test pins the
  boundary from both sides (last stamp `period/2 + 10`, then `11.0`
  → no wrap; then `9.0` → wrap).

  **Reconfigure:** the wrap count **resets with the channel**, and
  must. `reconfigure` closes and reopens, python-can re-derives
  `_timestamp_offset` from the live timer on the new bus, so the new
  channel's stamps are correct again at open; carrying a count across
  would push every stamp a full period into the future. The
  interface's *reported* count resets alongside it, in
  `_reset_state_baseline_locked` — otherwise the new channel's first
  rollover (count 1) would be read as already-reported and go
  unannounced. Both covered by tests.

  **Plumbing choice for the WARN envelope, and why.** The channel
  exposes `timer_wraps() -> int`; `_state_pump` reads it once per
  500 ms poll and `_broadcast_error(pb.LOG_LEVEL_WARN, …)` fans out
  one envelope per increment. Chosen over the two alternatives
  because it is the shape already in the tree: `_read_rx_overruns`
  does exactly this (driver counts, state poll reads, interface
  publishes), down to treating a missing method on the channel as the
  backend's answer rather than a fault. The rx pump was rejected —
  it is deliberately kept minimal so PCAN's queue drains, and an
  11 h 56 m event does not need per-frame latency. A driver callback
  was rejected — `Driver.open(channel_id, config)` is the protocol
  boundary and there is nowhere to pass one without widening it,
  which is a bigger change than the optional method. `timer_wraps` is
  documented on the `OpenChannel` protocol as optional, the way
  `rx_loss` effectively is, and listed in the sidecar README's
  "Swap the driver library" section.

  **Note the log-level constant is `pb.LOG_LEVEL_WARN`**, not
  `LOG_LEVEL_WARNING` — the name in the task text does not exist in
  the generated proto.

  **Lockfile hazard hit in passing** (already tracked, queue § 5): a
  plain `uv run` with the local uv 0.7.12 rewrote
  `servers/cannet-local-sidecar/uv.lock` (revision 3 → 2, and the
  wire package's `grpcio-tools` specifier). Reverted; every command
  after that used `--frozen`, which is what the pre-commit hooks do.

  **Upstream python-can issue — drafted, NOT filed.** Text below for
  the overseer to post once the owner confirms. No `gh` was run
  against any external repository.

  > **Title:** Kvaser backend: `Message.timestamp` jumps 42,949.67 s
  > backwards when the 32-bit hardware timer wraps
  >
  > **Body:**
  >
  > `can/interfaces/kvaser/canlib.py` reads a received frame's
  > timestamp with
  >
  > ```python
  > timestamp = ctypes.c_ulong(0)
  > status = canReadWait(self._read_handle, ..., ctypes.byref(timestamp), timeout)
  > ...
  > msg_timestamp = timestamp.value * TIMESTAMP_FACTOR
  > rx_msg = Message(..., timestamp=msg_timestamp + self._timestamp_offset)
  > ```
  >
  > with `TIMESTAMP_RESOLUTION = 10` (µs) and
  > `TIMESTAMP_FACTOR = TIMESTAMP_RESOLUTION / 1000000.0`.
  >
  > `canReadWait` writes a **32-bit** tick count (Kvaser's CANlib
  > documents the timestamp as stored in 32 bits), so the value rolls
  > over every `2**32` ticks:
  >
  > ```
  > 2**32 * 10 µs = 42_949.67296 s = 11 h 55 m 49.67 s
  > ```
  >
  > Nothing in the backend tracks the rollover, so from that point on
  > every `Message.timestamp` is 42,949.67 s **earlier** than the one
  > before it, and it repeats every ~11 h 56 m. `_timestamp_offset`
  > does not help: it is computed once in `__init__` from `kvReadTimer`
  > (also a 32-bit read) and never updated.
  >
  > Observed on a Kvaser Leaf v3 in a long logging session: a consumer
  > that anchors a capture on its first frame discarded 4 h 46 m of
  > received frames as falling before the session start, then accepted
  > everything after that with timestamps ~11.93 h stale, overlapping
  > the capture's own first hours. python-can 4.6.1; the same code is
  > on `main` as of 2026-09-23.
  >
  > **Minimal repro** (no hardware — the arithmetic is the bug):
  >
  > ```python
  > TIMESTAMP_FACTOR = 10 / 1_000_000.0
  > offset = 1_700_000_000.0           # whatever __init__ computed
  > ticks_before = 2**32 - 1           # one tick before the rollover
  > ticks_after = 99                   # ~1 ms later on the wire
  > print(ticks_before * TIMESTAMP_FACTOR + offset)   # 1700042949.67295
  > print(ticks_after * TIMESTAMP_FACTOR + offset)    # 1700000000.00099
  > # 1 ms of bus time reads as -42,949.672 s
  > ```
  >
  > On hardware: open a Kvaser channel, leave it receiving for just
  > over 11 h 56 m, and watch `msg.timestamp` step backwards by
  > 42,949.67 s exactly once per period.
  >
  > **Suggested fix**, the usual shape for a wrapping counter: keep
  > the previous raw tick count on the bus, and when a new one is more
  > than half the period below it, add `2**32 * TIMESTAMP_FACTOR` to a
  > running correction applied to every later stamp. Half a period is
  > ~5 h 58 m, far outside any legitimate out-of-order delivery. Happy
  > to send a PR if the approach is agreeable.

  **Verification (scoped per-phase tier).** `uv run --frozen --extra
  dev pytest` 230 passed; `ruff check` / `ruff format --check` clean;
  `mypy` clean (10 source files); `git grep --untracked -Ein "task
  [0-9]|plans/" -- apps/ crates/` no hits; `pnpm --dir apps/gui tauri
  build --no-bundle` green in 2 m 01 s →
  `target/release/cannet-gui.exe`. No Rust or frontend source was
  touched, so those lanes are unreachable from this diff.
## Blockers / side effects

- **The `OpenChannel` driver protocol gained `timer_wraps()`**
  (optional, like `rx_loss`). An alternative driver that omits it is
  read as "no rollovers", which is what a missing method means, so
  nothing external breaks — but the swappable-driver surface the
  sidecar README advertises is one method wider than it was.
- **The correction mutates `msg.timestamp` in place** on the
  `can.Message` python-can returned, before the shared mapper reads
  it. The message is the driver's own (straight off `bus.recv`) and
  nothing else ever sees it, but a reader expecting the driver to be
  read-only on python-can objects should know.
- **Three rollovers on one open channel is not tested against the
  mapper's plausibility window.** With the correction applied first
  the window never sees a stale stamp, so it should not matter; there
  is no test because there is no cheap way to write one at 35 h of
  continuous receive that would mean anything.
- The live ≥ 12 h Kvaser confirmation run (task exit criteria, not
  gating) is still owed after all three phases land.
- 2026-09-23 — **phase 1 reviewed and accepted** (overseer). Diff
  read in full: the unwrap keys on `_timestamp_offset`, which is the
  Kvaser backend's alone in python-can 4.6.1 (re-grepped); the
  threshold is pinned from both sides; the count and the interface's
  reported count both reset with the channel. Comment-references grep
  clean on the tree. **Ruling (overseer, open to reversal): correcting
  `msg.timestamp` before the shared mapper is the ruling's own
  reading** — "in the sidecar driver, per open channel" is satisfied,
  and correcting after the mapper would let a third rollover take the
  mapper's wall-clock fallback and then gain three periods. The queue
  line asking to confirm it is withdrawn; the upstream-issue go/no-go
  stays in the queue for the owner. Branch tracked in Graphite under
  `task149-units-surfaces`; phase 2 launched.
