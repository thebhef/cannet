# Task 71 — Perf Grooming: Gate Anomaly + Renderer Drift Trend

Opened by owner ruling 2026-08-14 out of Task 70's closeout review:
two perf questions the closeout measured but did not attribute.

## Scope

1. **Isolate the `rx_gap_short_frac_worst` gate failure.** Task 70's
   final ADR-0031 gate: run 1 failed the metric at 0.120 against a
   0.041 limit — 20× the worst of the four earlier gates — while
   runs 2 and 3 either side measured 0.002, the series minimum
   (reports: `docs/performance-measurements/frontend/`, the
   `2026-08-14-*-task70-p10-run*.json` set). Run 1 differed from the
   clean runs in two unisolated ways: first capture after a fresh
   link (cold page cache), and two watcher shells polling `tasklist`
   every 5–10 s across its window. The falsifying experiment was not
   run: warm cache with polling reintroduced alone, and cold cache
   with no polling. Attribute the failure to build, environment, or
   metric sensitivity — with the experiment's data, per the
   scientific method.
2. **Attribute the `renderer_mb_drift_per_min` trend.** Worst-to-worst
   across Task 70's four gates: 92.6 → 97.6 → 97.6 → 99.4 against a
   106.605 limit (93 %). Every phase judged its own delta
   pre-existing; nothing was ever attributed. `tree_mb_drift_per_min`
   shows the same shape with more headroom (129.0 of 165.2). Establish
   whether the rise is real growth (attribute it to a change window),
   measurement drift (e.g. machine state across a long session), or
   metric noise — then either fix the growth or record the ruling on
   what the gate should expect. **No baseline promotion without a
   root cause.**

Related recorded observation (Task 70 FYI, in scope if it turns out
to be the same mechanism): the whole-capture follow window is
expensive at 90 minutes — `longtask_ms_per_s` mean 95.4,
`jank_fraction` 0.439 at a 5401 s window — superlinear in window
length somewhere, unattributed.

## Data points from later gates (accumulating)

- **2026-08-15, task75-p1 gate (build 9eac7f5, three runs, all
  passed):** `rx_gap_short_frac_worst` 0.002 / 0.001 / 0.003 — and
  run 1 was again the first capture after a fresh link (cold-ish
  cache) but with **no watcher shells polling** this time, and it
  measured clean. One cell of the isolation matrix, observed for
  free: cold-cache-alone did not reproduce the 0.120; the polling
  leg remains untested. `renderer_mb_drift_per_min` worst-to-worst
  trend extends: 92.6 → 97.6 → 97.6 → 99.4 → **100.7** against the
  106.605 limit (94 %) — the creep continues across builds.

