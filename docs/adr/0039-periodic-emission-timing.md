# ADR 0039 — Periodic emission timing: phase stagger, drop-and-realign, park on route loss

Status: accepted (2026-07-25)

## Decision

The transmit scheduler's periodic-emission semantics, in four rules:

1. **Phase stagger, always on.** Every periodic message's first fire
   lands at `start + offset`, where
   `offset = stable_hash(registry row id) % period`
   (`transmit_scheduler::stagger_offset`). The fixed-rate grid then
   anchors at that first deadline, so same-period messages hold
   *different* phases indefinitely. Uniform rule — a manual row start
   and an RBS bulk start take the same path; the one-time sub-period
   delay before the first frame is accepted.
2. **Missed period: drop and realign.** A late tick fires once and
   realigns the grid to now (`next_tick_deadline`) — never a catch-up
   burst, never a growing backlog. Same rule for counter/CRC-bearing
   messages: a dropped period is never *prepared*, so the counter does
   not step (ADR 0027) and the receiver sees sequential counters with
   a longer gap — no manufactured end-to-end violation.
3. **Route down: park.** A periodic whose bus has no live route is
   parked: no preparation (counter frozen), no tx-confirm trace rows,
   no per-period wakes. It resumes promptly when the route returns —
   a `RoutesChanged` hint sent from the session-registration seam
   (`AppState::register_session`) wakes the scheduler immediately, and
   a ~1 s retry probe (armed only while something is parked) backstops
   any future route-up path that forgets the hint. On resume the grid
   re-anchors at the resume instant plus the same stagger offset.
   Manual single-shot sends while disconnected still prepare and
   append their trace row — an analyzer shows its own transmits.

   **A bus whose peer reports its interface `unavailable` has no live
   route**, and parks with the rest. Unplugging an adapter leaves the
   session, the subscription and the binding exactly as they were, so
   nothing else in the route notices; without this the scheduler goes
   on transmitting into a driver that cannot carry the frames, and
   every one of them still appends a tx-confirm row. A trace that shows
   traffic no wire carried is wrong data, not a missing indicator. The
   test is deliberately narrow: a controller over the ISO 11898-1
   **warning** limit, one that has gone **error-passive**, and even one
   that is **bus-off** all keep their routes, because each is present
   and recovers on its own — the error counters fall on every
   successful transmission — and parking one would freeze every
   counter over a fault the hardware clears by itself. Only
   `unavailable` parks, because only there is the device itself gone.
4. **Wake contract: best-effort OS timer.** The driver blocks on the
   command channel with a deadline timeout; typical wake lateness is
   ≤2 ms (measured), and the regression guard is the perf rig's
   `tx_late_ms_max` gate — not a hard real-time promise.

## Why

All periodics used to share one epoch: a bulk RBS start scheduled every
message at the same instant and the fixed-rate grid kept the cycle
groups phase-locked. Measured on the 2×PCAN rig: every 100 ms tick
fired a 70–148-frame cohort which drained at the ~1 kHz wire/sidecar
rate — 40–90 ms trains that starved the 100 Hz ids (≈30 ms gaps plus
pairs of frames arriving nearly back-to-back). No per-send optimization
fixes cohort math; the fix is not creating the cohort. Real buses
behave this way already — each ECU has its own clock, so co-phased
periodics are the simulation artifact, not fidelity.

Hashing the row id makes the phase deterministic per project row across
restarts and start order, with zero configuration. The offset is never
persisted, so hash drift across toolchain versions is harmless.

Parking on route loss keeps idle cost at ~zero (no per-period wakes
while disconnected) and models "transmission is suspended," which
keeps received counters sequential across an outage instead of
manufacturing a violation the sender never put on a wire.

## Consequences

- Frames are no longer tick-aligned across messages; a capture shows
  same-period ids offset from each other by a fixed per-id phase.
- First emission after start is delayed up to one period.
- A route outage freezes a periodic's counter and produces no trace
  rows; on reconnect the receiver sees a time gap but a sequential
  counter. Reconnect resume is immediate via the hint, ≤ ~1 s via the
  probe if the hint is ever missed.
- Route-up transitions arrive two ways. A session's channel→bus mapping
  is fixed at insert, so a *new* route comes only from the
  session-registration seam and its `RoutesChanged` hint. An interface
  becoming reachable again does not pass through that seam — the
  controller state changes underneath a session that never moved — so
  that resume rides the ~1 s parked probe alone. The probe is armed
  only while something is parked, which is exactly when it is needed.

## Rejected alternatives

- **DBC `GenMsgStartDelayTime` as the offset source.** Authentic where
  a DBC specifies it, and additive later — the offset source can change
  without touching these semantics. Not worth the attribute plumbing
  now.
- **User-editable per-message offset.** Configuration nobody asked for.
- **Pacing the emission downstream (sidecar queue shaping).** Preserves
  co-phase nobody needs, adds hot-path machinery, and the host still
  produces bursts.
- **Catch-up burst on missed periods.** Back-to-back stale frames are
  something a real cyclic transmitter never sends.
- **Keep ticking while the route is down** (prepare + step counter,
  emit nothing). Wastes per-period wakes on a disconnected bus and
  turns every outage into a counter discontinuity at the receiver.
- **Park on bus-off too.** A bus-off controller recovers on its own and
  the periodics should be running when it does; parking would freeze
  their counters across a fault the hardware clears in milliseconds.
- **Mark the tx-confirm row instead of parking, when the interface is
  gone.** The trace row would have to carry a "went nowhere" flag every
  reader, exporter and file format then has to understand — and the
  frame still would not have been sent. Not transmitting is both
  smaller and more truthful.
- **Event-only park resume (no probe).** A missed hint from a future
  route-up path would strand parked messages forever; the probe bounds
  that failure to ~1 s of latency.
- **`timeBeginPeriod` / high-resolution timers.** System-wide timer and
  power cost against a measured ≤2 ms typical lateness.
