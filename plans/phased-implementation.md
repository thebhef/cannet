# Phased Implementation Plan

Phases are ordered. Each phase should land as a working, demoable slice before
the next one starts. Concrete library / framework choices live in
`technology-inventory.md`; this document describes scope and exit criteria.

## Phase 1 — Alpha0 GUI

First end-to-end vertical slice: open the app, point it at a BLF log, and watch
decoded traffic scroll in a trace window.

Scope:

- **CAN abstraction.** In-process representation of CAN and CAN FD frames plus
  the producer/consumer interfaces that everything downstream (trace, decode,
  plotting) will read from. Designed so a network transport can slot in later
  without reshaping callers.
- **BLF log reader.** Parses Vector `.blf` files and streams frames through the
  CAN abstraction. No replay-rate control required yet beyond "stream as fast
  as the consumer drains."
- **Basic trace window.** Scrollable list of frames with timestamp, channel,
  ID, DLC, and data bytes. Pause / resume; auto-scroll toggle. Performance
  target: keep up with a typical BLF replay without dropping frames or stalling
  the UI thread.
- **DBC decoding.** Load a DBC, attach it to a channel, and render decoded
  signal values in the trace view (expand a frame to see signals).

Exit criteria:

- Launch the GUI, open a BLF + DBC pair from disk, see decoded traffic live in
  a trace window.
- CAN abstraction has a documented interface; BLF reader and trace view both
  go through it.

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
