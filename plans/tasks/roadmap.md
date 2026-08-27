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

## Where things stand

The 2026-08 chain — tasks 19, 27, 86–110 — is implemented on one
linear branch chain off `main`, tip `task-109-phase-6-pattern-signals`;
nothing has merged, and merging the last branch takes all of it. Those
task files are retired (the detail lives in git history); what remains
of them is acceptance verification, tracked as the checklist in
[`../owner-review-queue.md`](../owner-review-queue.md). The review
findings the chain produced were all dispositioned by 2026-08-26: into
the tasks below, the backlog, or closures recorded at their sources.

## Outstanding — correctness, rework, stability, project health

In order of work, first at the top. None started.

1. [Task 126 — Test and Example Cleanup](0126-test-and-example-cleanup.md)
   — the perf harness stops lying (memory attribution fails loudly
   instead of adopting foreign processes or reading 0.0; the `__shot`
   helpers get a guard test; the interaction script's gestures are
   tallied; one clean-machine capture set; the two unstable metrics get
   their ruling on charted evidence before the close-out gate), small
   LFS-carried example files for every demoable frontend surface, and
   the exit-criteria verdicts five tasks never received. From queue
   findings 3.45 and all of § 3F, ruled 2026-08-26. **Placed first
   (owner, 2026-08-26): it furnishes the input files the verification
   checklist's acceptance walk needs, and it gates the chain
   close-out.**
2. [Task 121 — The Tool Tells the Truth About the Wire](0121-the-trace-tells-the-truth-about-the-wire.md)
   — a transmit row is appended before any wire attempt, so a frame the
   bus never carried looks identical to one it did; the `TX_REJECTED`
   that would say otherwise is logged to dev stderr and discarded; and
   error frames reach the trace one row each, at ~5,200/s during the
   owner's bench fault. One defect from three sides. **Ruled 2026-08-26:**
   error frames stay in the saved capture and coalesce in the frontend,
   so nothing is dropped at ingest. Carries two smaller findings — the
   "Error-active" label and a dropped-frame counter — neither yet ruled.
   Widened 2026-08-26 to carry all the hardware-truth work as one task
   (split into PRs as convenient, all before next release): the
   `Connected` relabel, the rx-loss counter reading the per-vendor
   status the ingest discards, and the adapter-identity fields shipped
   across from the sidecar (queue 3.52). Placed first: two of its
   findings are the owner's own observations from hardware, and it is
   the only group of findings sourced from real use.
3. [Task 125 — The Suite Is Green](0125-the-suite-is-green.md)
   — `PlotPanel.dom.test.tsx`'s panel-local-state test fails in two of
   three full runs (`expected 1 to be +0`, one extra render), so the
   frontend job every phase must report green is not reliably green.
   Owner ruling 2026-08-26: *"re-run/fix."* Cause unestablished — one
   hypothesis already refuted; scientific method required.
4. [Task 127 — Shared-Layer Cleanups](0127-shared-layer-cleanups.md)
   — the dead-keyboard defect after editing an event's tag (reachable
   today, gets the regression test its F2 sibling got), a `fromPayload`
   option on `useHostMirror` so `useConnectionStates` stops hand-rolling
   the launch race open on a shipped connection path, and one focus
   model plus real ARIA roles in the trace gridviews. From the queue's
   § 3G, accepted as a task 2026-08-26; 3.13 closed the same day as
   already done.
5. [Task 122 — A File Keeps What You Wrote](0122-a-file-keeps-what-you-wrote.md)
   — five small capture-format fixes, all ruled 2026-08-26 from the
   queue's § 3A walk, no open questions: a black event survives BLF
   (two colour guards of ours, not a format limit); the BLF anchor
   reaches disk on first append so a killed session's `.part` stops
   dating from 1970; foreign MDF sample order is sorted at the
   boundary instead of trusted into a wrong plot; a future build's
   unknown block keys round-trip; `commented_event_type` rides the
   `cannet-event/1` block on every carrier. One phase, test-first.
