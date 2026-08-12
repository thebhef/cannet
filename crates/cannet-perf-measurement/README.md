# cannet-perf-measurement

Agent-runnable performance / integration harness. It runs a **rest-of-bus
(RBS) simulation** of a reproducible CAN workload — the
[`examples/ev-demo`](../../examples/ev-demo) EV project — synthesizing
frames from the DBCs and the project's static RBS signal values (it does
*not* replay a recorded log), and emits machine-readable metrics that a
checked-in baseline can be diffed against, so a regression shows up as a
failing comparison rather than a human noticing lag.

The harness **stands in for the GUI frontend**: it owns a real
[`TraceStore`](../../apps/gui/src-tauri/src/trace_store.rs) (reused from
the `cannet-gui` crate, not a stand-in), feeds the simulated frames into
it, and runs the same filtered-scan query load the trace view issues.

## Modes

Three modes differ only in **where the frames come from** before they
land in the model; they share one model (`TraceStore` + the filtered
scan), one metric set, and one report shape (the shared machinery is in
`runner.rs`). So a regression is attributable to the layer a mode adds.

| Mode | Frame source | Needs |
| --- | --- | --- |
| `tracebuffer` | the RBS simulation appends straight into the `TraceStore`, in-process | nothing — deterministic, CI-friendly |
| `grpc` | frames travel the real gRPC wire through an in-process `cannet-server` virtual bus (`SharedBus`) between two `cannet-client` sessions | nothing (all in-process) |
| `hardware-peak` | the python-can sidecar transmits the simulation onto a real PEAK adapter and reads it back on a second one | `uv` + the sidecar package + two physically-bridged PEAK adapters |

`tracebuffer` directly characterises the host-model lock contention the
perf-harness diagnosis found. `grpc` adds gRPC serialization + virtual-bus
fan-out; `hardware-peak` adds the real driver and wire.

`filter-bench` is a one-shot characterization of the **filter index**
(ADR 0002 DS-3), separate from the continuous modes. `tracebuffer`'s scan
measures the *incremental count* refresh (already O(Δ)), which doesn't
exercise the index; the index's win is the **positional page fetch** —
the scan path re-scans `[0, offset]` to place a page (O(buffer)), while
the index pages in O(page) after a one-time build. `filter-bench` fills a
real `TraceStore`, resolves the predicate to its by-id candidate set, and
times the deep positional page three ways:

| field | meaning |
| --- | --- |
| `scan_positional_ms` | full forward scan to count + materialise the page — today's positioned-fetch cost, paid on every scroll |
| `index_build_ms` | one-time filter-index build (≈ one scan for a permissive predicate; far less for a selective one, which visits only candidate-id frames) |
| `index_page_us` | per-fetch index page after the build — the steady cost (O(page)) |

So a permissive `bus` filter pays ~one scan to build, then every fetch
drops from ~scan-time to microseconds; a selective `id_list` filter wins
on the build too. Flags: `--store mem|disk`, `--frames`, `--predicate`
(JSON, must be id-narrowable — no decode), `--offset`, `--limit`.

`signal-bench` is the analogous one-shot characterization of the
**per-signal decimation pyramid** (ADR 0002 DS-5). The pyramid is a
property of a decoded signal — a multi-resolution view of its value
series — not of any one consumer (a plot fitting all data is the consumer
today, but the property is the signal's). Before it, a whole-span serve
materialized every decoded sample in range and decimated it — O(matches),
paid on every request; the pyramid lets the host read the coarsest level
whose in-range count still exceeds the point budget, so the serve is
O(budget) regardless of the signal's length. `signal-bench` fills a real
`TraceStore`, picks the most-frequent scheduled signal, builds its
pyramid once, then times a whole-span serve two ways:

| field | meaning |
| --- | --- |
| `matches` | decoded samples for the chosen signal — the raw series length |
| `build_ms` | first serve: catch-up decode of the signal's frames + fold up the pyramid (O(that id's occurrences)) |
| `serve_naive_ms` | raw whole-span materialise + `decimate_min_max` — the per-request cost before the pyramid (O(matches)) |
| `serve_pyramid_us` | pyramid serve of the same span — the steady cost now (O(max_points)) |

So as a capture deepens, `serve_naive_ms` grows with `matches` while
`serve_pyramid_us` stays flat — at 10^8 frames the naive path is hundreds
of ms per request (jank) while the pyramid serve stays sub-ms. Flags:
`--store mem|disk`, `--frames`, `--max-points`.

