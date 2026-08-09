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

1. [Task 58 — Ingest & Rebuild at Scale](0058-ingest-and-rebuild-at-scale.md)
   — from a real large-workload session 2026-08-08 (6.5 M-frame BLF,
   ~96 plotted signals): one-pass import through the one shared
   pipeline (notes pass dies, `open_log` async, header-only exact
   channel scan), import-dialog metadata/markers/time-range, persist
   signal pyramids across restore, one decode pass per message,
   rebuild off the global signal-cache mutex (also the exit-hang
   root), and incremental paint — a bounded serve, so `building…`
   shows only until the first points arrive.
2. [Task 59 — Minor UX Round](0059-minor-ux-round.md)
   — theme menu light/lighthk/dark with `normal_mode` deleted,
   no-project launches restore window geometry only, Ctrl+F focuses
   the focused panel's find/filter box, three solo-filter bugs,
   gridview keyboard rounds-out (Escape back to nav, Shift+arrow
   range select), an autosave-on-exit project setting (explicit-dir
   projects only), and clean builds no longer stamping `-dirty`.
3. [Task 60 — Undo/Redo for View Changes](0060-view-undo-redo.md)
   — extend the existing layout undo (panel add/close/move) to a
   filtered-snapshot history over the element registry: signals,
   areas, solo, visibility, filters/predicates/sources, colors,
   columns, renames — one gesture, one step; behavior fields (RBS,
   transmit, connection) never replayed, per a new boundary ADR
   ("undo never applies to values on the bus"). Requires the panel
   rehydrate-from-element path.
4. [Task 41 — Production Cannet Server](0041-production-cannet-server.md)
   — `cannet-server` becomes the production server (ADR 0040):
   operator-launched CLI that supervises the frozen python-can sidecar
   and proxies its interfaces, under their real identities, at one
   network endpoint. Sidecar supervision factored out of the GUI host
   and shared; per-OS distribution archive.
5. [Task 42 — Server Connection Security](0042-server-connection-security.md)
   — TLS (rustls via tonic) with an auto-generated self-signed server
   cert, TOFU fingerprint pinning in the GUI, and bearer-token client
   auth (ADR 0041). Non-loopback binds require TLS + token unless
   `--insecure`.
6. [Task 43 — Server Discovery](0043-server-discovery.md)
   — the server advertises `_cannet._tcp` via mDNS/DNS-SD (name + TXT
   labels, `--no-mdns` opt-out); the GUI shows a fuzzy-searchable
   browse list beside manual host:port entry. mDNS-crate
   evaluate-dependency pass is the blocking prerequisite.
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
    (Drag-a-plot-area-between-panels moved to task 55, 2026-08-07.)
12. [Task 27 — Live Disk-Watch for Project & RBS Files](0027-project-rbs-disk-watch.md)
    — generalize the DBC auto-reload watcher to project (`.cannet_prj`)
    and RBS (`.cannet_rbs`) files so external edits are picked up
    automatically.
13. [Task 28 — RBS External Value-Source Binding](0028-rbs-external-value-source.md)
    — cannet connects out to a value-source server that streams sparse
    `(signal, value)` updates by name; RBS applies them as overrides and
    keeps its own cadence/CRC/counters. Lets an external, out-of-repo sim
    (e.g. an EV drive cycle) drive the RBS.
14. [Task 38 — MDF (MF4) Logger-File Import](0038-mdf-import.md)
    — import ASAM MDF 4.x bus-logging files (CANedge, Vector loggers)
    through the existing `CanFrameSource` seam; library
    evaluate-dependency pass is the blocking prerequisite. Signal-shape
    MF4 and MF4 export are explicitly later.
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

## Notes

- **Numbers vs. order.** Task numbers are stable identifiers, not the
  sequence. The list above is the sequence; reorder it here when
  priorities change without renumbering the task files.
- **ADRs describe what *is*.** Several ADRs still carry references to
  these task numbers from when this was a phased plan. Each task that
  owns an ADR carries an "ADR cleanup" line to scrub those references
  out as that task is worked — ADRs should hold decisions, and the
  tasks should reference the ADRs, not the other way round.
