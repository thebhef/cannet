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

1. [Task 106 — The Any-Bus Series, and the Sample Order It Breaks](0106-any-bus-series-and-sample-order.md)
   — a DBC-backed plot series naming no bus decodes samples its
   fingerprint cannot see, and it is the only sequence in the signal
   cache that can mix buses, so `partition_by_t`'s "non-decreasing"
   precondition is asserted rather than enforced. One task because
   settling the first half dissolves the second. Opened by the overseer
   2026-08-21 out of task 91's audit; groomed 2026-08-22 and
   **implemented the same day** (3 phases, 5 commits: the busless series
   made unrepresentable, the mapping panel able to re-point it, and the
   order sweep). Remains listed pending close-out — the ruling shipped on
   the overseer's recommendation and needs the owner's ratification
   (owner-review-queue 1.19).
2. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — two steps: the typed-argument prompt infrastructure with the
   commands that need it (go-to-time and set-visible-range, with
   `Mod+T` go-to-time and `Mod+E` go-to-event bindings; go-to-row
   dropped to the backlog), then keyboard interaction for event rows
   in both the events view and the trace (Space to goto, F2 to
   rename, ARIA surface verified against the gridview layer).
   Events-view *filtering* stays with task 102. Pulled forward from
   position 32, groomed, and design questions resolved by owner
   rulings 2026-08-21. **Implemented 2026-08-22** (2 steps, 15
   commits; ADR 0018 and ADR 0044 both amended). Remains listed
   pending close-out.
3. [Task 103 — Toolbar Buttons Become Status Chips](0103-toolbar-status-chips.md)
   — **implemented 2026-08-21** (`StatusChip` / `StatusBar` /
   `statusBarFit`, ADR 0055; the toolbar lost its states to the bar).
   Remains listed pending close-out: owner-review-queue items 1.13–1.15
   (the RBS chip's destination diverges from its ruling; bus load has
   no producer until task 101; press-while-connecting means cancel)
   need owner verdicts before this comes off the roadmap.
4. [Task 108 — The Chip Language: A GUI Polish Pass](0108-gui-chip-redesign.md)
   — the top-level button bar, plot and trace chrome, and every other
   panel toolbar regrouped onto the color-chip shape — smaller
   controls, the adopted in-repo icon registry, state on the
   hairline. **After task 103** (owner ruling 2026-08-21), whose
   shared chip component this language styles. Prototype approved-in-
   substance and kept durable; also styles task 107's event-surface
   toolbar. Opened by owner instruction 2026-08-21.
5. [Task 107 — Events Point at Signals](0107-events-point-at-signals.md)
   — an event gains subjects (signals / messages / other events, by
   structural reference), untyped event links whose pairs draw
   highlight-only extent bands, and provenance-agnostic authoring.
   Groomed and prototype approved 2026-08-21; position in this list
   is provisional pending owner ordering.
6. [Task 86 — Usage Feedback: Import Time Origins, Enum Overlays,
   Events-Panel Width](0086-usage-feedback-0.9.0.md) — four unrelated
   owner observations from 0.8.1 / 0.9.0-dev use, each
   investigation-first: the events panel's rename/remove controls need
   an implausible width, imported BLFs render negative timestamps (and
   import time origins differ per format), enum overlays only appear
   after a view remount, and a 0.8.1-era "signal rebuild doesn't
   always happen on DBC load" that needs re-verifying against 0.9.0.
   Opened by owner ruling 2026-08-18.
6. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
   — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
   and RBS (`.cannet_rbs`) files so external edits are picked up
   automatically, and own the DBC-change propagation contract (and its
   ADR) that task 86 item 3 consumes. Groomed and pulled forward by
   owner ruling 2026-08-19.
7. [Task 87 — BLF Writer Timestamp Fidelity](0087-blf-writer-timestamp-fidelity.md)
   — `BlfCaptureWriter` silently clamps a frame whose timestamp is
   earlier than the one before it, so a saved BLF can differ from the
   capture it came from. Real multi-bus captures dip ~1.1 s below
   their own maximum several times a minute (ADR 0024) and Save
   Capture writes in arrival order, so this is ordinary data, not an
   edge case. Research the format question first. Opened by owner
   ruling 2026-08-19.
