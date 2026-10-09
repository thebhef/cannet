# Roadmap

The ordered list of outstanding work and the canonical implementation
order. Each item is a **task** with its own `NNNN-description.md` file
in this directory (`plans/tasks/`); this file is the table of contents
and the sequence.

Concrete library / framework choices live in
[`technology-inventory.md`](../technology-inventory.md); cross-cutting
principles live in the ADRs under [`../../docs/adr/`](../../docs/adr/)
and in [`../../CLAUDE.md`](../../CLAUDE.md).

Tasks keep stable numbers (they don't renumber when the order changes).

This file lists work not yet started. A task that is in progress, or
has met every exit criterion, lives under `pending-closeout/` until the
owner closes it out; that directory — not this file — is that list.

## 0.10.x — fix and stabilize

The development path for the 0.10.x releases: correctness, rework,
stability, project health. In order of work, first at the top. None
started.

1. [Task 128 — Shared-Layer Holdouts](0128-shared-layer-holdouts.md)
   — the last cleanup items the 2026-08-27 run surfaced, opened at the
   owner's instruction while walking its open items: `serverList.ts`'s
   two hooks onto `useHostMirror` via a `fromPayload` ignore signal
   (ruled: option a — no behaviour change), Escape reaching a
   portalled dropdown before the fullscreen binding, and the columned
   gridviews' missing ARIA roles.
2. [Task 119 — Example DBCs for the Duplicate-Id Collision](0119-duplicate-id-example-dbcs.md)
    — two DBCs that collide on one bus plus a project assigning both, so
    the owner can review what the Database panel marks. **A deliverable
    to review against, not a behaviour change.** From queue item 1.33a;
    ruled 2026-08-25. Two open questions.
3. [Task 79 — Restore-Then-Import + Scratch Isolation](0079-restore-then-import.md)
    — the user-reachable empty-view defect Task 78 phase 1 attributed
    (restore a prior capture, then import: the view stays empty while
    the store refills), plus making `--app-data-dir` isolate the
    capture scratch as ADR 0031 claims. Opened by owner ruling
    2026-08-15; kept as scoped, both halves, by owner ruling
    2026-08-19.
4. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
    — the hardware/virtual-bus verify-and-fix pass (post-clear negative
    timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
    plot-color bug and the `decimatePoints` dead-code removal.
5. [Task 83 — Follow-Ups from the 70–78 Cycle](0083-cycle-follow-ups.md)
    — the small findings the retiring 70–78 task files recorded in
    passing, collected as one groomable pass: the project-command test
    harness gap, the rebuild-chip rough edges, the unattributed
    launch-hang lead, frameless-import time ranges, and the
    untrusted-row token editor. Opened by owner ruling 2026-08-16.
6. [Task 84 — Make the MDF's Embedded DBC Durable](0084-mdf-embedded-dbc.md)
    — an imported MDF's embedded DBC decodes for the session but
    survives no reopen; make it durable (extraction or a durable
    project reference), then revisit name-matching file-backed
    signals on top. **Needs grilling before implementation.** Opened by
    owner ruling 2026-08-16.
7. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
    — crash on exit (wry/WebKit layer-tree teardown race) and missing
    Spotlight bundle metadata. Independently-shippable macOS fixes.
8. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
    — the two data-named cuts from the 2026-08-08 ingest profiling: the
    disk-spill segment write (43 % of the release per-frame budget)
    and `bus_id: Option<String>` interning (~15 %). Opened by owner
    ruling 2026-08-09.
9. [Task 82 — Engine-Native Resource Monitoring](0082-engine-native-resource-monitoring.md)
    — the health sampler's process-family metrics move to the web
    engine's own bookkeeping (WebView2 `GetProcessInfos`) as the
    de-jure source; per-platform matrix (the macOS ppid walk silently
    excludes WKWebView's launchd-parented helpers), the
    `unsafe`/`webview2-com` adoption rulings, costs re-measured.
    Opened by owner ruling 2026-08-15.
10. [Task 77 — Catch-Up Decode Off the Serve Path](0077-background-catchup-decode.md)
    — shape 3 of Task 72 phase 3's attributed enum-lag fix (owner
    ruling 2026-08-15): decode cursors advance independently of view
    fetches, serves read what the cursors reached. Amends ADR 0049.
11. [Task 133 — Misc Fixes](0133-misc-fixes.md)
    — the collection point for small owner-reported fixes that belong
    to no open task; currently: hex displays preserve leading zeros.
    Opened by owner instruction 2026-09-03.
12. [Task 143 — A Webview Reload Rejoins the Running Session](0143-reload-rejoins-the-session.md)
    — a reload today re-runs the fresh-host boot (stops loggers, RBS
    and periodic TX; swaps the raw store under a live pump); make it
    rejoin the host's session instead, then let the health recorder
    reload a window whose renderer has stopped heartbeating (the
    black screen from the six-day ll16 capture). Opened by owner
    ruling 2026-09-15; the WebView2 `ProcessFailed` hook is backlogged.

## Beyond 0.10.x — feature rework and architecture

The heavier items: feature rework and architectural change, the
revisions that follow the 0.10.x path. Ordered among themselves; the
section above comes first.

1. [Task 157 — A Scratch That Cannot Grow Is an Error, Not a Panic](0157-scratch-growth-failures-are-errors.md)
    — cannet-spill's segment growth panics on I/O failure and the
    panic poisons the session; make growth fallible across its 5 call
    sites and 4 APIs and decide what a session does when the scratch
    cannot grow. Opened 2026-09-23 by owner ruling on task 156's
    verdict; **needs grilling**; behind task 156.
2. [Task 159 — Math Pyramids Persist Like Any Other Series](0159-math-pyramids-persist.md)
    — math series leave session scope: persisted with their
    compositional fingerprint, restored with the capture, parked on a
    definition change, the fill warmed from the operands on restore.
    Opened 2026-10-02 by owner ruling on task 135's deviation;
    **executes now**, behind task 158.
3. [Task 138 — Events in Logged BLFs](0138-logged-events.md)
    — the project logger appends user-authored timeline events to the
    streaming BLF live: a marker on create and on every edit, fresh id
    per revision chained by an `edited:` key, deletion as a tombstone
    revision; ingest collapses chains to current state and re-export
    writes the clean file. Extends task 137's logger; opened by owner
    instruction 2026-09-06, groomed same day — all questions ruled,
    two phases.
4. [Task 116 — RBS Problems Across Every Configuration](0116-rbs-problems-across-configurations.md)
   — one view over problems from every open `.cannet_rbs`, filterable by
   file, host-computed and paged. The RBS button opens that instead of a
   single configuration. From queue item 1.13ab; the steps-to-reproduce
   leg was dropped by owner ruling 2026-08-25. Task 113 settled what an
   RBS grid row is (landed 2026-08-27), so that dependency is met. Two
   open questions.
5. [Task 112 — The Signal Reference Registry](0112-signal-reference-registry.md)
   — every persisted signal reference moves onto one host-side registry,
   the way `NotesStore` and `TransmitFrameRegistry` already hold theirs.
   The `elements` blob stays opaque for presentation and stops carrying
   references, so the mapping panel reads a model instead of being
   pushed to, and a repair is one edit instead of a five-store walk.
   Opened by owner observation 2026-08-24 while walking queue item 1.3.
   **Took 1.3's residual (a transmit row is `bus + message id + which
   database`), 1.30 and 1.19 on 2026-08-25** — because building any of
   them ahead of the registry builds a one-off of it. **Needs grilling
   before implementation** — no phases, and five open design questions.
   Bears on queue findings 3.1, 3.31, 3.41 and 3.47.
6. [Task 124 — One Toolbar](0124-one-toolbar.md)
   — the app-level toolbar and the ten panel toolbars wear one button
   style but remain hand-laid flex rows; converge them on a shared
   toolbar control that owns layout and wrap-vs-overflow, settling
   `useToolbarFit`'s one-consumer question. Opened from queue finding
   3.21; owner-placed later, definitely not immediate scope.
7. [Task 130 — One Modal](0130-one-modal.md)
   — the six modal dialogs share CSS chrome and a hand-copied
   "Escape/backdrop means Cancel" convention but no code; converge them
   on a shared modal base owning dismissal, ARIA, and focus trapping.
   The modal companion to task 124; opened by owner instruction
   2026-08-30.
8. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13.
9. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
10. [Task 132 — J1939](0132-j1939.md)
   — the basic functions of a complete J1939 implementation as one
   set: PGN-aware decode, Transport Protocol reassembly (RTS/CTS and
   BAM), DM1/DM2 diagnostics including DM1 over TP, address claim.
   Opened by owner instruction 2026-08-31; no J1939 task existed
   before it.
11. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
   Inherits the measurement strip's rework, which task 108 phase 4
   suppressed rather than removed.
12. [Task 131 — Grow Live](0131-grow-live.md)
   — a third x-range behaviour beside manual and Follow: left edge
   pinned to the capture's first sample, right edge riding the live
   edge, so the window widens as data arrives. Runs for a period after
   connect, then hands off to Follow at the grown width. Opened by
   owner instruction 2026-08-31; duration and mode-vs-phase questions
   open.
13. [Task 85 — Extended Multiplexing End to End](0085-extended-multiplexing.md)
   — `SG_MUL_VAL_` parsed and modelled, the Database panel rendering
   nested mux trees, per-frame decode gated on the full selector path,
   and a worked example DBC. The task file existed but had never
   reached this roadmap; found unlisted and added at the 2026-08-26
   close-out. Open design questions.
14. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
   — cannet connects out to a value-source server that streams sparse
   `(signal, value)` updates by name; RBS applies them as overrides and
   keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
   (e.g. an EV drive cycle) drive the RBS.
15. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
   — staged: pcapng import (CAN linktypes, no model change), step/hold
   plot semantics for on-change series, then the multi-protocol trace
   model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
   Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
16. [Task 40 — bridge_client / cannet-client Session-Machinery
    Consolidation](0040-bridge-client-consolidation.md) — gated on
    cannet-client growing a subscribe-timeout / dynamic-allocation
    capability; split out from task 30's item #9 once everything else
    in that audit shipped.
17. [Task 162 — System Dimension](0162-system-dimension.md) — signals
    carry a system dimension (e.g. string- vs cell-level vs LV supply
    voltage); the per-unit view groups each dimension separately.
    Ungroomed.

## Notes

- **Numbers vs. order.** Task numbers are stable identifiers, not the
  sequence. The order within each section above is the sequence;
  reorder it here when priorities change without renumbering the task
  files.
- **ADRs describe what *is*.** Several ADRs still carry references to
  these task numbers from when this was a phased plan. Each task that
  owns an ADR carries an "ADR cleanup" line to scrub those references
  out as that task is worked — ADRs should hold decisions, and the
  tasks should reference the ADRs, not the other way round.
