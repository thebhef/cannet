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

1. [Task 86 — Usage Feedback: Import Time Origins, Enum Overlays,
   Events-Panel Width](0086-usage-feedback-0.9.0.md) — four unrelated
   owner observations from 0.8.1 / 0.9.0-dev use, each
   investigation-first: the events panel's rename/remove controls need
   an implausible width, imported BLFs render negative timestamps (and
   import time origins differ per format), enum overlays only appear
   after a view remount, and a 0.8.1-era "signal rebuild doesn't
   always happen on DBC load" that needs re-verifying against 0.9.0.
   Opened by owner ruling 2026-08-18.
2. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
   — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
   and RBS (`.cannet_rbs`) files so external edits are picked up
   automatically, and own the DBC-change propagation contract (and its
   ADR) that task 86 item 3 consumes. Groomed and pulled forward by
   owner ruling 2026-08-19.
3. [Task 87 — BLF Writer Timestamp Fidelity](0087-blf-writer-timestamp-fidelity.md)
   — `BlfCaptureWriter` silently clamps a frame whose timestamp is
   earlier than the one before it, so a saved BLF can differ from the
   capture it came from. Real multi-bus captures dip ~1.1 s below
   their own maximum several times a minute (ADR 0024) and Save
   Capture writes in arrival order, so this is ordinary data, not an
   edge case. Research the format question first. Opened by owner
   ruling 2026-08-19.
4. [Task 88 — Bus Assignment Governs Decode](0088-bus-assignment-governs-decode.md)
   — a DBC assigned to no bus decodes nothing; adding and removing
   say nothing about assignment; assignment is the cache lifecycle
   boundary (assign revives matching fingerprints, unassign parks);
   every frame carries a bus. Supersedes parts of task 81. Groomed
   2026-08-19; needs its exit criteria firmed before implementation.
5. [Task 79 — Restore-Then-Import + Scratch Isolation](0079-restore-then-import.md)
   — the user-reachable empty-view defect Task 78 phase 1 attributed
   (restore a prior capture, then import: the view stays empty while
   the store refills), plus making `--app-data-dir` isolate the
   capture scratch as ADR 0031 claims. Opened by owner ruling
   2026-08-15; **whether it is worth implementing at all is under
   owner review (2026-08-18)** — settle that before starting it.
6. [Task 80 — Plot Resample Churn Over a Stopped
   Capture](0080-stopped-capture-resample.md) — investigation-first:
   ~30 Hz resample + follow-slide held over a stopped, fully imported
   capture (trace still reads RUNNING after import). Opened by owner
   ruling 2026-08-15.
7. [Task 82 — Engine-Native Resource Monitoring](0082-engine-native-resource-monitoring.md)
   — the health sampler's process-family metrics move to the web
   engine's own bookkeeping (WebView2 `GetProcessInfos`) as the
   de-jure source; per-platform matrix (the macOS ppid walk silently
   excludes WKWebView's launchd-parented helpers), the
   `unsafe`/`webview2-com` adoption rulings, costs re-measured.
   Opened by owner ruling 2026-08-15.
8. [Task 83 — Follow-Ups from the 70–78 Cycle](0083-cycle-follow-ups.md)
   — the small findings the retiring 70–78 task files recorded in
   passing, collected as one groomable pass: the project-command test
   harness gap, the rebuild-chip rough edges, the unattributed
   launch-hang lead, frameless-import time ranges, and the
   untrusted-row token editor. Opened by owner ruling 2026-08-16.
9. [Task 84 — Make the MDF's Embedded DBC Durable](0084-mdf-embedded-dbc.md)
   — an imported MDF's embedded DBC decodes for the session but
   survives no reopen; make it durable (extraction or a durable
   project reference), then revisit name-matching file-backed
   signals on top. Needs grilling before implementation. Opened by
   owner ruling 2026-08-16.
10. [Task 77 — Catch-Up Decode Off the Serve Path](0077-background-catchup-decode.md)
   — shape 3 of Task 72 phase 3's attributed enum-lag fix (owner
   ruling 2026-08-15): decode cursors advance independently of view
   fetches, serves read what the cursors reached. Amends ADR 0049;
   gated on Task 72 phase 5's batched scan landing first.
11. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13;
   adopted onto the roadmap same day.
12. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
   — the two data-named cuts from the 2026-08-08 ingest profiling: the
   disk-spill segment write (43 % of the release per-frame budget)
   and `bus_id: Option<String>` interning (~15 %). Opened by owner
   ruling 2026-08-09.
13. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
   — crash on exit (wry/WebKit layer-tree teardown race) and missing
   Spotlight bundle metadata. Independently-shippable macOS fixes.
14. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — the remaining argument-taking commands (go-to-row / -time,
   set-visible-range) and the shared input-prompt UI, on top of the
   command / palette framework. Save-with-picker (`capture.save`), the
   close commands, and a list-select go-to-event palette shipped with
   Task 37; what's left is the typed-argument prompt infrastructure.
15. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (post-clear negative
   timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
   plot-color bug and the `decimatePoints` dead-code removal.
16. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
17. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
18. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
19. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
20. [Task 40 — bridge_client / cannet-client Session-Machinery
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
