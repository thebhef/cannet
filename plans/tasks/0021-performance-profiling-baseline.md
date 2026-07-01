# Task 21 — Performance Profiling Baseline

Profiling procedure that covers all three tiers — client (GUI),
server, and the wire between them. Metrics (frame throughput,
end-to-end latency from server ingest to GUI render, per-frame CPU
cost on each side, memory growth under sustained replay,
dropped-frame counts), instrumentation (in-process counters / timers,
sampling profiler hooks), and a reproducible workload (likely a
standard BLF replay at a known rate). Baseline numbers checked in
against the Task 8 build for each supported source (BLF replay + at
least one hardware vendor). Pulls in the perf backlog items the
baseline tends to motivate: `CanFramePayload` inline buffer and
precise time → frame-index mapping for the plot visible-range fetch.
(The two-tier per-signal sample cache and `TraceStore` disk-spill are
Task 18, not pulled in here — Task 18 owns the indefinite-length
model.)

## Added scope (roadmap pass)

Two things beyond the original baseline, both flagged as current
usability problems rather than future concerns:

- **Agent-runnable automated harness.** The procedure must be
  executable from a user's OS context and emit machine-readable
  numbers an agent can diff against the checked-in baseline — not only
  a manual profiler session. This is what lets a regression show up as
  a failing comparison instead of a human noticing lag.
- **Fix the two confirmed offenders the baseline characterizes:**
  - *Plot-panel UI-thread saturation.* At ~1000 msg/s with several
    plot panels / derived areas the UI thread runs at 75–100%
    utilization just displaying the stream (~200 `PlotArea` renders/s,
    750–1000 ms of >50 ms long tasks per second; this saturation is
    what made the rename-freeze bug reachable). Two fixes, one
    surface: coalesce the per-resample report fan-out (one reducer
    dispatch / rAF flush per resample instead of up to six panel
    setStates), and coalesce the per-axis resamples in per-unit mode
    (one panel-level fetch split per axis instead of N `sample_signals`
    round-trips). Folded in from the plot-panel backlog.
    - **Report fan-out coalescing — attempted, refuted.** A first cut
      collapsed the per-resample panel callbacks into one
      `onResample(areaId, report)` coalesced through a per-frame
      `requestAnimationFrame` flush. In live testing it left the
      lurch *entirely unchanged* and broke follow-live scrolling, so it
      was reverted. Takeaway: the panel-level report fan-out is **not**
      the dominant over-render cost — the next step is to instrument
      *which* component re-renders at ~200/s (candidates: each
      `PlotArea`'s per-resample `setValueTick`, or an App-level
      re-render) before changing code again.
  - *Transmit steady-state regularity.* On a 1000+ frames/s bus the TX
    message timing drifts after running a while — not stable at steady
    state. Characterize the jitter over session time. The
    time-dependence is a hypothesis worth testing: it may correlate
    with the unbounded model growth (allocator pressure as raw frames
    / indexes / sample caches accumulate), in which case it eases
    behind Task 18 — so measure TX jitter against memory growth, and
    separately rule out a fire-path stall (transmit-registry lock
    contention at high aggregate rates).

## Remaining scope (task NOT complete)

The diagnosis below is done and the ingest/TX lock offender has a
tactical fix committed, but Task 21 is **not finished**. Still owed:

- **Agent-runnable automated harness + checked-in baseline.** Not
  started. The whole "baseline numbers, diffable by an agent" deliverable
  (above) is still outstanding — what exists today is ad-hoc manual
  captures, not a reproducible harness.
- **Plot UI-thread saturation.** Unfixed. The report-fan-out cut was
  attempted and refuted (see below); the over-render driver is not yet
  localised. The eventual fix is expected to land as part of the plot
  rewrite in Task 17 Slice 4, but the *characterisation* (which
  component re-renders at ~200/s; what the 200–767 ms long tasks are)
  is still owed here.
- **Ingest/TX lock contention — full fix.** The tactical
  `scan_window_filtered` clone-deferral is committed; the durable fix
  (incremental O(Δ) match-count, bounded lock-hold) and its virtual-bus
  regression test live in **Task 17 Slice 2** and are not yet done.
