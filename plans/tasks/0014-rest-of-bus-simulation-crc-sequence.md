# Task 14 — Rest-of-Bus Simulation + CRC / Sequence-Count Fields

Two transmit-side features that share one mechanism: **host-computed
signal fields on messages this GUI sends.** Rest-of-bus simulation
(RBS) is the surface that sends a configured set of messages on a
cadence with live, editable signal values; CRC and sequence-count are
*auto-fields* layered onto those messages — signals whose value the
host recomputes on every send (a counter that increments and rolls
over; a CRC computed over a data range of the just-encoded payload).
Both build on the transmit encoder from Tasks 5 / 11
(`cannet_dbc::Database::encode_frame`, [ADR 0017](../../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)
— the encoder is the inverse of `decode` and lives in `cannet-dbc`)
and ride the virtual / hardware buses from Task 13. RBS is, in
effect, the bulk + cadence counterpart of the by-ID panel: by-ID
shows one row per id *received*; RBS holds one row per id
*transmitted*.

Why together: an RBS message that carries a rolling counter and a CRC
is the common real-world case (AUTOSAR E2E-protected frames). Build
the auto-field machinery once — computed in `cannet-dbc` alongside the
encoder, not in the GUI — and have RBS consume it, so the hand-written
surface stays small.

## Captured requirements (from the feature owner)

**CRC / sequence-count fields** — designated per (message, signal):

- **Select the signal** that holds the field: one signal as the CRC
  field, one as the sequence counter, per message.
- **CRC:** either a **named algorithm config** (e.g. CRC-CCITT,
  CRC-8 — the catalogue is TBD) *or* explicit algorithm parameters
  (the "typical properties": width, polynomial, init, reflect-in /
  reflect-out, xor-out), plus the **data range within the message**
  the CRC is computed over.
- **Sequence counter:** an **increment** (default 1) and a
  **rollover** value.

**Rest-of-bus simulation** — a **gridview of the DBC's signals,
grouped per ECU (transmitting node)**, with live, editable signal
values, transmitted on a cadence.

## Open design questions (the feature owner flagged design work; these are the forks that change the implementation)

1. **Where the auto-field designation persists.** "On arbitrary
   signals in the DBC" suggests DBC custom attributes (`BA_`),
   consistent with the no-sidecar rule
   ([ADR 0010](../../docs/adr/0010-no-sidecar-files.md)) — but these
   would be *cannet-defined* attributes written into a third-party
   DBC, with round-trip and reload-from-disk implications. The
   alternative is project-file config keyed by `(bus, message id,
   signal name)`, leaving the DBC untouched. Pick one and ADR it.
2. **CRC data-range specification.** Bit range vs. byte range;
   whether it implicitly excludes the CRC field and the counter;
   byte order of the stored CRC. The realistic target is **AUTOSAR
   E2E** profiles — decide whether to model E2E profiles directly,
   expose the raw CRC parameter set, or both.
3. **CRC algorithm catalogue + library.** Which named configs ship,
   and whether to adopt a vetted CRC crate (`crc`) vs. a small
   hand-rolled table — a `plans/technology-inventory.md` decision.
4. **Decode-side verification (scope).** Beyond transmit-side
   *calculation*, optionally **verify** received frames — flag a bad
   CRC or an out-of-sequence counter in the trace / system messages.
   In or out for this task?
5. **RBS panel shape and reuse.** RBS as a new project-element /
   panel `kind: "rbs"` that, given a node, auto-populates a transmit
   entry per message that node sends (DBC transmitter / `BO_TX_BU_`),
   reusing the Tasks 5 / 11 transmit machinery — vs. an extension of
   the existing transmit panel. The grid: one row per message (expand
   to its signals) or one row per signal. "Per ECU" = the DBC
   transmitter node; the user picks which node(s) cannet simulates
   (the rest of the bus = everything except the device under test).
6. **Host-side periodic scheduler.** RBS needs a real host-side
   cadence scheduler (a timer per message), not the per-UI-tick
   `setInterval` the transmit panel uses today — this task absorbs
   the "host-side periodic scheduler" deferral from the transmit-
   usability work (and the 1 ms-cyclic-transmit `plans/backlog.md`
   item).
7. **FD / which buses.** Confirm RBS + auto-fields work over
   `local-virtual-bus`, hardware (sidecar) interfaces, and FD frames.

## Exit criteria (provisional — firm up once the questions above are settled)

- A message can be configured so a chosen signal is a **sequence
  counter** (increment, rollover) and another is a **CRC** (named
  config or explicit params, over a stated data range); each
  transmit recomputes both, verified against an independent reference
  (e.g. an E2E test vector) by a round-trip test in `cannet-dbc`.
- An **RBS panel** lists the messages a selected node transmits as a
  grid of live, editable signal values and sends them on their
  configured cadence onto the bus; sent frames appear as `Tx` rows
  (and over the wire to a writable bus) with the auto-fields filled
  in.
- The cadence is driven by a host-side scheduler (not the UI tick);
  cyclic RBS sends keep timing under load.
- The configuration round-trips through whichever persistence
  design question (1) settles on.
- ADR(s) for the auto-field mechanism and the persistence choice are
  checked in; `plans/technology-inventory.md` records any CRC library
  decision; the README documents the RBS workflow and the CRC /
  sequence configuration; rustdoc covers the new `cannet-dbc`
  surface.
- **ADR cleanup:** scrub task-number references out of
  [ADR 0017](../../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)
  (its rest-of-bus mention) — ADRs describe what *is*; task tracking
  lives here, not in the ADR.
- Deferral cleanup: the transmit-usability "host-side periodic
  scheduler" follow-up and the "1 ms cyclic transmit" backlog item
  are resolved (or explicitly re-deferred).
