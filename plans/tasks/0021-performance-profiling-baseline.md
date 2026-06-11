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
  - *Transmit steady-state regularity.* On a 1000+ frames/s bus the TX
    message timing drifts after running a while — not stable at steady
    state. Characterize the jitter over session time. The
    time-dependence is a hypothesis worth testing: it may correlate
    with the unbounded model growth (allocator pressure as raw frames
    / indexes / sample caches accumulate), in which case it eases
    behind Task 18 — so measure TX jitter against memory growth, and
    separately rule out a fire-path stall (transmit-registry lock
    contention at high aggregate rates).
