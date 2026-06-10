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

- **Wire protocol in a new `crates/cannet-wire`.** Decisions
  (transport, encoding, service surface, envelope variants):
  see [`../docs/adr/0004-grpc-wire-protocol.md`](../docs/adr/0004-grpc-wire-protocol.md).
- **`crates/cannet-server`** — Phase 2's only supported input is BLF:
  the server loads a file at startup and streams it on a loop while
  clients are subscribed to its interfaces. Looping is a server-CLI
  concern, not a wire concern. BLF is read-only, so the server
  rejects client transmits with `Error::TX_REJECTED`.
- **Single-client per server** for Phase 2: a second connection is
  rejected with `Error::BUSY`. Multi-client fanout is in
  `plans/backlog.md`.
- **`crates/cannet-client`** implements `cannet_core::CanFrameSource`
  over a tonic client, so the GUI's existing trace + decode pipeline
  consumes a remote server with no changes to its consumer code.
  The GUI grows a connection panel (host:port + interface picker
  driven by `ListInterfaces`) alongside the in-process BLF path.
- Server is addressable by host:port. Discovery is **not** in scope.
- TLS is configurable but off by default (per ADR 0004); plaintext
  on loopback is the dev / demo flow. Cert UX (fingerprint pinning,
  project-file persistence) is deferred until the project-file
  feature lands.

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

Status: **shipped.** Logical buses + interfaces, BLF as a client-side
import feature, per-bus DBC scoping, the filter element, and the
project graph view all landed. Phase 6.5 (below) closed the
consumer-side wiring gaps the original Phase 6 plan deferred.

What shipped:

- **Logical buses + interface bindings** in the project schema
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
- **Project panel / project graph surface-role split** —
  see [ADR 0012](../docs/adr/0012-project-panel-graph-split.md).
  The project panel keeps file-IO + inventory roles; the graph view
  owns the spatial wiring story. Both surfaces are views over the
  same `Project` state.
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
    *Discover* button that calls `refresh_interfaces` (per ADR 0016
    superseding the original `list_remote_interfaces`), interface
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

### Phase 6.5 — default-receive-all consumers, edge edits, transmit by bus

A follow-up pass after Phase 6 shipped, addressing the consumer-side
wiring gaps the original Phase-6 plan deferred. The three coordinated
decisions — consumers receive from every bus by default
(`sources: string[]` with `"*"` wildcard), user-editable graph edges,
transmit binding to project `bus_id`s instead of raw wire channels —
are recorded in
[ADR 0013](../docs/adr/0013-default-receive-all-edge-edits-transmit-by-bus.md).
Schema change was purely additive; `PROJECT_SCHEMA_VERSION` stayed at 4.

Implementation specifics that landed in the same pass:

- **Graph affordances**: right-click an edge → delete; right-click a
  trace / plot / transmit panel → sources / sinks picker (checkboxes
  for every project bus + filter, with an "All" toggle that
  re-collapses to `["*"]`); `+ filter` button on each consumer node
  in the graph (creates a fresh filter, transfers the consumer's
  `sources` to it, re-routes through the filter); `+ filter` button
  on the graph panel toolbar (free-standing filter, fans in from
  every bus, no downstream until wired). Cycle prevention is
  enforced in `applyElementPatch`.
- **Filter predicate editor**: inline (caret-expand) on each filter
  node for the structured leaf variants
  (`bus | id_range | id_list | name_regex | signal_equals`);
  composition variants (`all | any`) stay JSON-only.
- **Sources picker on plot panel** is embedded in the existing
  toolbar context-menu shell.
- **Open-BLF modal** pre-seeds bus matches from the project's
  ordered bus list (channel `N` ↔ `project.buses[N]`).
- **Trace view column rename**: `ch` → `bus`, rendering the bus
  *name* (or "unassigned").

Deferred follow-ups:

- Per-panel **chronological** trace filtering and per-panel **plot
  sampling** filtering — Phase 6.5 only wired the predicate into the
  per-panel by-id fetch. Absorbed into **Phase 11 Slice 2** (chrono)
  and **Slice 4** (plot sampling) of the windowed-model convergence.
- **Drag-to-wire** in the graph (literal drag from a producer
  handle onto a consumer) — tracked in `plans/backlog.md`; the
  right-click picker handles wiring today.
- **Bus-like graph topology** (gateway at one end, bus running
  long, consumers branching off) — tracked in `plans/backlog.md`;
  current layout is lane-based.

## Phase 7 — System Messages

Plumb a structured log bus and a panel that surfaces it, before later
phases add sources (vendor sidecars, capture writer, perf events) that
all want a uniform place to talk to the user. Small, focused, and
exactly the kind of plumbing every phase from 8 onward leans on.

The architectural shape of the bus — bounded, session-scoped,
flood-protected, tee'd to `tracing`, plus the sidecar wire `Log`
envelope distinct from `Error` — is recorded in
[ADR 0014](../docs/adr/0014-host-system-log.md). Phase 7's scope
is the panel, the initial-source conversion, the unread indicator,
and the wire envelope's definition (consumer arrives in Phase 8).

Scope:

- **System Messages panel.** A new dockview panel
  `kind: "system-messages"`, registered in the toolbar's panel-add set.
  Renders the buffer as a virtualised list (timestamp, source, level,
  message), filterable by source and minimum level (defaulting to
  `warn`), with copy-entry / copy-all / clear actions. Per-panel filter
  state in dockview `params`.
- **Initial message sources.** Convert the existing ad-hoc `eprintln!`
  / `console.error` paths in project open / save, DBC parse / reload,
  connection lifecycle, and BLF import to structured events feeding
  the bus.
- **Unread-error indicator.** A count badge on the toolbar's *System
  messages* button for unread `warn` + `error` entries since the panel
  was last focused; clicking it focuses the panel and clears the
  badge.
- **Wire `Log` envelope** on `cannet-wire`'s `Session` stream
  (per ADR 0014). Defined here, consumed in Phase 8.

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

Status: **shipped.** A single `python-can`-backed sidecar process
wraps Vector, Kvaser, and PEAK drivers; the GUI auto-launches it;
its channels appear in the Phase-6 graph view bindable to logical
buses; transmit on hardware uses Phase 5's wire TX path unchanged.
The sidecar coexists with the BLF replay test fixture and starts
cleanly even with zero hardware / `python-can` absent (yields zero
interfaces + an info-level log).

What shipped:

- **Sidecar at `servers/cannet-python-can/`** — a standalone Python
  package (`cannet_python_can`) speaking the same tonic-defined gRPC
  `.proto` as `cannet-server` / `cannet-client`. Enumerates channels
  through `ListInterfaces` with vendor-prefixed names
  (`vector:VN1640A/ch0`, `kvaser:0`, `pcan:PCAN_USBBUS1`).
- **gRPC stubs checked into the tree** (generated with
  `grpc_tools.protoc` from `crates/cannet-wire/proto/cannet.proto`)
  so the sidecar runs without a `protoc` install step. Regeneration
  is scripted (`servers/cannet-python-can/scripts/regen_proto.sh`).
- **GUI host lifecycle** in `apps/gui/src-tauri/src/sidecar.rs`. The
  Tauri host spawns the sidecar eager-but-deferred at startup,
  captures stdout / stderr as `sidecar:python-can` System Messages,
  emits an error-level message on unexpected exit, and exposes a
  one-click "Restart sidecar" host command capped at 3 retries per
  session.
- **`uv` is fetched, not bundled** — per
  [ADR 0015](../docs/adr/0015-fetched-runtime-binaries.md).
  `scripts/fetch-uv.sh` produces a per-OS `uv` binary under
  `tools/uv/` at build time; the host discovers it at runtime
  alongside its executable, falls back to a `uv` already on `PATH`,
  and otherwise logs a warn-level message with install instructions.
- **User-replaceable driver layer.** The venv is editable. A user
  with LGPL concerns about `python-can` (or who wants a different
  driver) can `uv pip install` a replacement; the sidecar adapter
  exposes a small internal driver interface so swaps don't reach
  wire-level code. Documented in the README, alongside
  `servers/LICENSING.md` recording the LGPL analysis.
- **Hardware-specific paths are documented procedures, not
  executable tests.** Per-vendor smoke procedures live in
  `servers/cannet-python-can/SMOKE.md` with clearly marked "requires
  hardware" steps. CI runs only the Python import smoke (the
  sidecar boots, reports zero interfaces, exits cleanly) and the
  Rust-side host-spawn test.
- **`grpcio` / `grpcio-tools` confirmed**, not reconsidered. A raw-
  TCP envelope-framing fork was considered and rejected: it would
  fragment the wire into two flavours, and `grpcio` is mainstream
  and Apache-2.0. Inventory updated accordingly.
- **Vendor-specific code is contained to the sidecar.** `cannet-gui`,
  `cannet-core`, `cannet-wire`, `cannet-client`, and `cannet-server`
  carry no vendor symbols.

Deferred follow-ups:

- **Wire-level `LogMessage` → System Messages bridge.** Today the
  panel sees the process-level lifecycle messages (start /
  interfaces-discovered / exit) tagged `sidecar:python-can`; the
  in-band gRPC `LogMessage` bridge from an active sidecar Session is
  unit-tested on the sidecar side, host consumer tracked in
  `plans/backlog.md`.
- **End-user `uv` fetch mechanism.** Dev-side fetch ships today; the
  end-user-side fetch (installer post-step vs first-run host
  downloader) is the **Phase 19** deliverable per ADR 0015.
  Tracked in `plans/backlog.md`.
- **`Subscribe` carrying bus speed / FD config + listen-only
  `TX_REJECTED` wire surfacing.** Adapter trait exposes the
  `open(bitrate, fd)` slot; today's `Subscribe` envelope carries
  only an `interface_id` and per-bus speed / FD config flows in a
  second pass. Tracked in `plans/backlog.md`.
- **Multiple vendor sidecars / socketcan / native Rust FFI per
  vendor** — Phase 8 ships a single python-can sidecar; alternatives
  are wire-protocol-compatible follow-ups that wait for profiling
  (**Phase 15**) or a real driver-fragmentation use case.

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
  and overflowing to an append-only file is Phase 12, not the
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

## Phase 10 — Integration Testing and Refinement