8. [Task 88 — Bus Assignment Governs Decode](0088-bus-assignment-governs-decode.md)
   — a DBC assigned to no bus decodes nothing; adding and removing
   say nothing about assignment; assignment is the cache lifecycle
   boundary (assign revives matching fingerprints, unassign parks);
   every frame carries a bus. Supersedes parts of task 81. Groomed
   2026-08-19; needs its exit criteria firmed before implementation.
9. [Task 90 — Follow-Ups from the 86 / 27 / 87 Cycle](0090-cycle-86-87-follow-ups.md)
   — the findings those tasks recorded and left undispositioned,
   collected as one task: `WindowedSource` silently truncating an
   out-of-order import (read-path data loss, and cannet writes files it
   then truncates), two crates sharing the `gen_time_origin_fixtures`
   example name so a parallel `cargo test --workspace` races, a
   `frame_index_at_ns` doc comment its own test contradicts, and
   `cannet-spill`'s manifest version being stamped but never checked on
   reopen. All small. The Tauri mock-app harness finding went to the
   backlog instead (owner ruling 2026-08-19) — it dissolves when the
   host-side model moves to its own crate. Opened by owner ruling
   2026-08-19.
10. [Task 89 — The Signal Mapping Panel](0089-signal-mapping-panel.md)
   — a live status panel over the signals the open views reference:
   what decodes each one, which need attention, and the one place the
   rare "two databases define this signal" ambiguity is resolved. Task
   88 ships the warning; this ships the resolution affordance. The same
   grid serves an RBS config's DBC fields. Prototyped and groomed
   2026-08-19; a few open questions remain (see the task file).
11. [Task 91 — `frame_index_at_ns` Binary-Searches an Unsorted Store](0091-frame-index-at-ns-unsorted.md)
   — a `lower_bound` search over a store that is routinely unsorted:
   on a multi-bus capture it anchors a timeline marker to the wrong
   trace row, or reports "not found" for a timestamp that is present
   and silently drops the marker. Found by task 90 phase 2 while
   verifying the doc comment that asserted the false precondition.
   Needs grooming: the contract, and what it can afford on the serve
   path. Opened 2026-08-20.
12. [Task 92 — One Resolution Rule, Not Eleven Copies](0092-one-resolution-rule.md)
   — [ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)
   says a decoded value has exactly one definition; thirteen
   `dbc_applies` sites each spell that rule out for themselves, in at
   least two different ways. Five take "the first eligible database
   that *has* the attribute", which can source enum labels or a
   counter/CRC default from a database that is not decoding the value;
   the trace row resolves per *message* where the signal cache resolves
   per *signal*, so a collision can decode two ways at once. Sweep
   findings from the ADR 0054 pass. Opened by owner instruction
   2026-08-20.
13. [Task 93 — Source Comments Name Task Numbers](0093-source-comments-name-tasks.md)
   — `CLAUDE.md` forbids source from referencing `plans/` or naming a
   task number; `main` carries 17 such references and the current
   branch chain added 54 more. Rewrite each to state its reason inline
   or cite the governing ADR, and decide whether a lint enforces it —
   without one this recurred 54 times under active review. Runs first
   of this block so the nine tasks after it do not compound the
   violation. Opened by overseer review finding 2026-08-20.
14. [Task 98 — Signals Render Wrong on a Common Scale](0098-common-scale-wrong.md)
   — a signal spanning -200..0 A rendered as roughly -1.5..0. Wrong
   data on screen, and "still" in the report implies a prior attempt
   missed it, so investigation-first with a deterministic reproduction
   before any fix, by owner instruction. Opened 2026-08-20 from 0.9.0
   usage feedback.
15. [Task 95 — Clicking Grid Content Collapses the Row](0095-grid-content-click-collapses.md)
   — the trace row's root element owns the collapse `onClick` and the
   expanded signal list is its child, so reading a signal collapses the
   message. Fix the affordance to the message line, make content
   clicks select, and sweep every gridview with expandable rows.
   Opened 2026-08-20 from 0.9.0 usage feedback.
