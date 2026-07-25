# Task 29 — TX Timing Robustness

One defect remains: **emission cadence driven by OS timer wakes, not
the nominal period.** Second suspected defect (counter not 1:1 with
wire) resolved as **not-a-defect** — see Status.

Where: scheduler driver in `apps/gui/src-tauri/src/lib.rs`
(`take_due` → `fire_info` → transmit → `reschedule`); schedule in
`transmit_scheduler.rs`; counter/CRC fire path in `transmit_frames.rs`
(`Entry::prepare_send`, ADR 0027; seeding ADR 0028).

## Status

**Counter half: resolved, no code.** Original symptom ("counter ran
ahead of wire on route flap") was LLM-captured, not deeply examined.
Ruling 2026-07-25: counter steps **per prepared send** by design —
dropped frame = real E2E gap; receivers (incl. cannet's ingest
verifier) reseed from next observed frame, so a gap costs one
violation, not a desync. Commit-on-emit staging (29a, briefly
shipped) bought nothing observable → reverted wholesale. Decision +
rejected alternative recorded in
[ADR 0027](../../docs/adr/0027-calculated-fields-counter-crc.md);
decode-side recovery semantics (single-clean-transition, no
hysteresis) documented there same change.

**Remaining: timing robustness.** Timer wake lateness, missed-period
policy, periodic-emission ADR. **Blocked on jitter-target / metrics
decision** (what wake lateness good enough; drop vs spread vs burst;
rig metric below).

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

## Scope

- **Reduce wake lateness.** Evaluate finer Windows timer granularity
  (`timeBeginPeriod` / higher-res wait) vs cost (system-wide timer
  effect, power). Set jitter target; gate against it.
- **Missed-period policy.** Late wake → drop (latest-value wins) /
  spread / burst? Current implicit policy (collapse + catch-up
  double) = the bunching. Capture as ADR — durable periodic-emission
  semantics.
- **Rig metric** (prerequisite for the gate): see design question.
- Keep hand-written surface small + single-thread model (already
  beats old thread-per-message jitter). Work = the wait + per-tick
  policy, not rewrite.

## Design questions

- `timeBeginPeriod` acceptable given process-/system-wide reach, or
  different high-res wait (waitable timer, spin-tail)? Jitter target
  (e.g. p95 wake lateness < few ms)?
- Missed-period policy: drop vs spread vs burst — differ for plain
  vs counter/CRC-bearing periodics? (Counter steps per prep either
  way — ADR 0027; policy only decides *emission* cadence.)
- Route down: schedule keeps stepping time silently (today), clean
  resume on reconnect?
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
  stats exist in By-ID projection — extend, don't invent. Caveat:
  verify dongle rx timestamps hardware-stamped, not host-stamped on
  USB read — USB batching noise decides how tight p95 can gate.

## Coordination with Task 30 (don't worsen debt)

- `lib.rs` TX commands + scheduler region slated for
  `transmit_commands.rs` extraction. Land 29 timing work before split
  (or after — not interleaved).
- Task 30 #12 counts bare `.lock().expect(...)` — add no more.
  Accessor sweep stays Task 30.
- `transmit_frame_inner` `CanId` construction = one of Task 30 #5's
  eight dup sites. Adjacent edits fine; dedup stays Task 30.

## Exit criteria

- Measurable bunching/jitter improvement, **machine-gated in the
  ADR-0031 perf rig** (2 dongles, shared bus, high rate): an on-wire
  cadence metric from the receiving dongle (rig-metric design
  question) lands in `RenderReport` + `check` gate and stays within
  the agreed target. Sidecar `max_gap` / `tx-sched` histogram stay as
  diagnostic logs, not the gate.
- ADR records periodic-emission timing semantics (missed-period
  policy, wake-lateness contract).
- Docs same-change: scheduler / fire-path rustdoc reflects new
  contract.
