# Task 160 — Only the Wire Writes Data

Opened 2026-10-03 by owner order, after the fifth report of the defect
task 121 was opened for: a 0.5 s dongle unplug under RBS left the plot
untouched. Skeleton; **phase 1 is an audit**, and the rest is groomed
from what it finds.

## Why

> We should only be showing the received messages, because those are
> the ones that make it to the bus. — owner, 2026-10-03

cannet has recorded what it *intended* to put on the bus as if the
bus carried it since the transmit path was built: `append_tx_row`
(`transmit_commands.rs`) appends a `Tx` row for every frame the
client's channel accepted — an answer that fails only when the channel
is closed. Every consumer reads that row: the trace, the plot through
the signal cache, per-message counts, loggers, Save Capture. A dead bus
therefore shows healthy traffic everywhere. Two fixes narrowed symptoms
upstream of the wire and left the row — the `Tx ✗` enqueue mark (#434)
and park-on-`unavailable` (#397, ADR 0039 § 3, which also wrote down the
false premise that a bus-off controller "recovers on its own") — so the
owner reported the same thing five times (2026-08-26, -08-30, -09-xx,
-10-02, -10-03). Task 121 now carries the fix for the row itself (the
driver's post-transmission echo is the row); this task makes sure the
row was the *only* place, and makes the rule stick in the repository.

## The rule

A frame is data when the wire reports it: a received frame, or the
driver's echo of our own frame (`DIRECTION_TX`). An enqueue answer, a
`send()` return, a route being up, a chip state — none is a bus fact.
No row, count, sample, logger record, export record or health tally may
come from an intent.

## Phases

1. **Audit** (read-only, Opus; running 2026-10-03). Inventory every
   site where a transmit intent becomes something a user reads as a bus
   fact, and every consumer of trace-store rows, across host
   (`transmit_commands.rs`, `rbs/runtime.rs`, `signal_cache.rs`,
   `bus_health.rs`, `logger.rs`, `capture.rs`, the perf harness's
   expected tx fps), server and client (`cannet-server`,
   `cannet-client` tx stats, vbus echo, `TX_REJECTED`), sidecar
   (`_tx_pump` counters), frontend (Transmit/RBS panel counts, the
   manual send's returned row index), and docs (ADR 0021, ADR 0039,
   README, CONTEXT.md). Deliverable: a table — site, what it records,
   its source (enqueue / send return / echo / rows), whether 121's
   removal of the send-time row fixes it — plus the list of sites that
   would still lie afterwards, and the doc sentences to correct.
   Result goes in this file's status log.
2. **Disposition** (groomed with the owner from the audit). Each
   still-lying site either widens 121 phase 1 or becomes a phase here.
   Docs: the rule above becomes an ADR (amending ADR 0039 § 3 and
   ADR 0021's "synthesised Tx row" passage — the premise they rest on
   is wrong, and the correction is the durable decision), a
   `docs/CONTEXT.md` entry, and a short binding paragraph in
   `CLAUDE.md` beside the GUI-architecture rules, so every future
   change is reviewed against it.
3. **Bench confirmation** on PEAK with 121 phase 2: pull the cable
   under RBS — trace rows, plot samples, per-message counts, and a
   running logger's output all stop within the echo's latency; replug —
   all resume.

## Exit criteria

1. The audit table exists with every site dispositioned.
2. No site in the repository records a transmit intent as a bus fact
   (tests pin each fixed site with a faked driver that accepts sends
   and echoes nothing).
3. The rule is written down where reviewers read it: ADR, CONTEXT.md,
   CLAUDE.md.
4. Owner bench confirmation (phase 3).

## Status log

- 2026-10-03 — opened; phase 1 audit dispatched (read-only).
- 2026-10-03 — **Phase 1 audit done** (read-only, from the code).
  **One writer:** `append_tx_row` (`transmit_commands.rs:952-965`),
  reached from the scheduler tick (`:741-752`, periodic + RBS) and the
  manual send (`:874-888`). **Every consumer reads trace-store rows**,
  so 121's removal of the send-time row fixes all of them at once:
  the trace, the signal cache / plots (`signal_cache.rs:3561-3588`,
  no direction filter), latest-per-id and rates (`trace_query.rs`),
  the store's side indexes — per-bus bits → **bus load %**
  (`bus_health.rs:443,531`), `tx_rate` → **status `fps.tx`** —
  Save Capture BLF (`capture.rs:1460-1501`) and the **logger**
  (`logger.rs:704`): today both write synthesised rows into files.
  Truthful as they are: error tallies and the ingest verifier (wire
  only), `TX_REJECTED` tallies (far-end answer), the calc-field
  counter (steps per prepared send by design, ADR 0027), the
  scheduler's `record_fire` diag (a scheduler metric), the frontend
  (no click-time counters; `TransmitPanel.tsx:315` ignores the
  return).
  **Still wrong after 121 phase 1 as groomed — folded into it:**
  1. `libs/cannet-python-wire/…/python_can.py:61` reads
     `msg.is_tx`, which python-can's `Message` does not have — every
     frame maps to `DIRECTION_RX`; must read `msg.is_rx`.
     `driver_python_can.py:1180` sets `receive_own_messages` only to
     `False` (listen-only); the normal open must pass `True`.
  2. In-process virtual buses skip the originator
     (`cannet-core/src/shared_bus.rs:598`): without an originator
     echo (`Direction::Tx`, arbitration timestamp, only when
     `delivered > 0`; zero recipients stays `NoAcknowledger`) a vbus
     shows no `Tx` rows at all. Bridges: a physical echo re-entering
     through a bridge must not double with the originator echo.
  3. `fps.tx` is `tx_rate` from Tx rows: the perf gate's
     `--expected-tx-fps` reads ≈0 on a non-echoing bus until 1–2
     land; `diag.rs:201` "Transmit-confirmed throughput" and
     `cannet-perf-measurement/README.md:108-112, 343` reword.
  4. Sidecar "tx stats … sent=" (`shared_interface.py:280-293, 536`)
     counts `ch.send` returns → rename ("queued to driver").
  5. Manual-send IPC return (`ipc.rs:573-587`): `tx_confirm_index`
     and `TransmitWireStatus::Sent` claim a row and a send; with no
     row, drop the index and rename `Sent` → accepted.
  6. Refused enqueue keeps its `Tx ✗` row (owner ruling in 121) — the
     `UndeliveredTx` machinery stays for that case only.
  7. Tests pinning the old behaviour: `tests.rs:2403, 2496-2606,
     2610-2655, 6602, 8695`; `trace_store/mod.rs:912`.
  **Docs to correct** (121 phase 1 / 160 phase 2): ADR 0021 :13,
  :116-120; ADR 0027 :28-30; ADR 0039 :24, :30-31, :38-39, :41-47,
  :106-115; README :509-513, :2226-2233; perf README :108-112, :343.
  CONTEXT.md asserts nothing about send-time rows.
  **Open:** the sidecar's shared interface serves several sessions on
  one python-can bus, so an echo fans out to every subscriber as
  `DIRECTION_TX` — Q to the owner (below). Backends without
  `receive_own_messages` (python-can lists pcan, kvaser, vector,
  socketcan, ixxat, neovi, systec, etas, nixnet, virtual,
  udp_multicast) would show no `Tx` rows; acceptable, the row is the
  wire's.
- 2026-10-03 — audit follow-ons 1–5 and 7 landed in 121 phase 1
  (`task121-echo-row` `dd019c33`); 6 holds by ruling. Phase 2's list so
  far: the refused `Tx ✗` row's reach (decode, counts, `fps.tx`, logger,
  export — recommend: trace row stays, excluded from the rest); the
  bridge's `Tx` drop (121 § Blockers); the plot closing raw gaps at
  decimated zoom (queue § 3); the durable rule (ADR, CONTEXT.md,
  CLAUDE.md).
- 2026-10-03 — bench: PEAK's echo turned out to be "on the wire", not
  "acknowledged" (121 § Blockers). The rule stands; on PEAK the wire's
  own account of a failed transmission is the controller's TEC, carried
  in every error frame, so an echo from an error-passive transmitter is
  withheld. Phase 2's durable rule must state the PEAK caveat.
- 2026-10-03 — phase 3 (bench) **met** with 121/161's confirmation. Open:
  phase 2 — the durable rule (ADR, CONTEXT.md, CLAUDE.md, with the PEAK
  caveat), the refused `Tx ✗` row's reach (queue § 1), the bridge `Tx`
  drop (queue § 1), the plot's closed gaps (queue § 3).

- 2026-10-07 — **Owner rulings for phase 2 (queue § 1 → § 2).**
  (1) The refused `Tx ✗` row — the row the host writes when the driver
  refuses a send (queue full, bus-off) — leaves the parsing and plotting
  machinery entirely: no decode, no per-message count, no `fps.tx`, no
  logger output, no export. The trace row itself is the refusal's one
  record (a `UndeliveredTx` filter everywhere else). (2) The virtual bus
  behaves like a physical bus: the bridge carries the `Tx` frames it
  pulls from the far side instead of dropping them. Phase 2 = those two
  fixes, the plot's closed raw gaps if they fit (queue § 3), and the
  durable rule (ADR, CONTEXT.md, CLAUDE.md, with the PEAK caveat). Task
  file moved under `pending-closeout/` (in progress; owner's 2026-10-07
  roadmap rule).
- 2026-10-07 — For phase 2's bridge fix (queue § 3 note folded in): a
  vbus bridge counts as a recipient under ADR 0021's model — a local
  participant is echoed even when the physical bus behind the bridge
  carried nothing (0121 § Blockers, 2026-10-03). The fix must say whether
  that stands once the bridge carries far-side `Tx`.
