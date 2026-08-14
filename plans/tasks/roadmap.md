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

1. [Task 67 — Server Shutdown Hang and Logging
   Parity](0067-server-shutdown-and-logging.md) — owner feedback
   2026-08-13: Ctrl+C after a client hard-close left the server
   stuck at "shutting down" for minutes (investigation-first), and
   `cannet-server` gets the GUI host's logging pattern (rolling
   logfile, timestamps, levels; sidecar debug-log hook wired).
2. [Task 64 — Server Installers, and the Server in the GUI
   Install](0064-server-installers.md) — `.dmg` + NSIS + `.deb`
   server installers beside the existing plain archives, and the GUI
   bundles ship `cannet-server` (binary only — no in-app launch
   surface) reusing the bundled frozen sidecar. Opened by owner ask
   2026-08-12; supersedes Task 41's archive-only distribution.
3. [Task 65 — Server Browse & Trust UX Round](0065-server-browse-ux.md)
   — owner feedback 2026-08-12: server browse becomes its own
   singleton panel; selection/auth is user-level config surfaced in
   the project view; host name in the list; Windows native DNS-SD
   browse (no per-app firewall rules), macOS permission note,
   blocked-discovery legibility.
4. [Task 66 — Database Panel Round](0066-database-panel-round.md)
   — owner feedback 2026-08-12: one "Import trace" action for
   BLF + MDF; DBC panel renamed "Database" and lists file-backed
   signals as the primary add-signal mechanism; first-draft signal
   pickers removed (signal view confirmed; sweep for others).
5. [Task 63 — Plot Usage-Feedback Round](0063-plot-usage-feedback.md)
   — from owner live use 2026-08-11: a baseline disclosure-toggle
   implementation (the too-small ▾/▸ recurs at every disclosure
   site), collapsed plot areas actually reclaiming their space,
   hidden signal rows compacting to a single line, solo paging
   scrolling its selection into view, and an investigation-first
   fix for enum overlays lagging the other series in proportion to
   trace length.
6. [Task 68 — Server Clock Awareness](0068-server-clock-awareness.md)
   — from the owner's triage note 2026-08-13: frames carry unmapped
   wall-clock ns from whichever host stamped them, with no way to
   ask a server about its clock or observe cross-machine skew. Add
   a `ClockProbe`/`ClockReply` envelope pair (NTP-style offset),
   surface — and per grooming, apply — the offset at the client
   seam; fix the two stale proto timestamp comments.
7. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13;
   adopted onto the roadmap same day.
8. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
   — the two data-named cuts from the 2026-08-08 ingest profiling: the
   disk-spill segment write (43 % of the release per-frame budget)
   and `bus_id: Option<String>` interning (~15 %). Opened by owner
   ruling 2026-08-09.
9. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
   — crash on exit (wry/WebKit layer-tree teardown race) and missing
   Spotlight bundle metadata. Independently-shippable macOS fixes.
10. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — the remaining argument-taking commands (go-to-row / -time,
   set-visible-range) and the shared input-prompt UI, on top of the
   command / palette framework. Save-with-picker (`capture.save`), the
   close commands, and a list-select go-to-event palette shipped with
   Task 37; what's left is the typed-argument prompt infrastructure.
11. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (post-clear negative
   timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
   plot-color bug and the `decimatePoints` dead-code removal.
12. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
13. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
14. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
    — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
    and RBS (`.cannet_rbs`) files so external edits are picked up
    automatically.
15. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
16. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
17. [Task 40 — bridge_client / cannet-client Session-Machinery
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
