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

**Timing half: dominant stall FIXED (2026-07-25).** Root cause was
never timer granularity — measured: the 2 s `TraceStore` flush held
the store lock while Windows `FlushViewOfFile` pushed dirty pages
per-id/per-segment (~0.3–0.5 ms per call), stalling the fire loop's
tx-confirm `append` 10–45 ms at sim rate / ~150 ms at hardware rate.
Fix: byte-granular flush watermarks + platform-split
`Segment::queue_writeback` (Unix `msync(MS_ASYNC)` ranges; Windows
periodic data-msync = documented no-op, OS lazy writer bounds the
power-loss tail — ADR 0002 DS-2 updated). Confirmed by self-driving
run: `flush_ms` max 33→5.7 ms, `tx_late_ms` max 32→5.2 ms,
flush-seconds indistinguishable from clean seconds. Dev-build numbers.

**Rig re-measure (2026-07-25, 2×PCAN, 100 Hz ids, 60 s, dev build):**
host TX cadence fixed — σ 7.5→2.5 ms, `flush_ms` mean 50→5.4 / max
176→12.7. **On-wire (receiving dongle) still bursty and now the
dominant residual:** median 9.56 ms but p95 33 / p99 45 ms, 28% of
gaps <5 ms (0.98 ms burst floor), σ 9.5 — unchanged by the host fix.
Attribution: sidecar TX path ≈0.8–1 ms per serialized `ch.send`
(sidecar `max_send` ≈0.8 ms with `max_gap` spikes = idle-then-burst);
at ~800 TX/s per dongle that is near saturation, so frames queue and
drain in ~1 kHz trains, and occasional backpressure reaches the
scheduler (`tx_late_ms` max 73.7 while flush maxed 12.7 — not the
store). Analysis tooling: `jitter_stats.py`-style offline parse of the
spill scratch's meta segments (27 B records → per-id gap stats).

**Remaining:**

- **Sidecar TX throughput** — the new primary. Batch host→sidecar
  sends (Task 30 #10: `cannet-wire/batch.rs` exists with zero
  production consumers) and/or cut per-`ch.send` overhead. Verify
  PCAN rx timestamps are device-stamped before trusting fine rx
  percentiles (send-side `max_gap` already corroborates the
  attribution).
- Regenerate the perf baseline so `flush_ms_max` / `tx_late_ms_max`
  arm; release-build re-measure before pinning targets.
- Policy tail: missed-period policy + periodic-emission ADR; the rig
  metric (below) as the gate.

## Symptoms (observed; root cause measured 2026-07-25)

**Dominant artifact: ~150 ms scheduler stall every 2 s = trace-store
flush lock contention.** Confirmed by experiment, not inference:
temporary `tx-flush` probe beside `record_flush_ms` correlated 1:1,
phase-locked with `tx-sched` spike seconds (`flush_ms` 21/27/33/24 →
same-second `max_fire` 18/26/25/22; non-flush seconds ≤2.6 ms).
Mechanism: `TraceStore::flush_with` holds the store's inner lock
(`trace_store.rs:829`); fire loop's tx-confirm `append` blocks behind
it; expired deadlines then fire back-to-back = the visible burst.
Cadence = `TRACE_FLUSH_TICK` (2 s, lib.rs). Stall scales with buffer
growth per interval: ~20 ms @ 515 f/s (ev-demo sim), ~150 ms @
~1600 f/s (2×PCAN rig, user cursor-measured ~2 s / ~140–150 ms).
Corroborated by sidecar `max_gap` 62–390 ms with sub-ms `max_send`
(host-side delivery stall, not device). ADR 0031's `flush_ms` /
`tx_late_ms` gates watch this mechanism but gate the **mean** — spikes
this size passed clean, which is the rig-metric gap below. Dev-build
numbers; re-measure release before setting targets.

- **Timer-granularity drift — minor residual.** 8–18 ms bucket nearly
  empty in measurement (~98% of wakes <2 ms late); occasional
  12–20 ms singles. The old "up to ~15 ms `recv_timeout` lateness"
  framing overstated it as the lead cause.
- **Bunching** — not an independent defect: catch-up after the flush
  stall (dominant) or after a late wake (minor). Fix the stall, most
  bunching goes.

## Scope

- **[done] Shrink flush lock-hold** — shipped as byte-granular flush
  watermarks + platform-split `queue_writeback` (Windows periodic
  data-msync no-op; ADR 0002). Residual under the lock: manifest +
  derived write ≈ 5 ms/tick, rate-independent. Revisit only if the
  rig metric still shows it.
- **Reduce wake lateness** (residual): evaluate finer Windows timer
  granularity (`timeBeginPeriod` / higher-res wait) vs cost
  (system-wide timer effect, power) — only after the stall fix;
  today's data shows ≤2 ms typical.
- **Missed-period policy.** Late wake → drop (latest-value wins) /
  spread / burst? Current implicit policy (collapse + catch-up
  double) = the burst after a stall. Capture as ADR — durable
  periodic-emission semantics.
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
