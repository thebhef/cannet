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

1. [Task 48 — Miscellaneous Fixes](0048-misc-fixes.md)
   — independent defects found by using the app: the plot's cached
   window discarded 250 ms after mount, cold-cache sample cost,
   integer signals in scientific notation, unit glued to value,
   dock panels that do not scroll, a repaint stall after sitting
   live, the transmit sequence editor vanishing mid-edit, and
   per-unit y-axis scaling. Each is independently shippable; they
   are grouped so they get scheduled rather than rotting in the
   backlog.
2. [Task 41 — Production Cannet Server](0041-production-cannet-server.md)
   — `cannet-server` becomes the production server (ADR 0040):
   operator-launched CLI that supervises the frozen python-can sidecar
   and proxies its interfaces, under their real identities, at one
   network endpoint. Sidecar supervision factored out of the GUI host
   and shared; per-OS distribution archive.
3. [Task 42 — Server Connection Security](0042-server-connection-security.md)
   — TLS (rustls via tonic) with an auto-generated self-signed server
   cert, TOFU fingerprint pinning in the GUI, and bearer-token client
   auth (ADR 0041). Non-loopback binds require TLS + token unless
   `--insecure`.
4. [Task 43 — Server Discovery](0043-server-discovery.md)
   — the server advertises `_cannet._tcp` via mDNS/DNS-SD (name + TXT
   labels, `--no-mdns` opt-out); the GUI shows a fuzzy-searchable
   browse list beside manual host:port entry. mDNS-crate
   evaluate-dependency pass is the blocking prerequisite.
5. [Task 31 — macOS Integration Issues](0031-macos-integration-issues.md)
   — crash on exit (wry/WebKit layer-tree teardown race) and missing
   Spotlight bundle metadata. Independently-shippable macOS fixes.
6. [Task 19 — Argument-Taking Palette Commands](0019-command-palette-goto.md)
   — the remaining argument-taking commands (go-to-row / -time,
   set-visible-range) and the shared input-prompt UI, on top of the
   command / palette framework. Save-with-picker (`capture.save`), the
   close commands, and a list-select go-to-event palette shipped with
   Task 37; what's left is the typed-argument prompt infrastructure.
7. [Task 25 — CAN HW + Virtual-Bus Bug Fixes](0025-can-hw-vbus-bugfixes.md)
   — the hardware/virtual-bus verify-and-fix pass (post-clear negative
   timestamps; the TX-timing/rate leg closed 2026-07-25) plus the
   plot-colour bug and the `decimatePoints` dead-code removal.
8. [Task 22 — CANopen](0022-canopen.md)
   — EDS ingestion and SDO / PDO decoding.
9. [Task 49 — Multi-Select Signals in the Plot Panel](0049-plot-signal-multi-select.md)
   — hide, remove, recolour and add several of a plot area's signals at
   once. Split out of task 48's item 14 once it proved to need a
   selection model threaded through the signal rows, the derived axes
   and the pattern-materialization path. Ahead of task 23 so its
   per-series features can act on a selection that already exists.
10. [Task 23 — Plot Measurements and Triggers](0023-plot-measurements-and-triggers.md)
    — triggers, math channels, manual per-series y, export, drag a
    plot area between panels.
11. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
    — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
    and RBS (`.cannet_rbs`) files so external edits are picked up
    automatically.
12. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
13. [Task 38 — MDF (MF4) Logger-File Import](0038-mdf-import.md)
    — import ASAM MDF 4.x bus-logging files (CANedge, Vector loggers)
    through the existing `CanFrameSource` seam; library
    evaluate-dependency pass is the blocking prerequisite. Signal-shape
    MF4 and MF4 export are explicitly later.
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
