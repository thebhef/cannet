# 0163 — python-can usage review and a fault model that holds

## Why

Five fixes in a week, one symptom each (synthesised `Tx` row → task 121;
"bus-off recovers on its own" → ADR 0039 amendment; stale error-passive →
`fix-pcan-counters-decay`; PEAK echo ≠ ACK → same; PCAN auto-reset hiding
bus-off → `fix-pcan-busoff-visible`). The 2026-10-04 retest showed the
remaining defect is structural, not another symptom:

- four cable pulls totalling ≈ 45 s (sidecar rx 1 611/s → ~3 600/s error
  frames per channel each time); the sidecar transmitted again the moment
  the cable returned (`queued_to_driver` never moved);
- the host saw the **first** refusal 35 s after the wire had recovered and
  the **last** 3 min 15 s after it — 80 547 refusals (≈ 50 s of sends)
  spread over 2 min 40 s of display;
- the GUI showed a live frames/s figure with the bus disconnected, error
  counts still climbing a minute after reconnection, and "recovery" 45 s
  later — all a replay of the backlog.

Cause: every error frame is shipped as a row through an unbounded
per-session outbox (`service.py`), against a host ceiling of ~3.6 k f/s.
The same stale stream carried the clock-probe replies that split one
error blast into several events (recorded in 0161, 2026-10-04).

Owner, 2026-10-04: "I have seen other tools basically just handle this
case and cannet is totally choking on it every single time. I think we
need to do a comprehensive review of our usage of python-can."

## Scope

1. **Review (read-only).** Every python-can call site in
   `servers/cannet-local-sidecar` — `driver_python_can.py`,
   `server/shared_interface.py`, `server/service.py`, enumeration — against
   the backend contracts (python-can `pcan`, `kvaser`, `vector` source and
   vendor docs) and against how established tools treat error frames,
   controller state, queue-full and echo. Each divergence named with its
   user-visible consequence.
2. **Design.** One ADR superseding ADR 0039's fault model: error frames
   counted per episode at the sidecar, never rows; a bounded sidecar→host
   outbox that drops loud; state/counter publication cadence; per-vendor
   recovery; what the GUI shows during a fault. Phase list for the
   implementation.
3. **Implementation** per the design, after the owner's ruling on it.

Folds in: the clock-probe δ guard (0161 status, 2026-10-04 — a probe round
whose best δ exceeds the step threshold is discarded).

## Phases

| # | Phase | Shape | Status |
|---|---|---|---|
| 1 | Review | investigation, no code, no branch (owner: "no new branches right now", 2026-10-04) | done 2026-10-04 — report below |
| 2a | Investigate: H1 load experiment (fake driver, fixed modest rate, in-process client; harness kept as a slow-marked sidecar test) + trace the 72 s host park | investigation; branch `task163-fault-measure` | approved 2026-10-04 |
| 2b | ADR superseding ADR 0039's fault-model parts and amending ADR 0035; `docs/CONTEXT.md` terms (bus-error episode, control lane, dropped-frames gap, error-row cap) | design; `task163-fault-model-adr` | after 2a; **owner accepts the ADR before 3** |
| 3 | Proto (`cannet.v1`, additive): `BusErrorEpisode`, `TxRefusals`, `FramesDropped`, `InterfaceState.as_of_ns`, error-row cap on open/configure; python-wire regenerated | `task163-proto` | after the ADR |
| 4 | Sidecar: episode accumulator (PEAK / Vector-FD kind decode), row cap + reset, control lane + bounded data lane (drop oldest), refusal coalescing ≤ 4 Hz, 250 ms poll + 1 s heartbeat, D5/D10 fixes; tests | `task163-sidecar` | after 3 |
| 5 | cannet-client: decode the new messages into per-interface controller/rejection state; clock δ guard + round correlation; tests | `task163-client` | after 4 |
| 6 | Host: episodes → `busError` events with start/end; frames/s + load exclude error frames; gap event; per-bus refusals; import fold through the same builder; cap setting; park fix per 2a | `task163-host` | after 5 |
| 7 | Frontend: bus-health row (state, TEC/REC, episode summary, refusals), ongoing-episode row, gap marker, cap setting UI | `task163-frontend` | after 6 |
| 8 | Docs + checks: README, sidecar README, rustdoc, release notes | `task163-docs` | after 7 |
| 9 | Owner bench: pulls of 5 s / 60 s / 10 min, replug, PEAK bus-off | owner | exit criteria 3–4 |

Agent estimate ≈ 34 h. Every branch sits beneath `doc-closeout-2`, which
stays at the top of the stack (owner, 2026-10-04).

## Exit criteria

- [x] Review report (phase 1, 2026-10-04): call-site inventory, divergence table with
      consequences, comparison with at least three established tools.
- [x] ADR accepted by the owner (ADR 0060, 2026-10-04); ADR 0039's fault model superseded where
      the two disagree; `docs/CONTEXT.md` terms added.
- [ ] A cable pull of any length shows: one event per bus per blast, the
      fault within ~1 s of the wire, recovery within ~2 s of the wire, no
      frames/s figure from error frames, and a bounded host-side backlog.
- [ ] Bench-confirmed by the owner.

## Status

- 2026-10-04 — task opened from the retest findings above; phase 1 launched
  and reported the same day (Opus, read-only; nothing in the tree touched).
  Two corrections to the premise in *Why*: (a) the host ingest is not a
  constant ~3.6 k f/s ceiling — the `fps=` health field is the frame-time
  rate readout; measured ingest (Δ`trace_len`) was 1.3–1.6 k f/s while
  refusals flowed and 6.3–7.7 k f/s while draining afterwards, so the
  stream looks bound by *envelope* count (H1, unproven); (b) the sidecar
  did not "transmit again the moment the cable returned" everywhere:
  `queued_to_driver` was 0 on both channels 10:30:49–10:32:01 while each
  still read ~1 500/s — the host had stopped sending on the stale
  refusals/state it was still receiving, while the wire carried the PEAK
  tx-queue drain. Nothing was refused in that window (the refusal total
  covers only the pulls). The park trigger is not yet traced; phase 2
  names it. Queue § 3 items "clock accepts an uninformative round" and
  "sidecar→host stream buffers without bound" fold into this task (D12,
  D2/D4).
- 2026-10-04 — **phase 2a reported** (Opus; `task163-fault-measure`
  `8ad6a5ea` on `fix-events-checklist-inline`; harness only, no product
  change). **H1 refuted at the retest's load:** sidecar + gRPC deliver
  7.2 k error f/s + 1.6 k refusals/s in full in every mode (outbox peak
  28–60); the 1.3–1.6 k f/s ingest was bound downstream of the
  transport. At 2× the error rate per-frame refusals cost 0–14 % of
  frames; 4 Hz coalescing restores full delivery. **The "72 s park" was
  not a park:** `queued_to_driver` counts accepted sends only; the host
  kept offering, throttled to ≈ 330–520 sends/s across both channels,
  and PEAK refused all of them, fresh. The throttle mechanism is
  reproduced: one session's interfaces move in lockstep with the
  slowest tx worker. Why the driver refused everything for 77.6 s while
  reading ≈ 1 500 f/s is not decidable from the surviving logs (window
  rotated out). Detail: *Phase 2a report* below.
