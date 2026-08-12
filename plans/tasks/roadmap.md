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

1. [Task 41 — Production Cannet Server](0041-production-cannet-server.md)
   — `cannet-server` becomes the production server (ADR 0040):
   operator-launched CLI that supervises the frozen python-can sidecar
   and proxies its interfaces, under their real identities, at one
   network endpoint. Sidecar supervision factored out of the GUI host
   and shared; per-OS distribution archive.
2. [Task 42 — Server Connection Security](0042-server-connection-security.md)
   — TLS (rustls via tonic) with an auto-generated self-signed server
   cert, TOFU fingerprint pinning in the GUI, and bearer-token client
   auth (ADR 0041). Non-loopback binds require TLS + token unless
   `--insecure`.
3. [Task 43 — Server Discovery](0043-server-discovery.md)
   — the server advertises `_cannet._tcp` via mDNS/DNS-SD (name + a
   `ver` TXT key, `--no-mdns` opt-out); the GUI shows a fuzzy-searchable
   browse list beside manual host:port entry. mDNS-crate
   evaluate-dependency pass is the blocking prerequisite.
4. [Task 38 — MDF (MF4) Import and Export](0038-mdf-import.md)
    — import and export ASAM MDF 4.x bus-logging files so MDF
    round-trips; import lands through the existing `CanFrameSource`
    seam; one read+write library evaluate-dependency pass is the
    blocking prerequisite. Message-independent signals (present in
    user-provided example MDF data) are a model gap this task closes.
    Signal-shape MF4 import is explicitly later.
5. [Task 63 — Plot Usage-Feedback Round](0063-plot-usage-feedback.md)
   — from owner live use 2026-08-11: a baseline disclosure-toggle
   implementation (the too-small ▾/▸ recurs at every disclosure
   site), collapsed plot areas actually reclaiming their space,
   hidden signal rows compacting to a single line, solo paging
   scrolling its selection into view, and an investigation-first
   fix for enum overlays lagging the other series in proportion to
   trace length.
6. [Task 61 — Ingest Perf Round 2](0061-ingest-perf-round-2.md)
   — the two data-named cuts from the 2026-08-08 ingest profiling: the
   disk-spill segment write (43 % of the release per-frame budget)
   and `bus_id: Option<String>` interning (~15 %). Opened by owner
   ruling 2026-08-09.
7. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
   — crash on exit (wry/WebKit layer-tree teardown race) and missing
   Spotlight bundle metadata. Independently-shippable macOS fixes.
8. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — the remaining argument-taking commands (go-to-row / -time,
   set-visible-range) and the shared input-prompt UI, on top of the
   command / palette framework. Save-with-picker (`capture.save`), the
   close commands, and a list-select go-to-event palette shipped with
   Task 37; what's left is the typed-argument prompt infrastructure.
9. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (post-clear negative
   timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
   plot-color bug and the `decimatePoints` dead-code removal.
10. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
11. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
   — triggers, math channels, per-series offset / gain, export.
   (Drag-a-plot-area-between-panels shipped separately, 2026-08-08.)
12. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
    — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
    and RBS (`.cannet_rbs`) files so external edits are picked up
    automatically.
13. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
14. [Task 39 — Automotive Ethernet Signals](0039-ethernet-signals.md)
    — staged: pcapng import (CAN linktypes, no model change), step/hold
    plot semantics for on-change series, then the multi-protocol trace
    model and ARXML/FIBEX-described SOME/IP + signal-PDU decode.
    Research detail in [`0039-ethernet-signals/`](0039-ethernet-signals/).
15. [Task 40 — bridge_client / cannet-client Session-Machinery
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
