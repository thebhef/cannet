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

## Second stopped-capture serve cost: the by-id / signal window scan

Recorded by Task 75's investigation (2026-08-14, pre-existing) and
moved here at cycle-end housekeeping — same regime (a stopped capture
serving views), same shape (work sized to the capture rather than the
view).

`useByIdView` and `useSignalView` pass `scanEnd = winEnd` whenever the
trace is stopped, and `TraceStore::latest_in_window_where` takes its
O(keys) fast path only while `end == raw.len()`. On a fresh restore
those are equal; the moment the window stops covering the tip (Clear,
Start, a re-anchor) a stopped ~58 M-frame capture pays a full
O(buffer) pass **holding the trace-store append mutex**, blocking
every other command and the health sampler with it. Once per
descriptor change by design — but the design was sized before
captures this long. Fix shape: chunk the scan, or bound the snapshot
the way ADR 0049 bounds the pyramid catch-up.

## Exit criteria (draft — firm at grooming)

- The mechanism attributed with the confirming experiment's data in
  the status log.
- A stopped, fully imported capture holds the resample/slide counters
  at zero absent user interaction (tested at whatever seam the
  attribution shows is right); live captures unchanged.
- The import path ends in the state the trace element reports.
- The stopped-capture window scan no longer takes an unbounded pass
  under the append mutex: a descriptor change over a large stopped
  capture leaves commands and the health sampler responsive
  throughout, tested at the store seam.