Refine and integrate the work between Phase 9 and the windowed-source
convergence (Phase 11). Five tracks: a shipped BLF-format own-
implementation track (Track 1) plus four user-visible usability tracks
surfaced from real use of the app — transmit signals can't be edited
(Track 2), the plot can't show data points and has no fit / follow
hotkeys (Track 3), there is no command-palette / hotkey primitive
(Track 4), and the DBC inventory doesn't scale or surface signals as
drag sources (Track 5).

Tracks 2-5 were lifts from later phases: the encoder follow-up out of
Phase 5 (Track 2), plot refinements out of Phase 18 (Track 3), the
command-palette framework out of Phase 13 (Track 4), the DBC panel +
drag/drop out of Phase 14 (Track 5). Lifting them forward unblocks
day-to-day use of the app and gives Phase 11's view-side convergence
a stable hotkey/command surface from day one. Phases 13, 14, and 18
keep what's left of their original scope.

Track order: Track 1 (shipped), Track 2 (shipped). Then 4 → 3 → 5:
the command/hotkey framework lands next because Tracks 3 and 5
register commands on it; plot pinpoints land third (its hotkeys
ride the framework); DBC view + drag/drop lands fourth (its
palette commands ride the framework, its search reuses the
framework's fuzzy matcher).

### Track 1 — `cannet-blf` Own Implementation

Status: **shipped.** Replaced `cannet-blf`'s `blf_asc` wrapper with
our own focused BLF reader / writer per
[ADR 0009](../docs/adr/0009-dbc-blf-readers.md). Retired the third-
party Rust BLF crate from the dep tree, unlocked `GLOBAL_MARKER`
write so notes live inside the BLF per
[ADR 0010](../docs/adr/0010-no-sidecar-files.md), and gave us the
typed-write surface for the rest of the desired BLF object catalogue
([feature support matrix](../docs/blf-feature-support.md)).

What shipped (five steps, each landed as its own working slice):

- **Step 0 — `vector_blf` test oracle.** A build script clones
  Technica's [`vector_blf`](https://github.com/Technica-Engineering/vector_blf)
  at a pinned upstream ref into `target/` (never vendored), cmake-
  builds it, and compiles a small C++ test harness. Harness sources
  live test-only under `crates/cannet-blf/tests/oracle/`; the clone,
  the cmake build, and the resulting binary all sit in `target/` and
  never ship in cannet's runtime binary. Gated behind cargo feature
  `vector-blf-oracle` so default CI doesn't require a C++ toolchain.
- **Step 1 — Parity.** Native read+write for `LOG_CONTAINER` (10),
  `CAN_MESSAGE` (1), `CAN_MESSAGE2` (86), `CAN_FD_MESSAGE` (100),
  `CAN_FD_MESSAGE_64` (101), `CAN_ERROR_EXT` (73). The public
  `BlfCanFrameSource` / `BlfCaptureWriter` surface is unchanged.
  `blf_asc` is removed from the dep tree. Oracle test green.
  Implementation notes:
  - The on-disk inter-object padding rule is `object_size % 4`, not
    `(4 - object_size % 4) % 4` — matches Vector's reference
    `LogContainer.cpp` (`is.seekg(objectSize % 4, ...)`). The padding
    therefore doesn't 4-align the next object's start; it's a
    vestigial formula but every BLF implementation in the wild
    follows it.
  - `blf_asc` wrote `CAN_FD_MESSAGE` bodies missing the trailing
    `reservedCanFdMessage3` (82 bytes vs Vector's spec 86). The
    decoder accepts both forms; the encoder always emits the
    spec-compliant 86-byte form.
  - The native writer emits `CAN_MESSAGE2` for classic CAN and
    `CAN_FD_MESSAGE_64` for CAN FD (the modern types Vector's tools
    emit). The reader handles all five frame types either direction.
  - `FileStatistics.measurement_start_time` is a SYSTEMTIME (ms
    granularity). The writer floors the first event's timestamp to
    the ms boundary so per-event relative timestamps carry the
    sub-ms tail losslessly. End-to-end timestamp round-trip is ns-
    exact (previously ~10–100 ns drift via `blf_asc`'s f64 seconds).
- **Step 2 — `GLOBAL_MARKER`.** Read + write for object type 96 in
  `cannet-blf::format::marker`. `BlfReader` exposes the marker
  variant on `BlfObject`; `BlfFileWriter::append_object` accepts
  encoded marker bytes, so writers can intersperse markers with CAN
  frames in chronological order. `BlfCanFrameSource` skips markers;
  consumers that want them walk `BlfReader` directly. Notes now live
  inside the BLF per ADR 0010.
- **Step 3 — Annotation round-trip.** Read + write for
  `EVENT_COMMENT` (92) and `APP_TEXT` (65) in
  `cannet-blf::format::text`. `pack_db_channel_info(version, channel,
  bus_type, is_can_fd)` helper covers the
  `APP_TEXT.source == DB_CHANNEL_INFO` packing of
  `reserved_app_text1`.
- **Step 4 — Capture integrity.** Read + write for `CAN_STATISTIC`
  (4), `DATA_LOST_BEGIN` (125), `DATA_LOST_END` (126) in
  `cannet-blf::format::diagnostics`. `CanStatistic::bus_load_percent`
  convenience for the hundredths-of-a-percent on-disk encoding;
  queue-identifier constants (`QUEUE_RT` / `QUEUE_ANALYZER` /
  `QUEUE_RT_AND_ANALYZER`) cover Vector's three values.

The native BLF codec covers every object type listed in
`plans/features.md` as `required` or `desired`. Object types listed
`nice` (`CAN_OVERLOAD`, `CAN_FD_ERROR_64`, FlexRay events) remain
undecoded; the reader surfaces them via `BlfObject::Other`. Test
sources per ADR 0009: synthetic-bytes per-module tests (in-tree),
the `vector_blf` live oracle (Step 0, feature-gated), and Vector
CANalyzer round-trip fixtures (vendored under
`crates/cannet-blf/tests/fixtures/canalyzer/` as needed).

Deferred follow-ups:

- python-can BLF fixtures (Apache-2.0) under
  `crates/cannet-blf/tests/fixtures/python-can/` — tracked in
  `plans/backlog.md`.
- `oos` feature-matrix rows (LIN, MOST, FlexRay, Ethernet, J1708,
  WLAN, AFDX, A429, K-Line) and post-2018-v8 object types
  (`CAN_SETTING_CHANGED` and later) — out of cannet's scope; the
  matrix records the intent.

### Track 2 — Transmit Usability

Status: **shipped.** Made the transmit panel's signal editing
actually work and reshaped the panel around the real workflow
(interactive multi-frame poking) rather than a per-frame form. The
prior panel let the user type raw hex into `dataHex` and pick an
enum signal's raw value from a dropdown that copied a single byte
into the payload; numeric signals had no input at all. A frame with
a multi-byte signed signal or a big-endian message was unsendable
without computing bytes by hand. The form-shaped layout (one frame
in the sidebar, one tall form on the right, hex-string editor
mode-toggled with a signal picker) wasted screen and hid the
bytes ↔ signals relationship.

**Encoder + descriptor commands (`cannet-dbc` + GUI host).**

- **`cannet_dbc::Database::encode_frame`** — the inverse of
  `decode`. Encodes `{signal_name → f64}` into the message's
  payload at the signal's `start_bit / length`, with factor /
  offset, signedness, big- and little-endian, multi-byte signals,
  floats / doubles, and **multiplexed messages** (simple mux:
  one `M` switch + `m<N>` sub-signals). The encoder is a
  *partial encode* — it writes only the bits the named signals
  cover, preserving other bytes. Round-trip tests against
  `decode` over the demo fixture; oracle tests for mux against
  a hand-encoded reference.
- **`cannet_dbc::Database::describe_message`** — rich per-message
  view: name, declared length, `is_fd` (from `VFrameFormat`
  14/15, with `size > 8` fallback), `brs` (from `GenMsgCANFDBRS`,
  defaulting to `true` on FD), `uses_extended_mux`, and a vector
  of rich per-signal descriptors (`factor / offset / size /
  signed / min / max / mux indicator / float kind /
  has_value_table`).
- **Tauri commands.** Three new entries in the GUI host:
  `encode_frame` (writes signal edits back to bytes),
  `describe_message` (the metadata above — feeds the signals
  table headers + the FD / BRS auto-derivation), `decode_frame`
  (decodes a hypothetical panel-side payload through the loaded
  DBCs — feeds the signals table values without the frame
  needing to be in the trace store).

**Panel shape.** Single vertical column of frames; each frame is a
collapsible row-tile. Many tiles can be expanded at once.
Drag-reorderable via a far-left handle tinted with the destination
bus's colour. Clicking anywhere on the row that isn't an
interactive control (input, select, button, …) toggles the row's
expansion. Persisted state per frame stays `dataHex` (bytes as
source of truth — see ADR 0017).

**Collapsed face (per frame).** Two regions:

- *Line 1 (control + identity).* Drag handle · manual/periodic
  toggle (manual → `send`; periodic → period-ms input + start /
  stop) · name · bus · id (hex) · DBC message name when the id
  matches a loaded DBC · `×` remove with confirm-on-click.
- *Line 2+ (bytes editor).* Per-byte editable hex cells with
  `Tab` / `Shift+Tab` navigation between cells. Classic frames = 8
  cells in one row. FD frames wrap at *a multiple of 8 cells per
  row* — 8 at narrow panel widths, stepping up through 16 / 24 /
  32 / 40 / 48 / 56 / 64 as the panel widens (CSS container
  queries on the row body). The bytes editor *is* the bytes view —
  there is no separate bytes table elsewhere.

**Transmit is a no-op when the bus isn't connected.** The
project context exposes `connectedBusIds` (derived from
`interfaceBindings` + `connectedAddresses` + the resolved sidecar
address). When a frame's bus isn't in that set, `send` and
`start` are disabled with an explanatory tooltip, and the cyclic
scheduler (if it's running from a prior connected period) skips
ticks until the session comes back. No frames hit the local
trace as Tx-confirms while disconnected — the trace stays a
faithful record of what actually went on the wire.

Successful sends are visible as Tx-confirm rows in the trace;
failures and any unusual conditions write to the system log via
the existing `sys_info` / `sys_error` paths. There is no inline
last-send status on the tile.

**Expanded face (per frame).** Two regions:

- *Frame-shape strip.* Kind, extended toggle, BRS (FD only),
  DLC (remote only). **`kind` and `brs` are derived from the
  DBC** when the frame's id binds to a message: `kind` from the
  `VFrameFormat` attribute (14/15 → FD) with `size > 8` as
  fallback, and `brs` from `GenMsgCANFDBRS` (defaulting to `true`
  for FD messages with no attribute). The corresponding controls
  are disabled when DBC-bound and labelled accordingly; for
  unbound frames the user picks both directly. Remote / error
  kinds aren't DBC-derivable and remain user-selectable.
- *Signals table.* Only when the frame is bound to a DBC message.
  Spreadsheet-dense rows. Columns: `name` · `value` (editable) ·
  `unit` · `range`. Range is taken from the DBC `SG_ [min|max]`
  fields when set; when the DBC declares `[0|0]` (no constraint),
  the range is derived from `factor·raw_min + offset .. factor·raw_max + offset`.
  Plain signals: numeric input. Enum signals: a combobox that
  filters by label or accepts a raw number typed directly. No bit-
  level columns (`start_bit`, `length`, `endianness`, `signed?`) —
  that's DBC-editor territory.

**Mux (simple).** Active arm only — sub-signals for inactive
`m<N>` arms are not shown. When the mux switch changes, the new
arm's sub-signal bits are zeroed (the new arm starts fresh; the
encoder leaves no leakage from the previous arm).

**Nested / extended mux (`m0M`, `m1M`, …).** Signals table
replaced by a short note explaining that the message uses extended
multiplexing and isn't decoded for editing here. Bytes remain
editable — the frame can still be sent.

**Drop ESI.** The CAN-FD Error State Indicator flag is a niche
fuzz/test affordance and has no real use from a transmit panel.
Removed from the panel entirely; `transmit_frame` still accepts an
`esi` field (defaulted to `false`) so the IPC shape is unchanged.

ADR: [`docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md`](../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)
captures (i) where the encoder lives (`cannet-dbc`), (ii) the
partial-encode semantics, and (iii) the bytes-as-source-of-truth
two-way sync model.

Deferred follow-ups:

- **Nested / extended multiplexing** in the signals table — wants
  a recursive mux-picker UI; out of scope here.
- **CRC + sequence-count fields** stays a **Phase 17** feature.
- **Host-side periodic scheduler** — today's per-tick `setInterval`
  in the panel is rate-limited by the UI tick (see backlog: 1 ms
  cyclic transmit observed at ~20-40 msg/s). Moving the cycle loop
  fully host-side is its own piece of work and isn't bundled here.

Exit criteria:

- `cannet_dbc::Database::encode_frame` round-trips through
  `decode` for every signal in the demo fixture (factor / offset,
  signed / unsigned, BE / LE, multi-byte, floats, simple mux).
- Editing any plain signal's value in the panel produces the
  correct payload bytes; editing an enum signal via its combobox
  produces the correct multi-byte encoding (not just the one byte
  today's panel writes).
- Editing a single byte cell updates the visible signal values
  without clobbering bits outside the edited byte.
- A multiplexed message: changing the mux switch swaps the
  visible sub-signals and zeroes the new arm's sub-signal bits;
  editing a sub-signal's value updates only the bits for the
  currently active mux.
- A frame whose id has no matching DBC message edits as bytes
  only (no signals table).
- A frame whose DBC message uses extended multiplexing edits as
  bytes only (signals-table replaced by an explanatory note).
- A frame whose DBC message has `VFrameFormat` 14/15 (or
  `size > 8`) automatically gets `kind = "fd"`; the kind selector
  in the expanded face is disabled. `GenMsgCANFDBRS = 0` clears
  the BRS checkbox; default `1` (or absent) sets it. Both
  controls become editable again when the frame's id is changed
  to one with no DBC match.
- The `send` and `start` controls are disabled when the frame's
  bus has no live remote session (`projectContext.connectedBusIds`
  doesn't include the bus). A cyclic schedule started during a
  connected period skips ticks while disconnected and resumes on
  reconnect — no Tx-confirm rows land in the trace while
  disconnected.
- Clicking the row body (anywhere not on an interactive control)
  toggles the row's expansion. The bus-tinted drag handle on the
  left edge reorders frames within the list.
- FD frames wrap their byte cells at a multiple of 8 (8 at narrow
  widths, stepping up through 16/24/32/40/48/56/64 as the panel
  widens).
- Backlog item removed: "[feat] cannet-gui transmit panel: top
  level start/stop button in message list view" (now per-frame in
  the collapsed face).
- Rustdoc on `cannet_dbc::Database::encode_frame` and
  `Database::describe_message` covers the partial-encode contract
  and the DBC-derived FD / BRS rules; the ADR is checked in.

### Track 3 — Plot Pinpoints

Two small ergonomics in the plot panel. Track 3 lands after
Track 4 so its hotkeys register on the framework.

What lands:

- **Show-points control** — a tri-state toggle on the plot panel
  toolbar (next to "fit data" / "fit y" / "follow live"):
  `auto` (default) / `off` / `on`. `auto` uses uPlot's
  density-aware mode (`points: { show: "auto" }`); `off` forces
  no points; `on` forces points always. Applies to every series
  in the panel.
- **`f` — fit x to data** — registered as command
  `plot.fitXAxis` in the Track 4 framework, context-required
  `panel.kind === "plot"`. Bound to `f`. Calls the existing
  `fitData` handler.
- **`l` — enable follow-live** — registered as command
  `plot.followLive.enable`, context-required
  `panel.kind === "plot"`. Bound to `l`. Sets `followLive` to
  true (enable-only — the user drops out by panning the x axis).

Exit criteria:

- The plot toolbar surfaces the tri-state control; switching
  to `on` shows points on every series; switching to `off`
  hides them; `auto` defers to uPlot.
- With a plot panel focused, `f` re-runs fit-data and `l`
  enters follow-live. Both no-op when a non-plot panel is
  focused.
- Backlog items removed: "show points in plot"; the `f` / `l`
  bullets under "Minimum Usability Tasks".

### Track 4 — Command / Hotkey Framework

A generalised command + keybinding primitive that future tracks,
phases, and panels register on. Lifted from old Phase 12; what's
left of that phase (specialised commands like `goto.traceRow`,
`goto.timeInTrace`, `set-visible-time-range`) stays in **Phase 13**.

What lands:

- **Command registry.** Each command:
  `{id, label, category?, context?, run()}`. `context` is a
  predicate over a small typed context object
  (`focusedPanelKind`, `hasProjectOpen`, …); a missing `context`
  means always-available. Two commands bound to the same key in
  overlapping contexts is a build-time assertion.
- **Binding map.** `keyChord → commandId`. Single keys (`f`),
  modifiers (`Cmd+Shift+P`), simple chord sequences (`g r`).
  Bindings declared in code only; user customisation is out of
  scope here.
- **Dispatcher.** Key event → resolve binding → check context
  predicate → run, or silently no-op. Frontend-only React
  context; commands wrap existing Tauri commands where they
  need host work, no new IPC.
- **Palette.** `Cmd/Ctrl+Shift+P` opens a modal; types-to-filter
  through the fuzzy matcher (see below); arrow keys + enter;
  Esc closes.
- **Go-to-view.** `Cmd/Ctrl+P` opens a sibling palette listing
  every open dockview panel by its display name; selecting one
  focuses that panel. Same fuzzy matcher.
- **Element display names (prerequisite for go-to-view).**
  Every `ProjectElement` kind carries a model-owned `name:
  string`. Default on creation is `${Kind} ${nextIndex}`
  (matching today's dockview tab behaviour, but model-owned and
  stable across reloads). A shared resolver `elementLabel(el):
  string` is used by every view: dockview title bar, project
  graph node, project panel inventory list, and the
  `Cmd/Ctrl+P` palette. Inline-rename in the project panel
  (already in place for buses) extends to every element kind.
  `PROJECT_SCHEMA_VERSION` bumps additively; v4 elements
  without a `name` get the default on migration.
- **Fuzzy-search library.** Evaluate `fzf-for-js` (port of the
  VS Code / fzf matcher — MIT, camelHump + abbreviation
  matching), `fuse.js` (popular but lower-quality acronym
  matching), and `kbar`'s built-in matcher. Recommendation
  unless evaluation disqualifies it: **`fzf-for-js`**, used by
  both the command palette and Track 5's DBC search. The
  evaluation is a step in this track and updates
  `plans/technology-inventory.md`.
- **Lifted commands** — every existing toolbar action also
  becomes a palette command (same behaviour, second access
  path):
  - `project.open`, `project.save`, `project.saveAs`,
    `project.close`
  - `blf.open`, `dbc.add`
  - `connection.connect`, `connection.disconnect`
  - `panel.add.trace`, `panel.add.plot`, `panel.add.transmit`,
    `panel.add.systemMessages`, `panel.add.projectGraph`
  - `palette.show` (bound `Cmd/Ctrl+Shift+P`),
    `goto.view` (bound `Cmd/Ctrl+P`)

ADRs:

- [`docs/adr/0018-command-keybinding-framework.md`](../docs/adr/0018-command-keybinding-framework.md)
  — frontend-only React-context registry, code-declared bindings
  (no user persistence), typed-context predicates, build-time
  conflict assertion, two palettes sharing one matcher.
- [`docs/adr/0019-project-element-display-names.md`](../docs/adr/0019-project-element-display-names.md)
  — every `ProjectElement` carries a model-owned `name`; views
  resolve through one shared `elementLabel(el)` resolver; the
  project panel is the canonical edit surface.
- **Fuzzy-search library choice** — captured as a
  `technology-inventory.md` entry rather than a standalone ADR
  (the decision is a library pick, not architecture).

Exit criteria:

- The palette opens on `Cmd/Ctrl+Shift+P`, lists all registered
  commands, filters live as the user types, and runs the
  selected command on enter.
- `Cmd/Ctrl+P` opens go-to-view; selecting a panel focuses it.
- Every element kind carries a model-owned `name`; the dockview
  tab, project graph, project panel, and go-to-view show the
  same label; inline-rename works from the project panel.
- The fuzzy library is in `plans/technology-inventory.md` with
  its evaluation rationale; both ADRs are checked in (or the
  fuzzy-lib one is explicitly declined with a one-line note).
- Backlog item removed: "hotkey framework + new hotkeys".

### Track 5 — DBC View, Drag/Drop, Filter-Defined Plot Areas

Make the DBC database first-class as a *discovery* surface and let
the user move signals around the GUI by dragging. The project
panel's existing DBC inventory section stays untouched — that's
the add / remove / per-bus-scope list, an ADR-0012 file-IO+inventory
role. Track 5 is the spatial / search counterpart.

What lands:

- **New `kind: "dbc"` dockview panel.** Tree-with-search: DBC
  file → messages → signals. Default-rendered as a tree; typing in
  the search box filters the tree, expanding ancestors of matches
  and dimming non-matches. The search is the same fuzzy matcher
  Track 4 picks (`fzf-for-js` proposed). Searched fields: signal
  name, signal comment, message name, message id (hex and
  decimal), message comment, value-table labels and raw values,
  units, attribute names and values. Read-only; multiple instances
  allowed; selection / scroll / expand state is panel-local.
- **Multi-select in the DBC panel.** Click selects one; Shift-
  click range-extends within the visible tree; Cmd/Ctrl-click
  toggles individual rows. Selection may mix message rows and
  signal rows — a message contributes its signal set.
- **Drag sources** producing the existing
  `application/x-cannet-plot-signal` mime (an object carrying
  `{signals: SignalRef[]}` — the plot panel's drop handler already
  accepts arrays):
  - DBC panel signal row → array of one.
  - DBC panel message row → array of every signal in that message.
  - DBC panel multi-selection → resolved set of signals, deduped.
  - Trace panel expanded-row signal grid → array of one (folds in
    the backlog item "drag a decoded signal into a plot from
    elsewhere").
  - By-ID panel signal row → array of one (same backlog item).
- **Plot panel drop target unchanged.** It already accepts the
  `signals: SignalRef[]` shape. Dropping a message adds every
  signal as a series, each round-robin-coloured.
- **Drag between plot panels** is verified-working today via the
  same mime and not new code. Track 5 confirms parity.

- **Filter-defined plot areas.** Each plot area gains an optional
  `signalFilter: string` (regex). When set, the area is **filter
  mode** and its `signals` list is *computed* from every signal
  whose `${busName}.${messageName}.${signalName}` matches the
  regex, drawn from the panel's `sources`-scoped DBC set. Manual
  signal management is disabled in filter mode (toggle clears the
  filter and promotes the computed signals to manual). The regex
  is re-evaluated on every DBC add / remove / reload event and on
  app launch (so a project saved with a filter rehydrates its
  series). `${busName}` is the displayed bus name; unbound frames
  render as `(unassigned)`. A bus rename invalidates a regex that
  referenced the old name — surfaced as a System Messages warning.

ADRs:

- **DBC panel as standalone discovery surface** — already covered
  by [ADR 0012](../docs/adr/0012-project-panel-graph-split.md)'s
  surface-role split; no new ADR.
- [`docs/adr/0020-filter-defined-plot-areas.md`](../docs/adr/0020-filter-defined-plot-areas.md)
  — filter-mode vs manual-mode (never both per area); regex target
  is `${busName}.${messageName}.${signalName}`; re-evaluation on
  DBC change, `sources` change, and app launch; bus renames warn
  rather than rewrite.

Exit criteria:

- A DBC panel can be added to the layout from the toolbar; it
  shows every loaded DBC's message → signal tree. Typing in the
  search filters the tree live with fuzzy / acronym matching.
- Multi-select (click / Shift-click / Cmd-Ctrl-click) selects a
  mix of signal and message rows; dragging the selection drops as
  a `signals: SignalRef[]` array onto a plot area.
- Dragging a single message row drops as all of that message's
  signals; dragging from a trace panel's expanded-row signal grid
  and from a by-ID panel's signal row also produce the array
  shape and drop onto a plot area as series.
- A plot area with `signalFilter` set populates from the regex
  against `${busName}.${messageName}.${signalName}`. Loading a
  new DBC adds matching signals; removing a DBC drops them;
  reopening the project rehydrates the series.
- Bus renames that invalidate a filter regex surface a System
  Messages warning naming the panel and the broken regex.
- Backlog items removed: "DBC view with good filter behavior";
  "Drag+drop signals from DBC or trace into graph, and between
  graphs"; the relevant drag-source bullets in the
  graph-and-bus-integration section.
- README documents the DBC panel; rustdoc covers any new public
  Tauri commands (the host needs to enumerate DBC content for the
  panel — likely an extension of `list_signals`); ADR 0020 checked
  in; `plans/technology-inventory.md` records `fzf-for-js`.

## Phase 11 — Windowed-Model Convergence

Converge the GUI's four hand-rolled view caches — chrono trace,
filtered trace, by-ID, plot — onto one windowed-source contract with
two accessors. [`windowed-model-convergence.md`](windowed-model-convergence.md)
is **normative for this phase**: it carries the principle, the Layer-A
contract, the two accessors, and the four slices (Slice 0 already
shipped). Domain terms are defined in [`../docs/CONTEXT.md`](../docs/CONTEXT.md).

This is a **view-side** refactor — it lands against the current in-RAM
`TraceStore` `Vec`. Slice 1 freezes the host accessor signatures
disk-spill-ready so Phase 12 is a second implementation behind them,
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

## Phase 12 — Indefinite-Length Capture (Disk-Spill)

Make a capture indefinite-length — 10^7 to 10^9 frames, multi-hour to
multi-day — by spilling the raw frame store to disk while keeping
every historical row addressable. [`../docs/adr/0001-indefinite-length-capture.md`](../docs/adr/0001-indefinite-length-capture.md)
fixes the requirement (random-access, loss-free);
[`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md) fixes
the on-disk format and I/O architecture and is **normative for this
phase**.

This is the **model-side** counterpart to Phase 11: it provides a
second implementation of the `RowPage` / `DecimatedRange` accessor
signatures Phase 11 Slice 1 froze — no contract change, no view
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
resolution pyramid (DS-5); the disk store is the only production
path, the in-RAM `Vec` retiring to a test double (DS-6); and the
scratch lives in a single `current/` directory under the OS cache
dir and is wiped exactly when the session buffer is — on Clear, or
on Start of a new capture — never on exit or crash, so a prior
session present at launch is loaded as a stopped historical trace
(DS-7).

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
- the `RowPage` / `DecimatedRange` signatures from Phase 11 are
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

## Phase 13 — Command Palette + Goto Framework

The framework itself (registry, bindings, palette,
`Cmd/Ctrl+Shift+P`, `Cmd/Ctrl+P` go-to-view, fuzzy matcher) ships
in **Phase 10 Track 4**. What's left for this phase is the
**specialised commands** that need richer UX than zero-arg
toolbar lifts — commands that prompt for an argument, drive a
view to a target, or compose a multi-step action: `goto.traceRow`
(absolute row index — the "Go to row…" backlog item),
`goto.timeInTrace` (absolute or relative time), `plot.setVisibleRange`,
`capture.save` (with a path picker), `palette.argumentForms` (the
shared input-prompt UI). Part of the phase is the explicit
decision on what belongs in the palette (broad, project-wide,
keyboard-accessible) vs. what stays local-only (right-click menus,
panel toolbars) — the model has to be deliberate about that
boundary.

## Phase 14 — Signals, Drag/Drop & Trace Signal Display

The DBC panel + signal drag/drop across the GUI ship in **Phase 10
Track 5**. What's left for this phase is the **signal view** panel
(a user-chosen set of signals with their latest values — distinct
from the DBC panel, which is a database navigator), the **trace
view's expanded-row decoded signals as inline lines under the
message row** (replacing today's expand-to-show grid — the trace-
side counterpart to "signals are first-class"), and the
**per-series colour picker** on the plot panel (right-click swatch
→ colour dialog).

## Phase 15 — Performance Profiling Baseline

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
Phase 12, not pulled in here — Phase 12 owns the indefinite-length
model.)

## Phase 16 — CANopen

EDS ingestion (CANopen Electronic Data Sheet — library TBD when this
phase becomes current) and SDO / PDO decoding on top of the Phase 5
value-table machinery.

## Phase 17 — Rest-of-Bus Simulation + CRC / Sequence

**Rest-of-bus simulation**: a gridview that holds a configurable set
of ids with live signal values and transmits them on a cadence — the
client side of "simulate the rest of the network", the TX counterpart
of the by-ID panel. **CRC + sequence-count calculation in arbitrary
fields** of a CAN message — transmit-side helper for messages that
carry their own integrity fields (and decode-side verification
where useful).

## Phase 18 — Plot Panel Refinements

The plot-panel feature tail. The "show points" tri-state and the
`f` / `l` hotkeys already shipped in **Phase 10 Track 3**. What's
left for this phase: **Triggers** (edge / level / value-match on a
chosen signal that freeze the view and emit an event marker —
oscilloscope trigger proper; the event-line rendering already
exists, the trigger engine doesn't). **Math channels** (derived
signals computed from other signals — also useful to the transmit
panel and a future scripting surface, so it may outgrow plotting).
**Manual per-series y** (offset / gain / log scale, overriding the
auto-norm that ships today). **CSV / image export** of the visible
window or cursor span. **Drag a whole plot area** (not just a
signal) between plot panels.

## Phase 19 — Cross-Cutting Polish

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

**Third-party runtime tool fetching strategy.** The architectural
decision is recorded in
[ADR 0015](../docs/adr/0015-fetched-runtime-binaries.md): external
runtime binaries are fetched from upstream at a pinned version, not
committed or bundled. Phase 19's deliverable is the **end-user**
fetch flow — pick between:

1. **Installer post-step** — the installer (Tauri's per-OS bundler
   target, or a thin wrapper around it) downloads `uv` at install
   time into the app's install dir.
2. **First-run host downloader** — the GUI fetches `uv` on first
   launch into the user's app-data dir and points the launcher at
   that path; offline first-run shows a clear error with the manual
   `uv` install link.

Both keep the runtime lookup chain in `sidecar.rs` unchanged
(`tools/uv/uv` → `PATH` `uv` → `python3` fallback). The pin
(`UV_VERSION` in [`scripts/fetch-uv.sh`](../scripts/fetch-uv.sh),
already in use on the dev side) is the single source of truth in
either flow.