6. [Task 115 — Trace Row Menus Keep Only the Event Action](0115-trace-row-menu-scope.md)
   — a right-click on a trace frame row stops offering the sources
   picker; the button bar is where those items live and always was.
   Create event stays. From queue item 1.23; fully ruled 2026-08-25.
7. [Task 117 — Refuse to Connect Without a Bound Bus](0117-refuse-to-connect-without-a-bound-bus.md)
   — connecting with any unbound bus fails loudly and names it; the
   empty-project refusal names the bus rather than a binding; a new
   project starts with one bus called `Bus 1`. From queue item 1.34,
   captured at the owner's instruction 2026-08-25. No open questions.
8. [Task 114 — One Name Per Thing](0114-one-name-per-thing.md)
   — the chrome says one thing where the model says another. ADR 0055
   is amended to say what the code does (the command registry is the
   model, the chip bar one rendering of it); the toolbar's last `DBC`
   chip becomes `Database`; a virtual bus stops rendering its wire id
   in the bus-health adapter cell, reading `virtual bus` instead. Split
   out of the owner review walk and fully groomed on 2026-08-25.
   **No open questions**, no phases yet.
9. [Task 118 — The `comment-references` Check Leaves CI](0118-comment-references-out-of-ci.md)
   — the check moves to the `implement-phase` and `oversee-roadmap`
   skills and the CI job goes. **Process, not product.** From queue
   item 1.35; ruled 2026-08-25. The risk being accepted —
   instruction-level enforcement is what failed before — is recorded in
   the task, not argued.
10. [Task 119 — Example DBCs for the Duplicate-Id Collision](0119-duplicate-id-example-dbcs.md)
    — two DBCs that collide on one bus plus a project assigning both, so
    the owner can review what the Database panel marks. **A deliverable
    to review against, not a behaviour change.** From queue item 1.33a;
    ruled 2026-08-25. Two open questions.
11. [Task 79 — Restore-Then-Import + Scratch Isolation](0079-restore-then-import.md)
    — the user-reachable empty-view defect Task 78 phase 1 attributed
    (restore a prior capture, then import: the view stays empty while
    the store refills), plus making `--app-data-dir` isolate the
    capture scratch as ADR 0031 claims. Opened by owner ruling
    2026-08-15; kept as scoped, both halves, by owner ruling
    2026-08-19.
12. [Task 80 — Plot Resample Churn Over a Stopped Capture](0080-stopped-capture-resample.md)
    — investigation-first: ~30 Hz resample + follow-slide held over a
    stopped, fully imported capture (trace still reads RUNNING after
    import). Opened by owner ruling 2026-08-15.
13. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
    — the hardware/virtual-bus verify-and-fix pass (post-clear negative
    timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
    plot-color bug and the `decimatePoints` dead-code removal.
14. [Task 83 — Follow-Ups from the 70–78 Cycle](0083-cycle-follow-ups.md)
    — the small findings the retiring 70–78 task files recorded in
    passing, collected as one groomable pass: the project-command test
    harness gap, the rebuild-chip rough edges, the unattributed
    launch-hang lead, frameless-import time ranges, and the
    untrusted-row token editor. Opened by owner ruling 2026-08-16.
15. [Task 84 — Make the MDF's Embedded DBC Durable](0084-mdf-embedded-dbc.md)
    — an imported MDF's embedded DBC decodes for the session but
    survives no reopen; make it durable (extraction or a durable
    project reference), then revisit name-matching file-backed
    signals on top. **Needs grilling before implementation.** Opened by
    owner ruling 2026-08-16.
16. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
    — crash on exit (wry/WebKit layer-tree teardown race) and missing
    Spotlight bundle metadata. Independently-shippable macOS fixes.
17. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
    — the two data-named cuts from the 2026-08-08 ingest profiling: the
    disk-spill segment write (43 % of the release per-frame budget)
    and `bus_id: Option<String>` interning (~15 %). Opened by owner
    ruling 2026-08-09.
18. [Task 82 — Engine-Native Resource Monitoring](0082-engine-native-resource-monitoring.md)
    — the health sampler's process-family metrics move to the web
    engine's own bookkeeping (WebView2 `GetProcessInfos`) as the
    de-jure source; per-platform matrix (the macOS ppid walk silently
    excludes WKWebView's launchd-parented helpers), the
    `unsafe`/`webview2-com` adoption rulings, costs re-measured.
    Opened by owner ruling 2026-08-15.
19. [Task 77 — Catch-Up Decode Off the Serve Path](0077-background-catchup-decode.md)
    — shape 3 of Task 72 phase 3's attributed enum-lag fix (owner
    ruling 2026-08-15): decode cursors advance independently of view
    fetches, serves read what the cursors reached. Amends ADR 0049.

## Outstanding — feature rework and architecture

The heavier items: feature rework and architectural change, most of
them recently opened from the review walk. Ordered among themselves;
the section above comes first.

1. [Task 113 — Is RBS a Grid?](0113-rbs-as-a-grid.md)
   — `RbsPanel` and `TransmitPanel` adopt `gridviewContentRows`, so a
   message's signals are grid rows the cursor reaches. Plus Space on a
   signal row going inert, and **a layer-wide Escape defect grooming
   turned up**: a fullscreened panel's global `Escape` binding beats the
   grid's way out of a row's content, so Escape exits fullscreen and
   leaves focus stuck on the control. And the signal-mapping panels'
   status washes come out — **row background is the layer's**, so a
   panel encodes per-row state in a cell, never in the row. Split out of
   the owner review walk and fully groomed on 2026-08-25; ADR 0044
   takes three amendments, including deleting the editor-face carve-out.
   **No open questions**, no phases yet.
2. [Task 116 — RBS Problems Across Every Configuration](0116-rbs-problems-across-configurations.md)
   — one view over problems from every open `.cannet_rbs`, filterable by
   file, host-computed and paged. The RBS chip opens that instead of a
   single configuration. From queue item 1.13ab; the steps-to-reproduce
   leg was dropped by owner ruling 2026-08-25. **Depends on task 113**,
   which settles what an RBS grid row is. Two open questions.
3. [Task 112 — The Signal Reference Registry](0112-signal-reference-registry.md)
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
4. [Task 124 — One Toolbar](0124-one-toolbar.md)
   — the app-level toolbar and the ten panel toolbars wear one chip
   language but remain hand-laid flex rows; converge them on a shared
   toolbar control that owns layout and wrap-vs-overflow, settling
   `useToolbarFit`'s one-consumer question. Opened from queue finding
   3.21; owner-placed later, definitely not immediate scope.
5. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13.
6. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
7. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
   Inherits the measurement strip's rework, which task 108 phase 4
   suppressed rather than removed.
8. [Task 85 — Extended Multiplexing End to End](0085-extended-multiplexing.md)
   — `SG_MUL_VAL_` parsed and modelled, the Database panel rendering
   nested mux trees, per-frame decode gated on the full selector path,
   and a worked example DBC. The task file existed but had never
   reached this roadmap; found unlisted and added at the 2026-08-26
   close-out. Open design questions.
9. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
   — cannet connects out to a value-source server that streams sparse
   `(signal, value)` updates by name; RBS applies them as overrides and
   keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
   (e.g. an EV drive cycle) drive the RBS.
10. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
11. [Task 40 — bridge_client / cannet-client Session-Machinery
    Consolidation](0040-bridge-client-consolidation.md) — gated on
    cannet-client growing a subscribe-timeout / dynamic-allocation
    capability; split out from task 30's item #9 once everything else
    in that audit shipped.

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