- **2026-08-15, task75-p5 gate (build ea9646a, runs under the new
  `--app-data-dir` isolation): run 1 FAILED `rx_gap_short_frac_worst`
  at 0.161 vs 0.041; runs 2–3 measured 0.002 / 0.001; all other
  metrics green all runs.** The matrix now holds three first-run
  cells: task70-p10 run 1 = real profile + cold link + `tasklist`
  polling → **0.120 FAIL**; task75-p1 run 1 = real profile + cold
  link + no polling → **0.002 clean**; task75-p5 run 1 = **fresh
  empty profile** (first-launch init) + cold link + no polling →
  **0.161 FAIL**. Cold link alone is exonerated (p1 run 1); the
  live suspects are first-launch initialization work and the
  polling, possibly two faces of one mechanism (extra process/disk
  activity during the capture's first seconds). Gate disposition
  follows the owner's task-70 precedent: stands on the clean runs,
  anomaly attributed here. `renderer_mb_drift_per_min` on the p5
  gate: 103.7 / 88.5 / 62.5 — worst-to-worst series now 92.6 →
  97.6 → 97.6 → 99.4 → 100.7 → **103.7** (97 % of 106.605), and
  the wide within-build spread (62.5–103.7, worst on the same run
  as the rx_gap failure) points at machine/run-state sensitivity
  as much as code growth. Comparability caveat (default-settings
  isolated profile from p5 on) recorded in ADR 0031.

## Exit criteria

- The run-1 anomaly attributed with the isolating experiment's data;
  the gate procedure amended if the environment (cold cache, polling,
  profile state) is the carrier — so a future first-run failure is not
  ambiguous. If no lever reproduces it, the procedure must say how a
  gate disposes of a sporadic single-run breach, so the ambiguity is
  closed either way.
- The renderer-drift rise attributed with data; either a fix lands,
  or the gate's expectation is re-grounded by owner ruling. No
  baseline promoted to make anything pass.
- Findings recorded in this file's status log — every experiment with
  its prediction stated before the run, its command, its data, and its
  verdict. ADR-0031 / README updated if the run procedure changes.
- Report sets that carry a finding committed under
  `docs/performance-measurements/frontend/` with the established
  naming.

## Status log

### 2026-08-14 — experiment design and predictions (stated before running)

**Reduction of the question.** `rx_gap_short_frac_worst` is the worst
per-id fraction of receive gaps shorter than half that id's median gap
(`diag.rs::rx_gap_stats`) — the bunching (catch-up-pair) signal, read
off device-stamped rx timestamps for frames appended during the
capture window. Both observed failures carry an elevated
`rx_gap_p95_ratio_worst` too (2.40 on task70-p10 run 1, 2.27 on
task75-p5 run 1, against 1.13–1.25 on every clean run in the series),
so the failures are genuine long-gap-then-short-gap bunching on the
wire, not a reduction artifact.

**Levers still live after the three observed cells.** Cold exe link
and "first run of the session" are both exonerated by task75-p1 run 1
(cold link, first run, clean at 0.002). What separates the two failing
runs from that clean one is (a) a fresh empty `--app-data-dir` profile
paying first-launch initialization inside the capture window
(task75-p5 run 1), and (b) two watcher shells walking the process
table every 5–10 s across the window (task70-p10 run 1).

**Matrix.** Constant release binary
`target/release/cannet-gui.exe` (built at `ea9646ae`, never rebuilt in
this task), constant project `examples/ev-zonal/ev-zonal.cannet_prj`,
constant flags `--connect-on-start --perf-capture-secs 60
--perf-interact scrub` (the gate scenario — `scrub` is what every
report in the series was captured under). Nothing else runs on the
machine; the dongles are free.

| cell | profile | polling | reps |
| --- | --- | --- | --- |
| **A** | fresh empty `--app-data-dir`, new per rep | none | 3 |
| **B** | one reused warm dir | none | 3 |
| **C** | the same reused warm dir | `tasklist` every 5 s and every 10 s, two shells, across the window | 3 |

Run order is interleaved **A B C A B C A B C** so that session run
order (positions 1–9) is decorrelated from the cell. A tenth run
precedes them: the launch that creates the warm dir is itself a
fresh-dir, first-of-session, cold-link run, so it is recorded as a
data point (`init`) rather than thrown away.

**Predictions (falsifiable, per hypothesis).**

- **H1 — first-launch profile initialization carries the failure.**
  Predicts ≥ 2 of 3 A runs (plus `init`) over the 0.041 limit, and all
  B runs under 0.01. Falsified if A runs are clean.
- **H2 — the process-table polling carries the failure.** Predicts ≥ 1
  of 3 C runs over 0.041 with B clean. Falsified if C matches B.
- **H3 — neither lever; the breach is a sporadic machine event.**
  Predicts every cell clean (or a breach landing in a cell with no
  corresponding lever). Confirmed only by A and B and C all measuring
  in the same band, with any breach unattached to a cell.
- **H4 — `renderer_mb_drift_per_min` is real code growth.** Predicts
  the ten slopes cluster near the build's observed worst (103.7),
  i.e. a narrow spread. Falsified by a spread comparable to the
  62.5–103.7 already seen within this one build.
- **H5 — drift is inflated by first-launch initialization.** Predicts
  A slopes systematically above B slopes.
- **H6 — drift tracks session run order / machine warmth.** Predicts
  slope falling with position regardless of cell.

### 2026-08-14 — experiment 1: the A/B/C matrix (10 runs)

Command per cell (absolute paths, constant binary
`target/release/cannet-gui.exe` @ `ea9646ae`, mtime unchanged
throughout the task):

```sh
target/release/cannet-gui.exe \
  --project <abs>/examples/ev-zonal/ev-zonal.cannet_prj \
  --connect-on-start --perf-capture-secs 60 --perf-interact scrub \
  --app-data-dir <abs>/<per-cell dir> \
  --perf-out <abs>/<label>.json --perf-label <label>
```

Cell C additionally ran two shells walking the process table
(`tasklist`) every 5 s and every 10 s across the whole window, the
task70-p10 condition. All ten runs: `rc=0`, 60 samples over 59.0 s,
rx 1601.7–1607.2 fps, `ids_measured` 173, `longtask_ms_per_s_max`
0.000, `jank_fraction` 0.000. No cannet process was alive before any
run; nothing else on the machine competed by design.

| pos | cell | profile | polling | `short_frac` | `p95_ratio` | `rend_slope` | `tree_slope` | `jsheap_slope` | `rend_mean` | `tx_late_max` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | init | fresh | no | 0.0005 | 1.12 | 42.9 | 73.9 | 6.7 | 262.1 | 5.0 |
| 1 | A1 | fresh | no | 0.0003 | 1.13 | 18.5 | 49.5 | −1.3 | 251.8 | 5.1 |
| 2 | B1 | warm | no | 0.0003 | 1.13 | 47.2 | 77.6 | 14.2 | 269.7 | 5.0 |
| 3 | C1 | warm | **yes** | 0.0005 | 1.13 | 36.2 | 66.8 | 8.3 | 269.4 | 5.6 |
| 4 | A2 | fresh | no | 0.0007 | 1.15 | 41.2 | 71.4 | 10.8 | 260.4 | 5.5 |
| 5 | B2 | warm | no | 0.0007 | 1.14 | 37.7 | 67.1 | 8.0 | 262.2 | 6.1 |
| 6 | C2 | warm | **yes** | 0.0012 | 1.13 | 39.9 | 70.2 | 11.3 | 266.4 | 7.9 |
| 7 | A3 | fresh | no | 0.0027 | 1.19 | 44.4 | 75.1 | 12.6 | 259.0 | 13.4 |
| 8 | B3 | warm | no | 0.0028 | 1.22 | 32.0 | 60.8 | 9.6 | 269.9 | 83.6 |
| 9 | C3 | warm | **yes** | 0.0048 | 1.23 | 40.7 | 72.7 | 10.7 | 265.4 | 56.5 |

**Verdicts against the stated predictions.**

- **H1 (first-launch profile init) — falsified.** Four fresh-empty-dir
  runs (`init`, A1–A3) measured 0.0005 / 0.0003 / 0.0007 / 0.0027, all
  one to two orders of magnitude under the 0.041 limit and all inside
  the clean band. The prediction was ≥ 2 of them over the limit. A
  fresh profile does not reproduce the task75-p5 run-1 breach.
- **H2 (`tasklist` polling) — falsified.** Cell C mean 0.0022 vs cell
  B mean 0.0013, on the same warm profile — a difference smaller than
  the session-position effect below, and nowhere near 0.041. Polling
  does not reproduce the task70-p10 run-1 breach either.
- **H4 (renderer drift is real code growth) — falsified, decisively.**
  These ten runs use **the same binary file** that produced
  `renderer_mb_drift_per_min` 103.7 / 88.5 / 62.5 at the task75-p5
  gate two hours earlier. It now measures 18.5–47.2 (mean 38.1,
  n = 10). The two bands do not overlap; the same build measured a
  mean of 84.9 in one session and 38.1 in the next. A metric that
  moves 2.2× with zero code change cannot carry a 92.6 → 103.7
  worst-to-worst "trend" of 12 % as evidence of growth.
- **H5 (init inflates drift) — falsified.** A mean 34.7 vs B mean
  39.0 — fresh profiles measured *lower*, and the difference is inside
  the noise.
- **H6 (drift falls with run order) — falsified as stated.** Slopes by
  position: 42.9, 18.5, 47.2, 36.2, 41.2, 37.7, 39.9, 44.4, 32.0,
  40.7 — no order trend. The within-session spread is real but is not
  ordered.
- **H3 (sporadic, unattached to either lever) — surviving.** Nothing
  in the matrix reproduced a breach.

**One effect the matrix did find, unpredicted.** `short_frac` rises
with session position while ignoring the cell: mean 0.00037 over
positions 1–3, 0.00087 over 4–6, **0.00343** over 7–9 — a 9× rise
across 13 minutes of back-to-back runs, and `tx_late_ms_max` follows
it (5.0–5.6, then 5.5–7.9, then 13.4–83.6). The metric tracks
something about accumulated machine state during a run session, not
the profile and not the polling. That is the direction the remaining
hypothesis points.

### 2026-08-14 — experiment 2 design: concurrent machine load (prediction first)

**H7 — concurrent heavy CPU / disk work carries both anomalies.**
The `tasklist` polling of cell C is a trivial load on a 32-core, 64 GB
machine (~15 process-table walks per window); the task75-p5 gate, by
contrast, ran minutes after a full release `tauri build` and the
task70-p10 gate ran inside a busy agent session. If the carrier is
competing work of *build* magnitude rather than *polling* magnitude,
a deliberate load should reproduce both.

Cells, on the warm profile, run through the same command with a
concurrent load started before launch and killed after exit:

- **D — CPU:** 16 busy-loop shells (half the machine's 32 threads).
- **E — disk:** three shells each writing and re-reading a 400 MB file
  in a loop.

Predictions: if H7 holds, at least one loaded run breaches
`short_frac` 0.041 (or lands ≥ 10× the unloaded band) **and**
`rend_slope` climbs back toward the 62.5–103.7 band the same binary
produced at the p5 gate. If loaded runs measure inside the unloaded
band on both metrics, H7 is falsified and H3 (sporadic) is what
remains.
