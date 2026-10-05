# ADR 0039 — Periodic emission timing: phase stagger, drop-and-realign, park on route loss

Status: accepted (2026-07-25); amended (2026-10-03) — a bus-off
controller is brought back by a reset, not by its counters; amended
(2026-10-03) — a `Tx` row is a frame the bus carried: an accepted send
appends nothing, and only a refused enqueue writes a row of its own;
amended (2026-10-04) — PEAK's driver-side auto-reset rejected, and a
controller refusing sends in silence is reopened; partly superseded
(2026-10-04) by [ADR 0060](0060-a-bus-fault-is-an-episode-the-sidecar-reports.md)
— a full transmit queue that accepts nothing is flushed whatever is
received, missed periods are counted, and the state poll runs every
250 ms

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

   *Amended by [ADR 0060](0060-a-bus-fault-is-an-episode-the-sidecar-reports.md)
   rule 6:* a dropped period is counted per bus and shown, and a period
   the session's request channel has no room for is dropped the same
   way rather than waited for.
3. **Route down: park.** A periodic whose bus has no live route is
   parked: no preparation (counter frozen), nothing offered to the
   wire, no per-period wakes. It resumes promptly when the route returns —
   a `RoutesChanged` hint sent from the session-registration seam
   (`AppState::register_session`) wakes the scheduler immediately, and
   a ~1 s retry probe (armed only while something is parked) backstops
   any future route-up path that forgets the hint. On resume the grid
   re-anchors at the resume instant plus the same stagger offset.
   Manual single-shot sends while disconnected still prepare; the
   enqueue is refused, and the send leaves a `Tx ✗` row saying so.

   **A bus whose peer reports its interface `unavailable` has no live
   route**, and parks with the rest. Unplugging an adapter leaves the
   session, the subscription and the binding exactly as they were, so
   nothing else in the route notices; without this the scheduler goes
   on handing frames to a driver that cannot carry them, stepping
   counters for frames no bus will see. The
   test is deliberately narrow: a controller over the ISO 11898-1
   **warning** limit, one that has gone **error-passive**, and even one
   that is **bus-off** all keep their routes, because each is present
   and comes back without the user: warning and error-passive recover
   on their own as the error counters fall on every successful
   transmission, and a bus-off controller is reset — by its driver
   where the driver offers that, otherwise by the sidecar once it has
   read bus-off for a second (§ Amendment, bus-off). Parking one would
   freeze every counter over a fault that clears without anyone
   acting. Only `unavailable` parks, because only there is the device
   itself gone.
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
- **Park on bus-off too.** A bus-off controller is reset within about
  a second (§ Amendment, bus-off) and the periodics should be running
  when it comes back; parking would freeze their counters across a
  fault that clears without anyone acting.
- **Mark the transmit's row instead of parking, when the interface is
  gone.** For a *periodic* on a route that has gone, not transmitting is
  both smaller and more truthful than transmitting and annotating — the
  frame still would not have been sent, so the park stands.

  A mark does exist, for the cases the park does not cover: a manual
  send onto a bus no session carries, and a session that refuses the
  frame. There the enqueue said no, and these are the only transmits
  that write a row of their own — reading `Tx ✗`, so it cannot pass
  for a frame the bus carried. The objection that killed the mark as a
  *replacement* for parking does not apply to it: the mark is
  host-side state read at fetch time, not a field on the stored frame,
  so no exporter and no file format ever sees it.
- **Event-only park resume (no probe).** A missed hint from a future
  route-up path would strand parked messages forever; the probe bounds
  that failure to ~1 s of latency.
- **`timeBeginPeriod` / high-resolution timers.** System-wide timer and
  power cost against a measured ≤2 ms typical lateness.

## Amendment (2026-10-03) — a bus-off controller is reset

Rule 3 kept a bus-off bus's route on the premise that the controller
recovers on its own as its error counters fall. They cannot: a bus-off
controller has taken itself off the wire and transmits nothing, so
there is no successful transmission to lower them. ISO 11898-1's own
way back (128 occurrences of 11 recessive bits) takes milliseconds, but
PCAN-Basic holds the controller bus-off until it is reset, and so does
any driver that does not reset it itself — on the bench, a PEAK
channel whose CAN side was disconnected and reconnected stayed bus-off
for good.

