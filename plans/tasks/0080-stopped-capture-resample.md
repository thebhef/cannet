# Task 80 — Plot Resample Churn Over a Stopped Capture

Opened by owner ruling 2026-08-15 ("yes, new task") out of Task 78
phase 1's side observation.

## Observation (recorded, unattributed)

Over a stopped, fully imported capture the plot re-samples
continuously: `plotarea.resample` at 28–30/s and `followwin.slide` at
14–16/s, held for the whole run, and the trace element still reads
`RUNNING` after a file import ends. Nothing is changing; the render
hot path is doing per-frame work for a static picture.

Investigation-first: attribute what keeps the resample loop alive
(the import path never leaving RUNNING is the named suspect, but that
is a hypothesis without an experiment), then fix so a stopped capture
costs no steady-state render work beyond what interaction asks for.

## Exit criteria (draft — firm at grooming)

- The mechanism attributed with the confirming experiment's data in
  the status log.
- A stopped, fully imported capture holds the resample/slide counters
  at zero absent user interaction (tested at whatever seam the
  attribution shows is right); live captures unchanged.
- The import path ends in the state the trace element reports.
