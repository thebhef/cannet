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
  `apps/gui/src/TraceView.tsx` using `@tanstack/react-virtual`; the
  Tauri host (`apps/gui/src-tauri`) batches frame events at 256 frames
  per `can-frame-batch` IPC message. The OS title bar is hidden in
  favour of a custom `TitleBar.tsx` so the cannet branding lives in
  the window chrome.
- **DBC decoding.** Load a DBC and decode every matching frame's
  signals; expand a frame in the trace view to see them. The DBC is
  process-global, not per-channel — per-channel scoping is deferred
  until the multi-source story (Phase 2/3) makes the choice meaningful.
  Attaching a DBC after a BLF is already open retro-decodes existing
  trace rows in 1000-frame batches via the `decode_frames` IPC command,
  so the visible state always reflects the current database. Float /
  double signals declared via `SIG_VALTYPE_` decode as IEEE 754, not as
  scaled integers (added once the demo fixture exposed the gap).
  Realised as `crates/cannet-dbc` (uses `can-dbc` for parsing; runtime
  decoder lives in the crate root).

Architecture refinements that landed during implementation:

- **Frontend-resident trace store.** Trace data lives in a
  `useRef<CanFrameRecord[]>` inside the React app, with a version
  counter to wake the virtualizer. The Tauri host streams frames but
  doesn't keep a buffer. The trace view is a *view* over the live
  pump, not the source of truth — explicit, persistable trace capture
  lives in `features.md` as a future feature, not Phase 1 scope.
- **DBC in shared backend state.** `AppState::database` is a
  `Mutex<Option<Database>>` shared between the BLF pump thread and the
  IPC commands. `attach_dbc` / `detach_dbc` mutate it; the pump reads
  it per frame; `decode_frames` reads it for the retro-decode path.
  Separating "which DBC are we using right now" from "which BLF are we
  replaying right now" is what lets the user attach/swap a DBC without
  reopening the log.

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
  in-process (Phase 2's BLF replay), as a sidecar (Phase 4 wrappers around
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

Exit criteria:

- GUI on machine A connects to a server on machine B, lists the
  interfaces it exposes, subscribes to one, and sees decoded traffic in
  the trace view with no functional regressions vs. Phase 1.
- The wire protocol carries client-side transmit envelopes; the BLF
  server rejects them with `Error::TX_REJECTED`. Actually delivering tx
  to a writable bus is Phase 3 / Phase 4 work.
- The same GUI build works against either an in-process server or a
  remote server, picked at connect time.
- README documents the new `cannet-server` crate, its CLI, and the
  connect flow; `plans/phased-implementation.md` matches what shipped;
  rustdoc on `cannet-wire` describes the service surface and the
  batching adapters.

## Phase 3 — Transmit, Multiple Windows, and Docking

Round out the GUI surface area before vendor drivers complicate the data
path. Doing this on top of the Phase 2 client/server split means multi-window
state has to flow through the same wire protocol from the start, rather than
being retrofitted later.

Scope:

- **Transmit window.** A panel that composes CAN / CAN FD frames (id, type,
  channel, payload, optional cycle time) and submits them to the active
  source. The CAN abstraction grows a transmit path so the GUI can send
  through either an in-process source or a remote server. When a DBC is
  attached, the transmit window offers signal-by-signal entry for any
  matching message id (factor / offset / endianness applied during encode);
  raw byte entry is always available as the fallback for ids the DBC
  doesn't cover.
- **Multiple trace windows and multiple transmit windows.** The GUI supports
  more than one of each, each independently configurable (filters and column
  set for trace; frame definitions for transmit). The frontend trace store
  becomes per-window rather than a single global ref.
- **Window docking.** Trace and transmit panels can be split, tabbed, and
  docked within the main window; layout is preserved across app restarts.
  Undocking into separate OS windows is **not** required for this phase —
  it's tracked in the backlog for a later GUI pass.

Out of scope (deferred to later phases / backlog):

- Project files that persist multi-window layouts alongside bus configs and
  DBC references — the persistence introduced here is a single layout blob,
  not the full project format from `features.md`.
- Tear-out / multi-OS-window docking.

Exit criteria:

- Two trace windows and one transmit window can be open simultaneously,
  each with its own filter / column / frame state, with no regressions vs.
  Phase 2 throughput.
- Sending a frame from a transmit window reaches the bus through both the
  in-process source and the Phase 2 remote server, in both raw-byte mode
  and (with a DBC attached) signal-by-signal encoded mode.
- Window layout (which panels are open, their dock positions, their
  per-panel config) survives an app restart.
- README documents the transmit workflow and how to manage / reset the
  saved layout; rustdoc covers any new public surface on the CAN
  abstraction (notably the transmit path).

## Phase 4 — Vector, Kvaser, and PEAK CAN Driver Support

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

## Phase 5 — Performance Profiling Baseline

Make performance measurable before we keep piling features on.

Scope:

- Define a profiling strategy that covers all three tiers — client (GUI),
  server, and the wire between them. Identify the metrics we care about
  (frame throughput, end-to-end latency from server ingest to GUI render,
  per-frame CPU cost on each side, memory growth under sustained replay,
  dropped-frame counts).
- Pick instrumentation: in-process counters/timers, sampling profiler hooks,
  and a reproducible workload (likely a standard BLF replay at a known rate).
- Capture an initial baseline against the Phase 4 build for each supported
  source (BLF replay + at least one hardware vendor) and check it in so future
  changes can be compared against it.

Exit criteria:

- Documented, repeatable profiling procedure.
- Baseline numbers committed for the current build, with enough detail that a
  later contributor can reproduce them and notice regressions.
- README points at the profiling doc and the baseline file.
