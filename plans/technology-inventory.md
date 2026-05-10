# Technology Inventory

Running list of third-party libraries, standard protocols, file formats, and
hardware/driver dependencies that the application takes on as it grows. Each
entry should record what it's used for, where it's introduced (which phase),
and the license / platform constraints we need to be aware of.

## Conventions

- Add an entry when a dependency is first proposed, even if not yet committed.
  Mark status as `proposed`, `adopted`, or `rejected`.
- Prefer libraries that are cross-platform (Windows / macOS / Linux) and have
  permissive licenses unless we have a strong reason otherwise.
- For protocols / file formats, link to the spec (or note the version we target)
  so we don't drift between implementations.

## Categories

### GUI / Application Framework

- **Tauri 2** — `adopted` in Phase 1. Rust backend + system WebView frontend.
  Pairs well with our Rust-friendly server-tier work (ZMQ, binary
  protocols), fully permissive licensing (MIT + Apache-2.0), small
  footprint. Risk: WebKitGTK feature/perf parity on Linux — re-evaluate if
  the trace view can't keep up; Electron remains the documented fallback.
- **React 18 + Vite + TypeScript** — `adopted` in Phase 1 as the frontend
  stack inside the Tauri WebView. Mainstream ecosystem, strong virtualized
  grid options. MIT-licensed.
- **`@tanstack/react-virtual`** — `adopted` in Phase 1 for trace-window row
  virtualization. MIT.
- **Electron** — `proposed (fallback)`. Documented fallback if Tauri's
  per-OS WebView fragmentation blocks us. Same JS frontend, swap the host
  shell. Trade-off: ~150 MB bundle, heavier RAM, Node backend instead of
  Rust.
- **Qt 6** — `rejected`. Excellent feature set but LGPL relink discipline
  and the lurking commercial-license question add friction we don't need;
  prior PySide experience surfaced ergonomic pain getting complex layouts
  right.
- **Dear ImGui + ImPlot** — `rejected`. MIT and very fast, but immediate-
  mode aesthetic and reinvention of standard desktop chrome don't match
  user expectations for a CAN analyzer.
- **wxWidgets** — `rejected`. Permissive license and native widgets, but
  dated tooling (wxAUI), weaker plotting story, and smaller community than
  the alternatives.

### CAN / CANFD Abstraction

In-process: a hand-written `cannet-core` crate defines the frame types and
producer/consumer interfaces. No external dependency for the abstraction
itself — kept deliberately small so a network transport can slot in later
without reshaping callers.

- Network transport: **tonic / gRPC over HTTP/2** — `proposed` (Phase 2).
  Apache-2.0. Rust server and Rust client both speak gRPC; the service
  definition lives as `.proto` files in a new `crates/cannet-wire` crate
  with `tonic-build` codegen on both ends. Encoding is protobuf via
  `prost`. Service surface (Phase 2 baseline): `Hello`, `StreamFrames`
  (server-streaming), `StartStream` / `StopStream`, `Subscribe` /
  `Unsubscribe`, `Error`. Phase 3 grows it with transmit RPCs; Phase 4
  with bus-config and bus-state RPCs. Chosen for: schema-evolution
  discipline (protobuf field tags, `reserved`, unknown-field
  preservation), generic RPC plumbing — request/response correlation,
  server-streaming, cancellation, flow control — handled by the runtime
  rather than hand-rolled, and trivial cross-language client support
  (gRPC has runtimes for every mainstream language) which directly
  serves the Phase 4 affordance for Python servers wrapping
  `python-can`. Hot-path overhead vs. raw TCP framing is sub-percent
  for our payload sizes (256-frame batches ≈ 10–15 KB) and gets
  re-validated in Phase 5.
- Network transport (alternatives considered):
  - **Raw TCP with length-prefixed framing + `prost`** — `rejected`
    (Phase 2 evaluation). Lowest possible framing overhead, but the
    "free" performance comes at the cost of hand-rolling the generic
    RPC layer ourselves: request/response correlation, server-streaming
    semantics, cancellation, sink multiplexing, half-close, backpressure.
    Subtle async-networking failure modes are easy to ship broken and
    hard to catch in review. Cross-language clients (e.g. Phase 4
    Python hardware servers) would each need our envelope reimplemented
    rather than picking up an off-the-shelf gRPC runtime.
  - **Raw TCP with length-prefixed framing + `bincode` / `postcard`** —
    `rejected` (Phase 2 evaluation). Same RPC-layer problem as above,
    plus weak schema-evolution semantics: most struct/enum changes are
    wire-breaking unless we hand-roll versioned envelopes. Discipline
    by convention is not the same as discipline enforced by tooling,
    and the schema grows non-trivially through Phases 3–4
    (transmit, cyclic transmit, bus config, bus state, hardware
    metadata).
  - **ZMQ** — `rejected` (Phase 2 evaluation). MPL-2.0 (libzmq) + MIT
    (`zmq` Rust binding). Permissive enough, but the sync C binding
    doesn't compose with the tokio runtime we already use, the
    pure-Rust `zeromq` reimplementation is sparsely maintained, and
    ZMQ's pattern set (PUB/SUB + ROUTER/DEALER) pushes toward a
    two-socket design where one bidirectional stream covers our needs.
    Doesn't solve the schema/encoding problem either — that's still
    ours to pick on top.
  - **WebSockets via `tokio-tungstenite`** — `rejected` (Phase 2
    evaluation). MIT and well-maintained, but the HTTP-upgrade
    handshake and per-frame masking exist to serve browser clients we
    don't have — the GUI client is the Tauri host (Rust). Same
    schema/encoding question as raw TCP and no offsetting benefit.

### Hardware Drivers

_Populated when Vector / Kvaser / PEAK support lands. May include vendor SDKs
and/or community wrappers (e.g. `python-can`) depending on the client._

### File Formats

- **DBC** — CAN database, signal definitions and decoding rules.
  - **`can-dbc`** crate (v9, MIT/Apache) — `adopted` in Phase 1 for parsing
    DBC files into an AST. Decoding signals from raw frames is implemented
    in our own thin runtime on top of the AST (the crate intentionally
    stops at parsing).
- **EDS** — CANopen Electronic Data Sheet, used for SDO/PDO decoding. Library
  TBD; not in scope until CANopen work begins.
- **BLF** — Vector binary log format, source for replay in early phases.
  - **`blf_asc`** crate (v0.2, MIT/Apache) — `adopted` in Phase 1. Pure-Rust
    reader exposing `Iterator<Item = Message>`; supports CAN classic, CAN
    FD, and error frames (object types CAN_MESSAGE, CAN_MESSAGE2,
    CAN_ERROR_EXT, CAN_FD_MESSAGE, CAN_FD_MESSAGE_64).
  - **`ablf`** — `rejected` (Phase 1 evaluation). Cleanly scoped pure-Rust
    BLF reader, but only decodes classic CAN messages — no CAN FD support,
    which our Phase 1 scope requires.

### Protocols

- CAN 2.0 A/B
- CAN FD
- CANopen (SDO, PDO)

### Plotting / Visualization

_TBD — selected when the plotting feature is implemented._

### Build / Packaging / CI

_TBD — populated as we set up cross-platform builds._

### Testing / Profiling

- **`tempfile`** crate — `adopted` in Phase 1 (dev-dependency only). Used by
  `cannet-blf` tests to round-trip BLF fixtures through a real file. MIT /
  Apache-2.0.

_Profiling instrumentation TBD — populated in Phase 5._
