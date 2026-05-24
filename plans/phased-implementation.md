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
  parsing; runtime decoder lives in the crate root) — which also
  resolves the long-name extension (`BA_ "System…LongSymbol"`), so
  names truncated to the classic 32-char limit on the `BO_` / `SG_`
  lines come back full.

Architecture refinements that landed during implementation:

- **Trace store as the model; the view is a view over it.** The trace
  data is the model layer and the trace window renders a slice of it;
  explicit, persistable trace capture is a future feature
  (`features.md`), not Phase 1 scope. Phase 1 kept the store
  frontend-resident (`useRef<CanFrameRecord[]>` + a version counter to
  wake the virtualizer); Phase 2 moved it host-side into
  `apps/gui/src-tauri/src/trace_store.rs` so the BLF and remote pumps
  share one model — see Phase 2's refinements.
- **DBCs in shared backend state.** `AppState::databases` is a
  `Mutex<Vec<LoadedDbc>>` (each = path + parsed `Database`), in priority
  order. `add_dbc` / `remove_dbc` / `clear_dbcs` mutate it; the IPC
  slice path walks the list when serving rows and takes the first match
  (Phase 1: the `decode_frames` retro-decode command; Phase 2:
  `fetch_trace_range` and the `trace-grew` tail, decode-on-fetch).
  Separating "which DBCs are we using right now" from "which source are
  we streaming right now" is what lets the user load/swap DBCs without
  reopening the log. (One interface for now, so every loaded DBC applies
  to it; per-bus DBC association is in `plans/backlog.md`.)

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
  Phase 5, not the wire.
- The wire protocol is the universal driver contract. A server can run
  in-process (Phase 2's BLF replay), as a sidecar (Phase 6 wrappers around
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
  `fetch_trace_range` Tauri command, decoded against the loaded DBCs
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
  — over the wire to a writable server (Phase 5, incl. `--loopback`),
  then to real hardware (Phase 6) — is later work.
- The same GUI build works against either an in-process server or a
  remote server, picked at connect time.
- README documents the new `cannet-server` crate, its CLI, and the
  connect flow; `plans/phased-implementation.md` matches what shipped;
  rustdoc on `cannet-wire` describes the service surface and the
  batching adapters.

## Phase 3 — Panel Layouts and Projects

Round out the GUI's window-management story before vendor drivers
complicate the data path: multiple dockable panels and projects that
persist a workspace. Doing this on top of the Phase 2 client/server
split means panel state and bus configuration flow through the same
wire protocol from the start, rather than being retrofitted later.
(Transmit — the other half of "round out the GUI" — became its own
phase, Phase 5, once the writable-target question got sorted; see that
section.)

Land it in small, independently demoable steps, each leaving the app
runnable. The realised order: the multi-panel docking shell first
(trace view ported into it), then resizable / hideable trace columns,
then the trace-lifecycle controls and the per-message-ID panel, then
the project panel and project file.

Scope:

- **Multi-panel main window with arbitrary layouts.** The GUI hosts
  multiple panels inside one OS window: more than one trace panel, the
  per-message-ID panel (below), a project panel (below), and — once
  Phase 4 / Phase 5 land — plot and transmit panels. Panels can be
  split, tabbed, dragged, and resized into arbitrary layouts within the
  window — the layout shell is a docking-layout library (see
  `technology-inventory.md`), not hand-rolled. Each panel is
  independently configurable: trace panels carry their own filter set
  and column set. Trace panels are independent views over the one
  host-side capture — each with its own scroll position, auto-scroll
  toggle, and expanded-row set — replacing Phase 1's single global
  frontend ref (see the implementation note below). The layout system
  is designed up front so the Phase 4 plot panel and Phase 5 transmit
  panel slot in as just another panel type.
- **Resizable and hideable trace columns.** Trace panels support
  drag-resizing column widths and toggling individual columns on/off
  (#, timestamp, channel, direction, ID, type, length, data, decoded
  name). Column widths and visibility are part of a trace panel's
  per-panel config, so they round-trip through the project file. (Folds
  in the two `[ui]` trace-column items from `plans/backlog.md`.)
- **Trace lifecycle & common trace-view controls.** Make "a trace" a
  first-class thing rather than "whatever's currently in the buffer":
  - The **session buffer** is the host-side capture (`TraceStore`) —
    every frame received since the current connection began. It's tied
    to the connection: a new connection starts a fresh buffer; it
    outlives pause / stop of individual traces, and is lost on app exit.
  - **A trace** is a capture window over that buffer: a start point and
    either *running*, *paused*, or *stopped* (with an end point). A
    trace-style view renders the slice `[start, end | now]`.
    - **Stop** freezes the trace (sets the end). **Start** from stopped
      begins a fresh running window from now — so stop→start clears the
      view.
    - **Pause** freezes the trace (sets the end, marked paused).
      **Resume** removes the end and the trace continues — frames that
      arrived during the pause are included (they were in the session
      buffer).
    - **Clear** wipes the window to empty at the current count but
      keeps the trace's run state — Clear deliberately does *not* imply
      Stop or Pause. So a running trace stays running (it keeps growing
      from now); a stopped/paused trace stays stopped/paused (now empty).
  - Each trace is **its own**: there's no global "the trace". A trace
    backs one trace-style window (chronological, per-message-ID, or — in
    Phase 4 — a plot), roughly one-to-one for now. The controls are a
    **common toolbar component** reused by all of them, but the
    running / paused / stopped / cleared state is per-window, not shared.
  - A trace's *lifecycle* is project-managed: a trace exists as part of
    the project; closing its view doesn't destroy it (reopen from the
    project panel), and removing a trace means removing it from the
    project. *On this branch*, until the project panel lands, closing a
    trace-style panel simply closes it; the controls + per-window trace
    window land first, the project wiring with the project-file step.
- **Per-message-ID panel.** A trace-style window (so it carries the same
  controls) that shows one row per arbitration ID — the *latest* frame
  seen for that ID within the window — sorted by ID, updating live,
  expandable to its decoded signals like a trace row. Backed by its own
  trace, same as a chronological panel. (Folds in the `[ui]` "by ID
  mode" item from `plans/backlog.md`; the rest-of-bus *transmit*
  gridview from `features.md` is the TX counterpart and stays Phase 5+.)
- **Project panel + project file.** Phase 3 ships the project file
  ([ADR 0011](../docs/adr/0011-project-file-format.md) — single JSON
  document holding the panel layout, bus/connection config, project
  elements, and DBC references) and its project panel UI: New / Open /
  Save / Save As, the configured-buses list, and the referenced DBC(s)
  with a "reload from disk" action (DBCs are referenced by path, never
  embedded). The most-recently-opened project is reopened on launch,
  so panel layout survives an app restart.

Out of scope (deferred to later phases / backlog):

- **The plot panel itself** — Phase 4. Phase 3 only has to leave room for
  it in the layout system.
- **Virtual CAN bus layer** — mapping logical project channels onto source
  channels (`features.md`). Phase 3's project file records concrete bus
  configs; the logical-channel indirection is a later phase.
- **Transmit** — composing and sending frames is Phase 5. Phase 3 just
  has to leave room for a transmit panel in the layout and a place for
  its config in the project file.
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
- **Resizable / hideable columns landed.** Per-panel column state
  (which columns, in what order, how wide) lives in `traceColumns.ts`
  (a pure module, unit-tested): drag the divider at a header cell's
  right edge to resize; the panel's "columns" menu toggles visibility.
  The state is per-panel React state in `TracePanel` for now — like the
  auto-scroll toggle, it resets when the layout is restored; persisting
  it is part of the project-file step below.
- **Trace controls + per-window trace landed.** `apps/gui/src/trace.ts`
  is the per-view trace: a window `[start, end | now]` over the
  host-side session buffer (`TraceStore`), in a `running` / `paused` /
  `stopped` state — pure transitions (unit-tested) plus a `useTrace`
  hook that wraps the shared `TraceData` context into a windowed
  `getFrame` / `count` (and exposes `offset` for views that query the
  buffer by absolute index). `TraceControls.tsx` is the common Start /
  Stop / Pause / Resume / Clear toolbar (stateless — the panel owns the
  trace). The session buffer is still cleared on (re)connect
  (`clear_trace_store`); a panel whose window the buffer shrank under
  re-anchors to a fresh running trace.
- **Per-message-ID panel landed (`ByIdPanel.tsx`).** A trace-style
  window (its own `useTrace`, the same controls) showing one row per
  arbitration id with its latest frame, sorted by id, refreshed each
  tick while running and frozen when paused / stopped, expandable to
  decoded signals. Backed by a host-side latest-frame-per-id index in
  `TraceStore` (`O(1)` on append) read via `fetch_latest_by_id(since)`
  — not by walking the buffer. Not virtualized (a bus has tens to a few
  hundred ids); resize / hide columns there is a follow-up. Still to do
  this phase: wiring traces into the project panel — closing a panel
  currently discards its trace.
- **Project file + panel landed.** `apps/gui/src-tauri/src/project.rs`
  is the `Project` model (schema-versioned — at v2 since multi-DBC
  replaced the single `dbc_path` with a `dbc_paths` list): the
  `dockview` layout blob (opaque to the host — and it carries each trace
  panel's per-panel config in dockview's panel `params`: column layout,
  auto-scroll), the loaded DBC paths, the remote-server address — with
  `open_project` / `save_project` commands (the host owns the model; the
  layout is the one frontend-owned bit it just round-trips).
  `apps/gui/src/ProjectPanel.tsx` is the project panel (a dockview
  panel, in the seed layout): New / Open / Save / Save As, lists the
  bus(es) with Connect / Disconnect, lists the loaded DBCs with add /
  remove / reload-all-from-disk — state + actions via a `ProjectContext`
  that `App` provides (the toolbar shares the callbacks). Open restores
  the layout (and the per-panel config), sets the remote-address field,
  and replaces the loaded DBC set with the project's list (clear, then
  re-add each by path; paths that fail are dropped and reported); it
  doesn't auto-connect. "New" starts a fresh workspace: seed layout, no
  DBCs, disconnected, session buffer cleared. The last opened/saved
  project's path is kept in
  `localStorage` (`LAST_PROJECT_KEY`) and reopened on launch. The
  workspace tracks a `dirty` flag (any layout / DBC / remote-address
  change sets it; Save / Open / New clear it) — shown as a `●` in the
  project panel, and the window-close handler prompts to Save before
  quitting when it's set (Save & close / Discard & close / Cancel — a
  small in-app modal).
  - Not carried in the project: a trace's window position (it
    re-anchors to the session buffer — empty on a fresh launch —
    anyway), the BLF replay path (a recent-BLF-files list is in
    `plans/backlog.md` instead — BLF replay is a one-shot from a
    captured trace), and the per-interface subscription set (the only
    mode is "subscribe to all"). **Interface selection is deferred** to
    when the physical drivers land — and the first step there is likely
    *not* literal hardware-interface picking but: teach `cannet-server`
    to publish a BLF as several streams (by channel), teach the client
    to configure those streams, and add a **filter element**
    (`kind: "filter"`) that can sit upstream of a trace window.
    Multiple DBCs *are* carried now (a `dbc_paths` list); what's still
    deferred is associating a DBC with a particular logical bus — for
    now every loaded DBC applies to the one interface (see
    `plans/backlog.md`).
