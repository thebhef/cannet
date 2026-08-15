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
