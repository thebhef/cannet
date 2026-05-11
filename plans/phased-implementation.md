# Phased Implementation Plan

Phases are ordered. Each phase should land as a working, demoable slice before
the next one starts. Concrete library / framework choices live in
`technology-inventory.md`; this document describes scope and exit criteria.

## Phase 1 — Alpha0 GUI

Status: **shipped**. The realised mapping of scope items onto crates /
modules, plus the design refinements that landed during implementation,
are captured below. Full per-OS prerequisites and the `pnpm tauri` run
flow live in [`../README.md`](../README.md).

First end-to-end vertical slice: open the app, point it at a BLF log,
and watch decoded traffic scroll in a trace window.

Scope (all delivered):

- **CAN abstraction.** In-process representation of CAN and CAN FD frames
  plus the producer/consumer interfaces that everything downstream
  (trace, decode, plotting) will read from. Designed so a network
  transport can slot in later without reshaping callers. Realised as
  `crates/cannet-core` (rustdoc on `cannet_core` describes the
  source/sink contract). Names are CAN-explicit (`CanFrame`,
  `CanFrameSource`, `CanFrameSink`) so non-CAN buses can sit beside
  them later without renames.
- **BLF log reader.** Parses Vector `.blf` files and streams frames
  through the CAN abstraction. No replay-rate control yet beyond
  "stream as fast as the consumer drains." Realised as
  `crates/cannet-blf` (`BlfCanFrameSource` adapts `blf-asc::BlfReader`
  to `cannet_core::CanFrameSource`).