## Usage

```sh
# Validate the example workload against the production parsers and print
# the schedule the RBS simulation produces.
cargo run -p cannet-perf-measurement -- validate

# Run one mode and print its metrics as JSON.
cargo run -p cannet-perf-measurement -- tracebuffer   [flags]
cargo run -p cannet-perf-measurement -- grpc          [flags]
cargo run -p cannet-perf-measurement -- hardware-peak [flags]

# Characterize the materialized filter index (ADR 0002 DS-3): fill a real
# TraceStore, then time a deep positional filtered page three ways — full
# scan, one-time index build, per-fetch index page.
cargo run -p cannet-perf-measurement -- filter-bench \
    --store disk --frames 200000 --predicate '{"bus":"pt"}' --offset 50000

# Characterize the per-signal decimation pyramid (ADR 0002 DS-5): fill a
# real TraceStore, then time a whole-span decoded-signal serve two ways —
# raw materialize + decimate vs the bounded pyramid serve.
cargo run -p cannet-perf-measurement -- signal-bench \
    --store disk --frames 2000000 --max-points 2000

# Capture a dated baseline of all modes, then check against it.
cargo run -p cannet-perf-measurement -- baseline
cargo run -p cannet-perf-measurement -- check         # exit non-zero on regression

# Include the render tier: a self-driving GUI run (ADR 0031) writes a
# RenderReport, which `baseline` stores and `check` compares. The expected
# rx/tx rates gate the live example sim's throughput as a two-sided band
# (too few *or* too many frames fails); they apply to the frontend tier
# only — host modes gate ingest relative to their own baseline.
cargo run -p cannet-perf-measurement -- \
    --frontend-report <render-report.json> \
    --expected-rx-fps 1608 --expected-tx-fps 1608 check
```

### Per-mode flags

Common to every mode: `--no-scan` (drop the contending scan — an
ingest-only control), `--scan-hz <hz>` (full-scan rate; `0` = continuous,
default 8), `--predicate <json>` (the filter the scan evaluates; an
id/bus predicate needs no decode, isolating lock cost; default
`{"bus":"pt"}`).

| Mode | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `tracebuffer` | `--store` | mem | store backend: `mem` (in-RAM) or `disk` (the disk-spill store, ADR 0002) — drives the disk store on the same in-process model load so it can be measured before it becomes the production path |
| | `--target-frames` | 200000 | stop once the buffer holds this many frames |
| | `--ingest-hz` | 25000 | append pace (frames/s); `0` = flat-out |
| `grpc` | `--target-frames` | 50000 | stop once the receiver has stored this many |
| | `--tx-hz` | 5000 | transmit pace (offered wire load); `0` = flat-out |
| `hardware-peak` | `--target-frames` | 20000 | stop once the receiver has stored this many |
| | `--tx-hz` | 1000 | transmit pace onto the bus; `0` = flat-out |
| | `--speed-bps` | 500000 | bit rate to configure the PEAK adapters at |
| | `--via-server` | — | measure through a locally spawned production `cannet-server` (path to the binary) instead of dialling the sidecar directly |

(The ingest pace is accelerated far above a real bus so a run is short,
but bounded so it coexists with the scan the way a real bus does —
flat-out ingest would fill the buffer before the scan runs, and would
pathologically starve on the unfair mutex.)

### Measuring proxy overhead

`hardware-peak --via-server <path-to-cannet-server>` points the same run
at a locally spawned production server instead of the sidecar: the
harness reserves a loopback port, spawns the binary **bare** (`--bind`,
no subcommand — the production hardware proxy, ADR 0040), waits until an
enumeration crosses it, then runs the identical workload against that
address. The server supervises its own sidecar, so the run differs from
the direct one by the proxy hop and nothing else, and the report is the
same shape — tagged `hardware-peak-proxy` so the two can't be confused.
Comparing several runs of each is how proxy overhead is measured; the
`baseline` / `check` gate always takes the direct path.

A `cargo build -p cannet-server` (debug) binary resolves its sidecar from
the source tree via `uv`, the same sidecar the direct path spawns — which
is what keeps the comparison apples-to-apples. A release binary instead
wants the frozen onedir unpacked beside it.

## The report

Every mode prints (and `baseline` stores a subset of) this JSON:

| field | meaning |
| --- | --- |
| `mode` | which mode produced the report (`tracebuffer` / `grpc` / `hardware-peak` / `hardware-peak-proxy`) |
| `scan` / `scan_hz` | whether the contending scan ran, and at what rate |
| `ingest_hz` | the offered ingest/transmit pace the run was configured with |
| `predicate` | the filter predicate the scan evaluated |
| `target_frames` | the buffer-size stop condition |
| `frames_ingested` | frames actually stored before stopping |
| `elapsed_s` | wall-clock duration of the run |
| `ingest_fps_overall` | mean stored-frames/s over the whole run |
| `ingest_fps_first_half` / `ingest_fps_second_half` | mean rate over the first/second half by frame count |
| `fps_retention` | `second_half ÷ first_half` — ~1.0 = flat; the diagnosed bug drove it toward 0.5 (ingest halving as the buffer grew) |
| `append_ms_max` | worst single-append stall (ms) — a long lock-hold by the scan shows up here |
| `append_ms_max_second_half` | the same, restricted to the large-buffer half, where an O(buffer) lock-hold regression bites |
| `scans_completed` | how many full filtered scans ran |
| `scan_ms_mean` / `scan_ms_max` | mean / worst full-scan time (ms) |
| `rss_start_mb` / `rss_end_mb` / `rss_growth_mb` | process RSS before/after, and the growth under sustained ingest |
| `checkpoints` | `[{buffer, ingest_fps}]` — instantaneous rate at successive buffer sizes, for trend inspection |

## Baselines

`baseline` runs every mode at its defaults and writes a dated,
git-stamped file under
[`docs/performance-measurements/`](../../docs/performance-measurements)
named `<YYYY-MM-DD>-<short-hash>[-dirty].json` (`-dirty` = taken against
an uncommitted tree). A mode that can't run (e.g. no hardware) is omitted
from the file rather than failing the capture.

`check` re-runs each captured mode with the *same config the baseline
stored* and compares; it defaults to reading the promoted
`docs/performance-measurements/baseline.json` unless `--baseline <path>`
is given — promoting a dated snapshot is a deliberate copy over
`baseline.json`, not a "newest file wins" guess. A mode present in the
baseline but unrunnable now (no hardware) is **skipped, not failed**, so
`check` still gates `tracebuffer` + `grpc` on a machine without PEAK
adapters.

Gated metrics and tolerances (per host mode):

| metric | gate |
| --- | --- |
| `ingest_fps_overall` | ≥ 85 % of baseline |
| `fps_retention` | ≥ 90 % of baseline, absolute floor 0.80 |
| `append_ms_max` | ≤ 2× baseline + 5 ms |
| `scan_ms_max` | ≤ 2× baseline + 5 ms |

### Frontend tier

The host modes can't see the React / uPlot / virtualizer render tier, so a
self-driving GUI run (ADR 0031) writes a `RenderReport` that `--frontend-report`
feeds in. It carries the render-tier UX-health signals **and** the
`fps.rx` / `fps.tx` gauges reduced to a per-direction throughput — the model
splits the trace store's append rate by `Direction`, so a transmit stall is
visible even when receive holds. The render-tier longtask/lag/jank gates
stayed green while real throughput halved under the diagnosed bug; the
rate gates below are what close that blind spot.

| metric | gate |
| --- | --- |
| `longtask_ms_per_s_mean` / `_p95` | ≤ 2× baseline + floor (10 / 17 ms) |
| `lag_ms_max` | ≤ 2× baseline + 20 ms |
| `jank_fraction` | ≤ 2× baseline + 0.05 |
| `rx_fps_retention` / `tx_fps_retention` | ≥ 90 % of baseline, absolute floor 0.80 |
| `rx_fps_expected` / `tx_fps_expected` | within ±15 % of `--expected-{rx,tx}-fps` |
| `jsheap_mb_peak` / `renderer_mb_peak` / `host_mb_peak` / `tree_mb_peak` | ≤ 2× baseline + 64 MB |
| `jsheap_mb_drift_per_min` / `renderer_mb_drift_per_min` / `tree_mb_drift_per_min` | ≤ 2× baseline + 5 MB/min |
| `flush_ms_mean` | ≤ 25 ms (absolute) |
| `tx_late_ms_mean` | ≤ 18 ms (absolute) |
| `flush_ms_max` / `tx_late_ms_max` | ≤ 2× baseline + 25 ms (inert until a baseline carries them) |
| `rx_gap_p95_ratio_worst` | ≤ 2× baseline + 0.5 (inert until a baseline carries it) |
| `rx_gap_short_frac_worst` | ≤ 2× baseline + 0.03 (inert until a baseline carries it) |