- **Project elements + the element registry landed.** The project
  carries a list of **elements** alongside the layout (`Project.elements`
  — a `Vec<serde_json::Value>` to the host; it round-trips it like
  `layout`, the frontend owns the shape). An element is a
  discriminated-union record with a stable `id` and a `kind` — *now*
  just `{ kind: "trace"; id; view: "chronological" | "by-id" }`;
  `"plot"` (signal set + axis config), `"transmit"` (frame
  definition), `"filter"` (a predicate placed upstream of a trace
  window), etc. become new variants without touching the registry /
  project-file plumbing. The frontend keeps an in-memory **element registry**
  (`apps/gui/src/projectElements.ts` — `RegistryEntry = { element,
  trace }`; App state, `ElementRegistryContext`): restored from
  `project.elements` on Open, seeded with one trace element on first
  launch / New, serialized back (the `element`s only) on Save. A newly
  created trace window (Add trace, a self-heal, a project reload) is
  **empty and stopped, anchored at the current session count** — it
  never starts out spanning whatever was already in the buffer; hit
  Start to begin capturing.
  - A trace-style panel (`trace` / `by-id`) carries `params.elementId`.
    `useTrace(data, elementId)` reads/writes that element's window in
    the registry rather than holding its own state — so closing the
    panel doesn't destroy the element; a panel pointing at a missing
    element self-heals (`ensureTrace`). `reanchorToSession` (was
    `clampToSession`) moved from `useTrace` to an App-level effect that
    re-anchors every trace entry when the session count drops.
  - A *view*'s display config that isn't the element's identity (a
    trace panel's column layout, auto-scroll) stays in the dockview
    panel `params`, not the element — keeps the element small and the
    per-panel-config persistence intact. (A *filter*, when filters
    land, would belong to the trace element — it defines what data the
    trace includes.)
  - The project panel lists the registry's elements: Open (no panel →
    create one with that `elementId`) / Focus (a panel exists → focus
    it) / Remove (drop the element + close its panel). "Add trace
    panel" / "Add by-ID panel" create a new element + a panel for it.
  - The project panel itself is a **show/hide singleton** — a fixed
    dockview id, and the toolbar's "Project panel" button toggles it
    (remove if present, add if not). We only ever have one project
    open.
  - 1:1 element↔panel for now; the structure allows many views on one
    element but nothing builds that yet.
- **Layout fallback when no project is open.** With no last project,
  the dockview layout is restored from `localStorage`
  (`LAYOUT_STORAGE_KEY`) — the implicit "default workspace".
- **Auto-scroll survives a window resize.** A geometry change can fire
  a `scroll` event that isn't a user scroll; the trace view only treats
  it as one (and drops the live-edge pin) if it actually moved more than
  a row off the bottom.

- **One trace-style panel with a mode toggle.** The chronological and
  per-message-ID views merged into one `TracePanel` with a *trace /
  by ID* toggle; **by ID is the default** mode for a new panel. The
  mode is per-panel state in the dockview `params.mode` (a trace
  *element* is just `{ kind: "trace", id }` now — nothing else). One
  **"Add trace"** toolbar button (no separate trace / by-id buttons).
  Chronological is `TraceView.tsx` (the scaled virtualizer), by-ID is
  `ByIdTable.tsx`; the shared header (drag-resize, right-click
  show/hide menu, click-to-sort with ▲/▼) and the cell renderer live
  in `traceTable.tsx`, the column model + `sortRows` / `nextSort` in
  `traceColumns.ts`. Column show/hide moved from a toolbar dropdown to
  a right-click context menu on the header. Per-id mode sorts on a
  column click (asc → desc → off — the host's channel/id order). The
  old `"by-id"` dockview component name aliases to `TracePanel` so
  layouts saved before the merge still restore.
  - **"msgs/s" column (by-id only).** `TraceStore` keeps a per-id
    EMA-of-inter-arrival rate estimate (`RateEstimate`, updated on
    append, cleared on `clear`); `latest_since` returns it alongside
    each id's latest frame, and `fetch_latest_by_id` surfaces it as
    `ByIdSnapshot { frame, rate }`. The "msg/s" column is `byIdOnly`
    in `COLUMN_DEFS`, so the chronological view drops it; the by-id
    view shows and can sort by it.

Exit criteria:

- Two trace panels, the per-message-ID panel, and the project panel can
  be open simultaneously inside one window, split / tabbed into a custom
  layout, each with its own per-panel state, with no regressions vs.
  Phase 2 throughput.
- Trace-panel columns can be drag-resized and individually shown / hidden,
  and that state persists with the panel.
- Each trace-style window (chronological and per-message-ID) carries
  its own trace with Start / Stop / Pause / Resume / Clear (a common
  toolbar component, independent per-window state): stop→start clears
  that window's view; pause→resume continues it (including frames
  received during the pause); the session buffer survives all of these
  and is replaced only on a new connection.
- The per-message-ID panel shows one row per arbitration ID with its
  latest payload, updating live, expandable to decoded signals.
- Opening a saved project restores the panel layout, the per-panel config,
  the bus / connection config, and the DBC reference(s); "reload DBC"
  picks up edits made to the file on disk; launching the app with no
  arguments reopens the last project.
- README documents the panel / layout UI (how to split, tab, and reset a
  layout), the trace controls and what each does, and the project-file
  workflow (create / open / save, where it lives, what it contains);
  rustdoc covers the new public surface on the trace / project-file types.

## Phase 4 — Signal Plotting

A plotting view in the spirit of vSignalyzer / CANape — and, more
loosely, a software oscilloscope: pick decoded signals and watch them
over time, live and historical, in one or more plot panels docked
alongside the trace panels in the Phase 3 layout. The "oscilloscope"
framing is deliberate: there's effectively no ceiling on features here
(time-base controls, multiple y-axes, cursors and delta measurement,
triggers, math channels, export, …), so the scope below is split into a
**Phase 4 MVP** that has to land and a **later passes** list the MVP
must not paint into a corner.

Land it in small, independently demoable steps. The realised order so
far: the host-side data path (signal sampler + `list_signals` /
`sample_signals` commands) first, then the plot panel itself (uPlot in a
dockview panel), then the interaction polish, then project-file
persistence (which is gated on the rest of Phase 3 — see below).

### Phase 4 MVP scope

- **Plot panel.** A new panel type in the Phase 3 dockview layout —
  `apps/gui/src/PlotPanel.tsx`, registered under `PLOT_PANEL_COMPONENT`
  in `dockLayout.ts`, with an "Add plot panel" toolbar action in
  `App.tsx`. A plot panel is a **stack of plot areas** (starts with one;
  "add plot area" appends more), all sharing one time axis; each area is
  a uPlot canvas plus a side signal panel (colour swatch / name /
  present value), and a signal can be moved between areas. Picking a
  `(message, signal)` pair from the toolbar drops it into the focused
  area. The plot-area list and the signal→area assignment round-trip
  through the project file via the panel's dockview `params` (same
  mechanism trace panels use for their columns). Multiple plot panels
  can be open, each independent. (This is the "Reference design" shape
  below, minus the cursor / measurement / sync / event layers, which
  are the later steps.)
- **Signal sampling over the trace store.** The data-path work: a
  sampler that, given a `(message id, signal)` pair and a time window,
  pulls the matching frames out of the trace store, decodes the signal,
  and yields a `(timestamp, value)` series — the plotting analogue of
  the trace view's decode-on-fetch slice. Live plots re-sample as the
  trace grows (driven by the same `trace-grew` tick); a paused or
  finished capture is queried over a fixed range. Realised as
  `apps/gui/src-tauri/src/signal_sampler.rs` plus a per-id frame
  index in `TraceStore` (`slice_matching_many` — one lock, one signal's
  frames each, `O(Σ matches)`); surfaced to the frontend as the
  `list_signals` (DBC → pickable signals) and `sample_signals` (batched
  `(t, v)` series for a `[from_index, window_end)` slice + that slice's
  time bounds) Tauri commands. Independently-sampled
  series are stitched onto one timeline (sorted-union x-axis,
  sample-and-hold per series) by `apps/gui/src/plotData.ts` before being
  handed to the renderer.
- **Window-bounded sampling + decimation, not an optimisation.** ✅ Done
  — the trace store can hold **hundreds of thousands to millions** of
  frames, so the plot must not pay `O(capture)` per re-sample, nor ship
  (or ask uPlot to draw) a point per frame. The live plot re-samples
  **incrementally**: each tick `sample_signals` is asked only for the
  frames appended since the previous tick (decoded against the DBC, no
  decimation), and the plot appends them to a bounded per-signal cache
  (`PlotPanel.tsx::AreaCache` — re-built from one min/max-decimated full
  `sample_signals` fetch only when raw increments overflow it). So a
  tick's host cost is `O(increment)`, not `O(window)`, and the trace
  store lock is held only to clone the increment — even at thousands of
  frames/s the pump isn't starved. The loop is self-paced (the next tick
  scheduled after the previous finishes — decoupled from React
  re-renders, which lurch at high rates) at a toolbar-configurable rate
  (default 15 Hz); the toolbar also shows the actual update rate. Pause/Stop freeze the window so the loop
  stops; a cursor / measurement query re-samples that signal over the
  (narrower) cursor span. (`signal_sampler::decimate_min_max` —
  per-bucket extrema so spikes survive — unit-tested.)
