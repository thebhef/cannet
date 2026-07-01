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

- **Agent-runnable automated harness + checked-in baseline — done.** The
  `cannet-perf-measurement` crate ships a reproducible workload — a
  rest-of-bus simulation of the `examples/ev-demo` EV project (two
  physically-bridged buses, seven ECUs, four DBCs, ~515 frames/s) — and
  three source modes that share one model (`TraceStore` + the filtered
  scan), one metric set, and one report shape (`runner.rs`):
  - **`tracebuffer` — in-process** (deterministic, CI-friendly): drives
    the real `TraceStore` directly against the filtered-scan contention.
    `baseline` captures a dated, git-stamped file under
    `docs/performance-measurements/`; `check` re-runs and exits non-zero
    on a gated regression.
  - **`grpc` — virtual bus**: frames travel the real gRPC wire through an
    in-process `cannet-server` `SharedBus` + two `cannet-client` sessions
    (added `cannet_server::serve_virtual_bus_ephemeral`).
  - **`hardware-peak` — full stack**: the python-can sidecar transmits
    the workload onto one PEAK adapter and reads it back on the other
    (bridged); validated on hardware (PCAN-USB ×2). Needs hardware, so
    `check` skips (not fails) it when absent.

  The `tracebuffer` mode reproduces the diagnosed contention as numbers:
  `fps_retention ≈
  1.0` (the chunked-scan tactical fix holds) but `append_ms_max ≈
  scan_ms_max` (an append can still stall ~one full scan on the unfair
  mutex — the residual the Task 17 Slice 2 incremental match-count
  removes; re-run `baseline` after Slice 2 lands and expect it to drop).