- **Basic trace window.** Virtualized list of frames with #, timestamp,
  channel, direction, ID, type (classic / CAN-FD / RTR / err), length,
  data bytes, and decoded-message name; expand a row to see decoded
  signals on a grid. Toolbar exposes Open BLF, Attach DBC, Pause /
  Resume, Clear, and an auto-scroll toggle. Realised as
  `apps/gui/src/TraceView.tsx`. The OS title bar is hidden in favour of
  a custom `TitleBar.tsx` so the cannet branding lives in the window
  chrome. (Phase 2 reworked the data path behind this view — see that
  section's refinements.)
- **DBC decoding.** Load a DBC and decode every matching frame's
  signals; expand a frame in the trace view to see them. The DBC is
  process-global, not per-channel — per-channel scoping is deferred
  until the multi-source story (Phase 2/3) makes the choice meaningful.
  Attaching a DBC after a BLF is already open re-decodes the affected
  trace rows, so the visible state always reflects the current
  database. Float / double signals declared via `SIG_VALTYPE_` decode
  as IEEE 754, not as scaled integers (added once the demo fixture
  exposed the gap). Realised as `crates/cannet-dbc` (uses `can-dbc` for
  parsing; runtime decoder lives in the crate root).

Architecture refinements that landed during implementation:

- **Trace store as the model; the view is a view over it.** The trace
  data is the model layer and the trace window renders a slice of it;
  explicit, persistable trace capture is a future feature
  (`features.md`), not Phase 1 scope. Phase 1 kept the store
  frontend-resident (`useRef<CanFrameRecord[]>` + a version counter to
  wake the virtualizer); Phase 2 moved it host-side into
  `apps/gui/src-tauri/src/trace_store.rs` so the BLF and remote pumps
  share one model — see Phase 2's refinements.
- **DBC in shared backend state.** `AppState::database` is a
  `Mutex<Option<Database>>`. `attach_dbc` / `detach_dbc` swap it; the
  IPC slice path reads it when serving rows (Phase 1: the `decode_frames`
  retro-decode command; Phase 2: `fetch_trace_range` and the
  `trace-grew` tail, decode-on-fetch). Separating "which DBC are we
  using right now" from "which source are we streaming right now" is
  what lets the user attach/swap a DBC without reopening the log.

Demo fixture:

- `examples/cannet-demo.blf` + `cannet-demo.dbc` cover standard and
  extended IDs, classic CAN and CAN FD payloads up to 32 bytes,
  unsigned/signed/float signal types, factor & offset, multiplexed
  signal blocks, value tables, and five different cadences. Generated
  deterministically by `examples/generate_blf.py`.
  `cargo run --example verify_decode -p cannet-dbc` round-trips the
  fixture through `cannet-blf` + `cannet-dbc` as a sanity script.

Exit criteria:

- Launch the GUI, open a BLF + DBC pair from disk, see decoded traffic
  live in a trace window. ✅
- CAN abstraction has a documented interface; BLF reader and trace view
  both go through it. ✅ (rustdoc on `cannet_core`; both producers and
  consumers cross only `CanFrame` / `CanFrameSource` / `CanFrameSink`.)
- Documentation reflects what shipped: README covers per-OS
  prerequisites, the `pnpm tauri dev / build` flow, and the build-
  artifacts list; `plans/` records the realised scope; rustdoc covers
  the public surface. ✅

## Phase 2 — Client / Server Implementation

Split the data source from the GUI so the analyzer can run against a remote
bus, and establish the wire protocol that all later driver work will plug
into.

Scope:

- Define the wire protocol as a tonic / gRPC service in a new
  `crates/cannet-wire` crate. The service exposes `ListInterfaces` (unary
  discovery — what CAN interfaces does this server provide?) and `Session`
  (a single bidirectional stream of `Envelope` messages with `Subscribe`,
  `Unsubscribe`, `FrameBatch`, and `Error` variants). Frame movement is
  symmetric: either side sends frames on a subscribed interface using the
  same wire shape. The protocol does not model cyclic / scheduled emission
  — sending on a cadence is a feature of the client transmit UI in
  Phase 3, not the wire.
- The wire protocol is the universal driver contract. A server can run
  in-process (Phase 2's BLF replay), as a sidecar (Phase 5 wrappers around
  `python-can`), or on the network. The same `.proto` covers all three;
  only the transport varies.
- `cannet-wire` provides batching adapters between `Stream<CanFrame>` and
  `Stream<FrameBatch>` so the application code on either side speaks the
  Phase 1 `cannet-core` types and never deals with batching directly.
  `FrameBatch` is the only frame-carrying envelope variant — single
  frames are batches of size one, emitted by the latency-flush rule.
- New `crates/cannet-server` runs the gRPC service. Phase 2's only
  supported input is BLF: the server loads a file at startup and streams
  it on a loop while clients are subscribed to its interfaces. Looping is
  a server-CLI concern, not a wire concern. BLF is read-only, so the
  server rejects client transmits with `Error::TX_REJECTED`.
- Phase 2 is **single-client per server**: a second connection is
  rejected with `Error::BUSY`. Multi-client fanout is in
  `plans/backlog.md`.
- New `crates/cannet-client` implements `cannet_core::CanFrameSource` over
  a tonic client, so the GUI's existing trace + decode pipeline consumes a
  remote server with no changes to its consumer code. The GUI grows a
  connection panel (host:port + interface picker driven by
  `ListInterfaces`) alongside the in-process BLF path.
- Server is addressable by host:port. Discovery is **not** in scope.
- TLS via tonic's `tls` feature (rustls) is configurable but **off by
  default**; plaintext on loopback is the dev / demo flow. Cert UX
  (fingerprint pinning, project-file persistence) is deferred until the
  project-file feature lands.

Refinements that landed during implementation:

- **Host-side trace store.** `apps/gui/src-tauri/src/trace_store.rs`
  (`TraceStore` / `RawTraceFrame`) is the model layer, replacing
  Phase 1's frontend-resident store. The BLF and remote pumps both
  append; the frontend pulls `[start, end)` slices via the
  `fetch_trace_range` Tauri command, decoded against the current DBC
  at fetch time. This retires Phase 1's per-frame `can-frame-batch`
  push and the `decode_frames` retro-decode command — no stored
  decoded state, no retro-decode walk. `clear()` releases the backing
  allocations so a small session after a big replay doesn't carry the
  old footprint.
- **`trace-grew` IPC tick.** In place of the per-frame push, the host
  emits `trace-grew` at ~10 Hz with the current frame count, the
  estimated rate (status line), and a short decoded *tail* of the
  newest frames so the auto-scrolling trace view can paint the live
  edge without a fetch round-trip. The frontend chunk-caches fetched
  slices (LRU) and prefetches a chunk on either side of the viewport.
- **Scaled-scrollbar trace view.** `apps/gui/src/TraceView.tsx` is a
  hand-rolled virtualizer whose scroll container is the trace scaled
  into a browser-safe height (capped at 16M px), so the scrollbar
  represents the whole trace at any size; visible rows live in a
  `position: sticky` element the compositor keeps pinned, so they
  never lag the scrollbar. The pure geometry (scrollTop ↔ row index,
  row stacking) lives in `apps/gui/src/traceViewport.ts` with unit
  tests (`traceViewport.test.ts`, run by `pnpm --dir apps/gui test`).
- **Server replay pacing.** `cannet-server --rate <multiplier>`:
  `1.0` replays at the BLF's recorded cadence (real-time emulation),
  `N` plays it N× faster, `0` (default) disables pacing entirely.
  Looping and pacing are server-CLI concerns, not wire concerns.

Exit criteria:

- GUI on machine A connects to a server on machine B, lists the
  interfaces it exposes, subscribes to one, and sees decoded traffic in
  the trace view with no functional regressions vs. Phase 1.
- The wire protocol carries client-side transmit envelopes; the BLF
  server rejects them with `Error::TX_REJECTED`. Actually delivering tx
  to a writable bus is Phase 3 / Phase 5 work.
- The same GUI build works against either an in-process server or a
  remote server, picked at connect time.
- README documents the new `cannet-server` crate, its CLI, and the
  connect flow; `plans/phased-implementation.md` matches what shipped;
  rustdoc on `cannet-wire` describes the service surface and the
  batching adapters.

## Phase 3 — Transmit, Panel Layouts, and Projects

Round out the GUI surface area before vendor drivers complicate the data
path. Doing this on top of the Phase 2 client/server split means panel
state and bus configuration flow through the same wire protocol from the
start, rather than being retrofitted later.

This is a large phase; land it in small, independently demoable steps,
each leaving the app runnable. The realised order: the multi-panel
docking shell first (trace view ported into it), then resizable /
hideable trace columns, then the transmit path + transmit panel, then
the project panel and project file.

Scope:

- **Transmit panel.** A panel that composes CAN / CAN FD frames (id, type,
  channel, payload, optional cycle time) and sends them. When a DBC is
  attached, the panel offers signal-by-signal entry for any matching
  message id (factor / offset / endianness applied during encode); raw
  byte entry is always available as the fallback for ids the DBC doesn't
  cover. Where a sent frame goes:
  - It always appears in the trace as a `Tx`-direction row (a tx-confirm)
    — what a real analyzer shows for your own transmits — so the
    compose / encode path is observable with no writable source at all.
  - If a remote session is open, it's also sent over the wire (the
    `cannet-core` / wire abstraction grows the transmit direction — the
    client emits frame envelopes, not just subscribes). The Phase-2 BLF
    replay server is read-only and answers `Error::TX_REJECTED`, which
    the UI surfaces. A new `cannet-server --loopback` mode exposes a
    writable interface that echoes received transmits back, so the wire
    transmit path can be demonstrated succeeding end to end.
  - An *actual* in-process writable bus (Linux `vcan` / socketcan, or an
    in-memory loopback-bus type) is **not** in scope — see "out of
    scope" and `plans/backlog.md`. Phase 3's tx-confirm + `--loopback`
    server cover demo and test without it.