16. [Task 97 — Enum Values Still Appear on Axis Labels](0097-enum-labels-on-axis.md)
   — a single-signal enum area emits one axis tick per enum value with
   the label quoted beside it, unbounded, so hundreds of values or long
   names wreck the gutter. The enum overlay already supplies the name.
   A removal, not a redesign. Opened 2026-08-20 from 0.9.0 usage
   feedback.
17. [Task 96 — Long Signal and Enum Names Do Not Render](0096-long-names-render.md)
   — the DBC long-name extension is already implemented at the parse
   layer; what is missing is presentation across every surface that
   shows a name, and an example DBC that exercises it (none of the nine
   does, so the defect is invisible in development). Opened 2026-08-20
   from 0.9.0 usage feedback.
18. [Task 94 — Server Defaults and Discovery Reachability](0094-server-defaults-and-discovery.md)
   — a server advertises addresses on every interface regardless of
   what its bind serves, so the default loopback bind is announced
   LAN-wide at addresses where nothing listens; plus what a bare
   invocation should do without weakening ADR 0041, and reaching the
   servers panel from the project view. Opened 2026-08-20 from 0.9.0
   usage feedback.
19. [Task 99 — Transmit Controls: One Idiom, One State](0099-transmit-controls.md)
   — the Space-to-act idiom stops at the RBS panel; the per-message
   green dot is an indicator for the wrong condition when the model
   already knows a message with no cycle time cannot run; and the kill
   switch is a second global stop in series with `run`. One question,
   three symptoms. Inherits task 88 phase 7's stop-on-reload. Opened
   2026-08-20 from 0.9.0 usage feedback.
20. [Task 100 — Counter / CRC From the DBC Does Not Reach the Fields
   Editor](0100-calc-fields-dbc-config.md) — the attributes parse and
   the host resolves and layers them, but the editor's controls come up
   empty. **After task 92**, which moves three of the resolution sites
   involved and may change the answer. Opened 2026-08-20 from 0.9.0
   usage feedback.
21. [Task 105 — A BLF Whose Writer Never Finalized](0105-unfinalized-blf-recovery.md)
   — a capture from a crashed process has a stub 144-byte header and
   intact `LOG_CONTAINER`s, losing at most the ≤128 kB still buffered,
   and cannot be opened. Our header parser does *not* reject a zero
   object count, so the cause is unidentified: either a placeholder
   `statistics_size` refusing the file outright, or the truncated tail
   raising `UnexpectedEof` and discarding a nearly-whole file. A hard
   kill leaves cannet's own `<dest>.part` in the same state. Read-only
   recovery — we never write to the file. Groomed 2026-08-21.
22. [Task 104 — Real Load Progress, and Cancel That Can Be Found](0104-load-progress-and-cancel.md)
   — the census and the import share one indeterminate chip although
   both have a known denominator (file bytes, then `scan_blf`'s own
   `frame_count`), and cancel is half-built: the import half works but
   is spelled "click the busy launcher", while the census cannot be
   cancelled at all for want of a cooperative checkpoint — the same
   checkpoint byte progress needs. One task because it is one
   mechanism. Opened by owner instruction 2026-08-20.
23. [Task 102 — The Event Surface: Kinds, Filtering, and Its Own
   View](0102-event-surface.md) — `EventKind` was built to grow and has
   exactly one variant; this makes kinds a real axis with per-kind
   default visibility, promotes the event list to a top-level view with
   filtering, and lands the BLF `GLOBAL_MARKER` / `EVENT_COMMENT` work.
   Promoted from the backlog by owner instruction 2026-08-20;
   task 101 depends on it.
24. [Task 101 — Bus Health: Error Frames, Bus Load, Adapter
   Status](0101-bus-health.md) — **implemented 2026-08-22** (7 commits;
   error frames labelled in the trace and coalesced into `busError`
   host-derived events, `ControllerStates` on the session, host-side bus
   load, the panel mounted from the status bar). Remains listed pending
   close-out and hardware verification (owner-review-queue 3.14). — the low-level state of the bus is
   surfaced nowhere. `InterfaceState` with controller state and TEC/REC
   is already in the protocol and discarded by the client; BLF error
   frames already reach the trace unlabelled. Error frames become a
   coalesced `busError` event kind, hidden by default. **After task
   102.** Opened 2026-08-20 from 0.9.0 usage feedback.
