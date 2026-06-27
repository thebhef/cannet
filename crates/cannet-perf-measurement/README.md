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

## Usage

```sh
# Validate the example workload against the production parsers and print
# the schedule the RBS simulation produces.
cargo run -p cannet-perf-measurement -- validate

# Run one mode and print its metrics as JSON.
cargo run -p cannet-perf-measurement -- tracebuffer   [flags]
cargo run -p cannet-perf-measurement -- grpc          [flags]
cargo run -p cannet-perf-measurement -- hardware-peak [flags]

# Capture a dated baseline of all modes, then check against it.
cargo run -p cannet-perf-measurement -- baseline
cargo run -p cannet-perf-measurement -- check         # exit non-zero on regression
```

### Per-mode flags

Common to every mode: `--no-scan` (drop the contending scan — an
ingest-only control), `--scan-hz <hz>` (full-scan rate; `0` = continuous,
default 8), `--predicate <json>` (the filter the scan evaluates; an
id/bus predicate needs no decode, isolating lock cost; default
`{"bus":"pt"}`).

| Mode | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `tracebuffer` | `--target-frames` | 200000 | stop once the buffer holds this many frames |
| | `--ingest-hz` | 25000 | append pace (frames/s); `0` = flat-out |
| `grpc` | `--target-frames` | 50000 | stop once the receiver has stored this many |
| | `--tx-hz` | 5000 | transmit pace (offered wire load); `0` = flat-out |
| `hardware-peak` | `--target-frames` | 20000 | stop once the receiver has stored this many |
| | `--tx-hz` | 1000 | transmit pace onto the bus; `0` = flat-out |
| | `--speed-bps` | 500000 | bit rate to configure the PEAK adapters at |

(The ingest pace is accelerated far above a real bus so a run is short,
but bounded so it coexists with the scan the way a real bus does —
flat-out ingest would fill the buffer before the scan runs, and would
pathologically starve on the unfair mutex.)

## The report

Every mode prints (and `baseline` stores a subset of) this JSON:

| field | meaning |
| --- | --- |
| `mode` | which mode produced the report (`tracebuffer` / `grpc` / `hardware-peak`) |
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
stored* and compares; it reads the newest file in
`docs/performance-measurements/` unless `--baseline <path>` is given. A
mode present in the baseline but unrunnable now (no hardware) is
**skipped, not failed**, so `check` still gates `tracebuffer` + `grpc` on
a machine without PEAK adapters.

Gated metrics and tolerances (per mode):

| metric | gate |
| --- | --- |
| `ingest_fps_overall` | ≥ 85 % of baseline |
| `fps_retention` | ≥ 90 % of baseline, absolute floor 0.80 |
| `append_ms_max` | ≤ 2× baseline + 5 ms |
| `scan_ms_max` | ≤ 2× baseline + 5 ms |

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
