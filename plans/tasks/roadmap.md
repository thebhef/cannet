# Roadmap

The ordered list of work and the canonical implementation order. Each
item is a **task** with its own `NNNN-description.md` file in this
directory (`plans/tasks/`); this file is the table of contents and the
sequence.

Concrete library / framework choices live in
[`technology-inventory.md`](../technology-inventory.md); cross-cutting
principles live in the ADRs under [`../../docs/adr/`](../../docs/adr/)
and in [`../../CLAUDE.md`](../../CLAUDE.md).

Tasks keep stable numbers (they don't renumber when the order changes).

## Where things stand

| | Count |
|---|---|
| Implemented, awaiting acceptance | 24 |
| In flight | 3 |
| Outstanding | 23 |

**Nothing has merged.** Everything implemented sits on one linear
branch chain off `main`, tip `task-109-phase-6-pattern-signals`.
Merging the last branch takes all of it.

Normally a completed task is removed from this file (the detail lives
in git history). That is **deferred by owner ruling 2026-08-22**: the
implemented tasks stay listed until 107, 108, 109 and the owner review
queue are settled, and the task-doc cleanup happens then.

**The queue's § 1 was walked by the owner 2026-08-24**: 18 of its 33
items accepted, 15 sent back. The 15 reach back into nine of the tasks
in the table below — so acceptance of those is what closes them out, not
a separate pass. They were walked with the owner on 2026-08-24 and
2026-08-25 and **dispersed into tasks 112 through 119**; two were dropped
as intractable and one ratified with no work left. Every ruling is in
[`../owner-review-queue.md`](../owner-review-queue.md) § 2.10, and § 1's
index names the task that owns each item.

## Implemented — awaiting acceptance

Each met its documented exit criteria, walked criterion by criterion
against a named test or artefact. The acceptance record — and the
findings still needing a verdict — is
[`../owner-review-queue.md`](../owner-review-queue.md) § 4.

Listed in the order they landed on the chain, which is the order a
reviewer walks them.

| Task | What it was |
|---|---|
| [86](0086-usage-feedback-0.9.0.md) | Import time origins, enum overlays, events-panel width |
| [27](0027-project-rbs-disk-watch.md) | Live disk-watch for project and RBS files |
| [87](0087-blf-writer-timestamp-fidelity.md) | BLF writer timestamp fidelity |
| [89](0089-signal-mapping-panel.md) | The signal mapping panel |
| [90](0090-cycle-86-87-follow-ups.md) | Follow-ups from the 86 / 27 / 87 cycle |
| [88](0088-bus-assignment-governs-decode.md) | Bus assignment governs decode — 8 phases, 15 criteria |
| [92](0092-one-resolution-rule.md) | One resolution rule — 13 `dbc_applies` sites down to 4 |
| [91](0091-frame-index-at-ns-unsorted.md) | `frame_index_at_ns` binary-searching an unsorted store |
| [93](0093-source-comments-name-tasks.md) | Source comments naming task numbers, plus the CI lint |
| [98](0098-common-scale-wrong.md) | Signals rendering wrong on a common scale |
| [95](0095-grid-content-click-collapses.md) | Gridview content click collapsing the message |
| [97](0097-enum-labels-on-axis.md) | Enum value labels on the plot's y axis |
| [96](0096-long-names-render.md) | Long signal and `VAL_` names rendering |
| [94](0094-server-defaults-and-discovery.md) | Server bind defaults, mDNS honesty, servers panel from the project view |
| [99](0099-transmit-controls.md) | Transmit controls: kill switch out, run state unpersisted, Space in the transmit panel |
| [100](0100-calc-fields-dbc-config.md) | Counter/CRC declared in a DBC now populates the editor |
| [105](0105-unfinalized-blf-recovery.md) | Reading a BLF whose writer never finalized, read-only |
| [104](0104-load-progress-and-cancel.md) | Determinate load progress, and a discoverable cancel |
| [102](0102-event-surface.md) | The event surface: kinds, per-view visibility, tag and description |
| [103](0103-toolbar-status-chips.md) | The toolbar's status bar, status chips, and ADR 0055 |
| [101](0101-bus-health.md) | Bus health — error frames labelled and coalesced, controller state, bus load |
| [106](0106-any-bus-series-and-sample-order.md) | The any-bus series ruled on, and the signal cache's sample-order sweep |
| [19](0019-command-palette-goto.md) | Typed-argument palette prompts, `Mod+T`/`Mod+E`, event-row keyboard actions |
| [110](0110-chain-ci-repair.md) | Chain CI repair, and the Windows MSI bundle target dropped |

**102 and 110 were added to this table 2026-08-23.** Both landed on the
chain and neither had ever appeared here or in the owner review queue,
so nothing they recorded had reached the owner. 110 carries no exit
criteria at all, and 102's are the only ones in this table with a *not
met* verdict — see owner-review-queue 3.45.

Two of these have an acceptance blocker named in task 109 rather than
in their own files:

- **101** — its hardware verification (owner-review-queue 3.14) was run
  and **failed**: unplugging the PEAK dongles produced no indication of
  a bus fault, and the trace kept showing traffic. Task 109 item 2.
  **Cleared for PCAN 2026-08-23**: after task 109 phases 2 and 2c the
  owner re-ran it and the fix is confirmed working (owner-review-queue
  3.38). The Vector leg is implemented and still untested (3.40).
- **99** — it took "Space already works in the RBS panel" as a premise
  and only added the idiom to the transmit panel. The premise is
  false. Task 109 item 7. **Cleared 2026-08-23**: phase 3 landed the fix
  and the regression test the premise had cost.

## In flight

1. [Task 108 — The Chip Language: A GUI Polish Pass](0108-gui-chip-redesign.md)
   — the top-level button bar, plot and trace chrome, and every other
   panel toolbar regrouped onto the color-chip shape: smaller controls,
   the adopted in-repo icon registry, state on the hairline. Also
   styles task 107's event-surface toolbar. Opened by owner instruction
   2026-08-21.
   **All six phases landed.** The prototype
   [`../prototypes/gui-chip-redesign.html`](../prototypes/gui-chip-redesign.html)
   is durable and maintained in the same commits.
2. [Task 107 — Events Point at Signals](0107-events-point-at-signals.md)
   — an event gains subjects (signals / messages / other events, by
   structural reference), untyped event links whose pairs draw
   highlight-only extent bands, and provenance-agnostic authoring.
   Groomed and prototype approved 2026-08-21; carrier research (MDF4 EV
   blocks vs. BLF `GLOBAL_MARKER`) closed 2026-08-22, so phase 2
   implements rather than discovers.
   **All five phases landed; code-complete 2026-08-22.** Exit criteria
   walked in the task file: 22 of 24 met. The two that are not — unknown
   block keys surviving a text round-trip but not `file → Note → file`
   (queue 3.30), and a file-backed series being unable to be an event's
   subject (queue 3.31) — each close only with a durable-model change,
   and are the task's acceptance question.
3. [Task 109 — Usage Feedback From the Chip-Era Build](0109-usage-feedback-chip-era.md)
   — ten observations from test-driving the chain: the view-signals
   panel reading empty, the unplugged-PEAK verification failing, the
   status bar's labels, three project-management affordances that do
   not exist as buttons, Space in the RBS panel, a keyboard-nav
   highlight artefact, a redundant Disconnect-all, and RBS signals that
   are not grid rows. Opened by owner instruction 2026-08-22.
   **Groomed 2026-08-22; regrooved 2026-08-23 after a bench session
   found the reported fault was the CAN link, not the USB device.
   Every phase landed — 1, 2, 2b, 3, 2c, 2d, 4, 5 and 6; code-complete
   2026-08-23. Kvaser deferred by owner ruling (queue 2.7).** Carries the
   acceptance blockers for tasks 99 (item 7) and 101 (item 2). Owner
   ruling 2026-08-22 on item 1: pattern-matched signals belong in the
   view-signals list, so phase 6 implemented before it investigated —
   and the investigation then refuted the mount-order hypothesis, so
   the pattern exclusion was the whole of the reported cause.

## Outstanding

In order of work, first at the top. None started.

1. [Task 115 — Trace Row Menus Keep Only the Event Action](0115-trace-row-menu-scope.md)
   — a right-click on a trace frame row stops offering the sources
   picker; the button bar is where those items live and always was.
   Create event stays. From queue item 1.23; fully ruled 2026-08-25.

2. [Task 117 — Refuse to Connect Without a Bound Bus](0117-refuse-to-connect-without-a-bound-bus.md)
   — connecting with any unbound bus fails loudly and names it; the
   empty-project refusal names the bus rather than a binding; a new
   project starts with one bus called `Bus 1`. From queue item 1.34,
   captured at the owner's instruction 2026-08-25. No open questions.
3. [Task 114 — One Name Per Thing](0114-one-name-per-thing.md)
   — the chrome says one thing where the model says another. ADR 0055
   is amended to say what the code does (the command registry is the
   model, the chip bar one rendering of it); the toolbar's last `DBC`
   chip becomes `Database`; a virtual bus stops rendering its wire id
   in the bus-health adapter cell, reading `virtual bus` instead. Split
   out of the owner review walk and fully groomed on 2026-08-25.
   **No open questions**, no phases yet.
4. [Task 113 — Is RBS a Grid?](0113-rbs-as-a-grid.md)
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
5. [Task 116 — RBS Problems Across Every Configuration](0116-rbs-problems-across-configurations.md)
   — one view over problems from every open `.cannet_rbs`, filterable by
   file, host-computed and paged. The RBS chip opens that instead of a
   single configuration. From queue item 1.13ab; the steps-to-reproduce
   leg was dropped by owner ruling 2026-08-25. **Depends on task 113**,
   which settles what an RBS grid row is. Two open questions.
6. [Task 112 — The Signal Reference Registry](0112-signal-reference-registry.md)
   — every persisted signal reference moves onto one host-side registry,
   the way `NotesStore` and `TransmitFrameRegistry` already hold theirs.
   The `elements` blob stays opaque for presentation and stops carrying
   references, so the mapping panel reads a model instead of being
   pushed to, and a repair is one edit instead of a five-store walk.
   Opened by owner observation 2026-08-24 while walking queue item 1.3.
   **Took 1.3's residual (a transmit row is `bus + message id + which
   database`), 1.30 and 1.19 on 2026-08-25** — because building any of
   them ahead of the registry builds a one-off of it. **Needs grilling before implementation** — no phases,
   and five open design questions. Bears on queue findings 3.1, 3.31,
   3.41 and 3.47.

7. [Task 118 — The `comment-references` Check Leaves CI](0118-comment-references-out-of-ci.md)
   — the check moves to the `implement-phase` and `oversee-roadmap`
   skills and the CI job goes, so every phase's CI table becomes five
   jobs. **Process, not product.** From queue item 1.35; ruled
   2026-08-25. The risk being accepted — instruction-level enforcement
   is what failed before — is recorded in the task, not argued.
8. [Task 119 — Example DBCs for the Duplicate-Id Collision](0119-duplicate-id-example-dbcs.md)
   — two DBCs that collide on one bus plus a project assigning both, so
   the owner can review what the Database panel marks. **A deliverable
   to review against, not a behaviour change.** From queue item 1.33a;
   ruled 2026-08-25. Two open questions.
9. [Task 79 — Restore-Then-Import + Scratch Isolation](0079-restore-then-import.md)
   — the user-reachable empty-view defect Task 78 phase 1 attributed
   (restore a prior capture, then import: the view stays empty while
   the store refills), plus making `--app-data-dir` isolate the
   capture scratch as ADR 0031 claims. Opened by owner ruling
   2026-08-15; kept as scoped, both halves, by owner ruling
   2026-08-19.
10. [Task 80 — Plot Resample Churn Over a Stopped Capture](0080-stopped-capture-resample.md)
   — investigation-first: ~30 Hz resample + follow-slide held over a
   stopped, fully imported capture (trace still reads RUNNING after
   import). Opened by owner ruling 2026-08-15.
11. [Task 82 — Engine-Native Resource Monitoring](0082-engine-native-resource-monitoring.md)
   — the health sampler's process-family metrics move to the web
   engine's own bookkeeping (WebView2 `GetProcessInfos`) as the
   de-jure source; per-platform matrix (the macOS ppid walk silently
   excludes WKWebView's launchd-parented helpers), the
   `unsafe`/`webview2-com` adoption rulings, costs re-measured.
   Opened by owner ruling 2026-08-15.
12. [Task 83 — Follow-Ups from the 70–78 Cycle](0083-cycle-follow-ups.md)
   — the small findings the retiring 70–78 task files recorded in
   passing, collected as one groomable pass: the project-command test
   harness gap, the rebuild-chip rough edges, the unattributed
   launch-hang lead, frameless-import time ranges, and the
   untrusted-row token editor. Opened by owner ruling 2026-08-16.
13. [Task 84 — Make the MDF's Embedded DBC Durable](0084-mdf-embedded-dbc.md)
   — an imported MDF's embedded DBC decodes for the session but
   survives no reopen; make it durable (extraction or a durable
   project reference), then revisit name-matching file-backed
   signals on top. **Needs grilling before implementation.** Opened by
   owner ruling 2026-08-16.
14. [Task 77 — Catch-Up Decode Off the Serve Path](0077-background-catchup-decode.md)
   — shape 3 of Task 72 phase 3's attributed enum-lag fix (owner
   ruling 2026-08-15): decode cursors advance independently of view
   fetches, serves read what the cursors reached. Amends ADR 0049.
15. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13.
16. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
    — the two data-named cuts from the 2026-08-08 ingest profiling: the
    disk-spill segment write (43 % of the release per-frame budget)
    and `bus_id: Option<String>` interning (~15 %). Opened by owner
    ruling 2026-08-09.
17. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
    — crash on exit (wry/WebKit layer-tree teardown race) and missing
    Spotlight bundle metadata. Independently-shippable macOS fixes.
18. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
    — the hardware/virtual-bus verify-and-fix pass (post-clear negative
    timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
    plot-color bug and the `decimatePoints` dead-code removal.
19. [Task 22 — CANopen](0022-canopen.md)
    — EDS ingestion and SDO / PDO decoding.
20. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
    — triggers, math channels, per-series offset / gain, export.
    (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
    Inherits the measurement strip's rework, which task 108 phase 4
    suppressed rather than removed.
21. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
22. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
23. [Task 40 — bridge_client / cannet-client Session-Machinery
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
