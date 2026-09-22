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

## 0.10.x — fix and stabilize

The development path for the 0.10.x releases: correctness, rework,
stability, project health. In order of work, first at the top. None
started.

1. [Task 121 — The Trace Tells the Truth About the Wire](0121-the-trace-tells-the-truth-about-the-wire.md)
   — reopened 2026-08-30 on the bench: Tx rows still flow when the CAN
   bus is pulled, the observation that opened the task (109 item 2,
   thrice-reported). Both landed signals sit upstream of the wire (the
   enqueue mark and the remote peer's TX_REJECTED); a locally queued
   frame that never wins arbitration produces neither. Needs grooming:
   mark from chip state, pause on bus-off, or a coalesced signal.
2. [Task 128 — Shared-Layer Holdouts](0128-shared-layer-holdouts.md)
   — the last cleanup items the 2026-08-27 run surfaced, opened at the
   owner's instruction while walking its open items: `serverList.ts`'s
   two hooks onto `useHostMirror` via a `fromPayload` ignore signal
   (ruled: option a — no behaviour change), Escape reaching a
   portalled dropdown before the fullscreen binding, and the columned
   gridviews' missing ARIA roles.
3. [Task 119 — Example DBCs for the Duplicate-Id Collision](0119-duplicate-id-example-dbcs.md)
    — two DBCs that collide on one bus plus a project assigning both, so
    the owner can review what the Database panel marks. **A deliverable
    to review against, not a behaviour change.** From queue item 1.33a;
    ruled 2026-08-25. Two open questions.
4. [Task 79 — Restore-Then-Import + Scratch Isolation](0079-restore-then-import.md)
    — the user-reachable empty-view defect Task 78 phase 1 attributed
    (restore a prior capture, then import: the view stays empty while
    the store refills), plus making `--app-data-dir` isolate the
    capture scratch as ADR 0031 claims. Opened by owner ruling
    2026-08-15; kept as scoped, both halves, by owner ruling
    2026-08-19.
5. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
    — the hardware/virtual-bus verify-and-fix pass (post-clear negative
    timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
    plot-color bug and the `decimatePoints` dead-code removal.
6. [Task 83 — Follow-Ups from the 70–78 Cycle](0083-cycle-follow-ups.md)
    — the small findings the retiring 70–78 task files recorded in
    passing, collected as one groomable pass: the project-command test
    harness gap, the rebuild-chip rough edges, the unattributed
    launch-hang lead, frameless-import time ranges, and the
    untrusted-row token editor. Opened by owner ruling 2026-08-16.
7. [Task 84 — Make the MDF's Embedded DBC Durable](0084-mdf-embedded-dbc.md)
    — an imported MDF's embedded DBC decodes for the session but
    survives no reopen; make it durable (extraction or a durable
    project reference), then revisit name-matching file-backed
    signals on top. **Needs grilling before implementation.** Opened by
    owner ruling 2026-08-16.
8. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
    — crash on exit (wry/WebKit layer-tree teardown race) and missing
    Spotlight bundle metadata. Independently-shippable macOS fixes.
9. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
    — the two data-named cuts from the 2026-08-08 ingest profiling: the
    disk-spill segment write (43 % of the release per-frame budget)
    and `bus_id: Option<String>` interning (~15 %). Opened by owner
    ruling 2026-08-09.
10. [Task 82 — Engine-Native Resource Monitoring](0082-engine-native-resource-monitoring.md)
    — the health sampler's process-family metrics move to the web
    engine's own bookkeeping (WebView2 `GetProcessInfos`) as the
    de-jure source; per-platform matrix (the macOS ppid walk silently
    excludes WKWebView's launchd-parented helpers), the
    `unsafe`/`webview2-com` adoption rulings, costs re-measured.
    Opened by owner ruling 2026-08-15.
11. [Task 77 — Catch-Up Decode Off the Serve Path](0077-background-catchup-decode.md)
    — shape 3 of Task 72 phase 3's attributed enum-lag fix (owner
    ruling 2026-08-15): decode cursors advance independently of view
    fetches, serves read what the cursors reached. Amends ADR 0049.
12. [Task 133 — Misc Fixes](0133-misc-fixes.md)
    — the collection point for small owner-reported fixes that belong
    to no open task; currently: hex displays preserve leading zeros.
    Opened by owner instruction 2026-09-03.
13. [Task 143 — A Webview Reload Rejoins the Running Session](0143-reload-rejoins-the-session.md)
    — a reload today re-runs the fresh-host boot (stops loggers, RBS
    and periodic TX; swaps the raw store under a live pump); make it
    rejoin the host's session instead, then let the health recorder
    reload a window whose renderer has stopped heartbeating (the
    black screen from the six-day ll16 capture). Opened by owner
    ruling 2026-09-15; the WebView2 `ProcessFailed` hook is backlogged.

## Beyond 0.10.x — feature rework and architecture

The heavier items: feature rework and architectural change, the
revisions that follow the 0.10.x path. Ordered among themselves; the
section above comes first. **Exception (owner ruling 2026-09-06): the
groomed 136 → 137 → 135 run executes now**, moved to the head of this
section with implementation underway.

14. [Task 136 — python-can Cannet Client](0136-python-can-cannet-client.md)
    — `CannetBus(can.BusABC)` behind python-can's `can.interface`
    entry point, fed by a factory reading the canonical server trust
    store; SNTP time sync; detection dials the trusted servers; reuses
    the sidecar's gencode and frame mappers. Split out of task 134,
    2026-09-05; groomed 2026-09-06 — all questions ruled, exit
    criteria set. Two phases.
15. [Task 137 — Log Export](0137-log-export.md)
    — templated export naming ({project}/{logger}/{start}/{now}
    resolved host-side), an export dialog with range picker, background
    export with a status-bar progress chip, project loggers writing
    BLF live with size-cap splits, and the logger folder's recursive
    file gridview with ranged re-import. Split out of task 134,
    2026-09-05; groomed 2026-09-06 — prototype
    (`plans/prototypes/export-dialog.html`) accepted as the
    behavioural spec, exit criteria set. Four phases.
16. [Task 135 — Plot Math Functions](0135-plot-math-functions.md)
    — math functions on plotted signals (sum, difference, product,
    scale, expfilter, hline, integration, duty cycle, frequency, the
    pointwise set functions, statistic, rms), computed host-side as a
    new provenance with compositional fingerprints; created from the
    Database view's Computed branch, edited in place everywhere.
    Split out of task 134, 2026-09-05; grooming closing 2026-09-06 —
    prototype `plans/prototypes/math-signals.html`, exit-criteria
    draft in the task file pending the in-place-editor rework.
17. [Task 139 — Units and Scaling for Math Signals](0139-math-units-scaling.md)
    — per-operand and output scalars on math channels, unit-driven via
    a unit library seeded from the DBC's unit strings, with a mapping
    dialog and a persisted sparse dict for arbitrary strings. Opened by
    owner instruction 2026-09-06; **executes now, on the current
    stack**; grooming in progress.
18. [Task 141 — Bench Rework: Owner-Reported Fixes on the Open Stack](0141-bench-rework.md)
    — the 2026-09-06 evening bench queue, distributed through the
    stack: the database panel's two-stage delete converges on the
    shared control (amends `task135-editor`), its value rows stop
    letting the comment squeeze out name/value/unit
    (`task135-surfaces`), Ctrl+F reaches the settings search box (own
    branch off `feedback-capture`), and integration produces Ah from
    an A operand (139 phase 4, `task139-units`). **Executes now.**
19. [Task 144 — cannet-client CLI](0144-cannet-client-cli.md)
    — a `cannet-client` console script giving the python client the
    GUI Servers panel's affordances without the GUI: `list` (mDNS
    browse ∪ trust store, known servers shown even when absent),
    `connect` (the four ADR-0041 paths, TOFU accept, token entry,
    writing the shared `servers.json`), `forget`. The package moves
    to top-level `clients/`. Opened by owner instruction 2026-09-17;
    **executes now, on the current stack.**
20. [Task 145 — An Explicit Wire Protocol Version](0145-wire-protocol-version.md)
    — the protobuf package-major convention made explicit and
    checkable: a `ServerInfo` RPC states the packages served, every
    client (GUI, python client, CLI, third parties) refuses a
    mismatch legibly, CI enforces additive-only changes inside
    `cannet.v1`, and the rule is written where a third party will
    read it. Releases stay lockstep. Opened by owner instruction
    2026-09-19 from user feedback; **executes now, on the current
    stack.**
21. [Task 146 — A Round of Plot Fixes](0146-plot-fixes-round.md)
    — five plot-panel defects from real use: show-points markers off
    the signal extrema, bus markers ignoring the events panel's
    enable/disable, empty plot areas drawing no grid or cursors,
    cursor handles/labels over the signals, point markers wrong on
    enum lanes. Opened 2026-09-19 from user feedback; **executes
    now.**
22. [Task 147 — Collapse Database Items Under a Filter](0147-collapse-under-filter.md)
    — the database view's branch nodes collapse while a filter
    string is present. Opened 2026-09-19 from user feedback;
    **executes now.**
23. [Task 148 — Connect With a Bus Set to No Interface](0148-connect-with-no-interface.md)
    — going online works again when a project bus is explicitly set
    to no interface. Opened 2026-09-19 from user feedback;
    **executes now.**
24. [Task 149 — Every Unit the Library Has](0149-every-unit-the-library-has.md)
    — the host's unit table stops curating: every base unit of every
    quantity `runtime_units` carries is offered as prefix + base unit,
    all 110 quantities built, so litres and `L / min` exist and a
    database's `LPM` has something to map to. Opened 2026-09-21 from
    user feedback (item 11); **executes now.**
25. [Task 150 — The Project Caches List Names Its Projects](0150-project-caches-list-names-projects.md)
    — the settings view's project caches rows lead with the project
    name instead of a cache-space hash path, and `Delete` becomes the
    shared two-stage trash control. Opened 2026-09-21 from owner
    observations; **executes now.**
26. [Task 138 — Events in Logged BLFs](0138-logged-events.md)
    — the project logger appends user-authored timeline events to the
    streaming BLF live: a marker on create and on every edit, fresh id
    per revision chained by an `edited:` key, deletion as a tombstone
    revision; ingest collapses chains to current state and re-export
    writes the clean file. Extends task 137's logger; opened by owner
    instruction 2026-09-06, groomed same day — all questions ruled,
    two phases.
27. [Task 140 — Project State Items](0140-project-state-items.md)
    — start/stop on RBS and logger items in the project view, and a
    right-aligned recently-active section in the top-level status
    strip. Opened by owner instruction 2026-09-06; queued behind the
    in-progress stack and task 139; needs grooming and a status-strip
    prototype at pickup.
28. [Task 142 — Fzf Filter in the Trace Panel](0142-trace-fzf-filter.md)
    — an fzf-style fuzzy filter in the Trace panel's toolbar, active
    in both view modes (chronological and by-id), composing with the
    sources filter and event toggles. A Rust port of fzf's scoring
    (TS `fzf` as the oracle) matches host-side over bus, message,
    signal and enum-label text so both modes stay paged; event text
    is matched in JS over the bounded event list. Opened by owner
    instruction 2026-09-11; groomed 2026-09-20; **executes now.**
29. [Task 116 — RBS Problems Across Every Configuration](0116-rbs-problems-across-configurations.md)
   — one view over problems from every open `.cannet_rbs`, filterable by
   file, host-computed and paged. The RBS button opens that instead of a
   single configuration. From queue item 1.13ab; the steps-to-reproduce
   leg was dropped by owner ruling 2026-08-25. Task 113 settled what an
   RBS grid row is (landed 2026-08-27), so that dependency is met. Two
   open questions.
30. [Task 112 — The Signal Reference Registry](0112-signal-reference-registry.md)
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
31. [Task 124 — One Toolbar](0124-one-toolbar.md)
   — the app-level toolbar and the ten panel toolbars wear one button
   style but remain hand-laid flex rows; converge them on a shared
   toolbar control that owns layout and wrap-vs-overflow, settling
   `useToolbarFit`'s one-consumer question. Opened from queue finding
   3.21; owner-placed later, definitely not immediate scope.
32. [Task 130 — One Modal](0130-one-modal.md)
   — the six modal dialogs share CSS chrome and a hand-copied
   "Escape/backdrop means Cancel" convention but no code; converge them
   on a shared modal base owning dismissal, ARIA, and focus trapping.
   The modal companion to task 124; opened by owner instruction
   2026-08-30.
33. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13.
34. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
35. [Task 132 — J1939](0132-j1939.md)
   — the basic functions of a complete J1939 implementation as one
   set: PGN-aware decode, Transport Protocol reassembly (RTS/CTS and
   BAM), DM1/DM2 diagnostics including DM1 over TP, address claim.
   Opened by owner instruction 2026-08-31; no J1939 task existed
   before it.
36. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
   Inherits the measurement strip's rework, which task 108 phase 4
   suppressed rather than removed.
37. [Task 131 — Grow Live](0131-grow-live.md)
   — a third x-range behaviour beside manual and Follow: left edge
   pinned to the capture's first sample, right edge riding the live
   edge, so the window widens as data arrives. Runs for a period after
   connect, then hands off to Follow at the grown width. Opened by
   owner instruction 2026-08-31; duration and mode-vs-phase questions
   open.
38. [Task 85 — Extended Multiplexing End to End](0085-extended-multiplexing.md)
   — `SG_MUL_VAL_` parsed and modelled, the Database panel rendering
   nested mux trees, per-frame decode gated on the full selector path,
   and a worked example DBC. The task file existed but had never
   reached this roadmap; found unlisted and added at the 2026-08-26
   close-out. Open design questions.
39. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
   — cannet connects out to a value-source server that streams sparse
   `(signal, value)` updates by name; RBS applies them as overrides and
   keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
   (e.g. an EV drive cycle) drive the RBS.
40. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
   — staged: pcapng import (CAN linktypes, no model change), step/hold
   plot semantics for on-change series, then the multi-protocol trace
   model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
   Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
41. [Task 40 — bridge_client / cannet-client Session-Machinery
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