- 2026-10-04 — **phase 2b reported** (Opus; `task163-fault-model-adr`
  `efffcef8` on `task163-fault-measure`; docs only). ADR 0060
  `docs/adr/0060-a-bus-fault-is-an-episode-the-sidecar-reports.md`,
  Status **proposed** — flip to accepted on the owner's ruling. Rules
  1–8 as groomed; one figure-free rationale for T. ADR 0039 and 0035
  carry amendment notes at the affected clauses; CONTEXT.md gains
  *control lane / data lane*, *dropped-frames gap*, *error-row cap* and
  a revised *bus-error episode*. Decided beyond the rulings (owner to
  confirm):
  - **T = 1 s** for the stuck-queue flush (full + zero accepted, not
    bus-off, regardless of rx); repeats ≤ 1/s while it persists.
  - Flush per vendor: PEAK `CAN_Reset` (also empties the rx queue —
    small unmarked loss), Kvaser `canIOCTL_FLUSH_TX_BUFFER`, Vector
    `xlCanFlushTransmitQueue` else reopen; **never** python-can's
    `VectorBus.flush_tx_buffer` (it transmits a high-priority frame).
  - The flush is reported as a flush count + last time on
    `TxRefusals` (phase 3 proto gains two fields), one info line per run.
  - The silent-queue reopen (2 s) **stays** as the escalation for a
    controller that neither transmits nor errors.
  - Missed periods: the host scheduler reserves a request-channel slot
    (`try_reserve`) before preparing; no slot → missed period, counter
    not stepped; both missed kinds (no slot, late tick) counted per bus
    beside refusals.
  - Lane keys: `BusErrorEpisode` keyed (interface, seq), backed-up
    closed episodes fold exactly into their successor; `Log`/`Error` a
    bounded FIFO with a dropped-count note; `ClockReply` latest-wins
    per session.
  - The dropped-frames gap is a host-derived kind that **persists with
    the scratch** (cannot be recomputed); not exported.
  - A reopened save's episodes count only the ≤ N rows it holds.
  Not decided (open): a peer that predates episode reports (older
  remote `cannet-server`) — its error rows would show no episodes;
  ADR 0056 has no bus subject kind, so the ADR names the bus by the
  episode id as today rather than "subject = the bus".
- 2026-10-04 — **phase 3 reported** (`task163-proto` `5793adc5` on
  `task163-fault-model-adr`; proto + regenerated gencode + tests only,
  no behaviour change). `cannet.proto` additive changes inside
  `cannet.v1` (ADR 0059): `Envelope.body` tags 14–16
  (`BusErrorEpisode`, `TxRefusals`, `FramesDropped`, with a new
  `ErrorKindCounts` message and `TxRefusalReason` enum);
  `InterfaceState.as_of_ns` (tag 6); `ConfigureBus.error_row_cap`
  (tag 5, `optional uint32`) — landed on `ConfigureBus` rather than
  `Subscribe` because it already carries per-interface session
  configuration a client resends on change (speed, FD), for both
  virtual-bus and physical interfaces, while `Subscribe` carries only
  an interface id. `buf breaking` against `v0.10.0` passes clean.
  Python gencode regenerated (`scripts/regen-proto-gencode.sh`); one
  round-trip test per new message added to `libs/cannet-python-wire`
  (`tests/test_fault_report_envelopes.py`) and to `cannet-wire`
  (`tests/round_trip.rs`). `cannet-client`'s and `cannet-server`'s
  exhaustive `Envelope::Body` matches needed one new arm each: the two
  servers (BLF replay, virtual bus) fold the three new
  server-only-direction variants into their existing "flows the other
  way" ignore group; `cannet-client`'s receive loop gets a dedicated
  log-only arm (decoding into per-interface state is phase 5).
  `cannet-wire`/`cannet-client`/`cannet-server`/`cannet-gui` all build;
  `python-wire` and the sidecar's ruff/mypy/pytest stay green against
  the regenerated stubs. Released binary built
  (`target/release/cannet-gui.exe`) via `tauri build --no-bundle`; no
  bench run (no behaviour change to measure).
