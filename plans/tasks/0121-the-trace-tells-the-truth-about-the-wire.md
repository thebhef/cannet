# 0121 — The Trace Tells the Truth About the Wire

> **Reopened 2026-08-30** on the PEAK bench. Everything else this task
> carried — the tx-row append-after-answer split, the `Tx ✗` enqueue
> mark, the `TX_REJECTED` tally, the error-frame collapse, the
> Connected label, the rx-loss counter, the Overruns column and the
> adapter-identity line — landed and was bench-confirmed 2026-08-30;
> that detail, its rulings, and the original findings are in this
> file's git history and the verification checklist. What remains is
> the one thing the task was opened for, still unmet on hardware.

## The open defect

Owner, 2026-08-30, third report of the same observation (109 item 2,
re-observed 2026-08-26): *"I'm still not seeing TX messages stop
getting sent when I pull the CAN bus."* RBS into a dead local bus
shows a healthy stream of plain `Tx` rows beside one collapsed error
summary — the lie § 1 was written to end.

**Why the landed shape misses it:** both landed signals sit upstream
of the wire.

- The `Tx ✗` mark is the **enqueue** answer. A pulled cable does not
  refuse an enqueue — the local driver accepts the frame into its
  buffer and the controller retries arbitration forever, so
  `append_tx_row` gets a clean answer and appends a plain `Tx` row.
- `TX_REJECTED` is the **remote peer's** refusal (`rejections` on
  `RemoteSession`), which a local sidecar bus never emits.

A frame queued into a bus that is not delivering produces neither.

## Scope — to be groomed with the owner before code

A frame queued into a bus that is not delivering (the chip state the
health panel already reads: error-passive / bus-off, TEC climbing) must
not read as a plain `Tx`. Candidate shapes, one to be picked at
grooming:

1. Mark tx rows from the chip state (the health poll already carries
   it per bus).
2. Pause transmit (RBS and periodic frames) on bus-off, surfaced the
   way Muted already is.
3. A coalesced "transmitting into a dead bus" signal beside the error
   summary, leaving the rows alone.

## Exit criteria

Firm at grooming; at minimum: pulling the CAN cable on the bench regime
visibly changes what the trace/transmit surface says about outgoing
frames within the health poll's cadence, the behaviour is pinned by
tests against faked chip states, and the owner confirms it on the PEAK
bench.