25. [Task 106 — The Any-Bus Series, and the Sample Order It
    Breaks](0106-any-bus-series-and-sample-order.md) — the migration
    decision task 88 phase 2 deferred (a DBC-backed series naming no
    bus decodes samples its fingerprint cannot see), together with the
    `partition_by_t` binary search that rests on an order only such a
    series can violate. One task because settling the first may
    dissolve the second entirely. Opened by the overseer 2026-08-21 out
    of task 91's audit.
26. [Task 79 — Restore-Then-Import + Scratch Isolation](0079-restore-then-import.md)
   — the user-reachable empty-view defect Task 78 phase 1 attributed
   (restore a prior capture, then import: the view stays empty while
   the store refills), plus making `--app-data-dir` isolate the
   capture scratch as ADR 0031 claims. Opened by owner ruling
   2026-08-15; kept as scoped, both halves, by owner ruling
   2026-08-19.
27. [Task 80 — Plot Resample Churn Over a Stopped
   Capture](0080-stopped-capture-resample.md) — investigation-first:
   ~30 Hz resample + follow-slide held over a stopped, fully imported
   capture (trace still reads RUNNING after import). Opened by owner
   ruling 2026-08-15.
28. [Task 82 — Engine-Native Resource Monitoring](0082-engine-native-resource-monitoring.md)
   — the health sampler's process-family metrics move to the web
   engine's own bookkeeping (WebView2 `GetProcessInfos`) as the
   de-jure source; per-platform matrix (the macOS ppid walk silently
   excludes WKWebView's launchd-parented helpers), the
   `unsafe`/`webview2-com` adoption rulings, costs re-measured.
   Opened by owner ruling 2026-08-15.
29. [Task 83 — Follow-Ups from the 70–78 Cycle](0083-cycle-follow-ups.md)
   — the small findings the retiring 70–78 task files recorded in
   passing, collected as one groomable pass: the project-command test
   harness gap, the rebuild-chip rough edges, the unattributed
   launch-hang lead, frameless-import time ranges, and the
   untrusted-row token editor. Opened by owner ruling 2026-08-16.
30. [Task 84 — Make the MDF's Embedded DBC Durable](0084-mdf-embedded-dbc.md)
   — an imported MDF's embedded DBC decodes for the session but
   survives no reopen; make it durable (extraction or a durable
   project reference), then revisit name-matching file-backed
   signals on top. Needs grilling before implementation. Opened by
   owner ruling 2026-08-16.
31. [Task 77 — Catch-Up Decode Off the Serve Path](0077-background-catchup-decode.md)
   — shape 3 of Task 72 phase 3's attributed enum-lag fix (owner
   ruling 2026-08-15): decode cursors advance independently of view
   fetches, serves read what the cursors reached. Amends ADR 0049;
   gated on Task 72 phase 5's batched scan landing first.
32. [Task 69 — Extension Architecture](0069-extension-architecture.md)
   — implement ADR 0051: out-of-process, GUI-host-supervised
   extensions on a new `ExtensionHost` service in `cannet.proto`
   (filtered frame subscription, manifest-gated transmit, sandboxed
   contributed webviews, `.cannet-extension` packaging) plus an
   in-repo Python reference extension. Design groomed 2026-08-13;
   adopted onto the roadmap same day.
33. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
   — the two data-named cuts from the 2026-08-08 ingest profiling: the
   disk-spill segment write (43 % of the release per-frame budget)
   and `bus_id: Option<String>` interning (~15 %). Opened by owner
   ruling 2026-08-09.
34. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
   — crash on exit (wry/WebKit layer-tree teardown race) and missing
   Spotlight bundle metadata. Independently-shippable macOS fixes.
35. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (post-clear negative
   timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
   plot-color bug and the `decimatePoints` dead-code removal.
36. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
37. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
38. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
39. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
40. [Task 40 — bridge_client / cannet-client Session-Machinery
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