- 2026-10-04 — **phase 4 reported** (`task163-sidecar` `cc8c7b85` on
  `task163-proto`; one commit, no pre-squash history). ADR 0060 rules
  1–7 on the sidecar, no deviation from the ADR. Paths under
  `servers/cannet-local-sidecar/cannet_local_sidecar/`.

  | Item | Where |
  |---|---|
  | 1 episodes | new `server/episodes.py` (`EpisodeAccumulator`); fed by `_SharedInterface._note_error_frame` from `_rx_pump`, ticked in `_poll_state`; PEAK `_pcan_bus_error`, Vector FD via `handle_canfd_event` → `PythonCanChannel._pending_fd_error` / `classify_error` (`driver_python_can.py`); `drv.BusError` + optional `OpenChannel.classify_error` (`driver.py`) |
  | 2 row cap | `EpisodeAccumulator.on_error`; `ConfigureBus.error_row_cap` → `helpers._configure_error_row_cap` → `_InterfaceRegistry.set_error_row_cap` (kept like configs, applied at next open) |
  | 3 lanes | new `server/outbox.py` (`SessionOutbox`), used by `service.Session` (old `service.py:112` queue gone) |
  | 4 refusals | `SessionOutbox.refuse` / `_report_due_locked`; `service._handle_tx`, `_SharedInterface._tx_pump`; `TxRejected.reason` (`driver.py`); D5 `_send_refusal_reason` |
  | 5 cadence | `_STATE_POLL_INTERVAL_S` 0.25, `_STATE_HEARTBEAT_S` 1.0 in `_publish_state`; `as_of_ns` in `helpers._interface_state`; D10 `PythonCanChannel._pcan_recv_fault` (+ floor in `_pcan_state`) |
  | 6 isolation | `_SharedInterface.transmit` → `put_nowait` (old `:300` 0.25 s blocking put gone) |
  | 7 flush | `_SharedInterface._flush_if_queue_stuck` (after the silent-queue reopen, which now returns whether it acted); `PythonCanChannel.flush_tx` |
  | 8 stats | `_rx_pump` stats tick: `errors=` `echoes=` / `offered=` `refused=` |

  Constants: `_DATA_LANE_FRAMES_PER_INTERFACE` 10 000 (2a's figure);
  `_LOG_LANE_MAX` 64 (4× the worst lifecycle burst: 8 interfaces × 2
  lines); `_REFUSAL_REPORT_PERIOD_S` 0.25 **per interface** (all pending
  reasons of an interface go out in one burst; the first refusal after
  a quiet period goes at once); `_EPISODE_REPORTS_PER_INTERFACE` 2
  (close of one + open of the next; a third folds the oldest);
  `_EPISODE_CLOSE_AFTER_NS` 1 s (frames' clock, or 1 s monotonic since
  the last error was read); `_DEFAULT_ERROR_ROW_CAP` 16;
  `_STUCK_QUEUE_FLUSH_AFTER_S` 1.0 (also needs a queue-full refusal
  inside the window, so stopped refusals are not flushed);
  `_PCAN_RECV_FAULT_PAUSE_S` 0.01 (a latched bus-off answers every Read
  at once; without it the rx loop would spin).

  Measurements: lockstep (`tests/test_tx_isolation.py`, in-process,
  A refusing after 5 ms, 800/s offered each) — **B 182/s before, 800/s
  after**; over gRPC (slow harness) 800/s. Fault-load harness (slow,
  2 interfaces, one run each):

  | load | refusals | counted err f/s | rows | env/s | refusal env/s/if | ctl peak | data peak | sidecar CPU |
  |---|---|---|---|---|---|---|---|---|
  | 2×3.6 k | none | 7 134 | 32 | 10 | 0 | 2 | 16 | 25 % |
  | 2×3.6 k | 1 602/s | 7 135 | 32 | 18 | 4.0 | 2 | 16 | 98 % |
  | 2×7.2 k | none | 14 273 | 32 | 10 | 0 | 2 | 16 | 37 % |
  | 2×7.2 k | 1 603/s | 14 275 | 32 | 18 | 4.0 | 2 | 16 | 110 % |

  Reader paused 10 s with data frames (2×3.6 k f/s): sends reached the
  channel at 1 572–1 628/s every second; data lane peaked at exactly
  10 000/interface, 49 959 frames dropped and the same number reported
  in `FramesDropped`; control peak 4; drained at once on resume.

  Test changes that encode ADR 0060 rather than the old shape:
  per-refusal `TX_REJECTED` → `TxRefusals`; "every clock probe gets its
  own reply" → latest-wins when replies back up; bus-off/recovery
  sequences now read the outbox between polls (state is latest-wins)
  and collapse heartbeat repeats; "queue full while errors arrive is
  left alone" → flushed, not reopened. `test_enumeration`'s
  `_install_fake_driver_config` reached the real Vector `canlib` when an
  earlier test had imported it (exposed by the new test file sorting
  first) — now via `sys.modules`.
  Checks (phase tier): ruff check / format --check / mypy / pytest
  347 passed (sidecar); `pytest -m slow tests/test_fault_load.py` 3
  passed (79 s); `cargo build -p cannet-gui` ok; comment-references
  grep clean. Frontend, MDF oracle, sidecar freeze: skipped — the diff
  touches only the sidecar's python, which none of them build or run
  (freeze skipped also because its smoke step enumerates the PEAK
  channels the owner is using). No release binary built (sidecar-only;
  the frozen sidecar is not rebuilt without the freeze lane).

  **Side effects for later phases:** (a) until phase 5 decodes the new
  messages the host shows **no refusal tally** (refusals were `Error`
  envelopes) and **no episodes**, and the trace holds ≤ 16 error rows
  per episode — the bench should not be pointed at this branch alone;
  (b) a backed-up closed episode folds into its successor, so the host
  may never see seq N's closing report: phase 5/6 must treat a report
  for seq M as closing every open seq < M on that interface;
  (c) `ConfigureBus` still reopens the channel on every receipt, so a
  host that resends it just to change `error_row_cap` (phase 6/7)
  reopens a live bus — see the queue item.
- 2026-10-04 — **fix landed** (`task163-sidecar` amended to `16cf17ed`,
  still one commit on `task163-proto`): side effect (c) above is
  closed. `_SharedInterface.reconfigure` (`shared_interface.py`) now
  compares the incoming `OpenConfig` against the live one and reopens
  only when it actually changed; a `ConfigureBus` that only carries a
  new `error_row_cap` applies the cap (already a separate path, via
  `set_error_row_cap`) and leaves the channel alone. Failing-first
  regression: `tests/test_shared_interface.py::
  test_configure_bus_with_unchanged_open_config_does_not_reopen`;
  `test_configure_bus_while_open_close_and_reopens` continues to prove
  a real config change still reopens. README's `ConfigureBus` bullet
  corrected to match (cites ADR 0060).

### Phase 2a report (2026-10-04)

**Method.** `servers/cannet-local-sidecar/tests/test_fault_load.py`
(slow-marked; `uv run --extra dev pytest -m slow
tests/test_fault_load.py -s`, ≈ 90 s). It runs the real `service.py` /
`shared_interface.py` behind `serve("127.0.0.1:0")` with a fake channel.
The channel paces error frames by sleeping until each is due and
refuses every send `queue_full`. A **python grpc client runs in a child
process**, so it does not share the sidecar's GIL. The Rust
`cannet-client` was not used: it has no entry point that subscribes
outside the GUI host, so driving it would take a new example binary
plus pytest→cargo plumbing. Coalescing is modelled in the test by an
instrumented outbox that folds `TX_REJECTED` envelopes into one per
250 ms; it also records peak depth. No hardware, loopback only, no
mDNS.

**H1 runs** (10 s window after 2 s warm-up; three runs, band shown
where runs differed). CPU is process CPU ÷ wall time, so >100 % means
more than one core.

| load (2 interfaces) | refusals | delivered f/s | env/s | refusals/s | outbox peak | sidecar CPU | client CPU |
|---|---|---|---|---|---|---|---|
| 3.6 k err f/s each (bench) | none | 7 199–7 201 | 371 | 0 | 2 | 48–54 % | 18–19 % |
| same | per frame (today) | 7 196–7 203 | 1 965 | 1 600 | 28–60 | 131–137 % | 91–99 % |
| same | coalesced 4 Hz | 7 199–7 201 | 369 | 1 603 | 2 | 89–100 % | 55–67 % |
| 7.2 k err f/s each | none | 14 396–14 400 | 372 | 0 | 2–3 | 52–58 % | 16–19 % |
| same | per frame | **12 456 / 13 027 / 14 399** | 1 700–1 967 | 1 384–1 600 | **85–3 166** | 142–145 % | 80–99 % |
| same | coalesced 4 Hz | 14 397–14 400 | 370 | 1 603 | 2 | 102–107 % | 58–64 % |

- **Verdict: H1 is refuted for the sidecar and the transport at the
  retest's load.** Nothing is lost and coalescing changes nothing.
  Whatever held the host to 1.3–1.6 k f/s sits after the transport, in
  the `cannet-client` worker or the host's `run_pump`.
- **The envelope cost is real but has headroom.** At 2× the error rate,
  per-frame refusals lost 14 % and 10 % of frames in two of three runs.
  The outbox grew to 2.5–3.2 k envelopes, so the session's yield loop
  was the slow stage. Client CPU was 80 % in the worst run, so the
  sidecar's yield path (GIL shared with 8 pump threads and 2 tx workers)
  is the likelier cost. The harness cannot split yield from transport
  further. Coalescing restored 14.4 k f/s in 3 of 3 runs.
- **Caveats.** The fake `recv` is cheaper than PEAK's ctypes read, so
  the real sidecar has less than the 2× headroom measured here. The
  client sends single-frame batches; the host batches per scheduler
  tick.
- **Where the retest backlog sat (inference).** The `cannet-client`
  worker tallies refusals when it reads them (`lib.rs:1437–1449`),
  before the unbounded frame channel to the host (`lib.rs:673`).
  - Host refusals stopped at 17:33:24Z. Bus 1's accepted sends were
    back to 826 of 841/s at 17:33:19Z.
  - The summed backlog was ≈ 0–2 s at 17:30:49Z. Phase 1 computed it as
    sidecar read totals − `trace_len`, which spans every queue.
  - So the refusals were fresh at both ends, and the 228 k-frame
    backlog sat after the client worker, in the host's channel and
    pump, not in the sidecar outbox.
  - Bus 2's lines are lost, so this rests on bus 1 alone.
- **Request side under a backed-up response stream.** The client's
  reader was paused for 10 s with BDP probing off, so the transport
  stopped taking bytes; the client kept sending 1 600 sends/s.
  - The outbox reached 3 540 envelopes.
  - Sends reached the channel at 1 597–1 603/s in every second.
  - A backlogged response stream does not stall the request side.

**The 72 s "park".** All times are UTC.

The raw window has rotated out of every log file. The oldest kept
lines are `cannet.log.1` from 20:55Z and `sidecar-python-can.log.4`
from 16:30 local. The evidence below is the phase-1 agent's verbatim
excerpts, recovered from its transcript: bus 1's sidecar rx/tx stats
from 17:29:21 to 17:33:19Z, the host's per-second refusal tallies and
the host's health lines. Bus 2's stats and the sidecar's debug lines
for the window are gone.

| Time | Bus 1 sidecar (`queued_to_driver`, `read`) | Host |
|---|---|---|
| 17:28:59–17:30:07 (pulls) | **841/s accepted** throughout; error frames, read 3.5–4.0 k/s | no refusals |
| 17:30:07.9 (wire back) | accepted falls to 528–677/s; read ≈ 2.1 k/s; max_send 2–3.7 ms (pulls: 1.0–1.8) | no refusals |
| 17:30:44.2 | last accepted send (from `max_gap=77702.06 ms` at 17:32:01.918) | 17:30:44.373 first tally: ×100 "The transmit queue is full" |
| 17:30:45.9–17:32:01 | **0 accepted**, total frozen at 101 717; read 1.4–2.0 k/s | refusals arrive at **326–522/s** every second |
| 17:32:01.9 | 36/s, 34/s, then 0 until 17:32:11 | refusals continue |
| 17:32:11.9–17:33:19 | 208, then 600 → 720 → 826/s | refusals continue |
| 17:33:24 | — | last tally (+424, ×80 547 total) |

Hypotheses and how each was tested:

1. **H-gate: the ADR 0039 emission gate parked periodics on a stale
   fault reading.** **Refuted by code.**
   - The scheduler parks only when `resolve_bus_route` fails
     (`transmit_commands.rs:694–697`).
   - That happens only for a session gone or an interface reading
     `unavailable` (`session.rs:1080–1087`).
   - Warning, error-passive and bus-off keep their route
     (`tests.rs:8741` `a_bus_off_controller_still_has_a_route`).
   - Refusals feed only a tally (`rejections.rs`); no gate reads it.
   - The sidecar's "full queue with error frames is a live fault and is
     left" rule (`shared_interface.py:851–893`) decides a *reopen*. It
     never withholds a send.
   - `unavailable` cannot hold for 72 s while `recv` succeeds 1 500
     times a second: every successful read clears `_unreachable`
     (`driver_python_can.py:582`).
2. **H-park: the host stopped offering sends.** **Refuted.**
   `queued_to_driver` counts accepted sends only: a refused send
   `continue`s before the counter (`shared_interface.py:336–339` vs
   `:347–349`). Refusals arrived every second of the window. The first
   arrived within 0.2 s of the last accepted send, with the stream's
   summed lag ≈ 0–2 s. So sends were being offered and refused. The
   premise in *Status* 2026-10-04 ("nothing was refused in that window;
   the refusal total covers only the pulls") is wrong: during the pulls
   bus 1 accepted every send, so no refusal came from them.
3. **H-throttle: the offered rate collapsed to the slowest tx worker's
   pace.** **Mechanism reproduced; consistent with the window.**
   - A session's transmits are read by one thread
     (`service.py:128–146` → `_handle_tx` :256–283), which blocks in
     the per-interface `_tx_queue.put` (`shared_interface.py:300`)
     while that interface's worker is busy.
   - On the host, the backpressure reaches the single scheduler thread
     through the depth-16 request channel (`lib.rs:105`) and
     `transmit_batch`'s `blocking_send` (`lib.rs:976`). The scheduler
     drops the periods it misses (ADR 0039 rule 2).
   - Experiment (ad hoc, same fake; not committed because it asserts a
     defect): the refused sends on interface A take a slept 1 ms or
     5 ms; interface B accepts at once; 800 sends/s offered on each.
     **B received 630/s and 182/s**, locked to A's refusal throughput
     (630/s and 182/s). The 0.25 s put timeout never fired.
   - On 10-04 this fits the drop to ≈ 620/s at wire recovery, when
     sends slowed to 2–3.7 ms. It also fits the ≈ 165–260/s per
     channel in the window, where refusal arrivals equal the offered
     rate because all were refused.
4. **What made PEAK refuse every send for 77.6 s, and what released
   it.** **Open.**
   - The release (17:32:01.9) is the driver accepting again. Nothing on
     the host changed.
   - Unexplained: zero acceptance while each channel read ≈ 1 500 f/s.
     If those were our queue draining (echoes), slots would free and
     some sends would be accepted. So either the reads were error
     frames from a fault still present, or PCAN's queue-full has
     hysteresis.
   - The stats lines cannot tell these apart. Missing, cheapest first:
     - `refused=` and `offered=` per channel on the sidecar's tx stats
       line.
     - `errors=` and `echoes=` on the rx stats line.
     - Bus 2's lines for the window.
     - A file-sink line when a periodic parks or resumes.
   - The first two belong to phase 4. The last belongs to phase 6.

**Recommendations (numbers for phases 2b / 4 / 6).**

- **Refusal coalescing: 4 Hz per interface (as ruled).**
  - Measured effect: refusal envelopes drop from 1 600/s to ≈ 8/s
    across two interfaces.
  - Sidecar CPU falls ≈ 30–45 points and client CPU 30 points.
  - It removes the only loss seen (2× load).
- **Data-lane cap: 10 000 frames per interface**, evicting whole oldest
  batches (Q2's "≈ 1 s").
  - That is ≈ 1.4 s at 7.2 k f/s and ≈ 2.8 s at 3.6 k f/s.
  - A client that keeps up never exceeded 85 envelopes (≤ 1 batch per
    interface plus refusals), so the cap touches only a stalled
    reader.
- **Phase 4 (sidecar):** one interface's transmit queue must not
  throttle the session.
  - A full per-interface `_tx_queue` refuses at once into the coalesced
    refusal count instead of blocking the request thread.
  - Test: the lockstep experiment above, asserting B keeps ≥ 90 % of
    its offered rate.
  - Add the stats fields listed under 4.
- **Phase 6 (host):** there is no park to fix.
  - The single periodic scheduler blocks in `blocking_send`
    (`lib.rs:976`) when any session's request channel is full, so one
    slow session drops periods on every bus of every session.
  - Use the non-blocking `try_send` path the single-frame transmit
    already uses (`lib.rs:946`); a full channel counts as refused.
  - Add a debug-sink line per park and resume.
- **Phase 5/6 measurement:** H1's bound now sits after the transport.
  Log the client worker's envelopes and frames read per second and the
  frame-channel depth next to `trace_len`. That separates the worker
  from `run_pump` on the next bench pull.

## Grooming (2026-10-04)

Rulings from the owner (Q1–Q3) and answers taken from the codebase
(Q4, Q5, Q7, Q8). Q6 ruled and the phase list approved the same day.

**Precedent (researched 2026-10-04).** Vector CANoe/CANalyzer does not
log an acknowledge-error storm: once the channel's transmit error counter
reaches 128 (error-passive, 16 frames) the driver's **NACK error-frame
filter** suppresses further error frames, CANoe posts one system message
("The filter for the NACK error frames has been enabled!") and the Trace —
and the BLF it logs — show exactly 16 error frames until the bus recovers
(Vector KB0023696, KB0012204). SocketCAN reports bus errors only with
`berr-reporting on`; the `at91_can` driver disables the ACK-error interrupt
in error-passive state for the same reason. PCAN-View traces error frames
only on request and shows counters. A `CAN_ERROR_EXT` record costs 56 B,
the same as a classic 8-byte `CAN_MESSAGE2`; today a 10-minute pull at
~3 600/s per channel writes ≈ 240 MB of them.

- **Q1 — error-frame rows are capped per episode, and the fault is an
  event.** The sidecar forwards the **first N error frames of an episode
  as rows** (N configurable, **default 16**; an app-level setting passed
  to the sidecar per interface at open and on change — assumption, not
  yet ruled) and only counts the rest. The counter **resets when the
  episode closes** (1 s without an error — the bus has recovered), so the
  next blast gets N rows again. Every episode is also a `busError`
  **timeline event** per bus (ADR 0035 category, ADR 0056 subject = the
  bus, ADR 0057 text) with **start and end** = `first_ns`/`last_ns`,
  counts by kind and direction, TEC/REC. Export needs nothing new: the
  ≤ N rows are written as `CAN_ERROR_EXT` as today, so ADR 0035's "the
  error frames are what a save writes" stands and events stay unexported.
  frames/s and bus load still exclude error frames.
- **Q2 — drop oldest.** On data-lane overflow (cap ≈ 1 s of frames per
  interface) the sidecar evicts the oldest whole batches and emits
  `FramesDropped{interface_id, count, first_ns, last_ns}`; the host records
  a **dropped-frames gap** event on the timeline. Dropping newest was
  rejected (it recreates the minutes-late "live" display); blocking the
  rx thread was rejected (loss moves into the vendor queue, unmarked).
- **Q3 — imports behave identically to live.** Error records in a BLF/MDF
  feed the same episode builder; the first N per episode become rows and
  the rest are counted. A legacy cannet file with per-frame errors imports
  as episodes plus ≤ N rows each.
- **Q4 — 1 s fixed at the sidecar** (= `RATE_BURST_GAP_NS`); the host's
  reader gap (default 5 s) merges for display per ADR 0035 ("episodes at
  `2g` are the gap-`g` episodes merged").
- **Q5 — `unknown`** for Kvaser until a bench exists; overriding
  python-can's `_recv_internal` is the D9 pattern this task removes.
- **Q6 — run it (A).** Folded into phase 2a. The ADR records
  **decisions** (episode event, capped rows reset on recovery, two lanes,
  drop oldest and loud, cadence + heartbeat, rates exclude error frames);
  the measured numbers (envelope vs frame bound, cap sizes, H1 verdict)
  are implementation detail and live in the 2a report and as named
  constants — the ADR cites at most one figure as rationale.
- **Q7 — backlog.** Raw error-frame mode is not this task.
- **Q8 — nothing to design.** `cannet-server` is a 1:1 relay to the
  sidecar (ADR 0040); the new `cannet.v1` control messages pass through.
  `replay` and `vbus` never produce error frames.
- **Added to phase 2a:** trace the **72 s host park** (`queued_to_driver=0`
  on both channels 10:30:49–10:32:01 local while rx ≈ 1 500/s). Suspect:
  the ADR 0039 emission gate on a stale fault reading; the park ended 83 s
  before the last stale refusal reached the host, so the gate alone does
  not explain the release. Falsify from `session.rs` and the two logs
  before the ADR states what the host does with a stale reading.
- **ADR 0060 accepted (2026-10-04)** with two rulings on the points the
  2b agent decided: (6) missed periods counted and shown — ok; (7) the
  dropped-frames gap is a **durable event** (ADR 0035's durable kind,
  like the truncation marker): event store, saved with the capture,
  exported as a `GLOBAL_MARKER` — bare BLF has no record for frames a
  logging tool lost; if one turns up the export may use it. The other
  decided-here points (T = 1 s flush, per-vendor flush, flush count in
  `TxRefusals`, silent-queue reopen stays, control-lane keys, reopened
  saves read ≤ N) stand as written. Branch amended to 80608c02.

## Phase 1 review (2026-10-04)

Read-only review, 2026-10-04. Repo at `1186cfcf` (branch `doc-closeout-2`). python-can 4.6.1 (sidecar `.venv`). All times in the log excerpts are UTC (PDT + 7 h). Logs read: `%LOCALAPPDATA%/dev.cannet.app/logs/cannet.log{,.1}` (host and sidecar stats, bridged).

---

### 1. Verdict

- **What is structurally wrong:** cannet treats a bus fault as **data**. Every error frame becomes a `FrameBatch` row. Every refused send becomes its own `Error` envelope, which carries no interface id. Both travel through the same **unbounded, FIFO, per-session outbox** (`service.py:112`) as the control messages: `InterfaceState`, `ClockReply` and `Log`. When the stream falls behind, the state, the recovery and the clock all fall behind with it. Nothing is dropped, and nothing reports that it is late.
- **What python-can provides:** a per-frame `is_error_frame` flag. That is all; it gives no error kind and no counters. It also gives a `send()` that raises per frame with backend text, a `BusABC.state` that cannot be used (always ACTIVE; PEAK's is a stored config value), and backend-specific echo semantics behind one `is_rx` flag.
- **What python-can does not provide:** error-frame aggregation, fault-state events, queue-full classification, recovery, or backpressure. Every established tool builds those above the driver.
- **The reference design is SocketCAN.**
  - Per-bus-error frames are opt-in (`berr-reporting` off by default, because bus-error interrupts flood at about 10 kHz).
  - State changes are single events (`CAN_ERR_CRTL`, `CAN_ERR_BUSOFF`, `CAN_ERR_RESTARTED`).
  - Counters are statistics (`ip -s -d link`: `berr-counter`, `bus-errors`, `error-pass`, `bus-off`, `restarts`).
  - Drops are counted and reported (`SO_RXQ_OVFL`).
  - Linux's `peak_usb` consumes PEAK bus-error reports **inside the driver** to track counters, which is exactly why cannet needs them, and does not forward them unless asked.
- **Most expensive divergences:**
  1. D1, error frames as rows.
  2. D2, control and data sharing one FIFO.
  3. D3, one envelope per refusal.
  4. D4, no bound anywhere on the stream path.
  5. D12, the clock probe accepting stale replies.
- **Corrected bench premise:** the "~3.6 k f/s host ingest ceiling" is not a constant. The host `fps=` health field is the frame-time rate readout, not ingest. Ingest measured from `trace_len` growth ran at 1.3–7.7 k f/s depending on the envelope mix (§5).

### 2. Call-site inventory

Paths are relative to `servers/cannet-local-sidecar/cannet_local_sidecar/` unless prefixed. "Div" means a divergence, keyed to §3.

| # | file:line | python-can API | What we assume | pcan | kvaser | vector | socketcan (reference) | Div |
|---|---|---|---|---|---|---|---|---|
| 1 | driver_python_can.py:64 | `import can` | optional | – | – | – | – | N |
| 2 | :496 | `can.interface.Bus(interface=…, **kw)` | opens a channel | `PcanBus.__init__` forces `PCAN_ALLOW_ERROR_FRAMES` ON (pcan.py:313), ECHO on request (:329), AUTORESET only on `auto_reset` (:335) | `canOpenChannel` ×2 handles; `LOCAL_TXECHO`/`LOCAL_TXACK` = `receive_own_messages` (canlib.py:551-568) | n/a (we build `VectorBus` directly, #4) | err frames only when the `ignore_rx_error_frames=False` filter is set | N |
| 3 | :1466 | `receive_own_messages=True` | an echo is a frame the bus carried | echo when the controller **puts it on the wire**, not on ACK (bench) | `canMSG_LOCAL_TXACK`: sent "every time a message is successfully transmitted" | `XL_CAN_EV_TAG_TX_OK` / `TX_COMPLETED`: "transmitted by the CAN chip" (ACK unspecified) | loopback "right after a successful transmission" | D8 (mitigated) |
| 4 | :392-466 | `VectorBus` subclass, `handle_can_event` / `handle_canfd_event`, `xldriver.xlCanRequestChipState` | the documented seam for non-message events | – | – | FD error events (`XL_CAN_EV_TAG_RX_ERROR` 1025 / `TX_ERROR` 1026, with `errorCode` such as `ACK_ERROR` 6) also arrive here and **we ignore them** | – | **D6** |
| 5 | :578 | `bus.recv(timeout)` | `None` on timeout; raises only on device loss | raises `PcanCanOperationError` on any Read result except OK, QRCVEMPTY, ILLDATA and `BUSLIGHT\|BUSHEAVY` (pcan.py:521-563), so a `BUSPASSIVE` (0x40000) or `BUSOFF` (0x10) result would raise | `canReadWait`; raises on non-OK except NOMSG | raises except `XL_ERR_QUEUE_IS_EMPTY` | – | **D10** (risk) |
| 6 | libs/cannet-python-wire/…/python_can.py:56-76 | `Message.is_error_frame`, `.is_rx`, `.timestamp`, `.arbitration_id`, `.data` | error frame = row; `arbitration_id` = id | error frame `ID` = **error type** (0 counter-only update, 1 bit, 2 form, 4 stuff, 8 other); `DATA[0]` direction, `DATA[1]` bit position, `DATA[2]`/`DATA[3]` REC/TEC | `canMSGERR_*` kind flags (`BIT0/1`, `STUFF`, `FORM`, `CRC`, `OVERRUN`) are **dropped by python-can** (canlib.py:685 reads only `canMSG_ERROR_FRAME`) | classic: `XL_CAN_MSG_FLAG_ERROR_FRAME` row, no kind; FD: never reaches `Message` (#4) | `can_id` class bits plus `data[1..7]`; `data[6]`/`data[7]` = TEC/REC | **D1, D6** |
| 7 | :588-590, :701-727 | error frame payload bytes 2/3 | REC/TEC | matches PEAK docs (1-based DATA[3]/DATA[4]); **comment :119-120 says byte 1 is "an error-type code"; per PEAK it is the bit position** | – | – | – | D6 (doc) |
| 8 | :737-739 | `bus.send(msg)`; `str(e)` | raises `TxRejected`; queue-full is read from the text | `PcanCanOperationError`, text only, **no `error_code`**; QXMTFULL 0x80 "The transmit queue is full" matches; XMTFULL 0x1 ("Transmit buffer in CAN controller is full") does **not** | `CANLIBOperationError(error_code=-13)` `canERR_TXBUFOFL`, text from `canGetErrorText` (not matched) | `VectorOperationError(error_code=11)` `XL_ERR_QUEUE_IS_FULL`; text "xlCanTransmit failed (XL_ERR_QUEUE_IS_FULL)" (not matched) | `ENOBUFS` | **D5** |
| 9 | :807 | `bus.state` (fallback only) | live state | stored config echo (pcan.py:695) | `BusABC` → always ACTIVE | not implemented → ACTIVE | n/a | N (bypassed) |
| 10 | :866-870 | `PcanBus.status()` = `CAN_GetStatus` | floor for state; source of overrun bits | status word, bus-error flags | – | – | – | N |
| 11 | :273-330 | `kv.__canlib` (private), `canReadStatus`, `canReadErrorCounters`, `canIoCtl`, `canBusOff/On`, `bus._write_handle`, `_read_handle`, `single_handle` | private python-can internals are stable | – | private names: fragile across python-can versions | – | – | D9 (risk) |
| 12 | :1030 | `VectorBus.reset()` | in-place bus-off recovery | – | – | `xlDeactivateChannel` + `xlActivateChannel` (canlib.py:978) | `ip link … restart` / `restart-ms` | N |
| 13 | :1006-1041 (PEAK `False`) → reopen (shared_interface.py:817) | `PcanBus.reset()` deliberately not used | `CAN_Reset` clears queues only | per vendor doc | – | – | – | N |
| 14 | :1483-1488 | `auto_reset` omitted | bus-off visible to the poll | matches ADR 0039 amendment | – | – | `restart-ms` 0 = manual | N |
| 15 | :1538 | `SetValue(PCAN_ALLOW_STATUS_FRAMES, OFF)` | python-can would make status frames look like id 1 | correct | – | – | – | N |
| 16 | :1048 | `bus.shutdown()` | idempotent close | ok | `canWriteSync(100 ms)` then off/close | deactivate/close | – | N |
| 17 | :1114-1208, :1234, :1335, :1278 | `vector.canlib.get_channel_configs`, `_get_xl_driver_config` (private), `can.detect_available_configs`, `PCANBasic().GetValue` | enumeration | `PCAN_ATTACHED_CHANNELS` contends with Write (handled: no timer) | python-can detector | private `_get_xl_driver_config` | – | N (private-API note) |
| 18 | :1557 | `BitTimingFd.from_sample_point(f_clock=80 MHz)` | uniform FD timing | ok | ok | ok | – | N |
| 19 | not called anywhere | `flush_tx_buffer()` | – | not implemented (BusABC no-op) | `canIOCTL_FLUSH_TX_BUFFER` | `xlCanFlushTransmitQueue` | qdisc | N (post-recovery burst ruled accepted, b081cf2f) |
| 20 | server/shared_interface.py:149, 436 / service.py:112 | (ours) `queue.Queue()` unbounded rx handoff and outbox | the downstream keeps up | – | – | – | bounded socket rcvbuf + `SO_RXQ_OVFL` count | **D4** |
| 21 | shared_interface.py:336-338; service.py:271-273 | (ours) per-refusal `_error_envelope(CODE_TX_REJECTED)` | rare | at a fault: ~800/s per channel | same | same | `ENOBUFS` to the writer only | **D3** |
| 22 | shared_interface.py:687-727 | (ours) `InterfaceState` publish-on-change into the same outbox | arrives promptly | – | – | – | error frame on transitions only (dev.c `can_change_state`) | **D2** |
| 23 | service.py:149-156 | (ours) `ClockReply` into the same outbox | arrives promptly | – | – | – | – | **D2, D12** |

### 3. Divergence table

| ID | Divergence | User-visible consequence | Bench evidence |
|---|---|---|---|
| **D1** | Every error frame is a row end to end: sidecar → `FrameBatch` → host trace store (`trace_store/mod.rs:572-612` feeds per-bus, aggregate, by-direction and bit-load rate tracks), the by-id table, and the signal-cache error series that episodes are folded from (`bus_error_episodes.rs`). | A frames/s figure and bus load built from error frames on a disconnected bus. Error counts still climbing after reconnection, because the backlog is being replayed. 3.6 k rows/s per channel fill the trace. | Pull: sidecar `read=` 1 611 → 3 500–3 990/s per channel (17:29:35–17:30:07Z); host `fps=7975/7303` (17:29:49–17:30:49Z) with the wire faulted. |
| **D2** | Control (`InterfaceState`, `Error`, `ClockReply`, `Log`) shares the bulk FIFO outbox. | Fault state, "recovery" and refusals are shown late by however far behind the stream is. | First refusal on the host 35 s after the wire recovered, last 3 min 15 s after. Host refusal reports run 17:30:44Z–17:33:25Z while the sidecar–host frame backlog grows from ≈0 (17:30:49Z) to **≈228 k frames (17:33:10Z)**. |
| **D3** | One `Error` envelope per refused frame, with **no `interface_id`** (proto `Error`: code + message only) and no count. | Refusals cannot be attributed to a bus (the host logs per session: "127.0.0.1:51299: transmit rejected ×N"). 80 547 envelopes compete with frames for the stream. | Host tally arrived at 326–522/s; 80 547 refusals over 2 min 40 s of display. Host ingest fell to **1.3–1.6 k f/s** exactly while refusals flowed (17:30:49–17:33:10Z), then rose to **7.7 k f/s** once they stopped (17:33:30–17:34:30Z). Supports, without yet proving, that the stream is bounded by envelope count (§5 H1). |
| **D4** | No bound and no loss signal anywhere on the path: `_rx_queue`, outbox, and the client's `mpsc::channel` (`crates/cannet-client/src/lib.rs:673`). | Minutes of replay. Memory grows. "Live" views show the past with no marker saying so. | 228 k-frame peak (≈ 70 s at normal ingest); 0161: host kept receiving 45 min after the wire went silent. |
| **D5** | Queue-full is classified only by PEAK's English QXMTFULL text (`_QUEUE_FULL_TEXTS`, :133). Kvaser `canERR_TXBUFOFL` (-13), Vector `XL_ERR_QUEUE_IS_FULL` (11) and PEAK `XMTFULL` (0x1) are all missed. | ADR 0039's "full queue + 2 s silence → reopen" never fires on Kvaser or Vector, so a silent stuck controller there never recovers. | Not yet seen (no Kvaser/Vector bench). |
| **D6** | Error kind is discarded. PEAK gives type, direction and bit position; Vector FD error events are dropped entirely (Vector FD shows **no** errors); Kvaser kind flags are lost inside python-can. PEAK ID-0 "counter-only" frames are counted as errors. The comment at :119-120 is wrong about byte 1. | The GUI cannot say "ACK error: no other node is acknowledging", which is the one-line diagnosis of a pulled cable. Error counts on PEAK are inflated by counter-update frames. Vector FD faults are invisible except through chip state. | Not yet seen (kind never decoded); Vector FD unverified. |
| D7 | Vendor suppression knobs are unused (`PCAN_ALLOW_ERROR_FRAMES` forced on by python-can, Vector `xlCanSetReceiveMode`, SocketCAN err-mask). | None directly. PEAK needs error frames for TEC/REC; the fix is to consume them at the sidecar (as Linux `peak_usb` does), not to switch them off. | n/a |
| D8 | `is_rx=False` means different things per backend (PEAK: on wire; Kvaser: acknowledged; Vector: unspecified). | Already mitigated by the TEC > 127 echo gate (fix-pcan-counters-decay `e782e3df`). It stays sidecar-local, so the design below keeps it working. | 0161 bench confirmation. |
| D9 | Private python-can internals: `kv.__canlib`, `_write_handle`, `_read_handle`, `_timestamp_offset`, `vector.canlib._get_xl_driver_config`. | A python-can upgrade can silently break Kvaser state or the Vector version. | Not seen. |
| D10 | python-can's PEAK `recv` raises on a Read result of `BUSPASSIVE` or `BUSOFF`. We would then set `_unreachable` → `UNAVAILABLE` → the host **parks** periodics (ADR 0039 rule 3). | A bus fault could masquerade as an unplugged adapter. | Not seen: no "rx for … failed" anywhere in the 10-03/10-04 logs. |
| D11 | State poll 500 ms, publish on change only, no heartbeat. | The host cannot tell "unchanged" from "stale". | Indirect (D2). |
| **D12** | Clock probe: any `ClockReply` arriving while a round is open is accepted (no round correlation). `settle_round` takes the min-δ sample with **no δ bound**, and `OffsetSlew::retarget` steps above 1 s (`clock.rs:458, 510`). | The whole timeline jumps; one blast becomes several episodes. | 0161: θ −48.4 s, δ ≈ 97 s. Today: "clock offset … +16735.3 ms" at 17:38:00Z, recovered 17:43:16Z. |
| D13 | Frame-time rate windows (`RATE_WINDOW` 1 s, `rate.rs:19`) are correct for replay but show the replayed past as live. | "Live frames/s" during backlog drain. | Same as D1/D4. |

### 4. How established tools do it

| Tool | Error frames | State display | Queue-full | Recovery | Echo/ACK |
|---|---|---|---|---|---|
| **SocketCAN** (`candump`, `ip`) | Per-bus-error frames (`CAN_ERR_BUSERROR`) only with `berr-reporting on`; the doc for that mode calls bus-error interrupts something that "can really hammer the CPU" (~10 kHz). `candump` shows error frames only with an explicit err-mask (`#…`, candump.c:606-614); `-e` decodes them. Class bits in `can_id`; TEC/REC in `data[6]`/`data[7]`. | **Events on transitions only** (`can_change_state` returns early when the state did not change, dev.c). `ip -d -s link`: `state ERROR-ACTIVE (berr-counter tx 0 rx 0)`, plus `re-started bus-errors arbit-lost error-warn error-pass bus-off` counters. | `ENOBUFS` to the writer; bounded rx socket with `SO_RXQ_OVFL` drop count (candump `-d`, candump.c:692-837). | `restart-ms` N → automatic restart N ms after bus-off; `ip link set canX type can restart` manually; `CAN_ERR_RESTARTED` event. | Loopback "right after a successful transmission". |
| **Linux `peak_usb`** | Always requests BERR from PCAN-USB, because "the management of the transition to the ERROR_WARNING or ERROR_PASSIVE state is done according to the error counters". It consumes them in the driver and forwards `CAN_ERR_BUSERROR` only if userspace asked. | as above | as above | as above | – |
| **PCAN-View** (PEAK) | Error frames recorded in the Tracer only when tracing of error frames is activated (v3.0.6); error position decoded (v4.1.3). | Status bar bus status "OK", "Bus Warning", "Error Passive" (v4.0.28), plus bus-off. | Status-bar **counters** for "Overrun" and "QXmtFull" (v3.1.0): a count, not a row per refusal. | Manual reset (Receive "Rst" / Transmit "Reset" per PEAK manuals); auto-reset optional. | n/a |
| **Vector CANalyzer/CANoe** | The Trace can show error frames; the **Statistics / Bus Statistics** window shows "counters/rates for frames and errors", "total frequencies of data, remote, error and overload frames, bus loading and CAN controller status", and TEC/REC. XL API: `xlCanSetReceiveMode` suppresses error frames and chip-state events. | Chip state (active/warning/passive/bus-off) in statistics. | XL `XL_ERR_QUEUE_IS_FULL` returned to the caller. | `xlDeactivateChannel`/`xlActivateChannel`. | TX receipt event. |
| **SavvyCAN** | Error frames become rows (`frameId + 0x20000000`, serialbusconnection.cpp:196-201). | – | – | – | `hasLocalEcho()` → not Rx (:211). |
| SavvyCAN, backpressure | Fixed-size lock-free queue (`LFQueue`, `setSize(pQueueLen)`, canconnection.cpp:33). When it is full, `getQueue().get()` returns null and the frame is **dropped** ("can't get a frame, ERROR", :224). | | | | |

Common pattern: error **counts, rates and state** are first-class and cheap. Per-error rows are opt-in or diagnostic, and every buffer between driver and view is bounded. cannet inverts this.

Sources:
- [docs.kernel.org/networking/can.html](https://docs.kernel.org/networking/can.html)
- [linux error.h](https://raw.githubusercontent.com/torvalds/linux/master/include/uapi/linux/can/error.h)
- [linux dev.c](https://raw.githubusercontent.com/torvalds/linux/master/drivers/net/can/dev/dev.c)
- [peak_usb BERR patch](https://www.spinics.net/lists/linux-can/msg08636.html)
- [berr-reporting / flood discussion (xilinx_can patch)](https://www.spinics.net/lists/linux-can/msg02359.html)
- [can-utils candump.c](https://github.com/linux-can/can-utils/blob/master/candump.c)
- [PCAN-View version history](https://www.peak-system.com/support/software-information/software/pcan-view/)
- [PCAN-Basic Error Frames](https://www.peak-system.com/documentation/API/PCAN-Basic.Net/html/d8b8c576-cc90-4757-a914-4a503f9553d1.htm)
- [PCAN-USB Pro manual](https://www.peak-system.com/produktcd/Pdf/English/PCAN-USB-Pro_UserMan_eng.pdf)
- [Vector CANalyzer/CANoe (ESA)](https://indico.esa.int/event/162/contributions/1184/attachments/1162/1375/Analysis_and_Test_of_CAN_Applications.pdf)
- [XL Driver Library manual](https://cdn.vector.com/cms/content/products/XL_Driver_Library/Docs/XL_Driver_Library_Manual_EN.pdf)
- [SavvyCAN source](https://github.com/collin80/SavvyCAN/tree/master/connections)

### 5. Pipeline accounting

| Stage | Location | Bound | Observed (10-04) |
|---|---|---|---|
| Driver rx queue | PEAK / XL (`rx_queue_size` 2^14 events) / CANlib | vendor; overrun reported (PEAK bits, XL flag) | no overrun |
| rx thread `ch.recv` | shared_interface.py:521 | CPU; one ctypes read per frame | kept up: `read=` up to 3 990/s per channel |
| `_rx_queue` | shared_interface.py:149/436 | **unbounded** | `queue=` ≤ 5 throughout, so the pack thread keeps up |
| pack → `FrameBatch` | :623; 5 ms flush, ≤ 2 048 frames | ~200 envelopes/s per interface | – |
| tx worker refusals | :336-338 | **1 envelope per refused frame** | ≈ 1 600/s produced at a fault (2 × ~800/s sends) |
| per-session `outbox` | service.py:112 | **unbounded**, FIFO, carries control too | peak backlog **≈ 228 k frames** at 17:33:10Z (sidecar `read` totals − host `trace_len`), plus the refusal envelopes |
| gRPC yield + transport | service.py:173-177, sync server, 16-thread pool | **envelope-count-bound (H1, unproven)** | — |
| client worker | cannet-client lib.rs:1350-1530; per-refusal `tracing::warn!` + tally | per envelope | refusals arrived at 326–522/s |
| client → host | lib.rs:673 `mpsc::channel` | **unbounded** | – |
| host `run_pump` | session.rs:922; per-frame append + verifier + health | measured ingest (Δ`trace_len`/20 s) | **1.3–1.6 k f/s** while refusals flowed; **6.3–7.7 k f/s** while draining after; 2.4–4.0 k f/s on the night of 10-03 (14 M refusals). The `fps=` field (3 623 etc.) is the frame-time **rate readout**, not ingest. |
| rate windows | rate.rs:19,26 | 1 s window, 20 ms samples | counts error frames (D1/D13) |
| bus-health tally | bus_health.rs:63 | 1 s burst gap, 1 s poll | fed by backlogged frames |
| episodes | bus_error_episodes.rs | `bus_error_episode_gap_s` 5 s (min 1 s), bounded by capture time ÷ gap | split by clock steps (D12) |
| clock probe | lib.rs:111-142; clock.rs:445,458 | 4 probes, 20 ms apart, 2 s deadline, 30 s re-probe; slew 5 ms/s; step > 1 s; **no δ bound, no round correlation** | +16.7 s step, 17:38:00Z |
| state poll | shared_interface.py:59,67,77 | 500 ms; bus-off reset after 1 s; queue-full + silence reopen after 2 s | no reopen or bus-off in the 10-04 window |
| tx queue | :43-45 | bounded 256, 0.25 s grace | – |

**H1 (hypothesis, not proven):** the sidecar→host stream is bound by **envelope count**, not frame count. Two candidate mechanisms that the logs cannot separate:
- a GIL convoy, where the session generator thread re-acquires the GIL against 8 busy pump threads, costing up to the 5 ms switch interval per hand-off;
- per-envelope cost in the client worker.

The per-refusal envelopes are what the counts point at. **Falsifying experiment** (phase 2, no hardware): a fake driver at a fixed 7.2 k error frames/s plus 1.6 k refusals/s through the real service and an in-process client. Measure delivered frames/s with refusals sent per frame versus coalesced. If coalescing does not lift frames/s, H1 is wrong and the bottleneck is per-frame. The design below is right either way: it removes both per-error rows and per-refusal envelopes.

### 6. Design sketch for phase 2 (not the ADR)

1. **Error frames are counted per episode at the sidecar; at most N per episode become rows** (owner ruling 2026-10-04, see *Grooming*; N configurable, default 16 — Vector's NACK filter precedent).
   - Consumed in `PythonCanChannel.recv`, which already decodes PEAK counters. Vector FD `RX_ERROR`/`TX_ERROR` events are consumed in `handle_canfd_event`.
   - New control message `BusErrorEpisode` (additive in `cannet.v1`, ADR 0059):
     - `interface_id`, `episode_seq`
     - `first_ns`, `last_ns` (hardware stamps, same clock as frames)
     - `count`
     - `count_by_kind` {ack, bit, form, stuff, crc, other, unknown}
     - `count_tx_dir` / `count_rx_dir` (PEAK `DATA[0]`)
     - `tec`, `rec` at `last_ns`
     - `open` (bool)
   - Kind per vendor: PEAK from the frame ID (ID 0 = counter-only: updates TEC/REC, **not counted**), with "ACK" recognised from the bit position (ACK slot/delimiter). Vector FD from `errorCode`. Vector classic and Kvaser: `unknown` (python-can drops Kvaser's flags).
   - The episode closes after **1 s** without an error (= `RATE_BURST_GAP_NS`). The host merges episodes at the reader's gap (ADR 0035) for display.
2. **A bounded outbox that drops loud.** Each session gets two lanes:
   - **Control lane:** `InterfaceState`, `BusErrorEpisode`, refusal summaries, `ClockReply`, `Log`, `Error`. Coalesced latest-wins per (kind, interface), always drained first, bounded by key count.
   - **Data lane:** `FrameBatch` only, bounded at ~1 s of frames per interface (≈ 10 k; Q2). On overflow, drop the **oldest whole batches** and emit control `FramesDropped{interface_id, count, first_ns, last_ns}`. The host records a gap marker (ADR 0010-compatible: a timeline event, not a sidecar file).
   - Refusals become `TxRefusals{interface_id, reason: queue_full|closed|listen_only|incompatible|other, count, first_ns, last_ns, last_message}` at ≤ 4 Hz. No more per-frame `Error` for transmit.
3. **State and counter cadence.** Poll every 250 ms. Publish on change, plus a 1 s heartbeat (`InterfaceState` carries `as_of_ns`) so the host can show staleness. An open episode republishes every 250 ms on the control lane. Fault reaches the screen in ≤ ~0.75 s; recovery (state active, episode closed) in ≤ ~1.5 s, within the exit criteria.
4. **Per-vendor recovery.** Keep ADR 0039's bus-off reset (PEAK reopen; Kvaser off/on; Vector deactivate/activate) and the queue-full + silence reopen. Fix D5: classify by `error_code` where python-can gives one (Kvaser -13, Vector 11), and by text for PEAK (QXMTFULL **and** XMTFULL). Fix D10: treat a `recv` raising a PEAK bus-status result as a fault reading, not as `unreachable`.
5. **What the GUI shows during a fault.**
   - Bus-health row: state, TEC/REC, "errors: N (rate/s), mostly ACK: no other node acknowledging", "sends refused: N (transmit queue full)", per **bus**.
   - Events panel: one live "ongoing" episode row per bus per blast, finalised at close.
   - frames/s and bus load **exclude** error frames, so they drop to the true data rate (≈ 0 when the cable is pulled).
   - A dropped-frames gap marker if the data lane overflowed.
6. **Clock-probe δ guard.**
   - Client side (`crates/cannet-client/src/clock.rs`): discard a round whose best δ > `STEP_THRESHOLD_NS` (1 s) as a silent round, keeping the last measurement and logging one coalesced line.
   - Also ignore replies whose `t1` precedes the current round's first probe (round correlation).
   - With replies on the control lane, δ stays small anyway; the guard is the backstop.

Open questions raised by the review (rulings in *Grooming* below):
- **Q1. Capture fidelity** — what a live capture keeps of an error frame.
- **Q2. Data-lane overflow policy.**
- **Q3. Imports** carrying error frames.
- **Q4. Sidecar episode gap.**
- **Q5. Kvaser error kind.**
- **Q6. Run H1's falsifying load experiment** (fake driver at a fixed rate, no CAN hardware, not CPU-pegging) as phase 2's first step; ≈ 2 h.
- **Q7. Raw error-frame mode** (like `berr-reporting on`) for diagnostics.
- **Q8. Does the Rust `cannet-server` need the same messages?**

### 7. Phase list (layer, then consumers)

| # | Phase | Est. (h) |
|---|---|---|
| 2a | H1 load experiment (Q6), fake driver; numbers into the ADR | 2 |
| 2b | ADR (supersedes ADR 0039 rule 3's echo/refusal row parts and ADR 0035's "error frames are rows"), CONTEXT.md terms (bus-error episode reported by the sidecar; control lane; dropped-frames gap) | 3 |
| 3 | Proto: `BusErrorEpisode`, `TxRefusals`, `FramesDropped`, `InterfaceState.as_of_ns` (additive, `cannet.v1`) + python-wire | 2 |
| 4 | Sidecar: episode accumulator with PEAK/Vector-FD kind decode, control lane + bounded data lane, refusal coalescing, heartbeat, D5/D10 fixes, tests | 9 |
| 5 | cannet-client: decode the new messages into the controller/rejection maps per interface; δ guard + round correlation; tests | 3 |
| 6 | Host: health + episodes from the summaries; frames/s and load exclude error frames; gap marker; per-bus refusals; import fold (Q3); capture first/last rows (Q1) | 8 |
| 7 | Frontend: bus-health row, ongoing episode, refusal and drop display | 4 |
| 8 | Docs (README, sidecar README, rustdoc) + checks | 2 |
| 9 | Owner bench: cable pull of 5 s / 60 s / 10 min; replug; bus-off | owner |
|  | **Total (agent)** | **≈ 33** |

### 8. What this review did not cover

- **Kvaser and Vector hardware behaviour.** Neither library is installed ("Vector XL library not found", "Kvaser canlib is unavailable" in the 17:27:49Z log). Every Kvaser/Vector claim here is from python-can source and vendor docs.
- **Which side of the gRPC stream is the envelope bottleneck** (H1). The logs cannot separate the sidecar yield, the transport and the client worker. I ran no experiment: the phase is read-only and no CAN hardware may be opened.
- **The exact wire timeline of the four pulls.** I relied on the stated bench facts. The log is consistent with them (wire recovered ≈ 17:30:07Z; first host refusal 17:30:44Z, i.e. +37 s), but the 17:30:47–17:32:01Z window has `queued_to_driver=0` on both channels with rx ≈ 1 500/s, which I did not resolve.
- **Out of scope:** the Rust `cannet-server` / virtual-bus path, the python client `CannetBus`, the BLF writer, frontend code, and the `examples/` project.
- **Not read:** python-can `notifier.py` beyond its header. The sidecar does not use `Notifier`.

