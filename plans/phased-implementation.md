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
bus.

Scope:

- Define the wire protocol for CAN frames between client and server (built on
  the abstraction from Phase 1).
- Server can be spawned with any CAN abstraction input. For this iteration the
  only supported input is BLF: the server loads a BLF file at startup and
  streams it on a loop when the client commands replay.
- Client (the GUI from Phase 1) connects to a server by address, subscribes to
  frames, and renders them through the existing trace + decode pipeline.
- Server is addressable on the network. Discovery is **not** in scope yet.

Exit criteria:

- GUI on machine A can connect to a server on machine B, command BLF replay,
  and see decoded traffic with no functional regressions vs. Phase 1.
- The same GUI build works against either an in-process source or a remote
  server.
- README and `plans/phased-implementation.md` reflect the new server crate,
  its run command, and the wire protocol; rustdoc on the protocol crate
  describes the message set.

## Phase 3 — Vector, Kvaser, and PEAK CAN Driver Support

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

## Phase 4 — Performance Profiling Baseline

Make performance measurable before we keep piling features on.

Scope:

- Define a profiling strategy that covers all three tiers — client (GUI),
  server, and the wire between them. Identify the metrics we care about
  (frame throughput, end-to-end latency from server ingest to GUI render,
  per-frame CPU cost on each side, memory growth under sustained replay,
  dropped-frame counts).
- Pick instrumentation: in-process counters/timers, sampling profiler hooks,
  and a reproducible workload (likely a standard BLF replay at a known rate).
- Capture an initial baseline against the Phase 3 build for each supported
  source (BLF replay + at least one hardware vendor) and check it in so future
  changes can be compared against it.

Exit criteria:

- Documented, repeatable profiling procedure.
- Baseline numbers committed for the current build, with enough detail that a
  later contributor can reproduce them and notice regressions.
- README points at the profiling doc and the baseline file.
