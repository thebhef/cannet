# 0121 — The Trace Tells the Truth About the Wire

> **Reopened 2026-08-30** on the PEAK bench; **fifth report 2026-10-03**
> (the plot sat untouched through a 0.5 s dongle unplug under RBS —
> the same synthesised row, read through the signal cache). Task 160's
> audit found the row is the one writer and every consumer reads it;
> its seven follow-ons are folded into phase 1 below. Everything else this task
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

Phase 1 also carries what task 160's audit (2026-10-03) found it would
otherwise miss — see 0160's status log for the citations:
`cannet-python-wire` maps direction off a field python-can does not have
(`is_tx` → read `is_rx`); the normal open must pass
`receive_own_messages=True`; in-process virtual buses skip the
originator (`shared_bus.rs`) and need an originator echo
(`Direction::Tx`, arbitration timestamp, only when `delivered > 0`;
bridges must not double it); `fps.tx` is the row's rate (perf README and
`diag.rs` "Transmit-confirmed" reword); the sidecar's "sent=" stat is
renamed ("queued to driver"); the manual-send IPC return drops
`tx_confirm_index` and `Sent` becomes accepted; the six tests pinning
the old behaviour are rewritten; ADR 0021/0027/0039 and README passages
asserting send-time rows are corrected. Opus-sized.

**Q2 ruled 2026-10-03 (owner):** the sidecar's shared interface fans an
echo out to every session on the adapter as `DIRECTION_TX`, no
per-session matching — "consistent with the desired behavior".

## Exit criteria

Pulling the CAN cable on the bench regime
visibly changes what the trace/transmit surface says about outgoing
frames within the health poll's cadence, the behaviour is pinned by
tests against faked chip states, and the owner confirms it on the PEAK
bench.

## Blockers / side effects

- 2026-10-03: **Bridge ingress drops every `Tx` frame** — needed so the
  far side's echo of the bridge's own egress cannot double the
  originator's echo; it also drops (a) frames a co-subscriber on the
  bridged remote adapter transmitted and (b) recorded `Tx` frames from a
  bridged BLF replay server. Distinguishing them needs per-frame
  matching, which the rulings exclude. Queue § 1.
- 2026-10-03: **The refused `Tx ✗` row still feeds everything a row
  feeds** — plot samples, per-message counts, `fps.tx`, the logger, Save
  Capture. Kept per the ruling ("the queue did say no"), but it is a
  sample/count/record from an intent, which task 160's rule forbids.
  Queue § 1; 160 phase 2 owns the disposition.
- 2026-10-03: A vbus **bridge counts as a recipient**, so a local
  participant is echoed even when the physical bus behind the bridge
  carried nothing (ADR 0021's model, unchanged).
- 2026-10-03: Local venvs hold a stale `cannet-python-wire` (uv installs
  the path dependency as a copy) until `uv sync --extra dev
  --reinstall-package cannet-python-wire`; CI syncs fresh; the frozen
  sidecar and the release binary were rebuilt after the reinstall.
- 2026-10-03: python-can backends without `receive_own_messages` show no
  `Tx` rows at all — accepted (the row is the wire's).

## Status log

- 2026-10-03 — groomed: the wire writes the tx row (echo via
  `receive_own_messages`, logged as `DIRECTION_TX`), unconfirmed frames
  are dropped; one code phase plus the owner's bench confirmation. The
  acknowledgement-protocol and chip-state shapes considered on the way
  are rejected (the first for complexity the echo path makes
  unnecessary, the second for inaccuracy).
- 2026-10-03 — fifth report (plot); task 160 audit widens phase 1 (seven
  follow-ons, above); owner moved 121 to the front of the development
  sequence, right after `fix-plot-marker-refresh`. Branch
  `task121-echo-row` off `fix-plot-marker-refresh`.
- 2026-10-03 — **Phase 1 landed** as `85d8c7d7`, amended to `dd019c33` (the python client's
  `CannetBus` honours `receive_own_messages`, default `False`: own echoes
  are dropped unless asked for, as python-can does; red→green in
  `test_bus_vbus.py`) on `task121-echo-row` (off
  `fix-plot-marker-refresh`), one commit. The wire writes the `Tx` row:
  - **Sidecar:** `_bus_kwargs_for` passes `receive_own_messages = not
    listen_only` for every python-can bus. The echo needs no new code
    path — `PythonCanChannel.recv` → `message_to_frame` → `DIRECTION_TX`.
    "tx stats … sent=" → `queued_to_driver=`. Test fake channel echoes
    every send as `is_rx=False` unless opened listen-only.
  - **python-wire:** `message_to_frame` read `msg.is_tx` (python-can's
    `Message` has none, so every echo mapped to Rx) → reads `msg.is_rx`.
  - **Core:** `SharedBus` echoes the winner's frame to its originator as
    `ParticipantEvent::Frame { direction: Tx, sender: self }`, stamped with
    the arbitration timestamp, only when `delivered > 0` (zero recipients:
    `NoAcknowledger`, no echo). Bridge ingress drops `Direction::Tx`
    frames (the far side's echo of the bridge's own egress), so the
    physical/remote echo never doubles the originator echo.
    `cannet-server debug vbus` echoes through its existing drain
    (`interface_id` = own allocated id, prefix-routed by both clients).
  - **Host:** `append_tx_row` → `append_refused_tx_row`, called only when
    the enqueue is refused (manual send and scheduler batch); always marks
    `UndeliveredTx`. `TransmitResult.tx_confirm_index` dropped (frontend
    ignores the return — `TransmitPanel.tsx` `void invoke(...)`);
    `TransmitWireStatus::Sent` → `Accepted` (serde `accepted`). Ingest
    unchanged: `run_pump` already appends frames with their wire
    direction. Error tally: new `session::is_bus_fault` counts only `Rx`
    error frames (an echoed error frame we injected is a stimulus — this
    keeps today's behaviour, where the send-time row never reached the
    tally). ADR 0027 verifier already exempts `Tx` (`verification.rs`
    `wants`/`observe`) — our own counters are never checked; no change.
    `diag.rs` `tx_fps` doc reworded.
  - **Docs:** ADR 0021 (:13, fan-out § incl. bridge drop, NoAck no
    echo), ADR 0022 (frame flow: echo normalised; the "TX echo" known
    unknown removed — it was now false), ADR 0027 (step 3), ADR 0039
    (status line amended, :24, :31-32, :38-40, rejected-alt mark passage,
    new `## Amendment (2026-10-03)`; :41-47 bus-off premise untouched for
    161), README (:509-513 "as though it had been sent" clause; transmit
    § rewritten), perf README (:108-112 tx = echo rate, :343), CONTEXT.md
    (new **Tx row** entry), `cannet.proto` `direction` comment, frontend
    comments (`types.ts` `tx_delivery`, `traceTable.tsx`, `index.css`).
  - **Q2 (echo fan-out): ruled by the owner 2026-10-03** — every session
    on a shared adapter receives the echo as `DIRECTION_TX`, no
    per-session matching. Implemented as ruled (the sidecar fans out every
    received frame, echoes included); pinned by
    `test_the_drivers_echo_reaches_every_subscriber_as_a_transmitted_frame`.
