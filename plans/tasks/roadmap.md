# Roadmap

The ordered list of outstanding work and the canonical implementation
order. Each item is a **task** with its own `NNNN-description.md` file
in this directory (`plans/tasks/`); this file is the table of contents
and the sequence.

This is living documentation, not a historical record — completed work
is removed from here once it ships (the detail lives in git history and
in the code). Concrete library / framework choices live in
[`technology-inventory.md`](../technology-inventory.md); cross-cutting
principles live in the ADRs under [`../../docs/adr/`](../../docs/adr/)
and in [`../../CLAUDE.md`](../../CLAUDE.md).

Tasks keep stable numbers (they don't renumber when the order changes);
the order below is the order of work, top first.

## Implementation order

1. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the deferred hardware/virtual-bus verify-and-fix pass (timestamp
   handling, post-clear negative timestamps) plus DBC-view
   performance/search and the plot-colour bug.
2. [Task 17 — Windowed-Model Convergence](0017-windowed-model-convergence.md)
   — converge the four view caches onto one windowed-source contract
   (view-side; freezes the host signatures Task 18 reimplements).
3. [Task 18 — Indefinite-Length Capture (Disk-Spill)](0018-indefinite-length-capture-disk-spill.md)
   — the model-side disk-spill store behind Task 17's frozen contract.
4. [Task 19 — Command Palette + Goto Framework](0019-command-palette-goto.md)
   — the specialised, argument-taking commands on top of the command
   framework shipped in task 16.
5. [Task 20 — Signals, Drag/Drop & Trace Signal Display](0020-signals-drag-drop-trace-signal-display.md)
   — the signal-view panel, inline trace signals.
6. [Task 21 — Performance Profiling Baseline](0021-performance-profiling-baseline.md)
   — three-tier profiling procedure and baseline numbers.
7. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
8. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, manual per-series y, export, drag a
   plot area.
9. [Task 24 — Cross-Cutting Polish](0024-cross-cutting-polish.md)
    — the small UX / infrastructure tail and the end-user runtime-tool
    fetch flow.

## Notes

- **Numbers vs. order.** Task numbers are stable identifiers, not the
  sequence. The list above is the sequence; reorder it here when
  priorities change without renumbering the task files.
- **ADRs describe what *is*.** Several ADRs still carry references to
  these task numbers from when this was a phased plan. Each task that
  owns an ADR carries an "ADR cleanup" line to scrub those references
  out as that task is worked — ADRs should hold decisions, and the
  tasks should reference the ADRs, not the other way round.
