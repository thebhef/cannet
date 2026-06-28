# Task 29 — TX Timing Robustness & Counter-Per-Wire-Frame

Periodic transmit has two coupled defects, both rooted in the same
place: **emission and the rolling counter are driven by the scheduler
*tick*, not by the actual wire *send*.** Fixing the tick cadence and
re-binding the counter to the transmit are one piece of work.

The periodic scheduler is the single-threaded driver in
`apps/gui/src-tauri/src/lib.rs` (`take_due` → `fire_info` → transmit →
`reschedule`), the schedule itself in `transmit_scheduler.rs`, and the
counter/CRC fire path in `transmit_frames.rs` (`Entry::prepare_send`,
governed by ADR 0027; counter seeding by ADR 0028).

## Symptoms (observed)

- **Drift** — periodic TX is "not quite on period." The grid logic
  (`next_tick_deadline`) is fixed-rate and correct; the lateness comes
  from OS timer granularity: the driver waits on `recv_timeout`, which
  on Windows returns up to ~one timer tick (~15 ms) late. The
  `tx-sched` jitter probe (`SchedDiag`) buckets this — a cluster around
  the 8–18 ms bucket is the tell.
- **Bunching at high rate** — higher-frequency periodics clump. A late
  wake leaves several deadlines expired; the single fire loop services
  them back-to-back (catch-up doubles), so frames that should be spread
  by one period go out within ~sub-ms of each other. Corroborated by
  the sidecar's `max_gap` stat reaching ~2–4.5× the nominal period,
  worse the higher the rate.
- **Counter not incrementing per send** — the rolling counter
  (`CannetCounter` / RBS counter spec) doesn't advance 1:1 with frames
  on the wire. Root: `fire_info` calls `prepare_send`, which steps the
  counter and recomputes CRC, **unconditionally on every tick** — but
  the actual `transmit_frame_inner` is gated by whether the bus route
  resolves (`connected`). So a tick that steps-but-doesn't-send (route
  flap / reconnect race) runs the counter ahead of the wire, and the
  catch-up/collapse behavior under lateness desyncs the counter cadence
  from the emission cadence. In steady, fully-connected operation it is
  1:1, which is why the defect is intermittent and tracks exactly the
  conditions that drive the bunching.

## Scope

- **Re-bind the counter (and CRC) step to the actual transmit**, so the
  sequence advances exactly once per frame that goes on the wire. A
  tick that does not send (no live route) must not advance the counter.
  Keep the schedule ticking for cadence, but separate "what to send
  this tick" from "mutate the sequence state."
- **Reduce wake lateness.** Evaluate finer timer granularity on Windows
  (e.g. `timeBeginPeriod` / a higher-resolution wait) against its
  cost (system-wide timer-resolution effect, power draw). Establish a
  jitter target and gate against it.
- **Define and implement the missed-period policy.** Decide what a late
  wake should do per message: drop intervening periods (latest-value
  wins), spread the backlog, or burst it. The current implicit policy
  (collapse + catch-up double) is what produces the bunching; the
  counter case makes "one paced emission per period, distinct counter"
  the likely target. Capture this as an ADR — it is a durable decision
  about periodic-emission semantics.
- Keep the hand-written surface small and the single-thread model
  (it already avoids the per-thread jitter of the old
  thread-per-message design); the work is in the wait + the per-tick
  policy, not a rewrite.

## Design questions

- Is `timeBeginPeriod` acceptable given its process-/system-wide reach,
  or is a different high-resolution wait (waitable timer, spin-tail near
  the deadline) preferable? What jitter target is "good enough"
  (e.g. p95 wake lateness < a few ms)?
- Missed-period policy per emission: drop vs. spread vs. burst — and
  does the answer differ for plain periodics vs. counter/CRC-bearing
  ones?
- When a bus route is down, should the schedule keep stepping time
  silently (today's behavior) while neither sending nor advancing the
  counter, and resume cleanly on reconnect?
- Does any of this interact with multiple buses sharing the one driver
  thread (a slow/contended bus stalling another's cadence)? The fire
  loop holds the `transmit_frames` lock per message — confirm that is
  not a contributor.

## Exit criteria

- A failing-first test proving **one counter increment per wire frame**:
  a tick while the route is unresolved does not advance the counter, and
  N transmitted frames carry N consecutive counter values.
- Counter and CRC are recomputed on the transmit, not on the tick;
  manual-send and scheduled-send paths agree on the contract.
- A measurable bunching/jitter improvement: `max_gap` (sidecar) and the
  `tx-sched` lateness histogram stay within the agreed target on a
  high-rate periodic, demonstrated by a test or a recorded measurement.
- An ADR records the periodic-emission semantics (missed-period policy,
  counter-per-wire-frame, route-down behavior); ADR 0027/0028 updated if
  the fire-path contract changes.
- Docs updated in the same change: rustdoc on the scheduler / fire path
  reflects the new contract.