The memory rows (ADR 0031) gate the renderer's growth — the JS heap
(`jsheap_mb`, reported by the frontend) and the WebView renderer process RSS
(`mem.webview_renderer_mb`, where a native/GPU climb the heap can't see
surfaces), each as a run **peak** and a least-squares **drift per minute**.
`host_mb_peak` watches the Rust host RSS (expected flat). `tree_mb` —
the whole-app RSS (host + every WebView descendant: browser, renderer, GPU,
utility) — is the holistic backstop: a leak in a process the per-process
rows don't name (the GPU process, a helper) trips neither `renderer` nor
`host` but shows in the tree, which is also the single number for
total-footprint growth. They are **inert until a baseline carries them** — a
baseline lacking the fields gates nothing, so they arm on the next
regeneration. Drift only reads as signal over a representative-length
capture (a multi-minute `--perf-capture-secs`, not the smoke-test span), so
capture a memory baseline at scenario length.

The `flush_ms` / `tx_late_ms` rows gate **host append-lock contention** (ADR
0031): the periodic `TraceStore::flush` holds the append lock, so its
duration *is* the contention, and the transmit scheduler's wake lateness is
its user-facing effect. These are signals throughput/retention is
**structurally blind** to — a periodic sub-second stall is refilled by the
catch-up burst after it, so `tx_fps` retention stays ~1.0 straight through it
(it did, while a flush stalled ingest/transmit every 2 s). The gated
statistic is the **mean**, not the peak: the regression is a *systematic*
per-flush stall (every tick slow), which moves the mean cleanly, whereas a
peak gate would flap on one-off OS writeback noise. Gated against an
**absolute** ceiling (a flush should average a few ms regardless of the
machine), always active — an absent gauge reads 0, which passes.

The `flush_ms_max` / `tx_late_ms_max` rows guard the class the mean rows
deliberately absorb: a **periodic sub-second stall with clean seconds in
between** (measured 2026-07-25 — a whole-map msync per flush tick stalled
the transmit scheduler ~150 ms every 2 s at hardware rate while both mean
rows and `tx_fps` retention stayed green). They gate the run-worst value,
baseline-relative with a generous +25 ms floor so a one-off writeback
hiccup still doesn't flap, and stay **inert until a baseline carries the
fields** — regenerate the baseline (post-fix, on quiet hardware) to arm
them.

The `rx_gap_*` rows gate **on-wire receive cadence** (ADR 0039): the
report's `rx_gap` block reduces the capture window's per-id receive
gaps — from the receiving side's device-stamped timestamps, so it is
ground truth for bunching — to the worst per-id `p95 / median` gap
ratio (the lateness tail) and the worst fraction of gaps under half the
median (the catch-up-pair signal). Every other row is blind to this
class: a burst refills throughput within the second, and `tx_late_ms`
measures the cause side only — the pre-stagger cohort regression sat at
~3.5 / ~28% (healthy rig ~1.2 / ~2%) with all other rows green. Needs a
two-node rig (real rx); a sim-only run reports no `rx_gap`, its
baseline holds 0, and the rows stay **inert until a baseline carries
them**.

The expected-rate gate is a **two-sided band**: the sim emits a deterministic
schedule — the project DBCs' cycle-time sum, ~1608 frames/s for ev-zonal
(the current frontend-baseline project), 515 for ev-demo, echoed both
directions — so a shortfall
*and* an overshoot are failures. It's baseline-independent — a uniformly-slow
run is caught even against a slow baseline — whereas retention catches
decay-with-buffer-growth regardless of the absolute level.

**Baselines are environment-relative.** Absolute throughput and scan time
scale with the host CPU (and, for `hardware-peak`, the adapters), so a
baseline is only meaningful on the machine that captured it — capture on
a machine, then `check` there detects drift. The committed files are a
record per commit, not a cross-machine constant.

## What it measures

A real bus delivers ~500 frames/s; the GUI refreshes its filtered
match-count ~8×/s by scanning the buffer under the trace-store mutex. As
the buffer grows the scan takes longer, and while it holds the lock,
append (ingest and tx-confirm) is starved — the diagnosed "ingest FPS
halves / tx spacing grows" symptom.

The harness reproduces that with a **paced** ingest side and a scan
thread at the realistic 8 Hz. With the current tactical chunked scan,
ingest keeps pace (`fps_retention ≈ 1.0`) but a single append can still
stall ~one full scan (`append_ms_max ≈ scan_ms_max`) because the
trace-store mutex is unfair — the residual the incremental match-count
fix (filtered-chrono convergence) is expected to remove. A regression
that lengthens the lock-hold pushes these numbers up; the `check` gate
catches it.

