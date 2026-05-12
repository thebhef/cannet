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
`sample_signal` commands) first, then the plot panel itself (uPlot in a
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
  `apps/gui/src-tauri/src/signal_sampler.rs` plus
  `TraceStore::slice_time_range` / `first_timestamp_ns` /
  `last_timestamp_ns`; surfaced to the frontend as the `list_signals`
  (DBC → pickable signals) and `sample_signal` (`(t, v)` series + the
  capture's current time bounds) Tauri commands. Independently-sampled
  series are stitched onto one timeline (sorted-union x-axis,
  sample-and-hold per series) by `apps/gui/src/plotData.ts` before being
  handed to the renderer.
- **Decimation is part of the data path, not an optimisation.** ✅ Done
  — the trace store can hold **hundreds of thousands to millions** of
  frames, so a single signal series can be far larger than what uPlot
  (or any canvas renderer) should redraw. `sample_signal` takes a
  `max_points` hint (the plot passes ≈its pixel width) and
  min/max-decimates the decoded series to at most `2 * max_points`
  points — per-bucket extrema, so spikes survive
  (`signal_sampler::decimate_min_max`, unit-tested). The un-decimated
  frames stay in the trace store; a cursor / measurement query just asks
  for that signal again over the (narrower) cursor span. Still pending:
  decoding only the newly-appended frames each tick rather than
  re-scanning the whole window (`plans/backlog.md`).
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
  its time axis at the bottom plus a side signal panel (swatch, name,
  value). Picking a signal adds it to the focused area; a signal moves
  between areas via a per-row menu (native drag-and-drop is a follow-up
  polish, `plans/backlog.md`). The plot-area list and the signal→area
  assignment persist via the panel's dockview `params`.
- **Trace-style controls.** ✅ Done — the panel has Start / Stop / Pause
  / Clear (the shared `TraceControls`): it has trace behaviour, just
  focused on signal *values* over time. While "running" it follows the
  live capture; pause/stop freeze the view (the resample loop stops,
  which also keeps a fast/unlimited-rate stream from piling up
  `sample_signal` calls); Clear re-anchors what's plotted to the current
  capture edge. The play state is session-only.
- **Synced x zoom + pan; per-area y zoom; fit data.** ✅ Done —
  drag-select or `⌘/ctrl`+wheel on any area zooms x on all areas (and
  leaves follow-live); `shift`+wheel pans x (synced); `⌘/ctrl`+`shift`+
  wheel zooms y on the hovered area only; "fit data" refits x to the
  full capture span and y to the data. (`⌘/ctrl`+`shift` is the
  buried, rarely-used one — y is usually set with the per-area range
  control.) Implemented with a shared x-sync ref + a per-area `setScale`
  hook (cross-instance `setScale`, guarded so programmatic changes
  don't echo), and a per-area re-entrancy guard on the resample.
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
  H1/H2 Y-cursor values and ΔH show in the area's signal-panel head. A
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
  (`plans/backlog.md`); until then enum signals plot as their raw codes.
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
- **Incremental sampling.** The decimating `sample_signal` re-scans the
  whole window each tick; decoding only the newly-appended frames is the
  bigger win for very long captures (`plans/backlog.md`).
- **Drag-and-drop signal moves.** Signals move between areas via a
  per-row menu; native DnD is a polish item.
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

## Phase 5 — Transmit

Compose and send CAN / CAN FD frames from the GUI. This is the other
half of "round out the GUI" — split out of Phase 3 once the
writable-target question got sorted. It sits after plotting and before
hardware drivers: it needs the Phase 3 docking layout and project file
to host and persist a transmit panel, but nothing from the vendor
adapters.

Scope:

- **Transmit panel.** A dockview panel (alongside trace and plot panels)
  that composes CAN / CAN FD frames — id, type, channel, payload,
  optional cycle time. When a DBC is attached, the panel offers
  signal-by-signal entry for any matching message id (factor / offset /
  endianness applied during encode); raw byte entry is always available
  as the fallback for ids the DBC doesn't cover. A transmit panel's
  frame definitions are per-panel config and round-trip through the
  Phase 3 project file.
- **Where a sent frame goes:**
  - It always appears in the trace as a `Tx`-direction row (a tx-confirm)
    — what a real analyzer shows for your own transmits — so the
    compose / encode path is observable with no writable source at all.
  - If a remote session is open, it's also sent over the wire. The
    `cannet-core` / wire abstraction grows the transmit direction — the
    client emits frame envelopes, not just `Subscribe` (the wire already
    carries `FrameBatch` symmetrically; Phase 2 just never sent one from
    the client). The Phase-2 BLF replay server is read-only and answers
    `Error::TX_REJECTED`, which the UI surfaces.
  - A new `cannet-server --loopback` mode exposes a writable interface
    that echoes received transmits back, so the wire transmit path can be
    demonstrated succeeding end to end without hardware.
- **Cyclic transmit** is a client-side feature — the panel schedules the
  resend — not a wire feature; the wire stays one-frame-at-a-time, as
  Phase 2 fixed.

Out of scope (deferred to later phases / backlog):

- **A real in-process writable CAN bus** — Linux `vcan` / socketcan, or
  an in-memory loopback-bus type in `cannet-core`. The tx-confirm row +
  `cannet-server --loopback` cover demo and test; an actual local
  virtual-bus device is a later add. Tracked in `plans/backlog.md`.
- **Transmit to real hardware** — Phase 6 (the vendor adapters make the
  server's interfaces writable).

Exit criteria:

- Sending a frame from a transmit panel shows it in the trace as a `Tx`
  row, and — when a remote session is open — delivers it over the wire:
  the read-only BLF server answers `Error::TX_REJECTED` (surfaced in the
  UI), and a `cannet-server --loopback` accepts the transmit and echoes
  it back into the trace. Works in both raw-byte mode and (with a DBC
  attached) signal-by-signal encoded mode.
- Cyclic send: a frame with a cycle time resends on that cadence until
  stopped.
- A transmit panel's frame definitions persist through the project file.
- README documents the transmit workflow (compose, DBC encode, cyclic
  send, the `--loopback` server); rustdoc covers the new public surface
  on the CAN abstraction (the transmit direction) and the
  `cannet-client` transmit API.

## Phase 6 — Vector, Kvaser, and PEAK CAN Driver Support

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

## Phase 7 — Performance Profiling Baseline

Make performance measurable before we keep piling features on.

Scope:

- Define a profiling strategy that covers all three tiers — client (GUI),
  server, and the wire between them. Identify the metrics we care about
  (frame throughput, end-to-end latency from server ingest to GUI render,
  per-frame CPU cost on each side, memory growth under sustained replay,
  dropped-frame counts).
- Pick instrumentation: in-process counters/timers, sampling profiler hooks,
  and a reproducible workload (likely a standard BLF replay at a known rate).
- Capture an initial baseline against the Phase 6 build for each supported
  source (BLF replay + at least one hardware vendor) and check it in so future
  changes can be compared against it.

Exit criteria:

- Documented, repeatable profiling procedure.
- Baseline numbers committed for the current build, with enough detail that a
  later contributor can reproduce them and notice regressions.
- README points at the profiling doc and the baseline file.
