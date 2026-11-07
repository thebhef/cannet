# ADR 0061 — Only the wire writes data

Status: accepted (2026-10-07); amends [ADR 0039](0039-periodic-emission-timing.md)
(the refused send's `Tx ✗` row is withdrawn) and
[ADR 0023](0023-logical-bus-vs-interface.md) (frames aimed at a
`NoInterface` bus leave no row)

## Context

cannet recorded what it *intended* to put on a bus as if the bus had
carried it. The transmit path appended a `Tx` row for every frame the
session's channel accepted — an answer that fails only when the channel
is closed — and every reader of the trace store took that row for a bus
fact: the trace, the plots through the signal cache, per-message counts
and rates, `fps.tx`, bus load, the logger and Save Capture. A pulled
cable under rest-of-bus simulation therefore showed healthy outgoing
traffic everywhere, and the owner reported it five times before the row
itself was removed.

Two partial fixes narrowed the symptom upstream of the wire and left the
row: parking a periodic whose route is down
([ADR 0039](0039-periodic-emission-timing.md) rule 3), and a `Tx ✗` mark
on the row a refused enqueue still wrote. ADR 0039's 2026-10-03
amendment then made the driver's echo the only accepted-send row, but
kept the refused send's row "because there the queue did say no". That
exception was itself an intent recorded as a row: a frame no wire saw,
in the same store every consumer reads.

## Decision

**A row is the wire's account. Nothing else writes one.**

1. **A frame is data when the wire reports it**: a received frame, or
   the driver's echo of our own frame (`DIRECTION_TX`). The store takes
   rows only from the receive path.
2. **An intent is not data.** An enqueue answer, a `send()` return, a
   route being up, a chip state — none is a bus fact. No row, count,
   sample, rate, logger record, export record or health tally comes
   from one. This holds whatever the answer was: an accepted send
   appends nothing, and **a refused send appends nothing either**.
3. **A `Tx` row is an echo.** It exists because the bus carried our
   frame and the driver said so. A backend that cannot echo (python-can
   without `receive_own_messages`) shows no `Tx` rows; that is the
   truthful answer, not a gap to fill.
4. **A refusal is reported where refusals are counted**, never as a
   row:
   - the peer's refusals (transmit queue full, bus-off, listen-only, …)
     as the bus-health per-bus refusal count
     ([ADR 0060](0060-a-bus-fault-is-an-episode-the-sidecar-reports.md)
     rules 4 and 7);
   - a periodic the host could not offer as a missed period (ADR 0060
     rule 6), or not at all while its route is down (ADR 0039's park);
   - a manual send's refusal as the wire status returned to the caller.

### The PEAK caveat

An echo says the frame went onto the wire, and on most backends that is
also "a node acknowledged it". PEAK's echo is not: PCAN-Basic reports a
frame when it is transmitted, not when it is acknowledged, so a frame
retransmitted into a pulled cable is echoed every attempt. The wire's
own account of a failed transmission is the controller's transmit error
counter, carried in every error frame; while it says the transmitter is
**error-passive**, the sidecar withholds that channel's echoes. The rule
stands — the row is still the wire's — but on PEAK "the wire" is read
through the controller's counters as well as the echo.

## Consequences

- One writer, one rule: reviewers check any new row, count or sample
  against "did the wire report this?".
- A manual send onto an unbound bus, or a periodic batch a session has
  gone away under, leaves nothing in the trace. Its only record is the
  answer above.
- `fps.tx`, per-message counts and bus load read zero on a bus that
  carries nothing, whatever cannet tried to send.

## Rejected alternatives

- **Keep the refused send's `Tx ✗` row, filtered out of every consumer
  but the trace.** Every new consumer of the store would have to know
  the filter, and forgetting it is exactly the defect this rule exists
  to end. The trace was the one place it was meant to show, and the
  trace is a view of the wire.
- **A host-side delivery mark on accepted sends.** Delivery is the
  wire's to report; a mark derived from the enqueue is the same intent
  under another name.
