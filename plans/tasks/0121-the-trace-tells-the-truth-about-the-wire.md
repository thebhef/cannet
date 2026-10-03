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
re-observed 2026-08-26), and a **fourth on 2026-10-02** ("Message TX
counts _still_ increment when TX fails, despite several attempts to
have you fix that", after a 20 s dongle unplug): *"I'm still not seeing TX messages stop
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

## Scope — groomed 2026-10-02/03

**Why the three candidate shapes were wrong:** all three infer from the
chip state; none observes the wire. The driver's queue answers
"accepted" for a frame nobody will ever acknowledge, so nothing
upstream of the wire can say no.

**What the drivers offer** (python-can 4.6.1, the sidecar's pin): one
flag, `receive_own_messages=True`, makes every adapter the sidecar
opens hand back each frame it actually transmitted, through the
ordinary receive path, with `Message.is_rx == False` — PCAN via
`PCAN_ALLOW_ECHO_FRAMES` / `PCAN_MESSAGE_ECHO`, Kvaser via
`canIOCTL_SET_LOCAL_TXECHO` + `LOCAL_TXACK` (the on-bus ACK;
`single_handle=False`, the default), Vector via `tx_receipts` /
`XL_CAN_EV_TAG_TX_OK`. All three vendors document the echo as
post-transmission. The sidecar sets the flag `False` today
(`driver_python_can.py`). The wire already carries
`Frame.direction` (`DIRECTION_RX | DIRECTION_TX`).

### Rulings (owner, 2026-10-02/03)

- **The wire writes the tx row.** "Send the message, and let its
  reception be how it enters the log." A transmit no longer appends a
  row when the queue accepts it; the echoed frame — the one the bus
  carried — arrives as a `DIRECTION_TX` frame and is logged and counted
  like any frame. A dead bus produces no rows and no counts. No pending
  state, no acknowledgement protocol, no matching.
- **A frame the bus will not carry is dropped.** "The messages are
  periodic and usually fast. Dropping messages happens." Nothing is
  retried by cannet and nothing is logged for it; the controller's own
  retry of the one frame it holds is the hardware's business. The
  enqueue-refused `Tx ✗` row stays: there the queue did say no.
- The chip-state inference (old shape 1) is **not** used.

### Phases

1. **Echo in, send-time row out.** Sidecar: `receive_own_messages=True`
   for every python-can bus; a received `is_rx == False` frame is
   forwarded as `DIRECTION_TX` (today it is not requested at all); the
   fake driver in the tests gains an echo. The virtual-bus debug server
   (`cannet-server debug vbus`) echoes a session's own transmits as
   `DIRECTION_TX` so a vbus trace keeps showing them. Host:
   `append_tx_row` (`transmit_commands.rs`) writes no row for an
   accepted send; the frame-ingest path appends `DIRECTION_TX` frames as
   `Tx` rows (the row renderer already knows the direction); per-message
   TX counts follow the rows; the manual transmit command's returned row
   index becomes none (the row appears when the wire reports it — check
   its one UI consumer); the undelivered mark stays for refused enqueues.
   Tests: echo → `Tx` row and count; no echo → no row, count unchanged;
   refused enqueue → `Tx ✗`; a vbus session sees its own frames as
   `Tx`. README's trace passage: a `Tx` row is a frame the bus carried;
   a frame the bus would not carry leaves no row. ADR: the one that
   defines tx rows / the transmit primitive gets the sentence.
2. **Owner confirmation on the PEAK bench** (existing exit criterion):
   pull the cable under RBS — rows and counts stop; replug — they
   resume. The same sitting can read the chip state and load counters
   for the bus-health finding (review queue § 3, 2026-10-02), which
   stays its own item until that data says what it is.

Phase 1 is Sonnet-sized: one flag, one direction mapping, one removed
append, tests.

## Exit criteria

Pulling the CAN cable on the bench regime
visibly changes what the trace/transmit surface says about outgoing
frames within the health poll's cadence, the behaviour is pinned by
tests against faked chip states, and the owner confirms it on the PEAK
bench.

## Status log

- 2026-10-03 — groomed: the wire writes the tx row (echo via
  `receive_own_messages`, logged as `DIRECTION_TX`), unconfirmed frames
  are dropped; one code phase plus the owner's bench confirmation. The
  acknowledgement-protocol and chip-state shapes considered on the way
  are rejected (the first for complexity the echo path makes
  unnecessary, the second for inaccuracy).
