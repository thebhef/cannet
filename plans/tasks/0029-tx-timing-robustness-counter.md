# Task 29 — TX Timing Robustness

Two coupled defects, one root: **emission + rolling counter driven by
scheduler *tick*, not wire *send*.** Counter-per-wire-frame half
shipped (residual contract gaps below); tick cadence = remaining bulk.

Where: scheduler driver in `apps/gui/src-tauri/src/lib.rs`
(`take_due` → `fire_info` → transmit → `reschedule`); schedule in
`transmit_scheduler.rs`; counter/CRC fire path in `transmit_frames.rs`
(`Entry::prepare_send`, ADR 0027; seeding ADR 0028).

## Status

**Shipped:** stage/commit split. `prepare_send` / `send_request` /
`fire_info` compute from copy, stage stepped value;
`Entry::commit_send` promotes. Route-down tick no longer advances
counter — dominant desync source gone. Contract:
[ADR 0027](../../docs/adr/0027-calculated-fields-counter-crc.md).
Tests: `counter_advances_once_per_committed_send_not_per_tick` +
updated multi-fire tests in `transmit_frames.rs`. **[done]** tags
below = covered by that change.

**Residual gaps (review 2026-07-25).** Shipped invariant = one
increment per **Tx-confirm trace row**, not per wire frame.
`transmit_frame_inner` returns `Ok` for `wire_status: NotConnected` /
`Failed` (all `Err` arms precede Tx-confirm append). So:

- Manual path (`transmit_frame_once`) commits even fully offline.
- Scheduler commits on `is_ok()` — includes resolved-route send that
  fails (`Failed`) + session-drop window between `connected` pre-check
  and send. Same route-flap conditions that motivated fix.
- ADR 0027 wording ("reaches the wire", "after send succeeds")
  overstates code. Settle contract (design question below) → make
  code + ADR agree: gate on `wire_status == Sent`, or reword ADR to
  per-Tx-confirm.
- No test on the two `lib.rs` commit call-sites; new test =
  registry-only, "route down" simulated by not committing.
- Double-stage race (rare): manual send + scheduler fire both stage
  from same base counter → two emitted frames share counter value,
  one increment.

**Remaining bulk:** timer wake lateness, missed-period policy,
periodic-emission ADR. **Blocked on jitter-target / metrics decision**
(what wake lateness good enough; drop vs spread vs burst).

## Symptoms (observed)

- **Drift** — periodic TX "not quite on period." Grid logic
  (`next_tick_deadline`) fixed-rate, correct. Cause: OS timer
  granularity — `recv_timeout` on Windows up to ~15 ms late.
  `tx-sched` probe (`SchedDiag`) buckets it; cluster in 8–18 ms bucket
  = tell.
- **Bunching at high rate** — late wake → several deadlines expired →
  fire loop services back-to-back (catch-up doubles) → frames meant
  one period apart go out ~sub-ms apart. Sidecar `max_gap` ~2–4.5×
  nominal period, worse at higher rate.
- **[done] Counter not 1:1 with wire** — `fire_info` → `prepare_send`
  stepped counter **every tick**; `transmit_frame_inner` gated on
  route (`connected`). Step-without-send (route flap / reconnect
  race) → counter ran ahead of wire. Route-down ticks were *sole*
  desync source: connected fire always emits, so lateness/bunching
  never desynced counter. Intermittency tracks route flap, not
  bunching. (Earlier revision conflated the two; corrected 2026-07-25.)

## Scope

- **[done] Re-bind counter (and CRC) step to transmit.** No-send tick
  must not advance counter. Schedule keeps ticking for cadence;
  "what to send" separated from "mutate sequence state." (Shipped:
  stage-on-prepare / commit-on-emit.)
- **Close counter-contract gaps** (Status): settle per-wire-frame vs
  per-Tx-confirm; align commit gates + ADR 0027 wording; add tests on
  both `lib.rs` commit call-sites; decide double-stage race — fix or
  document.
