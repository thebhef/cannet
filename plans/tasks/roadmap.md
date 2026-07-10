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

1. [Task 31 — Frozen python-can Sidecar Binary](0031-frozen-sidecar-binary.md)
   — ship the sidecar as a frozen self-contained binary (PyInstaller
   onedir) so an installed cannet launches it with no Python, `uv`, or
   network. Fixes the installer that ships only the GUI exe; replaces the
   never-built end-user `uv`-fetch flow. See ADR 0036.
2. [Task 29 — TX Timing Robustness & Counter-Per-Wire-Frame](0029-tx-timing-robustness-counter.md)
   — fix periodic-TX drift and high-rate bunching, and re-bind the
   rolling counter / CRC to the actual wire send (one increment per
   frame) instead of the scheduler tick; both share one root.
3. [Task 20 — Signals, Drag/Drop & Trace Signal Display](0020-signals-drag-drop-trace-signal-display.md)
   — the signal-view panel and inline trace-row signals, plus the
   large-DBC panel performance and FZF-search-hiding fixes.
4. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — the specialised, argument-taking commands (go-to-row / -time,
   set-visible-range, save-with-picker) on top of the command palette
   and go-to-view framework already shipped in task 16.
5. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (timestamp handling,
   post-clear negative timestamps) plus DBC-view performance/search and
   the plot-colour bug.
6. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
7. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, manual per-series y, export, drag a
   plot area.
8. [Task 24 — Cross-Cutting Polish](0024-cross-cutting-polish.md)
   — the small UX / infrastructure tail; note the end-user runtime-tool
   fetch flow this task used to own is obsoleted by Task 31 (frozen
   sidecar). Several items now overlap Task 20 and the backlog, so
   re-derive the real remainder when it comes current.
9. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
    — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
    and RBS (`.cannet_rbs`) files so external edits are picked up
    automatically.
10. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
11. [Task 30 — Code-Quality Debt: Deduplication & God-File Split](0030-code-quality-dedup.md)
    — pay down the copy-pasted hot-path implementations (CAN-ID
    extraction ×5, DBC bit-walkers ×3, decoder boilerplate) and the
    frontend fetch/format dups that also break the thin-view rule, plus
    split the two god-files (`lib.rs`, `PlotPanel.tsx`). Small reviewable
    refactors under green tests; pick up opportunistically.

## Notes

- **Numbers vs. order.** Task numbers are stable identifiers, not the
  sequence. The list above is the sequence; reorder it here when
  priorities change without renumbering the task files.
- **ADRs describe what *is*.** Several ADRs still carry references to
  these task numbers from when this was a phased plan. Each task that
  owns an ADR carries an "ADR cleanup" line to scrub those references
  out as that task is worked — ADRs should hold decisions, and the
  tasks should reference the ADRs, not the other way round.
