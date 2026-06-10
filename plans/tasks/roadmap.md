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

1. [Task 15 — Plot Refinements](0015-plot-refinements.md)
   — **next.** The "show points" tri-state plus the plot-area /
   signal-display improvements.
2. [Task 14 — Rest-of-Bus Simulation + CRC / Sequence-Count Fields](0014-rest-of-bus-simulation-crc-sequence.md)
   — host-computed signal fields (CRC, sequence counters) and the
   rest-of-bus transmit gridview.
3. [Task 16 — Command / Hotkey Framework](0016-command-hotkey-framework.md)
   — the command registry + keybinding primitive (including the `f` /
   `l` plot hotkeys).
4. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the deferred hardware/virtual-bus verify-and-fix pass (timestamp
   handling, post-clear negative timestamps) plus DBC-view
   performance/search and the plot-colour bug.
5. [Task 17 — Windowed-Model Convergence](0017-windowed-model-convergence.md)
   — converge the four view caches onto one windowed-source contract
   (view-side; freezes the host signatures Task 18 reimplements).
6. [Task 18 — Indefinite-Length Capture (Disk-Spill)](0018-indefinite-length-capture-disk-spill.md)
   — the model-side disk-spill store behind Task 17's frozen contract.
7. [Task 19 — Command Palette + Goto Framework](0019-command-palette-goto.md)
   — the specialised, argument-taking commands on top of Task 16.
8. [Task 20 — Signals, Drag/Drop & Trace Signal Display](0020-signals-drag-drop-trace-signal-display.md)
   — the signal-view panel, inline trace signals, per-series colour
   picker.
9. [Task 21 — Performance Profiling Baseline](0021-performance-profiling-baseline.md)
   — three-tier profiling procedure and baseline numbers.
10. [Task 22 — CANopen](0022-canopen.md)
    — EDS ingestion and SDO / PDO decoding.
11. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
    — triggers, math channels, manual per-series y, export, drag a
    plot area.
12. [Task 24 — Cross-Cutting Polish](0024-cross-cutting-polish.md)
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