- **Reduce wake lateness.** Evaluate finer Windows timer granularity
  (`timeBeginPeriod` / higher-res wait) vs cost (system-wide timer
  effect, power). Set jitter target; gate against it.
- **Missed-period policy.** Late wake → drop (latest-value wins) /
  spread / burst? Current implicit policy (collapse + catch-up
  double) = the bunching. Counter case suggests "one paced emission
  per period, distinct counter." Capture as ADR — durable
  periodic-emission semantics.
- Keep hand-written surface small + single-thread model (already
  beats old thread-per-message jitter). Work = the wait + per-tick
  policy, not rewrite.

## Design questions

- **Counter-commit contract:** counter advance on Tx-confirm that
  missed the wire (manual offline send; `Failed` send)?
  Per-Tx-confirm → trace sequence self-consistent (every logged Tx
  row distinct counter). Per-wire-frame (`wire_status == Sent`) → bus
  sequence gapless for receivers. Code today = per-Tx-confirm; ADR
  0027 claims per-wire-frame. Pick one → align both.
- `timeBeginPeriod` acceptable given process-/system-wide reach, or
  different high-res wait (waitable timer, spin-tail)? Jitter target
  (e.g. p95 wake lateness < few ms)?
- Missed-period policy: drop vs spread vs burst — differ for plain
  vs counter/CRC-bearing periodics?
- Route down: schedule keeps stepping time silently (today), no send,
  no counter advance, clean resume on reconnect?
- Multi-bus on one driver thread: slow/contended bus stalls another's
  cadence? Fire loop holds `transmit_frames` lock per message —
  confirm not a contributor.
- **Rig metric:** ADR-0031 perf rig (2 dongles, shared bus, high
  rate) exhibits bunching but no gated metric sees it — `tx_fps`
  retention ~1.0 through catch-up bursts (README admits), `tx_late_ms`
  gates *mean* wake lateness (cause-side, tail absorbed), sidecar
  `max_gap` + `tx-sched` histogram log-only. Receiving dongle's rx
  timestamps = ground-truth on-wire cadence. Candidate: per-id rx
  gap normalized to nominal period; gate short-gap count (< 0.5×
  period, bunching) + p95 gap (lateness tail) via `HostMetrics` →
  `RenderReport` → `cannet-perf-measurement check`. Per-id period
  stats exist in By-ID projection — extend, don't invent.

## Coordination with Task 30 (don't worsen debt)

- `lib.rs` TX commands + scheduler region slated for
  `transmit_commands.rs` extraction. Land 29 fixes + 29b before split
  (or after — not interleaved).
- Task 30 #12 counts bare `.lock().expect(...)`; 29a added two. Add
  no more. Accessor sweep stays Task 30.
- `transmit_frame_inner` `CanId` construction = one of Task 30 #5's
  eight dup sites. Adjacent edits fine; dedup stays Task 30.

## Exit criteria

- **[done at registry level]** Failing-first test: one counter
  increment per wire frame — unresolved-route tick no advance; N
  sends → N consecutive values. **Remaining:** tests on both `lib.rs`
  commit call-sites incl. not-`Sent` outcomes, once contract settled.
- **[partial]** Counter + CRC recomputed on transmit, not tick —
  done. Paths share mechanism, not yet one observable contract
  (manual commits offline; scheduler doesn't emit offline) — closed
  by counter-commit design question.
- Measurable bunching/jitter improvement, **machine-gated in the
  ADR-0031 perf rig** (2 dongles, shared bus, high rate): an on-wire
  cadence metric from the receiving dongle (rig-metric design
  question) lands in `RenderReport` + `check` gate and stays within
  the agreed target. Sidecar `max_gap` / `tx-sched` histogram stay as
  diagnostic logs, not the gate.
- ADR 0027 wording matches shipped gate (per-wire-frame vs
  per-Tx-confirm — currently overstates). Plus new ADR:
  periodic-emission timing semantics (missed-period policy,
  wake-lateness contract).
- Docs same-change: scheduler / fire-path rustdoc reflects new
  contract.