Bus-off is transient, and the bus comes back without user action, the
same on every vendor: the sidecar's state poll resets a controller it
has read bus-off for a second — far longer than the controller's
own recovery — through the driver's `reset` hook: Vector in place
(`xlDeactivateChannel` then `xlActivateChannel`, python-can's
`VectorBus.reset`), Kvaser in place (every handle off bus and on
again, as CANlib's `canResetBus` does), and anything without an
in-place reset — PEAK included, whose `CAN_Reset` clears queues and
does not reset the controller — by reopening the channel with its
current configuration. A reset that fails is retried on the next
poll that still reads bus-off.

The poll then reads the controller active and publishes it, which is
what the bus-health panel shows. Parking is still not the mechanism —
the route stays up through the reset, and a periodic's counter keeps
stepping across it as it does across any other dropped frame.

## Amendment (2026-10-04) — no driver-side auto-reset; a silent, full transmit queue is reopened

**PCAN-Basic's `PCAN_BUSOFF_AUTORESET` is not used.** It resets a
bus-off controller inside the next `CAN_GetStatus`, read or write —
including the status read the state poll itself makes — so the poll
never reads bus-off and the bus-health panel never shows it. And it
does not restart a full transmit queue: on the bench, with the CAN
cable pulled for hours and sends refused "transmit queue is full", the
controller went bus-off, was auto-reset unseen, and then sat idle — no
error frames, the status word stale, every send still refused — and
transmitted nothing when the cable came back. Without it, PEAK's status
word reports bus-off, the state poll publishes it and reopens the
channel after a second (re-initialising the controller and emptying its
transmit queue), and publishes the recovered state — each step
visible, however often a disconnected bus repeats it.

**A channel refusing sends with a full transmit queue that has received
nothing for two seconds is reopened**, through the same swap. Received
means anything: a data frame, an echo, an error frame. A controller
retransmitting into a fault reports every attempt as an error frame, so
a full queue *with* error frames arriving is a live fault and is left
alone (*superseded by [ADR 0060](0060-a-bus-fault-is-an-episode-the-sidecar-reports.md)
rule 7: a queue that has accepted nothing for a second is flushed,
whatever is received*); silence *without* queue-full refusals is an
idle bus and is left alone. Both together are a controller that is neither transmitting nor
erroring, whatever its status word says, and nothing on the wire will
restart it. The driver classifies the refusal (`TxRejected.queue_full`);
the rule itself is vendor-neutral. It is checked once per state-poll
pass, logs one line per reopen, and repeats on a later pass only if the
fresh channel refuses queue-full too.

**PEAK's echo is "on the wire", not "acknowledged".** With the CAN
cable pulled, a lone PEAK transmitter retransmits the unacknowledged
frame indefinitely and PCAN-Basic echoes every attempt
(`PCAN_MESSAGE_ECHO`) at the normal cadence. On PEAK a `Tx` row
therefore additionally requires the controller not to be error-passive:
the sidecar drops an echo that arrives while the transmit error counter
is above 127, which ISO 11898-1's fault confinement reaches after 16
consecutive failed transmissions. The counters arrive in PEAK's error
frames, one per retransmission, so the gate closes within about 16
frames of the fault and stays closed for as long as it lasts; once the
wire is restored the error frames stop, the next status poll without
one (every 250 ms, [ADR 0060](0060-a-bus-fault-is-an-episode-the-sidecar-reports.md)
rule 5) reads the counters as 0, and echoes flow again. Vector
carries the same gate as a precaution (its documentation does not say
whether a transmit receipt waits for the acknowledge); Kvaser does not,
because CANlib documents its echo as a successful transmission.

## Amendment (2026-10-03) — only the wire writes the `Tx` row

A transmit the session accepts appends nothing. The frame enters the
trace when the bus carries it: every python-can bus the sidecar opens
asks for the driver's post-transmission echo (`receive_own_messages`,
off only for listen-only), the echo arrives on the receive path as a
`DIRECTION_TX` frame, and the ingest path appends it as a `Tx` row —
counted, decoded, plotted, logged and saved like any frame. The
virtual bus echoes a participant's own frame the same way (ADR 0021).
A frame the bus will not carry — a pulled cable, a dead bus — leaves
no row and is not retried; the controller's own retry of the frame it
holds is the hardware's business. Every session on a shared adapter
receives the echo, as `Tx`: the sessions on one adapter are one node.

The send-time row this replaces was appended whenever the session's
channel accepted the frame, an answer that fails only when the channel
is closed — so a dead bus showed healthy outgoing traffic in the trace,
the plots, the per-message counts, the logger and saved captures. Only
the enqueue-refused row remains (§ Rejected alternatives, the mark),
because there the queue did say no.

`fps.tx` is therefore the rate the bus carried our frames at, and a
backend that cannot echo shows no `Tx` rows. On PEAK the echo alone is
not enough — see the bus-off amendment's last paragraph: an echo from
an error-passive transmitter is withheld.