- **Plot interaction (MVP).** Pan / zoom on the time axis (uPlot's
  built-in drag-zoom), a readout cursor / legend showing each trace's
  value at the hovered instant (uPlot's built-in cursor + live legend),
  and a "follow live edge" toggle that re-fits the x-range to the
  capture's edge on every `trace-grew` tick — a user pan / zoom switches
  it off, the plot analogue of the trace view's auto-scroll. Realised
  (first cut) in `apps/gui/src/PlotPanel.tsx`; see "Reference design"
  below for where it's headed.
- **Plotting library.** uPlot — chosen and written up in
  `technology-inventory.md` (with the rejected alternatives and the
  confirmed criteria weighting). The data feeding it comes from the
  signal sampler; the library only renders.

### Reference design

`plans/plot-panel-reference.html` is a standalone prototype and is
**normative for Phase 4** — the plot panel should end up with all of its
features and behaviours, not a subset. (Its dark "scope" visual language
is approved; applying a similar look across the rest of the GUI is a
separate, larger restyle — noted in `plans/backlog.md`.)

A plot panel is a vertical stack of **plot areas**:

- **Starts with one plot area.** A freshly-added plot panel has exactly
  one plot area; **"add plot area"** appends another below it. All plot
  areas in the panel share one x (time) axis.
- **Each plot area = a uPlot canvas + a signal panel beside it.** The
  signal panel (to the side of the canvas, not a header strip) lists the
  area's signals with, per row: signal name, colour swatch, and the
  present value (last sample, or value-at-cursor when a cursor is up) in
  the signal's unit. It's also where you remove a signal from the area
  or move it to another.
- **Signals move between plot areas.** Drag a signal row (or use a
  menu) to reassign it from one plot area to another; an empty plot area
  can be removed. Default on picking a new signal: drop it into the
  currently-focused plot area. Each area has its own y-scale and unit
  label.
- **Synced x-zoom** — `⌘/ctrl`+wheel or drag-select on any plot area
  zooms the time axis on *all* areas together; `shift`+wheel y-zooms
  only the hovered area; reset-zoom restores full extent.
- **Cursors (off by default, toggled from the panel toolbar).** When
  enabled: global vertical X cursors (A / B) that run through every plot
  area; per-area horizontal Y cursors (H1 / H2); left-click places A/H1,
  right-click places B/H2. The cursor set is **configurable** — how many
  cursors, which axis each is, and which traces it reads out — and the
  config round-trips through the project file. With cursors off the plot
  is just the traces; nothing is drawn and clicks do nothing special.
- **A measurement strip (off by default, toggled from the panel
  toolbar).** When enabled it shows a **configurable** set of quantities
  — choose from A, B, Δt, 1/Δt, per-trace value-at-A, value-at-B, Δ,
  min / max / mean over the cursor span, visible-window extent, sample
  count, etc. — and which subset is shown is part of the panel config.
  (Most cursor-derived quantities only have a value once cursors are
  enabled and placed; the strip shows "—" until then.)
- **Per-panel toolbar.** A slim toolbar on the plot panel carries the
  cross-cutting toggles — "follow live", "cursors", "measurements", "add
  plot area", reset-zoom — plus the cursor / measurement configuration
  affordances. Both "cursors" and "measurements" start **off**; nothing
  cursor- or measurement-related renders until the user turns it on.
- **Event markers + notes** — vertical lines drawn from a shared event
  list (in cannet: trigger / fault / warn / info markers derived from
  the trace and, later, from triggers and other panels, plus
  user-placed notes), labelled sparingly to keep the stack readable.
- **A perf badge strip** — init time, per-area render time, x-sync
  redraw time, cursor redraw time, DPR — so regressions are visible
  during development.

Mechanically it's all uPlot's `plugins` hook (a custom `draw` overlay
for cursors and event lines, a `ready` hook for wheel / click handlers)
plus N uPlot instances with cross-instance `setScale("x", …)` — nothing
needs a different renderer. The shipped single-plot-area `PlotPanel.tsx`
is step one; reaching the reference is a substantial rework of that file
(the plot-area stack, the side signal panels, the overlay plugin, the
cross-area sync, the measurement strip).

### After the MVP, toward the reference design

In rough order, each step leaving the panel runnable:

- **Plot-area stack + side signal panels.** ✅ Done — `PlotPanel.tsx`
  owns a list of plot areas (starts with one) with "add plot area" /
  per-area remove; the areas flex to fill the panel (one area = full
  height; N split it; a tall stack scrolls), each a uPlot instance with
  its time axis at the bottom plus a side signal panel: per row a
  clickable colour swatch (toggles the line's visibility — hidden = not
  drawn, swatch dimmed, value still updates), the name, and the value.
  Picking a signal adds it to the focused area; **dragging a signal row**
  onto another plot area moves it there. The plot-area list, the
  signal→area assignment, and the per-signal `hidden` flag persist via
  the panel's dockview `params`.
- **It's a trace-style element.** ✅ Done — the plot panel is backed by
  a `useTrace` window, exactly like the trace panels: Start / Stop /
  Pause / Clear (the shared `TraceControls`) over the session buffer.
  It's a distinct project-element `kind` (`plot`, alongside `trace`), so
  the project view and panel-reopen treat it as a plot, not a trace; it
  persists in the project's element list and survives a panel close. It renders signal *values* over time instead
  of message rows. While "running" it follows the live capture; pause /
  stop freeze the window (the re-sample loop stops, which also keeps a
  fast / unlimited-rate stream from piling up `sample_signals` calls);
  Clear re-anchors the window to "now". The element's window indices are
  what `sample_signals` is given (see the window-bounded-sampling bullet
  above).
- **Synced x zoom + pan; per-area y zoom; fit data.** ✅ Done — plain
  **wheel** on any area zooms x on all areas (and leaves follow-live);
  **right-drag** box-zooms x; `shift`+wheel pans x (synced);
  `⌘/ctrl`+wheel zooms y on the hovered area only (buried under a
  modifier — y is usually set with the per-area range control); "fit
  data" refits x to the full signal extent and y to the data.
  (uPlot's built-in left-drag zoom is disabled so left-clicks are free
  for placing cursors / notes.) Implemented with a shared x-sync ref +
  a per-area `setScale` hook (cross-instance `setScale`, guarded so
  programmatic changes don't echo), and a per-area re-entrancy guard on
  the resample.
- **Follow live.** ✅ Done — a toggle that keeps every area pinned to
  the capture's growing edge while preserving the *current* visible
  x-width (so it just slides right); a manual x pan/zoom turns it off.
  The span shown is the whole capture (the longest-running trace) up to
  `capture_end`, not auto-fit to the picked signal — so adding a signal
  late shows it over the existing span. (There's no separate "window
  seconds" setting — the visible width *is* the window.)
- **Cursors & measurement strip.** ✅ Done — both **off by default**,
  turned on from the panel toolbar (the prototype ships them on; cannet
  doesn't). A cursor-mode selector: "X" (left-click places cursor A,
  right-click cursor B, drawn through every area), "Y" (places this
  area's H1 / H2), "+ note" (drops an event note); a "clear cursors"
  button removes them all. Cursors are a uPlot `draw`-hook overlay. The
  side signal panel shows the value at cursor A when placed, else the
  value at the mouse crosshair (throttled), else the latest sample; the
  H1/H2 Y-cursor values and ΔH show in the area's signal-panel head, and
  small Δt / ΔH chips draw on the plot between the cursor pair so the
  delta is visible without turning the measurement strip on. A
  "measurements" toggle reveals a strip whose quantity set is
  **configurable** from a checklist — A, B, Δt, 1/Δt, and per-trace
  value@A / value@B / Δ / min / max / mean over [A, B]. Cursor mode, the
  measurement toggle/selection, and (best-effort) the cursor positions
  persist via the panel's dockview `params`. The pure cursor/measurement
  maths (`indexAtOrBefore` / `valueAt` / `statsOver`) live in
  `apps/gui/src/plotCursors.ts` with unit tests.
- **Event markers + notes.** ✅ Done — a shared event list (the implicit
  capture-start "T0" plus user notes) drawn as vertical lines across the
  areas (labelled on the first area only); "+ note" cursor mode places a
  note at the clicked time; an event-log list under the panel renames
  (click the label) and removes notes. Notes persist in `params`.
  (Persisting notes *against a BLF* — annotate-and-save-back — is a
  separate backlog item.)
- **Per-area y range.** ✅ Done — each plot area has an "y: auto" /
  "y: min…max" control; manual mode pins the area's y-scale and persists
  in the area config. (Per-*trace* offset / gain and log scale are
  deferred — see below.)
- **Perf badge.** ✅ Done — the panel toolbar shows the worst recent
  plot-area resample time and the device-pixel ratio, so a regression in
  the plot path is visible during development.

### Out of scope (deferred to later phases / backlog)

- **Per-trace y offset / gain and log scale.** Per-*area* manual y-range
  shipped; per-trace transforms (so unrelated signals can share an area
  without one swamping the others) and log scaling are a later
  refinement (`plans/backlog.md`).
- **Enum / state signals.** Signals backed by DBC value tables rendered
  as a stepped state plot with symbolic axis labels rather than bare
  numbers. Needs value-table data threaded out of `cannet-dbc` first
  (Phase 5); until then enum signals plot as their raw codes.
- **Triggers.** Edge / level / value-match triggers on a chosen signal
  that freeze the view and emit a marker (into the plot's event list,
  and later the trace) — the oscilloscope trigger proper. The event-line
  rendering above is the half of this that's cheap; the trigger engine
  is a later add (`plans/backlog.md`).
- **Math channels.** Derived signals computed from other signals (sum,
  diff, scale, filter, …) — also useful to the transmit panel and a
  future scripting surface, so it may outgrow plotting; tracked
  separately (`plans/backlog.md`).
- **Export.** Copy / save the visible window (or the cursor span) as CSV
  or an image (`plans/backlog.md`).
- **Non-time-series views.** XY / scatter plots, gauges, and the
  bitfield / flag panel `features.md` calls for — likely separate panel
  types, a later GUI pass.

### Exit criteria

- A plot panel can be added to the layout, populated with several signals
  from the attached DBC, and shows them updating live while a BLF replays
  (or a remote server streams) — with pan / zoom, an opt-in readout
  cursor + measurement strip, and a follow-live toggle — alongside an
  open trace panel, with no regressions vs. Phase 3. ✅
- A historical range can be inspected on a paused or finished capture. ✅
  (zoom in / out of follow-live; the series is re-sampled and decimated
  over the visible window.)
- Plot panels save and restore through the project file. ✅ (the
  plot-area list, signal→area assignment, y-ranges, follow-live, cursor
  mode, measurement selection, and notes all round-trip via the dockview
  `params` the project file carries; the play state and the post-Clear
  anchor are session-only, like a trace panel's window.)
- README documents how to add a plot panel, pick signals, and use the
  cursors / measurements / notes; rustdoc covers the signal-sampler +
  decimation surface; `plans/technology-inventory.md` records the chosen
  plotting library and the rejected alternatives. ✅

## Phase 5 — Transmit + DBC Value Tables

Status: **shipped** in the realised-scope form documented below. The
deferrals from the original scope are folded into
[`backlog.md`](backlog.md) (proper signal-to-bytes encoding, plot
enum rendering for multi-signal / mixed areas).

Compose and send CAN / CAN FD frames from the GUI, and complete the DBC
value-table story so enum-valued signals render symbolically across the
trace and plot views. Sits before vendor drivers: needs the Phase 3
docking layout and project file (to host and persist a transmit panel)
and the Phase 4 plot panel (to grow the enum / state-signal rendering),
but nothing from the vendor adapters.

Scope:

- **Transmit panel.** A dockview panel (alongside trace and plot panels)
  that composes CAN / CAN FD frames — id, type, channel, payload,
  optional cycle time. When a loaded DBC matches the id, the panel offers
  signal-by-signal entry (factor / offset / endianness applied during
  encode); raw byte entry is always available as the fallback. A transmit
  panel's frame definitions are per-panel config and round-trip through
  the project file as a new project element `kind: "transmit"`.
- **Where a sent frame goes:**
  - It always appears in the trace as a `Tx`-direction row (a tx-confirm)
    — what a real analyzer shows for your own transmits — so the compose
    / encode path is observable with no writable source at all.
  - If a remote session is open, it's also sent over the wire. The
    `cannet-core` / wire abstraction grows the transmit direction — the
    client emits frame envelopes (`cannet-client::transmit`); the wire
    already carries `FrameBatch` symmetrically. The Phase-2 BLF replay
    server is read-only and answers `Error::TX_REJECTED`, surfaced inline
    on the transmit panel.
  - A new `cannet-server --loopback` mode exposes a writable interface
    that echoes received transmits back, so the wire transmit path can
    be demonstrated end-to-end without hardware. The in-process building
    block is a new loopback bus type in `cannet-core` (a paired
    `CanFrameSink` / `CanFrameSource`).
- **Cyclic transmit** is a client-side scheduler in the Tauri host —
  per-frame cycle time, the panel schedules the resend — not a wire
  feature; the wire stays one-frame-at-a-time.
- **DBC value tables.** `cannet-dbc` learns to surface `VAL_` records on
  `DecodedSignal` (a `label` field populated when a value table matches,
  alongside today's name / unit / scaling). The trace view's
  decoded-signal grid and the by-ID expansion render labelled values as
  `<code> "<label>"` instead of the bare number; the transmit panel's
  signal-by-signal mode offers a dropdown of labelled values for enum
  signals; the plot panel renders signals with a value table as a
  **stepped** line with symbolic y-axis tick labels (a separate
  `list_value_tables` command supplies the full table once per signal).
  Signals without a value table render unchanged.

Out of scope (deferred to later phases / backlog):

- **A real in-process writable CAN bus on Linux** — `vcan` / socketcan
  is not adopted in this phase; the tx-confirm row plus `--loopback` and
  the in-memory loopback bus cover demo and test. An actual local
  virtual-bus device is a later add. Tracked in `plans/backlog.md`.
- **Transmit to real hardware** — Phase 8 (the vendor sidecar makes the
  server's interfaces writable through `python-can`).

Exit criteria:

- Sending a frame from a transmit panel shows it in the trace as a `Tx`
  row; with a remote session open, the BLF replay server returns
  `Error::TX_REJECTED` (surfaced in the UI) and a `cannet-server
  --loopback` accepts the transmit and echoes it back into the trace.
  Works in both raw-byte and (with a DBC attached) signal-by-signal
  encoded modes.
- Cyclic send: a frame with a cycle time resends on that cadence until
  stopped; cancelling or removing the frame stops the loop.
- A transmit panel's frame definitions persist through the project file
  (project element + dockview `params`).
- `cannet-dbc::DecodedSignal` carries value-table labels when the DBC
  defines one; the trace view, by-ID expansion, transmit panel, and
  plot panel all render enum signals symbolically.
- An in-memory loopback bus type lives in `cannet-core` and is what
  `cannet-server --loopback` wraps; both have rustdoc and a smoke test.
- Backlog items removed: `cannet-dbc` value tables, trace-panel enum
  values, real in-process writable CAN source (the in-memory portion).
- README documents the transmit workflow (compose, DBC encode + value-
  table pick, cyclic send, the `--loopback` server) and the enum
  rendering behaviour; rustdoc covers the new public surface on
  `cannet-core` (transmit direction + loopback bus), `cannet-dbc` (value
  tables), `cannet-wire` / `cannet-client` (client TX).

Realised scope notes:

- The transmit panel's **signals** mode currently surfaces enum
  dropdowns and copies the picked raw value into the payload as a
  single byte (a coarse but informative way to populate the hex
  field). Proper per-signal bit-pack encoding (factor / offset /
  endianness / multi-byte / multiplexor) is the inverse of
  `cannet_dbc::Database::decode` and belongs there; surfaced through
  a future `encode_frame` host command. Tracked in
  [`backlog.md`](backlog.md).
- The plot panel switches into **stepped + symbolic** rendering when
  a plot area shows *exactly one* signal with a `VAL_` table — the
  realistic single-state-channel case. Multi-signal / mixed enum +
  numeric areas keep the existing numeric (auto-normalised) rendering;
  their layout (multiple symbolic axes, per-signal step overlays)
  wants the per-trace y offset / gain plumbing that
  [`backlog.md`](backlog.md) tracks, so it's folded into that
  follow-up.
- The loopback wire round-trip and the BLF replay server's
  `Error::TX_REJECTED` path are both covered by integration tests
  (`cannet-server/tests/loopback.rs`,
  `cannet-client/tests/end_to_end.rs::transmit_through_session_round_trips_via_loopback`).

## Phase 6 — Logical Buses, Filtering & Project Graph

Status: **in progress** — see "Realised scope notes" at the end of the
phase for what shipped versus what was narrowed and folded into
[`backlog.md`](backlog.md).

Introduce logical buses as the first-class abstraction frames belong to,
turn filtering into a project element placed upstream of trace-style
windows, and render the project's elements as a graph the user can wire
and edit. Includes a deliberate design iteration on the project panel:
what stays as lists, what moves into the graph view, and how the two
surfaces relate.

Scope:

- **Logical buses + interfaces (live).** A project owns a list of
  logical buses with stable ids and display names (plus optional speed /
  FD hints). An interface is a binding of a remote source (server name +
  interface name) onto a logical bus, recorded in the project.
  Connecting to a server populates the picker via `ListInterfaces`; the
  user binds an interface to a bus through the graph view or the project
  panel.
- **BLF as a client-side import feature.** Loading a BLF in the GUI runs
  a per-channel mapping step (channel → logical bus or "skip"); frames
  flow into the session buffer tagged with their assigned bus. This is
  independent of `cannet-server`'s BLF replay mode, which stays as it is
  — a wire-protocol test fixture, not the canonical way the GUI consumes
  a BLF.
- **Per-bus DBC scoping.** Each DBC entry gains a `buses: [bus_id…]`
  selection; a DBC decodes a frame only if the frame's bus is in scope.
  Unscoped is the convenient "all buses" default. The project panel
  surfaces the per-bus picker on each DBC.
- **Filter element.** A new project element `kind: "filter"` carrying a
  structured predicate (bus, id range / list, decoded-name regex,
  signal-value match, AND / OR composition). A filter has an input (a
  bus or another filter) and an output consumed by trace / by-ID / plot
  elements; views with a filter ref render only frames the predicate
  passes. The predicate is JSON; no expression DSL in this phase.
- **Project graph view.** A dockview panel that renders the project's
  elements as a graph — interface, logical bus, filter, trace / by-ID /
  plot nodes — with edges showing data flow. Adding a node creates the
  underlying element / binding; removing a node removes it; wiring an
  edge sets a consumer's source or a filter's input. The graph is one
  surface on the project, not the primary one: the project panel keeps
  its existing role (project file actions, inventory lists, DBC list +
  per-bus scoping); the graph is the spatial view.
- **Project panel design iteration.** Review the current panel and
  decide what stays as lists, what moves into the graph, and how the
  two surfaces relate. Output is a short design note in `plans/`
  alongside the implementation changes.

Out of scope:

- **An expression DSL for filter predicates** — structured JSON predicate
  stays the only shape this phase. A text DSL on top is a later option
  if the structured editor turns out to be clunky.
- **socketcan / vcan** — still deferred (see Phase 5).
- **Multiple vendor sidecars** — Phase 8 ships a single one; multi-
  sidecar is preserved as a wire-compatible future option.

Exit criteria:

- Project owns a `buses` list; connecting to a server lets the user bind
  interfaces to buses; a wired interface routes frames into the session
  buffer tagged with its bus.
- Loading a BLF runs a channel → bus mapping step; replayed frames carry
  their assigned bus through to consumers.
- Per-DBC bus scoping works: a DBC scoped to bus A produces no decoded
  signals for a bus B frame; unscoped behaves as today.
- A filter element can be created and wired between a bus (or another
  filter) and a trace / by-ID / plot consumer; the consumer renders only
  frames the predicate passes; clearing the wiring returns to
  unfiltered.
- The graph view renders the project's elements with their wiring and
  supports adding, removing, and re-wiring nodes; viewport and node
  positions persist in dockview `params`. The project panel remains the
  primary surface for project-file actions and inventory.
- The design note is checked into `plans/`; its description of what each
  surface covers matches what the code does.
- `PROJECT_SCHEMA_VERSION` is bumped; existing projects migrate cleanly
  (today's single-interface DBC scoping becomes unscoped = all buses).
- Backlog items removed: DBC-↔-logical-bus, logical-buses + physical
  mapping. The Phase-3 "Interface selection is deferred" sentence is
  updated to reflect what shipped.
- README documents bus mapping, BLF import, per-bus DBC scoping, the
  graph view, and the filter workflow; rustdoc covers the new public
  surface on the bus model, project schema, and filter predicate;
  `plans/technology-inventory.md` records `@xyflow/react` (and its
  rejected alternatives).

Realised scope notes:

- **Logical buses + interface bindings shipped** in the project schema
  (`Project.buses`, `Project.interface_bindings`). A bus carries
  `{id, name, speed_bps?, fd?}`; an interface binding maps a
  `(server, interface)` pair onto a `bus_id`. The project panel surfaces
  both as lists with add/edit/remove. Routing live remote-server frames
  through their bound bus is wired through the trace store (each frame
  carries an optional `bus_id`).
- **BLF import gained a channel→bus mapping step.** Opening a BLF
  pre-scans the file for distinct channels and shows a small in-app
  modal where each channel is bound to an existing bus (or skipped).
  Frames replay with the chosen `bus_id`. Channels mapped to "skip" are
  dropped on append, so the project panel and trace consumers don't see
  them.
- **Per-bus DBC scoping shipped.** Each loaded DBC carries a
  `buses: [bus_id…]` set; the host's decode walk filters by frame
  `bus_id` before trying each DBC. An empty set is the "all buses"
  default (and the migration target for v2 projects). The project panel
  renders a checkbox group per DBC.
- **Filter element shipped** as a project element `kind: "filter"`. The
  predicate is `{ all: [Predicate] } | { any: [Predicate] } |
  { bus: bus_id } | { id_range: [lo, hi] } | { id_list: [u32] } |
  { name_regex: String } | { signal_equals: { name, value } }`. Filters
  reference an upstream source (`bus_id` or another filter id) and are
  consumed by trace/by-ID/plot panels through their `source` parameter.
  An empty / unset predicate passes everything.
- **Project graph view shipped** as a dockview panel
  (`kind: "project-graph"`) using `@xyflow/react`. Nodes for interface
  bindings, logical buses, filters, and consumer panels (trace, plot,
  transmit) render with edges showing data flow. The user can add a bus
  / filter from the panel toolbar, drag-connect a source onto a
  consumer, and remove a node to delete the underlying element. Node
  positions and viewport persist in the panel's dockview `params`.
- **Project panel design note** lives at
  [`plans/project-panel-design.md`](project-panel-design.md): the
  project panel keeps file-IO + inventory roles (project actions, bus /
  binding / DBC lists, scoping checkboxes); the graph view owns the
  spatial wiring story (which filter feeds which trace, etc.). The two
  surfaces share the same underlying `Project` state through the
  element registry and context.
- **Schema migration**: `PROJECT_SCHEMA_VERSION = 3`. v2 projects open
  via an in-memory migration step that defaults `buses` and
  `interface_bindings` to empty and treats every existing DBC as
  unscoped — effectively "one implicit bus, every DBC unscoped". The
  on-disk version is rewritten to 3 the next time the project is
  saved. The README's project section calls this out.
- **Consumer-side filter evaluation**. The host fetch path
  (`fetch_trace_range`, `fetch_latest_by_id`, `sample_signals`) accepts
  an optional `filter` argument and, when present, applies the
  evaluated predicate over the slice. This keeps the trace store
  itself filter-agnostic (one shared session buffer) while letting each
  consumer scope what it renders.
- **Wire-level bus state stayed out of scope.** The plan's "Phase 6
  grows the surface with bus-config and bus-state RPCs" hint
  (tech-inventory tonic entry) is *not* taken in this phase — bus
  config is GUI-side only against the existing `Subscribe` surface.
  Tracked in [`backlog.md`](backlog.md) for whenever the hardware-side
  bus-config story actually needs it.
- **Backlog cleanup**: the Phase-3 "Interface selection is deferred"
  paragraph (above) is left in place as historical context for what
  Phase 3 shipped; its forward-looking sentence ("the first step there
  is likely…filter element") has materialised in this phase. The
  previously-mentioned DBC↔logical-bus / logical-buses-+-physical-mapping
  backlog entries were not standalone bullets in `backlog.md` at Phase 6
  start (they were referenced inline in this plan); the in-plan
  references are now satisfied.
- **Late additions to Phase 6's surface** (backfilled after the initial
  Phase-6 commits shipped, then restacked through Phases 7–9):
  - **Add-binding UI** in the project panel. The initial Phase-6 panel
    only allowed re-targeting an existing binding's bus via a dropdown
    — there was no flow to *create* a binding from the UI, so users
    had to hand-edit project JSON. Added an inline form: server input,
    *Discover* button that calls `list_remote_interfaces`, interface
    picker, and bus picker. The bus picker enforces "each bus has at
    most one interface" by hiding buses that already have a binding.
  - **Toolbar address input removed; Connect iterates bindings.** The
    initial Phase-6 toolbar still carried a `host:port` text field
    (legacy quick-connect) and Connect targeted a single server.
    Removed: server addresses now live per-binding. Connect groups
    `interface_bindings` by `server`, opens one gRPC session per
    server, and subscribes only to the bound interfaces. The host's
    `remote_session: Mutex<Option<…>>` became
    `remote_sessions: Mutex<HashMap<String, RemoteSession>>`;
    `disconnect_remote_server(address: Option<String>)` either
    disconnects one or drains all. `transmit_frame` currently picks
    the first session whose channel set matches the requested
    channel — see backlog for routing transmit by `bus_id`.
  - **Graph view reshape.** The initial Phase-6 panel rendered every
    element as a uniform "default" xyflow node. Reshaped with custom
    `nodeTypes`: buses render as a wide horizontal rail (the logical
    aggregator), gateways / transmits / traces / plots / filters each
    have a distinct shape and inline-SVG glyph. Edge derivation was
    pulled into a pure `projectGraph::deriveGraph` module with unit
    tests covering bus-only, gateway↔bus, bus→sink, bus→filter, the
    1-in/N-out filter case, transmit-as-source (no auto-edge yet),
    and dangling-source elements.

### Phase 6.5 — fan-out by default, edge edits, transmit by bus

A follow-up pass after Phase 6 shipped, addressing the consumer-side
wiring gaps the original Phase-6 plan deferred. The headline shift is
that the original explicit `source?: string` model was replaced by a
default-fan-out shape — every consumer wires to every bus unless the
user prunes it. Realised:

- **`sources: string[]` on every consumer** (trace / plot / filter)
  with the wildcard `"*"` meaning "every bus, current and future."
  Default for a freshly created consumer is `["*"]`, so a brand-new
  trace/plot already reads from every bus. The old `source?: string`
  is gone; legacy projects normalise it into `sources: ["*"]` on load.
- **`sinks: string[]` on transmit elements** (no wildcard — `sinks`
  is an explicit list to avoid silently picking up a newly-added
  bus). The transmit panel composes one frame per bus in `sinks` and
  the host resolves each `bus_id → (server, interface)` via the
  project's interface bindings. The per-frame `channel: u8` field is
  gone end-to-end (`TransmitRequest.bus_id` is the wire form).
- **By-id collision fix**: `TraceStore::FrameKey` now includes the
  frame's `bus_id`, so two servers sharing wire channel 0 no longer
  collapse their per-id snapshots.
- **Trace column "bus"** instead of "ch": looks up `bus_id` against
  the project's buses and renders the bus *name* (or "unassigned").
- **BLF save/load round-trips bus assignment** via the project's
  ordered bus list (channel `N` ↔ `project.buses[N]`). No sidecar —
  the BLF is the serialization (CLAUDE.md § File formats). The
  open-BLF modal pre-seeds bus matches from this ordering.
- **Filter UI**: a "+ filter" button on the project graph panel's
  toolbar creates a free-standing filter (fans in from every bus,
  no downstream until wired). Each filter node has an inline
  predicate editor (caret-expand) for the structured leaf variants
  (`bus | id_range | id_list | name_regex | signal_equals`).
  Composition variants (`all | any`) stay JSON-only.
- **Sources / sinks picker** lives in right-click context menus on
  the trace, plot, and transmit panels — checkboxes for every project
  bus + filter, with an "All" toggle that re-collapses to `["*"]`.
  Plot panel embeds it in the existing toolbar context menu shell.
- **Insert filter upstream** lives on each consumer node in the
  graph (a `+ filter` button on the trace/plot node). Creates a
  fresh filter, transfers the consumer's `sources` to it, then
  re-routes the consumer through the filter.
- **Edge deletion**: right-click an edge in the graph view to drop
  the matching bus / filter id from the consumer's `sources` (or
  from the transmit's `sinks`). The wildcard `"*"` expands into the
  explicit "every bus except this one" list on first deletion. The
  gateway↔bus edges are not user-deletable here — they're project-
  panel bindings.
- **Filter cycle prevention** at the registry layer: patching a
  filter's `sources` to a value that would close a filter→filter
  cycle is silently refused by `applyElementPatch`.
- **Schema is purely additive** — no migration step. Old projects
  load with `sources` defaulted to `["*"]`. The `PROJECT_SCHEMA_VERSION`
  stayed at 4.

Out of scope (tracked in `plans/backlog.md`):

- Per-panel **chronological** trace filtering and per-panel **plot
  sampling** filtering — Step 6 only wired the predicate into the
  per-panel by-id fetch. The chronological view's global chunk cache
  and `sample_signals` don't take a filter argument yet.
- **Drag-to-wire** in the graph (literal drag from a producer
  handle onto a consumer); the right-click picker handles wiring
  for now.
- **Bus-like graph topology** (gateway at one end, bus running
  long, consumers branching off) — current layout is lane-based.

## Phase 7 — System Messages

Plumb a structured log bus and a panel that surfaces it, before later
phases add sources (vendor sidecars, capture writer, perf events) that
all want a uniform place to talk to the user. Small, focused, and
exactly the kind of plumbing every phase from 8 onward leans on.

Scope:

- **Host-side log bus.** A bounded ring of structured messages
  (`{ ts, source, level, message, optional_payload }`) in the Tauri
  host. Sources are tagged (`project`, `dbc`, `connection`,
  `blf-import`, `plot`, …; `sidecar:<vendor>` arrives in Phase 8);
  levels are `info` / `warn` / `error`. A small `system_log` module
  exposes `info!` / `warn!` / `error!` macros that fan out to the ring
  **and** to `tracing`'s normal subscriber (so dev logs to stderr still
  work). Includes a simple per-`(source, template)` rate-limiter as
  insurance against floods.
- **System Messages panel.** A new dockview panel
  `kind: "system-messages"`, registered in the toolbar's panel-add set.
  Renders the buffer as a virtualised list (timestamp, source, level,
  message), filterable by source and minimum level (defaulting to
  `warn`), with copy-entry / copy-all / clear actions. Per-panel filter
  state in dockview `params`. Session-scoped, not persisted in the
  project file.
- **Initial message sources.** Convert the existing ad-hoc `eprintln!`
  / `console.error` paths in project open / save, DBC parse / reload,
  connection lifecycle, and BLF import to structured `tracing` events
  feeding the bus.
- **Unread-error indicator.** A count badge in the titlebar / toolbar
  for unread `warn` + `error` entries since the panel was last focused;
  clicking it focuses the panel and clears the badge.
- **Wire-level surface for sidecar messages.** A new envelope variant
  on `cannet-wire`'s `Session` stream — `Log { ts, level, source,
  message }` — distinct from `Error` (which still ends the session).
  Defined here, consumed in Phase 8.

Exit criteria:

- A System Messages panel can be added to the layout and shows live
  messages from the host. Filter-by-source and filter-by-level work;
  clear empties the panel's view; copy-entry / copy-all populate the
  clipboard.
- Each of project open/save, DBC parse/reload, connection lifecycle,
  and BLF import emits structured messages at appropriate levels; the
  host's previous ad-hoc paths in those flows are converted.
- An unread-error indicator surfaces in the title / toolbar and clears
  on panel focus.
- `cannet-wire`'s `Session` carries a `Log` envelope variant ready for
  Phase 8 sidecars; the host bridge that maps a wire-`Log` into the
  local bus is in place (no consumer yet, but tested).
- README documents the panel; rustdoc covers the `system_log` module
  and the new wire envelope variant; `plans/technology-inventory.md`
  records `tracing` / `tracing-subscriber` as adopted (the use is now
  direct, where today they may be transitive).

Realised scope notes:

- **Host-side log bus shipped** in
  `apps/gui/src-tauri/src/system_log.rs` as a `SystemLog` holding a
  bounded `VecDeque<SystemMessage>` (cap 4096) plus a per-`(source,
  template)` rate limiter (5 entries per 1s window; the sixth emits a
  single suppression note and further duplicates drop silently until
  the window rolls). The `sys_info!` / `sys_warn!` / `sys_error!`
  macros emit a `tracing::event!` *and* push into the ring via a
  small `emit_system_log` helper that also broadcasts a
  `system-log-appended` Tauri event. `tracing-subscriber` is
  initialised once in `run()` via the `fmt` layer so stderr keeps
  working alongside the in-process bus.
- **IPC**: `fetch_system_log` returns a chronological snapshot; the
  panel uses it on mount and reconciles incoming events by `seq`
  (monotonic, not reset on clear) to dedupe a snapshot/event race.
  `clear_system_log` empties the ring without resetting `seq`.
- **System Messages panel shipped** as a dockview component
  (`kind: "system-messages"`, registered in `dockLayout.ts`). The
  panel is a virtualised list (22 px rows, overscan 6) over the
  filtered view, with source + min-level dropdowns, copy-all,
  double-click-to-copy, and clear. Filter state (source + minLevel,
  default `warn`) rides in dockview `params`; the bus itself is
  session-scoped — not in the project file.
- **Initial sources converted**: project open / save, DBC add /
  remove / clear (load/reload/remove paths, including the read +
  parse error branches), BLF import (`open_log` + `scan_blf_channels`
  error paths), connection lifecycle (`connect_remote_server`'s
  list / subscribe / busy paths, `disconnect_remote_server`, the
  pump's end-of-stream and source-error branches). The pre-existing
  `log-finished` event still fires; the structured message is in
  addition, not in place of, so the existing `LogState` status line
  is unchanged.
- **Unread-error indicator** lives on the toolbar's *System messages*
  button (rather than the title bar) — the title bar holds OS
  window-control glyphs we don't want to crowd. Clicking the button
  opens (or focuses) the panel, and the panel's
  `onDidActiveChange(active=true)` handler marks every current
  warn+error as read. Pure logic — `unreadWarnOrError` in
  `systemLog.ts` — is unit-tested alongside the merge / filter
  helpers.
- **Wire-level `Log` variant shipped** as `proto::Envelope.body.log`
  (tag 5) carrying `{ timestamp_ns, level, source, message }` with a
  three-value `LogLevel` enum. The new variant is exercised by
  protobuf round-trip tests in `crates/cannet-wire/tests/round_trip.rs`.
  `system_log::bridge_wire_log` translates a wire `LogMessage` into
  the local bus, mapping `Unspecified` (and unknown future variants)
  to `Info`; unit tests cover that and the `Warn` mapping. No live
  consumer yet — Phase 8's sidecar receive loop is the first.
- **Server / client exhaustiveness**. Both `cannet-server`'s session
  and loopback envelope matches and `cannet-client`'s receive loop
  picked up the new variant for exhaustiveness; all three drop wire-
  `Log` envelopes today (no log destination on the server side; the
  client will bridge in Phase 8 once the GUI host hosts the receive
  loop).
- **`tracing` + `tracing-subscriber` adopted** in
  `plans/technology-inventory.md` (status flipped from `proposed` to
  `adopted`); `tracing` was already a transitive dep, only
  `tracing-subscriber` is newly direct.

## Phase 8 — Vendor Drivers (Vector, Kvaser, PEAK)

Status: **in progress** — see "Realised scope notes" at the end of the
section for what has and has not been delivered against the original
scope.

Replace the BLF-only data path with real hardware sources by way of a
single `python-can`-backed sidecar process, auto-launched and managed
by the GUI. The wire protocol is the universal driver contract; the
sidecar speaks the same `.proto` the BLF replay server does.

Scope:

- **One vendor sidecar, auto-launched.** `cannet-python-can` is a small
  Python process that uses `python-can` to enumerate Vector, Kvaser,
  and PEAK channels available on the local machine and reports them
  through `ListInterfaces` with vendor-prefixed names
  (`vector:VN1640A/ch0`, `kvaser:0`, `pcan:PCAN_USBBUS1`). One process,
  one wire connection. The GUI spawns it eager-but-deferred at startup
  (background task, "discovering interfaces…" indicator) so the
  interface picker is populated by the time the user looks at it. A
  vendor with no matching hardware contributes zero interfaces.
- **`uv`-managed Python environment.** The sidecar lives in
  `servers/cannet-python-can/` with its own `pyproject.toml`. The GUI
  bundles the `uv` binary per supported OS; `uv sync` materialises the
  venv lazily on first launch, `uv run` starts the sidecar. `uv` also
  installs Python itself if missing, so there is no pre-installed-
  Python prerequisite.
- **User-replaceable driver layer.** The venv is editable. A user with
  LGPL concerns about `python-can` (or who wants a different driver)
  can `uv pip install` a replacement; the sidecar adapter exposes a
  small internal driver interface (open device, list channels, rx, tx)
  so swaps don't reach the wire-level code. The procedure is documented
  in the README, alongside a `servers/LICENSING.md` recording the LGPL
  analysis.
- **Hardware channels → interfaces → buses.** Sidecar channels appear
  in the Phase-6 graph view; the user binds them to logical buses the
  same way as the BLF replay test fixture. Bus speed / FD config per
  interface flows through `Subscribe` (small `.proto` extension if
  today's envelope is too narrow).
- **Transmit on hardware.** Phase 5's wire TX path is unchanged: GUI
  sends `FrameBatch` envelopes, sidecar hands them to the driver
  library. Listen-only configurations surface `TX_REJECTED`.
- **Sidecar lifecycle + log integration.** The sidecar emits over
  Phase 7's `Log` envelope variant; the host bridges into the System
  Messages bus tagged `sidecar:python-can` so vendor errors show up in
  the panel. A sidecar crash takes all hardware-bound interfaces
  "offline" in the project graph, emits an error-level message, and
  surfaces a one-click relaunch with a capped retry budget per session.
- **Coexists with the BLF replay test fixture.** A project can mix
  hardware buses with the BLF replay server in the same graph; no
  special-casing.

Out of scope (deferred / backlog):

- **Multiple vendor sidecars.** Phase 8 ships one. Adding a second
  sidecar (e.g. a Rust-native Vector adapter, or splitting one vendor
  out for a different driver) is a wire-protocol-compatible follow-up
  if Phase 14 profiling shows the python-can path is the bottleneck.
- **socketcan / vcan.** PEAK's Linux kernel driver path could go via
  socketcan; not adopted in this phase.
- **Native Rust FFI per vendor.** Rejected for Phase 8; revisit only
  if profiling justifies it.

Exit criteria:

- Launching the GUI auto-starts the python-can sidecar; the user does
  not run any sidecar process manually.
- For each of Vector, Kvaser, PEAK: a documented way to plug in
  hardware, see the channels appear in the interface picker, bind one
  to a logical bus, see live traffic in a trace; and a documented way
  to send a frame from the transmit panel and observe it on the bus
  (or a documented loopback / listen-back equivalent where a second
  device isn't available).
- Per-vendor smoke-test procedure is checked in; hardware-required
  steps are clearly marked (CI cannot run them).
- A user can replace `python-can` in the sidecar's venv with an
  alternative driver library by editing `pyproject.toml` and the
  adapter; the procedure is documented.
- Sidecar `info` / `warn` / `error` events appear in the System
  Messages panel tagged `sidecar:python-can`; a sidecar crash surfaces
  as error-level and is recoverable from the GUI.
- Vendor-specific code is contained to the sidecar; `cannet-gui`,
  `cannet-core`, `cannet-wire`, `cannet-client`, and `cannet-server`
  carry no vendor symbols.
- `uv` is fetched per supported OS — not committed to the repo, not
  packed into the installer artefact. The dev-side fetch
  (`scripts/fetch-uv.sh`) and the planned end-user fetch are
  documented per-OS in the README. See Phase 18 "third-party runtime
  tool fetching strategy" for the rationale.
- README documents per-vendor prerequisites (vendor SDK / driver
  install, OS support matrix), the `uv` fetch flow, and how to swap
  the driver library; `plans/technology-inventory.md` records `uv`,
  `python-can`, `grpcio` / `grpcio-tools`, the per-vendor SDKs (as
  runtime, user-installed), and the rejected alternatives (native FFI
  per vendor, socketcan-only, multiple sidecars for Phase 8).


Realised scope notes:

- **The sidecar lives at `servers/cannet-python-can/`** with its own
  `pyproject.toml`. It is a standalone Python package
  (`cannet_python_can`) that, when run, speaks the same tonic-defined
  gRPC `.proto` as `cannet-server` / `cannet-client`. The sidecar
  starts cleanly with **zero hardware present** and with **`python-can`
  absent** — both cases just yield zero interfaces and an info-level
  `LogMessage` on the session stream. This matches the
  "vendor with no hardware = zero interfaces" exit criterion.
- **gRPC stubs are checked into the tree** (generated with
  `grpc_tools.protoc` from `crates/cannet-wire/proto/cannet.proto`) so
  the sidecar runs without a `protoc` install step. Regeneration is
  scripted (`servers/cannet-python-can/scripts/regen_proto.sh`) and
  documented; the regenerated files are deterministic apart from the
  protoc version header.
- **GUI host lifecycle.** The Tauri host spawns the sidecar at startup
  via `apps/gui/src-tauri/src/sidecar.rs`. The spawn is eager-but-
  deferred (Tauri's async runtime, not the UI thread), captures
  stdout / stderr lines as `sidecar:python-can` System Messages, and
  emits an error-level message on unexpected exit. A one-click
  "Restart sidecar" host command is exposed; retries are capped per
  session (default 3). Bridging the gRPC-level `LogMessage` envelope
  from the sidecar's session stream into the System Messages bus is
  deferred until the host actually opens a session against the
  sidecar — today the panel sees the process-level lifecycle messages
  (start / interfaces-discovered / exit), which covers the "sidecar
  events appear tagged `sidecar:python-can`" exit criterion. The
  wire-level `LogMessage` bridge has a unit test on the sidecar side;
  the GUI host consumer is tracked in `backlog.md`.
- **`uv` is fetched, not bundled.** `scripts/fetch-uv.sh` produces a
  per-OS `uv` binary under `tools/uv/` at build time; the host
  discovers it at runtime alongside its executable, falls back to a
  `uv` already on `PATH`, and failing that logs a warn-level System
  Message with the install instructions. The dev-side fetch ships
  today; the end-user-side fetch (installer post-step vs. first-run
  host downloader) is a Phase-18 deliverable. We deliberately do
  **not** commit `uv` binaries into the repo or bake them into the
  Tauri bundle artefact — see the Phase-18 "third-party runtime tool
  fetching strategy" note for the rationale. The README documents
  the dev-side path today and will document the end-user path when
  the Phase-18 mechanism lands.
- **Hardware-specific paths are documented procedures, not executable
  tests.** Per-vendor smoke procedures live in
  `servers/cannet-python-can/SMOKE.md` with clearly marked
  "requires hardware" steps. CI runs only the Python import smoke
  (the sidecar boots, reports zero interfaces, exits cleanly) and the
  Rust-side host-spawn test. Vendor SDK install steps reference each
  vendor's documentation rather than mirroring it.
- **`grpcio` / `grpcio-tools` was confirmed, not reconsidered.** The
  wire protocol is already tonic / HTTP-2 gRPC, so a Python sidecar
  that speaks the same `.proto` realistically needs `grpcio`. A raw-
  TCP envelope-framing fork of the protocol was considered and
  rejected: it would fragment the wire into two flavours, and `grpcio`
  is mainstream and Apache-2.0. Inventory updated accordingly.
- **Listen-only `TX_REJECTED` and bus speed / FD `Subscribe`
  extension** are scoped against the driver-adapter interface; the
  `.proto` extension is **deferred** with a tracking entry in
  `backlog.md` — today's `Subscribe` envelope carries only an
  `interface_id`, and per-bus speed / FD config flows in a second
  pass once at least one hardware path has been smoke-tested end-to-
  end. The adapter trait exposes the `open(bitrate, fd)` slot so the
  wire bump is purely additive when it happens.


## Phase 9 — Trace Capture Persistence

Make captures persistable to disk and re-loadable, with user-placed
notes round-tripping through native BLF event records so captures stay
a single self-contained file readable by other BLF tools.

Scope:

- **Save Capture (BLF writer).** A top-level toolbar / project-panel
  action writes the **entire session buffer** to a single `.blf` file
  via `blf_asc`'s writer. Every frame on every bus, full capture, no
  per-trace slicing. Each logical bus becomes a numbered BLF channel;
  on re-import the Phase-6 channel → bus mapping step binds them back.
  Supports classic CAN, CAN FD, and error frames (the types `blf_asc`
  already covers). Written via temp-file + atomic rename so a
  mid-write crash leaves no half-file behind.
- **Notes as BLF global markers.** Notes (the plot panel's `+ note`
  cursor) move from plot-panel `params` (where Phase 4 put them) to
  the session buffer, so they're part of the capture rather than
  per-panel state. Plot panels render notes from the session buffer;
  the `+ note` cursor writes there. A note placed in panel A is
  visible in panel B over the same timeline. Save Capture emits notes
  as BLF `GLOBAL_MARKER` records — Vector's native annotation type,
  readable by other BLF-aware tools. Open BLF reads `GLOBAL_MARKER`
  records into the session buffer's notes list.
- **Recent BLFs.** The few most-recent BLF paths persisted in
  `localStorage`, offered in the Open BLF flow and the project panel's
  BLF import affordance.
- **System Messages integration.** Save Capture (frame count, byte
  size, marker count) and Open BLF (frame count, marker count, any
  decode anomalies) log at info / warn / error as appropriate.

Out of scope (deferred / backlog):

- **Disk-spill for long sessions** — the session buffer staying in RAM
  and overflowing to an append-only file is Phase 11, not the
  save-the-capture feature this phase delivers.
- **Capture import filtering** beyond the channel → bus mapping — no
  time-range or content selection at import; the user gets the whole
  file.

Exit criteria:

- Save Capture writes a BLF that round-trips: a freshly-saved capture
  re-opens in `cannet-gui` with frames and notes matching the session
  buffer, and reads cleanly in third-party BLF tools (validated
  against Vector's reference reader or an equivalent), markers visible
  there too.
- Notes are session-buffer-scoped: any plot panel's `+ note` cursor
  writes there; every plot panel covering that timeline sees them;
  Save Capture writes them as `GLOBAL_MARKER` records; Open BLF reads
  them back with timestamps and labels preserved.
- A Phase-4-vintage project (with notes in dockview `params`) opens
  cleanly with its notes migrated to the session buffer;
  `PROJECT_SCHEMA_VERSION` is bumped accordingly.
- The Recent BLFs list shows the last N opened files; clicking one
  opens the BLF through the standard Open BLF flow.
- Save Capture, Open BLF, and Recent BLFs all surface their results in
  the System Messages panel at appropriate levels.
- Backlog items removed: "Save Capture…" toolbar action, BLF
  annotation round-trip, recent BLF files, the f64-timestamp `[docs]`
  note (the precision caveat folds into Phase 9's docs, including a
  warn-level System Messages note on save when precision is measurably
  degraded vs. the in-memory timeline).
- README documents Save Capture, the marker round-trip, and the Recent
  BLFs list; rustdoc covers the new public surface (the BLF writer
  wrapper, the session-buffer notes API);
  `plans/technology-inventory.md` records any `blf_asc` upstream
  contribution needed for marker write support.

Realised scope notes:

- **Frame round-trip via the wrapper crate**. A new
  `cannet_blf::BlfCaptureWriter` wraps `blf_asc::BlfWriter` so the
  host can emit classic CAN, CAN FD, error, and remote frames from
  the session buffer's `RawTraceFrame`s. The writer streams to a
  `<dest>.part` temp file and renames into place on `finish()` so
  a mid-write crash leaves no half-file behind. Round-tripped in
  `cannet-blf` unit tests against `BlfCanFrameSource`.
- **Markers ride beside the BLF, not inside it (deferred upstream
  contribution).** Upstream `blf_asc` (0.2) doesn't expose the
  `GLOBAL_MARKER` object surface — its `BlfWriter` carries a private
  `add_object` and no marker types. Re-implementing the BLF container
  + compression layer in `cannet-blf` to emit one marker type is
  phase-sized on its own, so Phase 9 ships marker round-trip via a
  sidecar `<file>.blf.notes.json` written and renamed atomically
  alongside the BLF. Open Capture loads both. The third-party-reader
  visibility of markers is **deferred** to a follow-up that
  contributes `GLOBAL_MARKER` write + read upstream; tracked in
  `plans/backlog.md` and recorded in `plans/technology-inventory.md`
  alongside the existing `blf_asc` entry.
- **Notes on the host, not in plot params**. A new
  `crate::trace_store` neighbour module owns a session-scoped notes
  list (`{id, timestamp_ns, label}`); Tauri commands let the
  frontend add / rename / remove / list / clear / restore notes and
  receive `notes-changed` events. Plot panels read this through a
  small TypeScript hook and write through the same IPC; a note placed
  in panel A is visible in panel B over the same timeline. The
  previous `params.notes` field on `PlotPanel`'s dockview state is
  retired.
- **Project schema v3 → v4**. `PROJECT_SCHEMA_VERSION` bumps to `4`.
  v4 stores no notes itself (notes are session-scoped); a v3
  migration parses the dockview layout, strips any
  `notes` field from plot-panel `params` (they were per-panel and
  session-scoped in effect anyway), and rewrites the version. The
  migration covers the Phase-4-vintage project case from the exit
  criteria.
- **Recent BLFs**. A small `localStorage` helper (`recentBlfs.ts`)
  tracks the last N opened BLF paths (default `N=8`), offered in
  the Open BLF flow and the project panel's BLF import affordance.
  Pure-TS, unit-tested.
- **System Messages integration**. `save_capture` emits info-level
  (`frame_count`, `byte_size`, `marker_count`) and warn-level
  (`precision degraded` when the f64-second round-trip loses
  measurable ns precision vs. the in-memory timestamps) messages
  tagged `capture`. `open_capture` emits info (`frame_count`,
  `marker_count`) and error / warn on decode anomalies tagged
  `blf-import`. Recent BLFs replay through the same path.

## Phase 10 — Windowed-Model Convergence

Converge the GUI's four hand-rolled view caches — chrono trace,
filtered trace, by-ID, plot — onto one windowed-source contract with
two accessors. [`windowed-model-convergence.md`](windowed-model-convergence.md)
is **normative for this phase**: it carries the principle, the Layer-A
contract, the two accessors, and the four slices (Slice 0 already
shipped). Domain terms are defined in [`../docs/CONTEXT.md`](../docs/CONTEXT.md).

This is a **view-side** refactor — it lands against the current in-RAM
`TraceStore` `Vec`. Slice 1 freezes the host accessor signatures
disk-spill-ready so Phase 11 is a second implementation behind them,
not a redesign.

Scope: Slices 1-4 of `windowed-model-convergence.md`.

- **Slice 1** — extract the shared `useWindowedQuery` lifecycle
  primitive (raw chrono as first consumer); freeze `RowPage` and
  `DecimatedRange` as disk-spill-ready host signatures.
- **Slice 2** — filtered chrono onto the contract; `fetch_trace_range`
  gains a `FilterPredicate`; `FILTERED_CAP` removed.
- **Slice 3** — by-ID onto the contract; `fetch_by_id_page` pages and
  sorts host-side and is filterable; client-side re-sort removed.
- **Slice 4** — plot onto the shared primitive via `DecimatedRange`;
  `traceRangesRef` moves host-side.

Exit criteria:

- all four data views render through the shared primitive; the bespoke
  per-view caches (`chunkCache`/`refreshChunk`, `chronoFiltered` +
  `FILTERED_CAP`, the client-side by-ID re-sort, `PlotArea`'s
  `cacheRef`/`traceRangesRef`) are gone;
- `RowPage` and `DecimatedRange` exist as frozen, disk-spill-ready
  host signatures, implemented over the in-RAM `Vec`;
- filtered chrono pages the full match history; by-ID pages, sorts
  host-side, and is filterable; the plot's per-signal extent is a host
  query;
- each slice's acceptance list in `windowed-model-convergence.md` is
  met; `pnpm --dir apps/gui test` and `cargo test -p cannet-gui` green;
- `plans/ui-architecture-backlog.md`'s deviations are resolved and the
  filtered-trace / by-ID items in `plans/backlog.md` removed;
- README and rustdoc reflect the windowed-source contract.

## Phase 11 — Indefinite-Length Capture (Disk-Spill)

Make a capture indefinite-length — 10^7 to 10^9 frames, multi-hour to
multi-day — by spilling the raw frame store to disk while keeping
every historical row addressable. [`../docs/adr/0001-indefinite-length-capture.md`](../docs/adr/0001-indefinite-length-capture.md)
fixes the requirement (random-access, loss-free);
[`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md) fixes
the on-disk format and I/O architecture and is **normative for this
phase**.

This is the **model-side** counterpart to Phase 10: it provides a
second implementation of the `RowPage` / `DecimatedRange` accessor
signatures Phase 10 Slice 1 froze — no contract change, no view
change. (Explicit `.blf` "Save Capture" stays a separate feature; the
disk-spill store is the live working store — ephemeral scratch, not an
export format.)

ADR 0002 in brief: the raw store is two append-only files — fixed-size
~26 B metadata records giving arithmetic random access, plus a packed
payload blob (DS-1); writes are write-through and readers `mmap`, with
the kernel page cache as the hot tier and a RAM ring bridging the
un-flushed tail (DS-2); `by-id` and per-filter indexes are
materialized mmap'd files, every predicate id-narrowable against the
DBC so no index build is an O(capture) scan (DS-3); every file family
is fixed-size pre-allocated segments mapped whole with a valid-length
watermark (DS-4); the decoded-signal cache gains a per-signal min/max
resolution pyramid (DS-5); and the disk store is the only production
path, the in-RAM `Vec` retiring to a test double (DS-6).

Steps — each lands independently, leaves the app working and tested
(`cargo test -p cannet-gui`, `pnpm --dir apps/gui test`), and keeps
rustdoc and the README current for what it ships:

- **Step 1 — `TraceStore` trait + disk-backed raw store (DS-1, DS-2,
  DS-4).** Extract `TraceStore` as a trait from the current `Vec`
  implementation. Add the disk-backed raw store: the two append-only
  segmented files, write-through buffered append, mmap'd reads, and the
  RAM ring for the un-flushed tail. `fetch_trace_range` with no
  predicate is served from it. Verify: frames round-trip through the
  disk store; a capture larger than the RAM ring reads back every row
  correctly; segment rollover is exercised.
- **Step 2 — Always-on `by-id` index (DS-3 backbone).** Add the per-id
  append-only mmap'd index files, maintained on every append.
  `fetch_by_id_page` with no predicate is served from it. Verify:
  by-id paging is O(page); a capture spanning many ids pages and sorts
  correctly.
- **Step 3 — Materialized filter index (DS-3).** Add per-filter index
  files. `bus` / `id_range` / `id_list` / `name_regex` predicates
  build by merging `by-id` lists with no frame decode; `signal_equals`
  builds by decoding only its DBC-resolved candidate ids' frames;
  `all` / `any` compose id sets. Indexes drop on predicate change.
  `fetch_trace_range(predicate)` and `fetch_by_id_page(predicate)` are
  O(page). Verify: filtered paging is O(page); `name_regex` builds
  with zero frame decode; `signal_equals` decodes only candidate-id
  frames; a predicate change drops and rebuilds the index.
- **Step 4 — Decimated decoded-sample tier (DS-5).** Give
  `signal_cache::SignalCacheStore` the per-signal min/max resolution
  pyramid; `DecimatedRange` reads the coarsest level above
  `maxPoints`. Pyramids build lazily per signal on first plot,
  by-id-accelerated. Verify: a plot "fit data" over a 10^8-frame
  capture does not re-decode the whole capture; min/max spikes survive
  decimation.
- **Step 5 — Retire the in-RAM `Vec` store (DS-6).** The disk-backed
  store becomes the only production path; the `Vec` implementation
  moves to a test double behind the `TraceStore` trait. Verify: the
  production path constructs only the disk store; the suite stays
  green through the test double.
- **Step 6 — Benchmark.** A documented benchmark covering scroll /
  filter / plot of deep history, confirming GUI interactions stay
  < 100 ms / 60 fps with a 10^8+-frame capture open.

Exit criteria:

- a capture runs past available RAM with no row becoming unreachable;
  scroll / filter / plot of deep history all work;
- the `RowPage` / `DecimatedRange` signatures from Phase 10 are
  unchanged — only their host implementation is swapped;
- `fetch_trace_range` / `fetch_by_id_page` with a predicate are
  O(page) via the filter index, with no O(capture) scan in any filter
  index build;
- a plot "fit data" over a 10^9-frame capture does not re-decode the
  whole capture;
- the disk-backed store is the only production `TraceStore`; the `Vec`
  store is a test double;
- a documented benchmark shows GUI interactions stay < 100 ms / 60 fps
  with a 10^8+-frame capture open;
- backlog items removed: `TraceStore` disk-spill, index the filtered
  trace scan, bound the host-side decoded-sample cache;
- README documents indefinite-length capture and its limits; rustdoc
  covers the `TraceStore` trait and the disk-backed implementation;
  ADR 0002 and the `memmap2` entry in
  `plans/technology-inventory.md` reflect the shipped design.

## Phase 12 — Command Palette + Goto Framework

A generalised command model plus a VS Code-style command palette
(Cmd/Ctrl+Shift+P) that surfaces it. Commands carry an id, a label, an
optional category, and an optional context-requirement (e.g. "focused
panel is a plot"); built-in commands include go-to-panel-instance, go
to a specific time in a trace, set a plot's visible time range, import
a DBC, connect / disconnect, Save Capture, and so on. Part of the
phase is the explicit decision on what belongs in the palette (broad,
project-wide, keyboard-accessible) vs. what stays local-only
(right-click menus, panel toolbars) — the model has to be deliberate
about that boundary. The "Go to row…" backlog item folds in as a
single `goto.traceRow` command.

## Phase 13 — Signals, Drag/Drop & Trace Signal Display

Make individual signals first-class objects you can grab and move
around. A new **signal view** panel hosts a user-chosen set of signals
with their latest values. **Drag / drop** of signals is enabled across
the GUI: trace ↔ plot, trace ↔ trace, plot ↔ signal view, DBC panel →
anywhere. A new **DBC panel** replaces today's project-panel DBC list
(which doesn't scale past a few large databases) and is where signals
are discovered and dragged from. The plot panel grows a **per-trace
colour picker** (right-click swatch → colour dialog). The trace view's
expanded-row decoded signals render as **inline lines under the
message row** rather than the expand-to-show grid — the trace-side
counterpart to "signals are first-class".

## Phase 14 — Performance Profiling Baseline

Profiling procedure that covers all three tiers — client (GUI),
server, and the wire between them. Metrics (frame throughput,
end-to-end latency from server ingest to GUI render, per-frame CPU
cost on each side, memory growth under sustained replay,
dropped-frame counts), instrumentation (in-process counters / timers,
sampling profiler hooks), and a reproducible workload (likely a
standard BLF replay at a known rate). Baseline numbers checked in
against the Phase 8 build for each supported source (BLF replay + at
least one hardware vendor). Pulls in the perf backlog items the
baseline tends to motivate: `CanFramePayload` inline buffer and
precise time → frame-index mapping for the plot visible-range fetch.
(The two-tier per-signal sample cache and `TraceStore` disk-spill are
Phase 11, not pulled in here — Phase 11 owns the indefinite-length
model.)

## Phase 15 — CANopen

EDS ingestion (CANopen Electronic Data Sheet — library TBD when this
phase becomes current) and SDO / PDO decoding on top of the Phase 5
value-table machinery.

## Phase 16 — Rest-of-Bus Simulation + CRC / Sequence

**Rest-of-bus simulation**: a gridview that holds a configurable set
of ids with live signal values and transmits them on a cadence — the
client side of "simulate the rest of the network", the TX counterpart
of the by-ID panel. **CRC + sequence-count calculation in arbitrary
fields** of a CAN message — transmit-side helper for messages that
carry their own integrity fields (and decode-side verification
where useful).

## Phase 17 — Plot Panel Refinements

The plot-panel feature tail that didn't need the bigger architectural
lifts of Phase 13. **Triggers** (edge / level / value-match on a
chosen signal that freeze the view and emit an event marker —
oscilloscope trigger proper; the event-line rendering already exists,
the trigger engine doesn't). **Math channels** (derived signals
computed from other signals — also useful to the transmit panel and a
future scripting surface, so it may outgrow plotting). **Manual
per-trace y** (offset / gain / log scale, overriding the auto-norm
that ships today). **CSV / image export** of the visible window or
cursor span. **Drag a whole plot area** (not just a signal) between
plot panels.

## Phase 18 — Cross-Cutting Polish

The remaining small UX and infrastructure items that don't deserve
their own phase: the **trace virtualizer rework** (real windowed
virtualizer with a synthetic-height spacer vs. the current scaled
approach), the **auto-scroll re-pin race** under fast streams, the
**by-ID paused-snapshot tighten** (return latest of each id within
`[since, end)` rather than reading the global latest index), a
**GUI-wide dark "scope" restyle**, **dock / undock** a panel as a
separate OS window, a **global UI FPS / responsiveness readout**,
**`cannet-server` multi-client** support, the **plot vs trace divider
drag** fix, and the **BLF f64-timestamp precision** documentation note
(if it hasn't already been folded into a user-facing surface message
by then).

**Third-party runtime tool fetching strategy.** External runtime
binaries we depend on (today: `uv`; potentially others later) are
**fetched, not committed to the repo and not packed into the
installer artefact**. First-party code we maintain (the sidecar
package, the GUI, the Rust crates) is bundled; tools we do *not*
maintain are pulled from their upstream release channel at the
pinned version. This keeps the distributable small, keeps the
supply chain auditable against upstream releases instead of a
snapshot we'd have to re-cut on every upstream version bump, and
gives us one place to revisit the pin.

The dev-side fetch already exists ([`scripts/fetch-uv.sh`](../scripts/fetch-uv.sh)
drops `uv` into `tools/uv/` next to the GUI binary, which the host
discovers at runtime). The Phase-18 deliverable is the **end-user**
fetch — choose between:

1. **Installer post-step** — the installer (Tauri's per-OS bundler
   target, or a thin wrapper around it) downloads `uv` at install
   time into the app's install dir.
2. **First-run host downloader** — the GUI fetches `uv` on first
   launch into the user's app-data dir and points the launcher at
   that path; offline first-run shows a clear error with the manual
   `uv` install link.

Both keep the runtime lookup chain in `sidecar.rs` unchanged
(`tools/uv/uv` → `PATH` `uv` → `python3` fallback). The pin
(`UV_VERSION` in `scripts/fetch-uv.sh`) is the single source of
truth in either flow.
