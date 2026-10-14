# ADR 0060 — A bus fault is an episode the sidecar reports, and control travels ahead of data

Status: accepted (2026-10-04); supersedes [ADR 0039](0039-periodic-emission-timing.md)'s
rule that a full transmit queue with error frames arriving is left
alone, and amends [ADR 0035](0035-timeline-event-model.md)'s bus-error
series

## Context

A pulled CAN cable is the most ordinary fault a bus has, and cannet
handled it as data. Every error frame the controller reported became a
row — packed into a `FrameBatch`, appended to the trace, counted into
frames/s and bus load, and sampled one by one into the bus-error series
the **bus-error episodes** are read from. Every send the driver refused
became an `Error` envelope of its own, with no interface named. Both
travelled to the host through one unbounded, first-in-first-out queue
per session, and so did everything that describes the bus rather than
carrying its traffic: `InterfaceState`, `ClockReply`, `Log`.

So when the stream fell behind, the description of the bus fell behind
with it, and nothing said so. On the bench, with the cable pulled and
put back, the GUI showed a frames/s figure on a disconnected bus, error
counts still climbing after the wire had recovered, and "recovery" long
after the fact — a replay of the backlog presented as live. The last
refused send reached the screen more than three minutes after the wire
was whole again. The clock probe's replies, queued behind the same
backlog, measured that lag as a clock error and stepped the timeline,
splitting one blast into several episodes.

Two transmit-path defects compounded it. One thread reads a session's
transmit requests and blocks on each interface's transmit queue in
turn, so every interface on a session transmits at the pace of the
slowest; on the host, a full request channel stalls the one periodic
scheduler for every bus. And a PEAK channel refused every send for over
a minute while it went on receiving: [ADR 0039](0039-periodic-emission-timing.md)
reopens a full queue only when the channel has also gone silent, and a
full queue with traffic arriving was by rule "a live fault, left
alone" — so nothing in cannet recovered it.