- **Frontend (render-tier) performance characterization.** The
  `cannet-perf-measurement` harness covers the host model, the wire, and
  the hardware path, but it **stands in for** the frontend — it cannot
  see the React/uPlot/virtualizer render tier, which is exactly where the
  remaining user-visible cost lives. Two things are owed:
  - **Localise the plot UI-thread saturation (immediate).** At high frame
    rates with plot panels open the UI thread runs ~75–100% (~200
    `PlotArea` renders/s, 200–767 ms long-task bursts). The report-fan-out
    cut was attempted and refuted; the over-render driver is **not yet
    localised**. Owed: instrument first — correlate the `[diag]`
    `longtask` spikes with which `render.*` / `plotarea.resample` counter
    moves with them (prime suspects: each `PlotArea`'s per-resample
    `setValueTick`, or an App-level re-render) **before** changing code.
    The *fix* is expected to fall out of the plot rewrite in Task 17 Slice
    4; this task owes the *characterisation* so Slice 4 targets the real
    driver.
  - **A representative, repeatable frontend perf measurement (durable).**
    The goal is to characterize the GUI's performance *as the user
    experiences it* — perceived smoothness under the real workload — and
    emit machine-readable numbers a baseline can diff, the render-tier
    counterpart to the host-side modes. Design questions to settle:
    - **Metrics that map to UX**, not internals: UI-thread long-task
      time per second, frames late against the ~16 ms budget (jank),
      `PlotArea` / panel renders/s, input→paint latency, and
      panel time-to-first-render. The `diag.ts` `lag` / `longtask`
      signals + render counters are the raw material. **Done**: the host
      `diag` module's `RenderReport` reduces a capture to long-task ms/s
      (mean / max / p95), lag, jank-second fraction, estimated frames-late
      per second, and per-counter / per-gauge spreads. Still missing from
      the metric set: input→paint latency and panel time-to-first-render
      (both need new frontend instrumentation, not just the existing
      counters).
    - **Representative drive**: against the real host + real frontend
      under the `examples/ev-demo` RBS workload, with representative view
      configurations (N plot panels / a trace panel / by-ID open), since
      the saturation is view- and rate-driven, not buffer-driven. The
      `examples/ev-demo` project **now carries that view set** — a
      populated `dockview` layout that opens a chronological trace, a
      by-id trace, a powertrain plot and a battery plot (each a filter-mode
      area so it draws its bus's signals), and the RBS panel, instead of
      the empty layout blob it shipped before (which rendered nothing on
      open). A `cannet-perf-measurement` test
      (`layout_opens_representative_views`) guards it against drifting back
      to empty. This committed layout is the representative view
      configuration the measurement drives; what remains is the measurement
      itself (metrics + automation).
    - **Automation — self-driving the real GUI ([ADR 0031](../../docs/adr/0031-gui-performance-automation-self-driving.md);
      partially done).** During a bracketed capture the `diag.ts` 1 Hz
      reporter pushes each second's snapshot to the host (`diag_push`);
      `diag_capture_start` / `diag_capture_finish` arm and finalise it, and
      the host reduces the series to a `RenderReport` written as JSON. Two
      ways to bracket a run: an operator from the devtools console via
      `window.__cannetPerf.begin(label)` / `.end(path)`, or **the
      self-driving launch flags** — `--project` / `--connect-on-start` /
      `--perf-capture-secs` / `--perf-out` (+ `--perf-label`), parsed by the
      host (`AutomationConfig::from_args`), served to the webview
      (`diag_autostart`), which then opens the project, connects, captures
      for the span, writes the report, and exits with no operator. The
      self-driving flow was run end-to-end on 2026-06-23 (production build,
      `ev-demo` over PCAN, ~1030 fps) and produced a valid `RenderReport` —
      ~600 `PlotArea` renders/s under load with the UI thread staying
      responsive (`lag` max 16 ms, zero janky seconds, `longtask` genuinely
      0 — the observer is live, re-confirmed by an 82 ms/s reading under a
      debug build). **Baseline/check fold — done (2026-06-24).** A
      `frontend` block now slots beside the host modes in the baseline
      file — a purely additive optional field, so no `baseline_version`
      bump and existing baselines keep checking (ADR 0011).
      `cannet-perf-measurement` gained a
      `--frontend-report <path>` flag and a `frontend` module that mirrors
      the gated UX-health subset (`longtask_ms_per_s` mean + p95,
      `lag_ms.max`, `jank_fraction`; `frames_late_per_s_mean` dropped as
      collinear with long-task mean). `baseline --frontend-report` stores
      those metrics; `check --frontend-report` gates a fresh report against
      them with the hardware-absent "compare-don't-rerun" pattern (no
      report → omitted at capture, skipped at check). `check` now compares
      against a canonical `docs/performance-measurements/baseline.json`
      (replacing the fragile "newest `.json` in the dir wins" discovery,
      which mistook a frontend report written beside the baselines for one
      and broke `check`); `baseline` still writes a dated
      `<date>-<hash>[-dirty].json` snapshot, and promoting one to the
      reference is a deliberate copy to `baseline.json`. Frontend render
      reports live under `docs/performance-measurements/frontend/`, apart
      from the host baseline they feed. Note: the committed `ev-demo` project binds to physical
      PCAN, so a hardware-free render run needs a project that binds to a
      virtual bus (a property of the saved project, per ADR 0031).
    This is end-to-end "server ingest → GUI render" latency the original
    scope named, captured at the tier the host-side harness can't reach.
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
- **TX residual jitter — grid catch-up after late wakes (observed
  2026-06-23; mechanism confirmed, root cause of the late wake not yet
  confirmed).** After the two stalls above were fixed, a 20 ms periodic
  still shows ~5–6 intervals at ~20 ms then a pair ~5 ms apart, repeating.
  This is *not* drift or loss (`sent`/s still matches the schedule
  exactly) — it's the fixed-rate grid paying back a late wake. Confirmed
  mechanism from the code: the scheduler reschedules on the grid
  (`next_tick_deadline` → `deadline + period`, not `now + period`), so a
  wake that returns ~15 ms late fires then, and the *next* grid deadline is
  only ~5 ms out → the short catch-up interval before it re-settles at
  20 ms. Corroborated by the sidecar `max_gap` (21–33 ms on the 20 ms
  message — the late wake; the 5 ms double is its payback). Magnitude is
  jitter (tens of ms), not the multi-hundred-ms stalls above. Two
  candidate causes for the *late wake* were: (a) Windows timer
  granularity (`rx.recv_timeout` ~15.6 ms unless `timeBeginPeriod(1)` is
  held), and (b) `trace_store` lock contention in the fire path (tx-confirm
  `append` blocked by the scan, same lock family as the stalls above).
  **Experiment run 2026-06-24** — a per-second wake-lateness histogram +
  max fire-duration probe (`SchedDiag`, dev-log target `tx-sched`) over a
  60 s debug run against the live PCAN bus, buffer growing 0 → 64 k frames:
  - **Timer granularity falsified.** Every second's wakes fell in the
    `<2 ms` bucket (`max_late` 1.7–2.5 ms) — the `8–18`/`18–30`/`≥30`
    buckets never populated (one lone 77 ms outlier across ~14 k wakes).
    `recv_timeout` returns within ~2 ms, so WebView2 is holding the global
    timer at ~1 ms; a `timeBeginPeriod(1)` fix would be treating a
    non-cause.
  - **No contention at 64 k frames.** `max_fire` stayed sub-millisecond
    (≤ 3.2 ms once). TX is clean at this scale — which is why the double
    only appears on *long* sessions (the original `max_gap` reading was at
    ~515 s / 530 k frames).
  So the surviving cause is (b), the **buffer-proportional
  `scan_window_filtered` lock** already documented under "Diagnosis
  findings" — not a new timer problem. **Follow-up runs (2026-06-24)
  to 250 k and 506 k frames stayed clean**: wakes held in the `<2 ms`
  bucket throughout, `max_fire` ≤ 8.65 ms (a lone outlier over ~130 k
  wakes; steady-state ~0.5 ms), `max_late` ≤ 5.9 ms. So the jitter is
  **not** a steady-state property of the running workload even at the
  buffer scale where it was originally seen (~515 s). It needs a trigger
  the *unattended* run lacks — the O(buffer) filtered / by-id scans only
  fire hard when those views are **actively scrolled / refreshed**, so the
  residual jitter is **interaction-triggered** scan-lock contention at high
  buffer, not something the live bus produces on its own. To reproduce it
  in automation we'd have to drive the heavy-view scroll (the self-driving
  flags don't). The fix still maps to the already-planned O(Δ) incremental
  match-count + bounded lock-hold (Task 17 Slice 2), **not**
  `timeBeginPeriod`.
- **Dev-terminal log firehose degraded TX regularity — fixed
  (2026-06-23).** `init_tracing_subscriber` installed a bare `fmt` layer
  with no filter, so every crate logged at TRACE (the `tonic` / `h2` /
  `hyper` transport firehose under a live gRPC session) and `RUST_LOG` was
  ignored. Volume itself wasn't the cost — it was the editor's integrated
  terminal *rendering* that firehose live (an Electron CPU sink on the same
  machine the scheduler runs on): a direct-exe run piping the same volume
  to a file was markedly steadier than `tauri dev` in the VSCode terminal.
  Fixed by giving the subscriber an `EnvFilter` (default
  `info,tonic=warn,h2=warn,hyper=warn,hyper_util=warn,tower=warn`,
  honouring `RUST_LOG`); the System Messages panel is unaffected (fed by
  `emit_system_log`, not this layer). Quieting the terminal visibly
  improved TX regularity — but the grid-catch-up jitter above remains, so
  this was a contributor, not the whole story. Broader per-source
  log-volume control (sidecar, frontend) stays the backlog item.

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
3. **Automated harness + checked-in baseline — done (all three modes).**
   `cannet-perf-measurement` ships the `examples/ev-demo` workload and the
   `tracebuffer` (in-process), `grpc` (virtual bus over real gRPC), and
   `hardware-peak` (full stack over PEAK hardware, validated) modes;
   `baseline` writes a dated file under `docs/performance-measurements/`
   and `check` re-runs and gates every captured mode
   (`cargo run -p cannet-perf-measurement -- check`). When Task 17 Slice 2
   lands, re-run `baseline` so the recorded numbers reflect the
   incremental-count model, and expect `append_ms_max` to drop well below
   `scan_ms_max`. Remaining harness polish (not blockers): fold the wire
   modes' offered-vs-achieved gap into the report, and add a `tracebuffer`
   smoke test to the default `cargo test` suite.

**Cross-task dependency.** The *durable* lock fix (incremental O(Δ)
match-count + bounded lock-hold) and its virtual-bus regression test are
**Task 17 Slice 2**, not this task — but that regression test is the
guard that keeps this task's confirmed offender dead, so the two must be
coordinated.