- **Multi-panel main window with arbitrary layouts.** The GUI hosts
  multiple panels inside one OS window: more than one trace panel, more
  than one transmit panel, and a project panel (below). Panels can be
  split, tabbed, dragged, and resized into arbitrary layouts within the
  window — the layout shell is a docking-layout library (see
  `technology-inventory.md`), not hand-rolled. Each panel is independently
  configurable: trace panels carry their own filter set and column set;
  transmit panels carry their own frame definitions. Trace panels are
  independent views over the one host-side capture — each with its own
  scroll position, auto-scroll toggle, and expanded-row set — replacing
  Phase 1's single global frontend ref (see the implementation note
  below). The layout system is designed up front so the Phase 4 plot
  panel slots in as just another panel type.
- **Resizable and hideable trace columns.** Trace panels support
  drag-resizing column widths and toggling individual columns on/off
  (#, timestamp, channel, direction, ID, type, length, data, decoded
  name). Column widths and visibility are part of a trace panel's
  per-panel config, so they round-trip through the project file. (Folds
  in the two `[ui]` trace-column items from `plans/backlog.md`.)
- **Project panel + project file.** A project is a JSON file
  (`features.md`: "projects — includes window layouts, bus configs,
  references DBCs … DBC should be reloadable from disk at any time").
  Opening a project restores the panel layout (which panels exist, their
  dock positions, their per-panel config), the bus / connection
  configuration (in-process BLF path and/or remote server host:port plus
  subscribed interfaces), and the DBC reference(s) by path. The project
  panel is the UI for New / Open / Save / Save As, lists the configured
  buses, and shows the referenced DBC(s) with a "reload from disk" action
  — a project's DBC reference is a path, not an embedded copy, so reload
  re-reads the file. The most-recently-opened project is reopened on
  launch, so panel layout survives an app restart by virtue of living in
  the project file rather than in a separate layout blob.

Out of scope (deferred to later phases / backlog):

- **The plot panel itself** — Phase 4. Phase 3 only has to leave room for
  it in the layout system.
- **Virtual CAN bus layer** — mapping logical project channels onto source
  channels (`features.md`). Phase 3's project file records concrete bus
  configs; the logical-channel indirection is a later phase.
- **A real in-process writable CAN bus** — the Phase-3 transmit path
  delivers over the wire (including `cannet-server --loopback`) and shows
  a tx-confirm row in the trace; an actual local virtual-bus device
  (Linux `vcan` / socketcan) or an in-memory loopback-bus type in
  `cannet-core` is a later add. Tracked in `plans/backlog.md`.
- **Tear-out into separate OS windows** — docking is within the single
  main window only. Tracked in `plans/backlog.md`.
- **EDS references in the project file** — added when CANopen work begins.

Implementation notes (in progress):

- **Panel shell: `dockview`** (see `technology-inventory.md`). The
  trace view moved into `apps/gui/src/TracePanel.tsx`, a dockview panel
  component; `App.tsx` hosts the `DockviewReact` area and an "Add trace
  panel" action.
- **One host-side capture; panels are independent views over it.** The
  Phase-2 `TraceStore` stays a single host-side capture. Rather than a
  separate frontend store per panel, the capture-level view plumbing
  (frame count, the chunk cache + `getFrame`, the `ensureVisible`
  prefetch hook) lives in one `TraceData` React context shared by every
  trace panel; what's *per panel* is the scroll position, the
  auto-scroll toggle, and the expanded-row set — already per-instance
  inside `TraceView`. Same intent as "the frontend store becomes
  per-window" (panels are independent), simpler shape (no duplicated
  cache of identical data).