Established tools do not do this. SocketCAN delivers per-bus-error
frames only with `berr-reporting on`, off by default because bus-error
interrupts flood the CPU, and reports controller state as single
transition events with the counters kept as statistics; the `at91_can`
driver disables its acknowledge-error interrupt in error-passive state
for the same reason. Vector's driver has a **NACK error-frame filter**:
once the transmit error counter reaches 128 it suppresses further
acknowledge-error frames, CANoe posts one system message, and the trace
— and the BLF it logs — holds exactly 16 error frames until the bus
recovers (Vector KB0023696, "Why does the CANoe trace window stop
updating after displaying only 16 NACK error frames"; KB0012204).
PCAN-View traces error frames only on request and counts transmit-queue
refusals rather than listing them. The common shape: counts, rates and
state are first-class and cheap; individual errors are bounded; every
buffer between driver and view is bounded, and a drop is reported.

python-can offers none of that above the driver. It gives a per-frame
`is_error_frame` flag, a `send` that raises per refused frame with
backend-specific text, and a `BusABC.state` that does not read the
controller. The aggregation is cannet's to do, and the place to do it
is the sidecar, which already decodes PEAK's counters from the error
frames.

## Decision

### 1. A bus fault is an episode, counted and reported by the sidecar

The sidecar counts error frames per **bus-error episode** at the
source. An episode opens at an error frame and closes after **1 s**
without one. The host merges episodes for display at the reader's gap,
as [ADR 0035](0035-timeline-event-model.md) already reads them —
episodes at gap `2g` are the gap-`g` episodes merged — so the
sidecar's 1 s is the finest grain any view shows.

The sidecar publishes a **`BusErrorEpisode`** on the control lane
(rule 3):

| Field | Meaning |
|---|---|
| `interface_id`, `seq` | the interface, and the episode's ordinal on it |
| `first_ns`, `last_ns` | hardware timestamps of the first and latest error, on the frames' clock |
| `count` | error frames in the episode |
| `count_by_kind` | per kind: `ack`, `bit`, `form`, `stuff`, `crc`, `other`, `unknown` |
| `tx_count`, `rx_count` | errors detected while transmitting / while receiving, where the vendor says |
| `tec`, `rec` | the error counters as of `last_ns` |
| `open` | the episode has not yet closed |

An open episode is republished at the state cadence (rule 5) and once
more when it closes.

The kind comes from what each vendor reports:

| Vendor | Kind | Notes |
|---|---|---|
| PEAK | from the error frame's ID (bit, form, stuff, other) and its bit position (an error in the acknowledge slot or delimiter is `ack`) | an ID-0 frame is a counter update: it updates TEC/REC and is **not counted** |
| Vector, CAN FD | from the error event's `errorCode` | the FD receive and transmit error events are consumed, not ignored |
| Vector, classic | `unknown` | the error-frame flag carries no kind |
| Kvaser | `unknown` | python-can discards CANlib's kind flags; recovering them means overriding its private receive path |

### 2. The first error frames of an episode are rows; the rest are counted

The sidecar forwards the **first N error frames of an episode** as
trace rows and only counts the rest — the **error-row cap**. N is
configurable per interface, default **16**, Vector's precedent. The cap
resets when the episode closes, so every blast gets its first N rows.

On the host each episode is a `busError` timeline event — the
host-derived kind [ADR 0035](0035-timeline-event-model.md) already
names — known by its first and last error, its counts by kind and
direction, and its counters, with its text as one block
([ADR 0057](0057-one-text-block-carries-an-event.md)). An open episode
is shown as ongoing and finalised when it closes.

- **The bus-error series is fed by the episode reports**, not by
  sampling each row: a report contributes the bus's running total at
  its first and last error. The series still never decreases, and any
  two served points still give an exact count and span. The capped
  rows are not sampled again.
- **A save writes the rows the capture holds** — at most N error frames
  per episode, as `CAN_ERROR_EXT` today — and the events stay
  unexported. ADR 0035's "the error frames are what a save writes"
  stands. The cap is applied at acquisition, as Vector's filter is, not
  on the way to disk: what the capture holds, the file holds.
- **Imports behave as live.** Error records in a BLF or MDF feed the
  same episode builder, at the same 1 s; the first N per episode become
  rows and the rest are counted. A file saved under an older cannet,
  with a row per error frame, imports as episodes plus at most N rows
  each.
- **frames/s and bus load exclude error frames.** On a disconnected bus
  they read the true data rate, which is none.

### 3. Two lanes per session, and the control lane goes first

A session's stream to the host is two lanes, drained **control first**:

| Lane | Carries | Bound | On overflow |
|---|---|---|---|
| control | `InterfaceState`, `BusErrorEpisode`, `TxRefusals`, `FramesDropped`, `ClockReply`, `Log`, `Error` | by key: latest wins per (message kind, interface) | nothing is lost that a later message does not restate |
| data | `FrameBatch` only | per interface, about one second of frames | the **oldest whole batches** are dropped, and `FramesDropped` says so |

`FramesDropped{interface_id, count, first_ns, last_ns}` names the
frames lost and the span they covered; the host records a
**dropped-frames gap** on that bus's timeline. Dropping the newest
instead was rejected: it recreates the minutes-late "live" display.
Blocking the receive thread was rejected: the loss moves into the
vendor's queue, where nothing marks it.

The lanes exist for **latency of fault visibility**, not throughput: a
fault, a refusal or a recovery reaches the screen however far behind
the data is. A bench load of twice the observed error rate went through
the existing stream in full, so the split is not a capacity fix, and is
not justified as one.

Keys that are not one-per-interface (decided here, owner to confirm):

- `BusErrorEpisode` is keyed by (interface, `seq`), so an episode's
  closing report is never replaced by the next one's opening. If closed
  episodes back up behind a stalled reader, the oldest fold into their
  successor — counts summed, the earlier `first_ns` kept — which is
  exact, because a report is already a sum.
- `Log` and `Error` are a bounded FIFO of their own; on overflow the
  oldest go, and the next `Log` says how many.
- `ClockReply` is latest-wins per session; rule 8 discards the stale.

### 4. Refusals are summarised, never one envelope per frame

A refused send is counted into **`TxRefusals{interface_id, reason,
count, first_ns, last_ns, last_message}`**, published at most about
four times a second per interface while refusals continue, with
`reason` one of `queue_full`, `closed`, `listen_only`, `incompatible`,
`other`. No refused transmit produces an `Error` envelope.

The reason is classified from the driver's own code where python-can
carries one, and from its text where it does not:

| Vendor | Queue full |
|---|---|
| PEAK | the text of `QXMTFULL` ("The transmit queue is full") **and** `XMTFULL` ("Transmit buffer in CAN controller is full") — python-can's PCAN error carries no code |
| Kvaser | `error_code` −13, `canERR_TXBUFOFL` |
| Vector | `error_code` 11, `XL_ERR_QUEUE_IS_FULL` |

### 5. State and counters have a cadence and a heartbeat

The sidecar reads each controller's state and error counters every
**250 ms**, publishes `InterfaceState` when it changes, and publishes it
**every second** regardless, carrying `as_of_ns` — so a reading that
has stopped arriving is visibly stale rather than silently unchanged.

A `recv` that raises because PCAN-Basic returned a bus-status result
(`BUSPASSIVE`, `BUSOFF`) is a fault reading, published as that state.
It is not `unavailable`: only a device that has gone is unavailable,
and only `unavailable` parks a route (ADR 0039 rule 3).

### 6. One interface's transmit path never delays another's

- **The sidecar refuses at once.** A send for an interface whose
  transmit queue is full is refused immediately, into that interface's
  `TxRefusals` with `queue_full`. The thread that reads a session's
  transmit requests never waits on any one interface, so the other
  interfaces on the session keep their rate.
- **The host's periodic path never blocks on a session.** The
  scheduler reserves room in the session's request channel before it
  prepares a frame; with no room, the period is **missed**: not
  prepared, its counter not stepped, exactly as
  [ADR 0039](0039-periodic-emission-timing.md) rule 2's dropped period.
  No one session can stall the scheduler for every other bus.
- **Missed periods are reported** (decided here, owner to confirm). The
  host counts, per bus, the periods it did not offer — those with no
  room in the request channel and those a late tick skipped under
  rule 2 — and shows the count beside the bus's refusals. Rule 2's
  drop-and-realign stands; it is no longer silent.

### 7. A transmit queue that accepts nothing is flushed, whatever is received

A channel whose driver has refused every send with a full queue for
**one second** — no send accepted in that time — and whose controller
is not bus-off has its **transmit queue flushed**, whether or not
frames are arriving. While it persists, the check repeats at most once
a second.

On a working bus a full queue frees a slot every frame time, so a
second without one accepted send is thousands of frame times: the
queue is not draining. The frames it holds are already older than any
period worth sending, and ADR 0039 rule 2 does not send stale periods.
Whatever the controller is doing — retransmitting into a live fault,
or holding a queue that will not move — a flush drops the stale frames
and lets the next period through the moment the wire can carry it.

The flush per vendor (decided here, owner to confirm):

| Vendor | Flush | Note |
|---|---|---|
| PEAK | `CAN_Reset` (python-can `PcanBus.reset`) | empties the transmit **and** receive queues without re-initialising the controller; frames already read are unaffected, frames still in the driver's receive queue are lost |
| Kvaser | `canIoCtl(canIOCTL_FLUSH_TX_BUFFER)` (python-can `KvaserBus.flush_tx_buffer`) | |
| Vector | `xlCanFlushTransmitQueue` where the device supports it, otherwise the reopen | **never** python-can's `VectorBus.flush_tx_buffer`, which transmits a frame of its own |

The flush is reported on the control lane: `TxRefusals` carries a count
of flushes and the time of the last (decided here, owner to confirm),
and the sidecar logs one line for the first flush of a run, the rest to
the debug sink.

What stands of ADR 0039:

- **Bus-off is reset per vendor** after it has been read for a second —
  Vector and Kvaser in place, PEAK and anything without an in-place
  reset by reopening. Rule 7 does not apply to a bus-off controller.
- **A full queue on a silent channel is reopened**, after two seconds
  without receiving anything. A controller that neither transmits nor
  errors needs re-initialising, which a flush does not do.
- **An echo is not an acknowledge.** PEAK's echo is withheld while the
  transmitter is error-passive (owner ruling 2026-10-03); Vector carries
  the same gate.
- **PCAN-Basic's driver-side auto-reset stays off.**

What is superseded: ADR 0039's "a full queue *with* error frames
arriving is a live fault and is left alone". A full queue that accepts
nothing is flushed; the error frames are reported as an episode.

### 8. A clock round whose delay is longer than a step is discarded

A clock-probe round whose best round-trip delay exceeds the step
threshold (1 s) is discarded as silent: the last offset stands. A reply
whose `t1` precedes the current round's first probe belongs to an
earlier round and is ignored. With replies on the control lane the
delay stays small; this is the backstop for when it does not.

## Consequences

During a cable pull, the user sees:

- **one `busError` event per bus per blast**, shown ongoing within
  about a second of the first error frame (the 250 ms cadence on a
  lane nothing waits behind), labelled with its kind — on PEAK and
  Vector FD, "ack" names the pulled cable outright;
- **TEC/REC and the controller state** on the bus-health row, with a
  staleness the heartbeat makes visible;
- **refused sends as one summary per bus** — a count and a reason —
  and, once a queue has accepted nothing for a second, a flush count;
- **frames/s and bus load at the true data rate**, not inflated by
  error frames;
- **at most N error-frame rows per blast** in the trace and in a saved
  file;
- **recovery within about two seconds of the wire** — the episode
  closes a second after its last error, the state reads active at the
  next poll, and a flushed queue sends the next period at once;
- **a bounded backlog**, and a dropped-frames gap on the timeline if
  the data lane ever overflowed, instead of a minutes-late replay.

And:

- A reopened save counts only the rows it holds: an episode from a
  file reads at most N errors where the live one read thousands. The
  file says what the trace showed, as Vector's BLF does.
- **The dropped-frames gap is a durable event kind**, not a
  host-derived one: nothing can recompute it from the frames, so it is
  held in the event store, persisted with the capture and exported as
  ADR 0035 exports durable kinds — a `GLOBAL_MARKER`, the same shape as
  the "history truncated here" marker. BLF has no record of its own for
  frames a logging tool lost; should one be found, the export may use
  it instead (owner ruling 2026-10-04).
- The wire changes are additive inside `cannet.v1`
  ([ADR 0059](0059-wire-protocol-package-major.md)); `cannet-server`
  relays the new messages unchanged ([ADR 0040](0040-production-cannet-server.md)).
- Raw error frames — every one, as rows — are not offered. A
  diagnostic mode like `berr-reporting on` would be a separate
  decision.
- A PEAK flush loses whatever sits unread in the driver's receive
  queue. The reader keeps that queue near empty, so the loss is small,
  and it is unmarked.

## Rejected alternatives

- **Keep error frames as rows and make the pipe faster.** The bench
  showed the stream carrying the observed error rate in full; the
  defect was what a row of an error frame does downstream — to rates,
  to the trace, to how late the fault reads — not how fast it travels.
- **Suppress error frames at the driver** (`PCAN_ALLOW_ERROR_FRAMES`
  off, Vector receive mode, a SocketCAN error mask). PEAK delivers the
  error counters inside its error frames; Linux's `peak_usb` consumes
  them in the driver for the same reason. They are consumed at the
  sidecar instead.
- **Drop the newest on overflow, or block the receive thread.** See
  rule 3.
- **Reopen instead of flush.** A reopen re-initialises a controller
  that is working and only holding a stale queue, and costs the
  channel; it stays for the silent controller, which needs it.
- **Leave a full queue alone while frames arrive** (ADR 0039 as it
  stood). It is what let a channel refuse every send for over a minute
  with no recovery in sight.