## Visual parity (`screenshot` / `screenshot-diff`)

The modes above characterize what the render tier *costs*. Two more
subcommands characterize what it *looks like*, so a change meant to be
pixel-neutral — swapping the stylesheet's literal colors for tokens,
say — is proven rather than eyeballed.

`screenshot` launches the shipping GUI on a project, walks a fixed
scenario, and writes one PNG per step:

```sh
cargo run -p cannet-perf-measurement -- screenshot \
  --gui-binary <ABS>/target/release/cannet-gui.exe \
  --project    <ABS>/examples/ev-demo/ev-demo.cannet_prj \
  --out-dir    <ABS>/shots/before --prefix before-
```

`screenshot-diff` compares two capture sets (or two single PNGs), prints
the differing-pixel count/percentage per pair, writes a magenta-marked
diff artifact per pair, and exits non-zero past `--max-diff-pct`
(default 0):

```sh
cargo run -p cannet-perf-measurement -- screenshot-diff \
  --before <ABS>/shots/before --after <ABS>/shots/after \
  --before-prefix before- --after-prefix after-
```

**Use absolute paths** — the GUI child's working directory is not the
repo root — and give it a binary with the frontend embedded
(`pnpm --dir apps/gui tauri build --no-bundle`); a plain
`cargo build --release` binary comes up with no frontend at all.

### Coverage

The scenario is written against `examples/ev-demo`, whose saved layout
already carries nine of the app's fourteen dock components; the rest are
opened the way a user opens them (toolbar buttons, the command palette
via its real `Ctrl+Shift+P` chord). A unit test asserts the union of the
steps' coverage ledgers against the full component list, so "the
captures show the whole app" is checked, not hoped. The always-on chrome
— toolbar, dock tabs, status bar, and the palette modal — is in frame
throughout.

### Determinism, and its limits

A pixel diff is only meaningful if both captures were of the same
picture, and the app renders live data. Four levers make the scenario
stand still:

- **Idle** — launched with `--project` only. Without `--connect-on-start`
  nothing connects, so no frames arrive and every rate, counter and
  follow-live window is at rest.
- **Fixed viewport** — CDP `Emulation.setDeviceMetricsOverride` pins the
  layout to `--width` × `--height` at device-scale 1, so the OS window
  geometry restored from the user's window state cannot move a pixel.
- **No animation** — `Emulation.setEmulatedMedia` forces
  `prefers-reduced-motion: reduce`, which the stylesheet honours by
  dropping its one keyframe animation.
- **Masking** — the regions that still move while idle (the status bar's
  memory readings, the system-log message counter and its wall-clock
  stamps, the plot's decaying perf badge) are hidden by a stylesheet the
  harness injects before the shutter. It sets `visibility`, never a
  color, so it adds nothing to a color comparison; and it lives in the
  harness, so it is identical on both sides of a diff. **Those regions
  are therefore outside the parity claim** — a change to their text or
  color is invisible to this check.

Measure the residual rather than assuming it: capture the same scenario
twice against one build and diff the two. On the reference machine that
floor is **0 differing pixels** on eight of the nine captures — two
independent app launches are bit-identical — so a non-zero diff there is
signal, not jitter.

The ninth (`09-palette`) has a known bistable state: the bottom dock row
(y ≈ 763–999, the band holding a plot canvas) composites under the modal
backdrop two ways that differ by **≤ 1 per channel**, chosen per run.
Both states have been observed from the same binary. Treat a palette
diff whose `max Δchannel` is 1 as that artifact; a real color change
moves channels by far more (a text change reads ~140–210). Re-measure
the floor on a new machine before trusting a number from it.

### Platform

**Windows only.** The capture speaks the Chrome DevTools Protocol, which
needs a Chromium-backed webview — WebView2. macOS (WKWebView) and Linux
(WebKitGTK) have no CDP endpoint, so this is a developer/CI check on
Windows rather than a per-platform gate (the same platform asymmetry
[ADR 0031](../../docs/adr/0031-gui-performance-automation-self-driving.md)
rejected `tauri-driver` over — but here it costs coverage of a check, not
of the measurement the ADR is about). The shipping binary is unchanged:
WebView2 opens the debugging port from the
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable the harness
sets on the child process, so no automation surface is added to the app.