- **Auto-scroll is per panel now.** It moved out of the global toolbar
  into each trace panel's slim toolbar; Phase 1/2's single global
  auto-scroll checkbox is gone.
- **Layout persistence is a placeholder.** Until the project file lands
  (later in this phase), the dockview layout is saved to `localStorage`
  and restored on launch — i.e. the "default project". Project files
  will own the layout (plus bus configs and DBC refs) and supersede
  this.

Exit criteria:

- Two trace panels and a transmit panel can be open simultaneously inside
  one window, split / tabbed into a custom layout, each with its own
  filter / column / frame state, with no regressions vs. Phase 2
  throughput.
- Trace-panel columns can be drag-resized and individually shown / hidden,
  and that state persists with the panel.
- Sending a frame from a transmit panel shows it in the trace as a `Tx`
  row, and — when a remote session is open — delivers it over the wire:
  the read-only BLF server answers `Error::TX_REJECTED` (surfaced in the
  UI), and a `cannet-server --loopback` accepts the transmit and echoes
  it back into the trace. Works in both raw-byte mode and (with a DBC
  attached) signal-by-signal encoded mode.
- Opening a saved project restores the panel layout, the per-panel config,
  the bus / connection config, and the DBC reference(s); "reload DBC"
  picks up edits made to the file on disk; launching the app with no
  arguments reopens the last project.
- README documents the transmit workflow, the panel / layout UI (how to
  split, tab, and reset a layout), and the project-file workflow (create /
  open / save, where it lives, what it contains); rustdoc covers any new
  public surface on the CAN abstraction (notably the transmit path) and
  on the project-file types.

## Phase 4 — Signal Plotting

A plotting view in the spirit of vSignalyzer / TSMaster: pick decoded
signals and watch them over time — live and historical — in one or more
plot panels docked alongside the trace and transmit panels from Phase 3.