- **TX steady-state regularity — diagnosed (2026-06-22); two distinct
  stalls, both fixed.** The `max_send` probe was read against a live
  high-rate capture (Bus 1 TX → Bus 2 RX loopback), and a second probe —
  `max_gap`, the idle between consecutive `ch.send` calls, measured so a
  slow send can't inflate it — was added to separate a device-side block
  from an upstream delivery gap. The single symptom was actually two
  independent problems:
  - **Periodic ~150 ms `max_send` spikes — sidecar/driver.** Spaced to
    the `WatchInterfaces` poll cadence (confirmed: bumping the poll
    interval retimed the spikes to it). Root cause: the watcher
    re-enumerated PCAN every poll via the global
    `GetValue(PCAN_ATTACHED_CHANNELS)`, which serialises against
    `CAN_Write` in the driver, so a send landing during enumeration
    blocked. Fixed by making the sidecar enumerate only on subscribe
    (the seed) and on an explicit `ListInterfaces` pull — never on a
    timer while channels are open (within ADR 0016's server-cadence
    latitude). The `max_gap` probe is kept.
  - **Growing 30→300 ms `max_gap` — host-side, buffer-proportional.**
    `max_send` stayed near-zero while `max_gap` climbed with `buffer_s`
    (rate held constant) ⇒ frames were delivered to the sidecar in
    bursts: the host's TX-frame delivery stalls, not the device. This is
    the `trace_store` filtered-scan lock (the confirmed offender)
    starving `append` — including the tx-confirm `append`. Fixed by the
    chunked, lock-releasing, `await`-yielding filtered scan (Task 17
    Slice 2 — `scan_chunk` / `frames_at`, driven from
    `fetch_filtered_trace`). Still owed there: the true O(Δ) incremental
    match-count and the full virtual-bus FPS-flat regression test.
  Neither case is frame loss (sidecar `total` == host `count`).

## Diagnosis findings (confirmed 2026-06-21)

Per-tier instrumentation was added through the diag plumbing — `diag.ts`
gauges + `diagTime`, host `frames_per_second_by_bus` on the `trace-grew`
event — logging per-bus FPS, buffer `count`, `ms.fetch_latest_by_id`, UI
`lag`/`longtask`, and render counters. Run against the RBS repro (~360
msg/s — the config sum — on Bus 1, physically looped to Bus 2; 5 message
ids; example DBC on both buses), it localised the steady-state slowdown
to **host
`trace_store` mutex contention** — not frontend rendering and not backend
ingest cost:

- **Backend ingest is O(1)/frame.** `run_pump` → `TraceStore::append`
  and the `trace-grew` emitter do no buffer-proportional work.
- **Buffer-proportional decay, isolated by a falsifying experiment.**
  With the filtered chronological trace + by-id panel open, per-bus FPS
  halves (≈440 → ≈190 /bus) as the buffer grows 5k → 180k and
  `ms.fetch_latest_by_id` climbs ≈90 → ≈200 ms (jittery). With the trace
  panels closed (plots only), per-bus FPS holds ≈440 to 205k frames —
  zero decay. Removing the panels removed the symptom.
- **The offender is `scan_window_filtered`** holding the `trace_store`
  mutex for an O(buffer) scan ~8×/s (the filtered view's scrollbar
  count refresh). The held lock starves RX `append` (FPS halves),
  tx-confirm `append` (TX spacing grows — the "transmit steady-state
  regularity" item above is the same lock), and `latest_since` (jittery
  by-id msg/s). With only 5 ids, `latest_since` compute is trivial, so
  its measured latency is pure lock-wait — the confirming detail.
- **UI thread is idle during the stall** (`lag≈0`, `longtask=0`,
  observer confirmed live): blocked on host IPC, not CPU-bound. The plot
  over-render storm is a real but separate, rate-driven (not
  buffer-driven) cost — keep it as the plot-coalescing item, not the
  ingest-decay fix.

The fix lives on Task 17 (filtered-chrono convergence) — see its Slice 2
note for the incremental-count + bounded-lock-hold requirements and the
virtual-bus regression test.

### Follow-on: frame-loss investigation — resolved, no loss

After the `scan_window_filtered` fix landed, per-bus FPS stopped decaying
with buffer size, but the stream looked *bursty*: periodic UI-thread long
tasks (200–767 ms) returned once the host lock no longer throttled the
frontend (the over-render, unmasked), and gaps appeared in the plot data
on the CAN-time axis — i.e. frames looked genuinely missing, not merely
late.

A combined, timestamp-aligned capture (sidecar + host, to ~60k frames)
**ruled frame loss out**: the sidecar's cumulative driver-read on the
active interface matched the host's stored RX count within ~2%, with the
sidecar `rx_queue`≈1 throughout and `fps` ≈ the source rate. The host
stores essentially every frame the driver delivers; the pipeline is
clean. (`drop.before_session`, the session-start-guard counter, also
stayed 0 — that silent path is not firing either.)

Two corrections came out of this, and shaped what instrumentation was
kept:

- The **source rate is ~360/s**, not 460/s (the RBS config sums to 360);
  the earlier "loss vs 460" comparison used a wrong baseline.
- A trial **ingest-gap counter** (a frame arriving late versus a per-id
  cadence ⇒ "missing" frames) proved a **false positive** — it reported
  ~47% missing while the rate-truth showed ≤2%, because it fired on
  timestamp jitter / batched arrival, not real holes. It was **removed**.
  The authoritative loss check is sidecar `total` vs host `count`.

Instrumentation kept (useful beyond this hunt): per-bus FPS
(`frames_per_second_by_bus` on `trace-grew`), the `drop.before_session`
session-start-guard counter, the sidecar `_rx_pump` `read/total/queue`
stats plus the companion `tx stats … sent=…/s max_send=… ms` line (both
stderr → System Messages), and wall-clock timestamps on the diag console
lines so sidecar and host captures can be aligned by time.

So the real residual problems are **not frame loss**: (1) frontend
UI-thread saturation / over-render (the bursty "lurch"), and (2) plot
live-edge gaps, which — since the frames are present in the buffer — are
a **render/latency artifact** of that saturation under load, worsening
with buffer size only while views are open. Both route to the
plot-coalescing fix here and the Task 17 view convergence, not to the
sidecar or driver.

**Correction (2026-06-22).** Conclusion (2) was too broad. The plot
gaps that align with the periodic ~150 ms `max_send` spikes are *not* a
render artifact — they are a genuine on-wire/timestamp hole from the
PCAN watch-loop enumeration stalling `ch.send` (see "TX steady-state
regularity" above). On the loopback those frames hit Bus 2 late and
recv-stamped late, so the gap is faithfully rendered. The
render-artifact explanation still holds for the *non-stall-aligned*
bursty lurch; the stall-aligned gaps are sidecar/driver and are fixed by
the no-timer-enumeration change.

## Handoff — current state and next steps

**Repo state.** The instrumentation and the *tactical* lock fix are
committed on this branch: the `scan_window_filtered` clone-deferral, the
`diag.ts` plumbing (gauges / `diagTime` / counters / timestamps),
per-bus FPS, `drop.before_session`, the crash recorder, and the sidecar
`rx stats`. Staged/uncommitted at handoff: the crash recorder's
`sysinfo` rework, the sidecar **`tx stats`** probe (`server.py`), and
these doc updates. Frontend and sidecar suites are green
(`pnpm --dir apps/gui test`; `uv run --extra dev pytest` + `ruff` +
`mypy`); the staged Rust `sysinfo` swap still needs
`cargo test -p cannet-gui` + `cargo clippy`.

**Do not resurrect the reverted plot change.** The rAF report-coalescing
cut is gone (no measured win, broke follow-live); its one durable lesson
is recorded on Task 17 Slice 4. Don't hand-patch `PlotArea`'s
cache/reporting surface — Task 17 Slice 4 rewrites it.

**Next, in priority order:**

1. **Localise the plot over-render (gates the plot-saturation fix).**
   With the RBS repro above running and a plot panel open, read the
   `[diag]` console: correlate the `longtask` ms spikes with which
   `diagCount` delta moves with them (`render.PlotPanel`,
   `render.PlotArea`, `plotarea.resample`, `invoke.sample_signals`).
   Prime suspects, untouched by the reverted change: the per-area
   `setValueTick` (fires every resample) and any App-level re-render.
   Wrap the synchronous resample sections (`decodeSignalsSample`, the
   auto-norm / `mergeSeries` block, `u.setData`) in `diagTime` to find
   which one is the 200–767 ms task. Localise *before* changing code.
2. **Read the TX probe — done (2026-06-22).** Both branches turned out
   to be real: a spiking `max_send` (sidecar/driver — PCAN watch-loop
   enumeration) *and* a growing `max_gap` with near-zero `max_send`
   (host-side — the trace_store lock). Both fixed; see "TX steady-state
   regularity" above. The `max_gap` probe was added to disambiguate them.
3. **Build the automated harness + checked-in baseline.** Unstarted and
   the largest remaining deliverable (see "Added scope") — a runnable
   procedure emitting machine-readable numbers diffable against a
   checked-in baseline. Best built after Task 17 stabilises the model it
   baselines against.

**Cross-task dependency.** The *durable* lock fix (incremental O(Δ)
match-count + bounded lock-hold) and its virtual-bus regression test are
**Task 17 Slice 2**, not this task — but that regression test is the
guard that keeps this task's confirmed offender dead, so the two must be
coordinated.
