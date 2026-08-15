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

1. [Task 70 — Live-Pass Findings on the 63–68 Batch](0070-live-pass-findings.md)
   — owner live pass 2026-08-14 over the completed stack: two
   regressions (BLF-open dialog latency/reentrancy, project-view
   label alignment), an enum leading-edge lag to re-investigate,
   build-provenance verification for the "still not fixed" items,
   disclosure-ink sizing, task-file retirement, and the
   MDF-decoded-groups scope question. Groom, then work through.
2. [Task 75 — Verification-Pass Findings on the Task-70
   Chain](0075-verification-pass-findings.md) — the owner's manual
   pass over the shipped chain: the MAJOR boot-restore
   slowness/non-updating-plot investigation, trace-open feedback
   round 2 (persist, cancel, rename), the un-forgettable mystery
   trust row, recents popup stickiness, recents-in-palette verdict.
   Opened 2026-08-14; slotted first among the follow-ups for the
   MAJOR item — order is the owner's to adjust.
3. [Task 71 — Perf Grooming](0071-perf-grooming.md)
   — the two unattributed perf questions from Task 70's closeout
   gates: the run-1 `rx_gap_short_frac_worst` failure and the
   `renderer_mb_drift_per_min` rise. Opened by owner ruling
   2026-08-14. **Investigation done** — both attributed to the
   measurement environment (neither is the build; every nominated
   lever falsified over fourteen runs on one constant binary), and
   the gate procedure amended in ADR 0031 / README so a lone breach
   is re-run rather than explained. **Outstanding: one owner
   decision** on how the gate should treat drift metrics whose
   session-to-session spread exceeds their limit's margin — median
   the gate's runs, widen the limits, or leave them now that the
   trend is known to be an artifact. Closes on that ruling.
4. [Task 72 — Extrapolation-Aware Plot Rendering + Enum Leading-Edge
   Lag](0072-extrapolation-rendering.md) — investigation-first: the
   proportional leading-edge lag on a growing full-trace view
   (hours-scale, owner-observed, rig-unreproduced at 5400 s), then
   the ruled differentiated rendering for extrapolated stretches
   (lines, hlines, enum lanes), lane sample-marker visibility, and
   the hover-over-a-lane points regression reported 2026-08-14.
   Opened by owner rulings 2026-08-14.
5. [Task 73 — MDF Ingestion Round 2](0073-mdf-ingestion-round-2.md)
   — signal-only MF4 import and decoded-enum value labels; both
   ruled yes 2026-08-14, building on the task-70 ingestion work.
6. [Task 74 — Trust-Flow Rework](0074-trust-flow-rework.md)
   — identity/token changes surface as indicators (project view +
   Servers panel), modal only for a directly blocked connect, one
   dialog implementation total. Opened by owner rulings 2026-08-14.
7. [Task 76 — Per-Signal Cache Validity + Retention](0076-per-signal-cache-validity.md)
   — replace the whole-DBC-set pyramid validity stamp with per-signal
   encoding fingerprints (a touched-but-unchanged DBC rebuilds
   nothing; one changed signal rebuilds one pyramid) plus a bounded
   MRU retention pool for unreferenced caches. Opened by owner ruling
   2026-08-14; groomed and worked in the same cycle as 71–75.
8. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13;
   adopted onto the roadmap same day.
9. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
   — the two data-named cuts from the 2026-08-08 ingest profiling: the
   disk-spill segment write (43 % of the release per-frame budget)
   and `bus_id: Option<String>` interning (~15 %). Opened by owner
   ruling 2026-08-09.
10. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
   — crash on exit (wry/WebKit layer-tree teardown race) and missing
   Spotlight bundle metadata. Independently-shippable macOS fixes.
11. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — the remaining argument-taking commands (go-to-row / -time,
   set-visible-range) and the shared input-prompt UI, on top of the
   command / palette framework. Save-with-picker (`capture.save`), the
   close commands, and a list-select go-to-event palette shipped with
   Task 37; what's left is the typed-argument prompt infrastructure.
12. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (post-clear negative
   timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
   plot-color bug and the `decimatePoints` dead-code removal.
13. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
14. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
15. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
    — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
    and RBS (`.cannet_rbs`) files so external edits are picked up
    automatically.
16. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
17. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
18. [Task 40 — bridge_client / cannet-client Session-Machinery
    Consolidation](0040-bridge-client-consolidation.md) — gated on
    cannet-client growing a subscribe-timeout / dynamic-allocation
    capability; split out from task 30's item #9 once everything else
    in that audit shipped.

## Notes

- **Numbers vs. order.** Task numbers are stable identifiers, not the
  sequence. The list above is the sequence; reorder it here when
  priorities change without renumbering the task files.
- **ADRs describe what *is*.** Several ADRs still carry references to
  these task numbers from when this was a phased plan. Each task that
  owns an ADR carries an "ADR cleanup" line to scrub those references
  out as that task is worked — ADRs should hold decisions, and the
  tasks should reference the ADRs, not the other way round.