Scope:

- **Plot panel.** A new panel type in the Phase 3 layout system. A plot
  panel hosts one or more signal traces on a shared time axis; the user
  adds a trace by picking a (message, signal) pair from the attached DBC.
  Multiple plot panels can be open, each with its own signal set and axis
  configuration.
- **Signal sampling over the trace store.** The data-path work: a sampler
  that walks the trace store for frames matching a signal's message id,
  decodes the signal, and yields a `(timestamp, value)` series for a
  requested time range — the plotting analogue of the trace view's
  decode-on-fetch slice. Live plots extend as the trace grows (driven by
  the same `trace-grew` tick); a paused or finished capture is queried
  over a fixed range.
- **Plot interaction.** Pan / zoom on the time axis, per-trace or shared
  y-axis with auto and manual scaling, a movable cursor that reads out
  each trace's value at that instant, and a "follow live edge" toggle
  mirroring the trace view's auto-scroll. Enum-valued signals (DBC value
  tables) render as a stepped state plot.
- **Plot panels in the project file.** A plot panel's signal set and axis
  config round-trip through the Phase 3 project file like any other
  panel's config.
- **Plotting library.** Selected here (see `technology-inventory.md`): it
  has to handle high-rate streaming time-series (tens of thousands of
  points, growing live) without choking the WebView, support multiple
  independent plots, and carry a permissive license. A candidate
  shortlist is recorded in the inventory now; the pick and the rejected
  alternatives get written up when this phase starts.

Out of scope (deferred to later phases / backlog):

- **XY / scatter plots, gauges, and bitfield / flag panels** —
  `features.md` lists "bitfield views, with flag indicators per signal"
  and arbitrary plotting; Phase 4's MVP is time-series line / step plots.
  The bitfield view and non-time-series plot types are a later GUI pass.
- **Math channels** — derived signals computed from other signals.

Exit criteria:

- A plot panel can be added to the layout, populated with several signals
  from the attached DBC, and shows them updating live while a BLF replays
  (or a remote server streams) — with pan / zoom, a readout cursor, and a
  follow-live toggle — alongside an open trace panel, with no regressions
  vs. Phase 3.
- A historical range can be inspected on a paused or finished capture.
- Plot panels save and restore through the project file.
- README documents how to add a plot panel and pick signals; rustdoc
  covers the signal-sampler surface; `plans/technology-inventory.md`
  records the chosen plotting library and the rejected alternatives.

## Phase 5 — Vector, Kvaser, and PEAK CAN Driver Support

Replace the BLF-only server with real hardware sources.

Scope:

- Add server-side adapters for Vector, Kvaser, and PEAK hardware that feed the
  CAN abstraction.
- Per-vendor support may ship as **separate client/server processes** so we can
  reuse existing vendor or community drivers (e.g. `python-can`) without
  forcing the GUI process into a lower-performance language. The GUI talks to
  all of them via the same wire protocol from Phase 2.
- BLF replay server from Phase 2 continues to work alongside hardware servers.

Exit criteria:

- For each of Vector, Kvaser, and PEAK: a documented way to start a server
  bound to real hardware and have the GUI receive live traffic from it.
- Vendor-specific code is isolated to its own server / adapter; nothing
  vendor-specific leaks into the GUI.
- README lists each vendor's prerequisites (drivers, SDK, OS support
  matrix) and the command to launch its server.

## Phase 6 — Performance Profiling Baseline

Make performance measurable before we keep piling features on.

Scope:

- Define a profiling strategy that covers all three tiers — client (GUI),
  server, and the wire between them. Identify the metrics we care about
  (frame throughput, end-to-end latency from server ingest to GUI render,
  per-frame CPU cost on each side, memory growth under sustained replay,
  dropped-frame counts).
- Pick instrumentation: in-process counters/timers, sampling profiler hooks,
  and a reproducible workload (likely a standard BLF replay at a known rate).
- Capture an initial baseline against the Phase 5 build for each supported
  source (BLF replay + at least one hardware vendor) and check it in so future
  changes can be compared against it.

Exit criteria:

- Documented, repeatable profiling procedure.
- Baseline numbers committed for the current build, with enough detail that a
  later contributor can reproduce them and notice regressions.
- README points at the profiling doc and the baseline file.
