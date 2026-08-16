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

## Exit criteria (draft — firm at grooming)

- The run-1 anomaly attributed with the isolating experiment's data;
  the gate procedure amended if the environment (cold cache, polling)
  is the carrier — so a future first-run failure is not ambiguous.
- The renderer-drift rise attributed with data; either a fix lands,
  or the gate's expectation is re-grounded by owner ruling. No
  baseline promoted to make anything pass.
- Findings recorded in this file's status log; ADR-0031 docs updated
  if the run procedure changes.
