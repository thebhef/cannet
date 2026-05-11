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
- **`dockview`** (v6, MIT) — `adopted` in Phase 3 for the multi-panel
  shell: arbitrary split / tab / drag / resize layouts of trace and
  project panels (and the plot / transmit panels that arrive in
  Phases 4–5) inside the single app window. A dock manager is exactly
  the "lean on a vetted library for the failure-mode-rich parts" call
  from `CLAUDE.md` — hand-rolling
  drag-and-drop docking is a lot of fiddly UI state to get right.
  Chosen for: TypeScript-native with a first-class React package
  (`dockview`), a serialisable layout model (`api.toJSON()` /
  `fromJSON()`) that drops straight into the project file, no jQuery /
  legacy baggage, and good docs. Panel content stays plain React
  components behind a thin adapter (`TracePanel.tsx`, the `TraceData`
  context) so the blast radius of swapping it later is small. Risk:
  small bus factor (≈one primary maintainer) — mitigated by that
  adapter boundary. Cost note: ships one ≈100 KB CSS bundle covering
  all built-in themes (≈9 KB gzipped); fine for a desktop app.
  Alternatives considered (all permissive, all cover the must-haves):
  - **`flexlayout-react`** (Apache-2.0) — `rejected`. Strong runner-up;
    mature, persistent JSON model, built-in popout windows. Edged out
    by dockview's cleaner TS/React story; the popout feature is
    deferred Phase-3 scope anyway.
  - **`rc-dock`** (MIT) — `rejected`. Works, but an older-feeling API
    next to dockview with no offsetting advantage.
  - **`react-mosaic`** (Apache-2.0) — `rejected`. Tiling only — no
    tabs — which doesn't fit a panel-heavy analyzer UI.
  - **`golden-layout`** v2 (MIT) — `rejected`. Capable and mature, but
    framework-agnostic with no React bindings, so adopting it means
    writing and maintaining the React glue ourselves.
- **`serde_json`** (Rust) / native JSON (frontend) — `proposed` (Phase 3)
  for the project file (`features.md`: window layouts + bus configs + DBC
  references, JSON, reloadable from disk). `serde` / `serde_json` are
  already in the dependency graph via Tauri's IPC; the project format adds
  no new crate, just new schema types in the GUI host (and matching TS
  types). No external project-file format is adopted — it's our own
  versioned JSON schema.
- **`@tanstack/react-virtual`** — `adopted` in Phase 1, `removed` in
  Phase 2. The library's count-based virtualizer doesn't handle the
  browser's CSS dimension cap (≈17M-33M px depending on the engine):
  past ~1.5M rows at 22 px each, scrollTo no longer resolves
  individual rows. Replaced with a hand-rolled scaled-scrollbar
  virtualizer (`apps/gui/src/TraceView.tsx`) that caps the scroll
  container at 16M px and maps scrollTop fractionally to absolute
  row index. ~120 lines, no external dep.
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
  `prost`. Service surface (Phase 2 baseline): two RPCs.
  `ListInterfaces` is unary, on-demand discovery of the CAN interfaces
  a server exposes. `Session` is a single bidirectional stream of
  `Envelope` messages — `Subscribe` / `Unsubscribe` / `FrameBatch` /
  `Error` — with frames travelling symmetrically in either direction
  using the same wire shape. `FrameBatch` is the only frame-carrying
  variant; the wire crate exposes batching adapters so application
  code consumes `Stream<CanFrame>` and never sees the batch. Cyclic /
  scheduled emission is **not** part of the wire — sending on a
  cadence is a feature of the client transmit UI. Phase 6 grows the
  surface with bus-config and bus-state RPCs. Optional TLS via the
  `tls` feature (rustls) for non-loopback connections; plaintext
  loopback is the dev default.
  Chosen for: schema-evolution discipline (protobuf field tags,
  `reserved`, unknown-field preservation), generic RPC plumbing —
  request/response correlation, stream lifecycle, cancellation, flow
  control — handled by the runtime rather than hand-rolled, trivial
  cross-language client support (gRPC has runtimes for every
  mainstream language) which directly serves the Phase 6 affordance
  for Python servers wrapping `python-can`, and a service shape that
  doubles as the universal driver contract — in-process drivers,
  sidecar processes, and remote test rigs all implement the same
  `.proto`. Hot-path overhead vs. raw TCP framing is sub-percent for
  our payload sizes (256-frame batches ≈ 10–15 KB) and gets
  re-validated in Phase 7.
- Network transport (alternatives considered):
  - **Raw TCP with length-prefixed framing + `prost`** — `rejected`
    (Phase 2 evaluation). Lowest possible framing overhead, but the
    "free" performance comes at the cost of hand-rolling the generic
    RPC layer ourselves: request/response correlation, server-streaming
    semantics, cancellation, sink multiplexing, half-close, backpressure.
    Subtle async-networking failure modes are easy to ship broken and
    hard to catch in review. Cross-language clients (e.g. Phase 6
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
- **`async-stream`** crate (v0.3, MIT) — `adopted` in Phase 2.
  Provides the `stream! {}` macro that lets the wire crate's
  `unbatch_frames` adapter and the server's looping replay
  source be expressed as ordinary async control flow (loop / await /
  yield) rather than as hand-rolled `Stream` impls with manual
  `Pin` plumbing. Used in `cannet-wire` and `cannet-server`.
- **`clap`** crate (v4, MIT/Apache) — `adopted` in Phase 2 for the
  `cannet-server` CLI (positional BLF path, `--bind` address). The
  Rust ecosystem standard for derive-macro CLI parsing; small
  enough not to be controversial.

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

- **Streaming time-series plot library** — `proposed` (Phase 4). The
  Phase 4 plot panel (vSignalyzer / TSMaster-style signal-over-time view)
  needs a charting library that can hold tens of thousands of points per
  trace, append to them live without re-laying-out the world, draw
  several independent plots at once, and ship under a permissive license.
  Candidate shortlist to evaluate when Phase 4 starts: `uPlot` (MIT, tiny,
  canvas, built for exactly this — large fast-updating time-series),
  `dygraphs` (MIT, canvas, mature, good live-append story), `Chart.js`
  with the streaming/zoom plugins (MIT, but DOM/canvas perf at our point
  counts needs checking), `lightweight-charts` (Apache-2.0, very fast,
  but finance-chart-shaped — adapting it to arbitrary signals may fight
  the API), and WebGL options (`regl-plot`-style) if canvas can't keep
  up. Whichever wins, the data feeding it comes from the trace store's
  signal sampler, not the library — the library only renders. Final pick
  + rejected alternatives get written up here when the phase lands.

### Build / Packaging / CI

_TBD — populated as we set up cross-platform builds._

### Testing / Profiling

- **`tempfile`** crate — `adopted` in Phase 1 (dev-dependency only). Used by
  `cannet-blf` tests to round-trip BLF fixtures through a real file. MIT /
  Apache-2.0.
- **Vitest** (v2, dev-dependency in `apps/gui`) — `adopted` in Phase 2 for
  frontend unit tests. Runs `apps/gui/src/traceViewport.ts` (the trace
  view's pure scroll/stacking arithmetic) without a DOM. Pinned to v2
  because v3+ requires Vite 6+ while the app is on Vite 5. MIT. Run via
  `pnpm --dir apps/gui test`.

_Profiling instrumentation TBD — populated in Phase 7._
