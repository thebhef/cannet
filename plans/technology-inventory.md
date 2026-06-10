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
- **`serde_json`** (Rust) / native JSON (frontend) — `adopted` (Phase 3)
  for the project file (`features.md`: window layouts + bus configs + DBC
  references, JSON, reloadable from disk). `serde` / `serde_json` were
  already in the dependency graph via Tauri's IPC; the project format adds
  no new crate, just schema types in the GUI host (`src-tauri/src/project.rs`:
  the `Project` struct, `open_project` / `save_project`) and matching TS
  types. The schema is our own, versioned (`PROJECT_SCHEMA_VERSION`) — no
  external project-file format is adopted. The `dockview` layout blob is
  stored verbatim as a `serde_json::Value` (the host doesn't interpret it).
- **`@tanstack/react-virtual`** — `adopted` in Phase 1, `removed` in
  Phase 2. The library's count-based virtualizer doesn't handle the
  browser's CSS dimension cap (≈17M-33M px depending on the engine):
  past ~1.5M rows at 22 px each, scrollTo no longer resolves
  individual rows. Replaced with a hand-rolled scaled-scrollbar
  virtualizer (`apps/gui/src/TraceView.tsx`) that caps the scroll
  container at 16M px and maps scrollTop fractionally to absolute
  row index. ~120 lines, no external dep.
- **`@xyflow/react`** (formerly `react-flow`, MIT) — `adopted` in
  Phase 6 for the project graph view (`apps/gui/src/ProjectGraphPanel.tsx`).
  Node / edge model with drag-to-create-edge, custom node renderers,
  controllable state, and a serialisable layout — fits the "lean on a
  vetted library for failure-mode-rich UI" call from `CLAUDE.md` (graph
  interaction is the kind of work that compounds badly when
  hand-rolled). The logical model lives in the project schema
  (`buses`, `interface_bindings`, `elements` with `filter` /
  `trace` / `plot` / `transmit` kinds); the view only stores viewport
  + per-node positions in the panel's dockview `params`, so the
  library boundary stays thin (swap-out cost is one file). Cost note:
  ≈100 KB JS gzipped + a small CSS bundle; fine for a desktop app.
  Alternatives considered (all permissive):
  - **`cytoscape.js`** + React wrapper — `rejected`. Graph-algorithms-
    first; weak React integration story (glue rather than first-class).
  - **`d3-force`** / `d3-zoom` + SVG hand-roll — `rejected`. Viable
    for very small graphs, but rebuilds what `@xyflow/react` already
    gives us once the project gains multiple buses / DBCs / filters /
    consumers.
  - **`reaflow`, `reagraph`, `nivo/network`** — `rejected`. Smaller
    bus factor and missing the editing affordances (drag-to-create-
    edge, custom node UIs) we need.
- **Filter predicate expression DSL** — `rejected` (Phase 6
  evaluation). Filter predicates stay structured JSON, edited by the
  graph view's filter-node UI; `serde_json::Value` already round-trips
  in the project file (no new dep). A small text DSL parsed by
  `nom`/`chumsky`/`pest` would be friendlier for power users but adds
  a parser dep plus an autocomplete / error-reporting problem. Revisit
  if the structured editor turns out to be clunky in practice.
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
- **`tracing`** + **`tracing-subscriber`** (Rust, MIT) — `adopted`
  (Phase 7). The de-facto Rust structured-logging crates. `tracing`
  was already in the dependency graph transitively (tonic, tokio);
  `tracing-subscriber` is newly direct. Phase 7 uses them directly in
  `cannet-gui`: the `system_log` module exposes `info!` / `warn!` /
  `error!` macros that fan out events into both a bounded in-process
  ring (consumed by the System Messages panel via Tauri IPC) and
  `tracing-subscriber`'s `fmt` layer (so dev stderr logs still work).
  A per-`(source, template)` rate limiter inside the ring layer
  caps floods at a few entries per second per source.

### Hardware Drivers

- **`python-can`** (Apache-2.0; depends on LGPL-3.0 vendor wrappers
  internally for some backends) — `adopted` (Phase 8). Used inside
  the auto-launched `cannet-python-can` sidecar process to enumerate
  and drive Vector, Kvaser, and PEAK channels through one library.
  The single sidecar is the canonical Phase-8 shape; the wire protocol
  is the universal driver contract, so adding a second sidecar later
  (Rust-native, different driver, etc.) needs no protocol change.
  LGPL diligence: the sidecar is its own process with its own
  user-replaceable venv (see `uv` below) and a small internal driver
  interface, so a user can swap `python-can` out without touching
  `cannet-*` code. `servers/LICENSING.md` records the analysis.
- **`uv`** (Rust, Apache-2.0 / MIT) — `adopted` (Phase 8). Astral's
  Python package & project manager, distributed as a single
  self-contained binary; manages venvs, installs Python itself if
  needed. Bundled with the GUI per supported OS; `uv sync`
  materialises the sidecar's venv lazily on first launch, `uv run`
  starts the sidecar. Lets users replace the default driver library
  in-place (`uv pip install …`) without rebuilding the app. Fallback
  if Astral disappears is `python -m venv` + `pip`, a recoverable
  swap.
- **`grpcio`** + **`grpcio-tools`** (Python, Apache-2.0) — `adopted`
  (Phase 8). Python implementation of gRPC; generates stubs from
  `cannet-wire`'s existing `.proto` so the sidecar speaks the same
  protocol as `cannet-server` and `cannet-client`. Mainstream, no
  realistic alternative if we want gRPC clients in Python.
- **Vector XL Driver Library** — `adopted` (Phase 8) as a
  *runtime, user-installed* dependency. Vector's proprietary,
  freely redistributable for use with Vector hardware. Windows is the
  first-class target; Linux is partial. Not bundled with the GUI;
  installed by the user per Vector's own instructions. Wrapped via
  `python-can`'s `vector` backend.
- **Kvaser CANlib** — `adopted` (Phase 8) as a *runtime, user-
  installed* dependency. Kvaser's proprietary, freely redistributable.
  Cross-platform (Windows, Linux; macOS partial). Wrapped via
  `python-can`'s `kvaser` backend.
- **PEAK PCAN-Basic** — `adopted` (Phase 8) as a *runtime, user-
  installed* dependency. PEAK's proprietary, freely redistributable.
  Cross-platform. Wrapped via `python-can`'s `pcan` backend. (PEAK on
  Linux can alternatively go through the in-kernel `peak_usb` driver
  via socketcan; that's a future option, see the socketcan backlog
  entry.)
- **Native Rust FFI per vendor** (e.g. `vector-xl-sys`,
  `kvaser-canlib-sys`, `pcan-basic-sys`) — `rejected for Phase 8`.
  Writing three FFI shims plus their packaging is ≈3× the work of
  wrapping one `python-can` library, for a performance win we have no
  evidence we need. Revisit only if Phase 10 profiling shows a
  specific sidecar is the bottleneck for a specific workload; the
  wire protocol lets us swap one vendor over to a native adapter
  without touching the rest.
- **socketcan-only Linux path** — `rejected for Phase 8`. Not
  cross-platform; covers neither Windows nor macOS. PEAK's Linux
  kernel driver path is a future option, tracked in
  `plans/backlog.md`.
- **Multiple vendor sidecars in Phase 8** — `rejected for Phase 8`,
  deliberately preserved as a future possibility on the same wire.
  One `python-can` process covers all three vendors today; we can
  fan out later if needed.

### File Formats

- **DBC** — CAN database, signal definitions and decoding rules.
  - **`can-dbc`** crate (v9, MIT/Apache) — `adopted` in Phase 1 for parsing
    DBC files into an AST. Decoding signals from raw frames is implemented
    in our own thin runtime on top of the AST (the crate intentionally
    stops at parsing). The runtime also resolves the long-name extension
    (`BA_ "System{Message,Signal}LongSymbol" …`) from the AST's
    attribute-value lists, so names truncated to the classic 32-char
    limit on the `BO_` / `SG_` lines come back full.
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
  - **`blf_asc` writer (frames only)** — `adopted` (Phase 9). The
    Phase-9 capture writer uses `blf_asc::BlfWriter` directly for
    classic CAN, CAN FD, error, and remote-frame append; `cannet-blf`
    wraps it as `BlfCaptureWriter` with atomic temp-file + rename.
  - **`blf_asc` `GLOBAL_MARKER` write + read** — `deferred upstream
    contribution` (Phase 9). Upstream `blf_asc` 0.2 exposes no
    marker type and no public hook on `BlfWriter` for adding
    arbitrary object types, so Phase 9 ships note round-trip via a
    sidecar `<file>.blf.notes.json` written alongside the BLF
    instead of native `GLOBAL_MARKER` records. The third-party-
    reader visibility of notes is the deferred piece; a follow-up
    contributes `GLOBAL_MARKER` write + read upstream (the crate is
    1.6 kloc, MIT / Apache) and the host swaps the sidecar layer
    for native markers without changing the session-buffer notes
    API. Tracked in `plans/backlog.md`.

### Protocols

- CAN 2.0 A/B
- CAN FD
- CANopen (SDO, PDO)

### Plotting / Visualization

- **uPlot** — `adopted` (Phase 4; decision confirmed). MIT, ~50 KB, zero
  dependencies, canvas-based, purpose-built for our case rather than
  adapted to it: many series on a shared x-axis, built-in drag-zoom and a
  readout cursor/legend, fast incremental redraw, and a tiny imperative
  API (`new uPlot(opts, data, el)` + `setData` / `setScale` / `setSize`,
  plus a `plugins` hook for custom canvas overlays) that drops into a
  React panel with no wrapper library. The data feeding it comes from the
  host-side signal sampler (`apps/gui/src-tauri/src/signal_sampler.rs`)
  merged onto a shared timeline by `apps/gui/src/plotData.ts` — uPlot
  only renders. Used by `apps/gui/src/PlotPanel.tsx`.

  Criteria weighting for this pick (confirmed with the maintainer):
  **cost** first — must be permissively licensed forever, with a low
  build-it-ourselves cost (the library has to actually save the work);
  then **performance**, **feature set**, **architectural fit**;
  maintenance / openness / popularity secondary, since the blast radius
  is one panel behind a thin adapter. uPlot's one real weakness is bus
  factor (essentially a single very-active maintainer); mitigated by the
  permissive license and the small, isolated adapter — fork-and-freeze is
  cheap if it ever goes dark.

  Scale note: the trace store can hold **hundreds of thousands to
  millions** of frames, so a signal series can be far larger than uPlot's
  comfortable redraw size. The renderer is not where that's solved — the
  host (`signal_sampler::decimate_min_max`, driven by the `sample_signals`
  command's `max_points` hint) min/max-decimates the decoded series down
  to ≈the pixel width of the visible window before it reaches uPlot;
  spikes survive (per-bucket extrema). The live plot also samples
  incrementally — only the frames appended since the previous tick are
  decoded, appended to a bounded per-signal cache (re-decimated full
  re-fetch on overflow) — so a long capture isn't re-decoded every tick.

  Reference design: `plans/plot-panel-reference.html` — a standalone
  prototype (5 stacked panes × 4 signals, synced x-zoom across panes,
  per-pane y-zoom, global X cursors + per-pane Y cursors with Δt / 1/Δt /
  Δy readouts, event marker lines + user notes, a perf badge strip). It's
  the shape Phase 4's plot panel should grow toward; the current
  single-pane `PlotPanel.tsx` is the first step, not the destination.

  Seriously considered and rejected:
  - **dygraphs** — `rejected`. MIT, canvas, mature, with a good
    live-append story; the credible fallback. But it owns more of the
    container / interaction model than uPlot, its bundle is several times
    larger for features we don't need (range selector, annotations, CSV
    ingest), and its release cadence is much slower.
  - **Chart.js + chartjs-plugin-streaming + zoom** — `rejected`. MIT and
    familiar, but a general charting library, not a time-series engine;
    poor per-update cost and GC pressure at our point counts, and three
    packages plus a plugin lifecycle to keep working.
  - **lightweight-charts** — `rejected`. Apache-2.0 and very fast, but
    finance-chart-shaped (candles, a single price/time pane, a fixed
    interaction grammar); mapping arbitrary CAN signals with their own
    units and y-scales onto it fights the API.
  - **Apache ECharts** — `rejected`. Apache-2.0 and does everything
    (including streaming via `appendData`), but a large dependency with a
    config-object programming model — disproportionate bundle and
    complexity for one panel in a WebView.
  - **Plotly.js** — `rejected`. The library is MIT (the SaaS is separate
    and paid) and has a WebGL `scattergl` mode, but it's ~1 MB+ and
    D3-based — far heavier than the job needs.
  - **Highcharts / amCharts** — `rejected on cost`. Free for
    non-commercial use only; commercial use requires a paid license. Out
    per the "permissively licensed, no fees ever" constraint.
  - **Hand-rolled canvas / WebGL renderer** — `rejected`. A *good* one
    (incremental redraw on append, min/max decimation, cursor
    hit-testing, correct pan/zoom scale maths, DPR handling, axis tick
    generation) is most of what uPlot already is, tested against a large
    user base hitting the same edge cases — weeks of build plus ongoing
    maintenance to re-create an MIT library. Revisit only if a Phase 7
    profiling baseline shows uPlot's canvas path is a real bottleneck,
    and then as a WebGL *renderer* (regl-plot-style) under the same data
    pipeline, not a from-scratch chart.

### Build / Packaging / CI

_TBD — populated as we set up cross-platform builds._

### Testing / Profiling

- **`tempfile`** crate — `adopted` in Phase 1 (dev-dependency only). Used by
  `cannet-blf` tests to round-trip BLF fixtures through a real file. MIT /
  Apache-2.0.
- **Vitest** (v2, dev-dependency in `apps/gui`) — `adopted` in Phase 2 for
  frontend unit tests. Most suites are the pure logic modules
  (`traceViewport.ts`, `traceColumns.ts`, `trace.ts`, `plotData.ts`,
  `plotCursors.ts`) running without a DOM. Pinned to v2 because v3+
  requires Vite 6+ while the app is on Vite 5. MIT. Run via
  `pnpm --dir apps/gui test`.
- **`@testing-library/react` + `@testing-library/jest-dom` + `jsdom`**
  (dev-dependencies in `apps/gui`) — `adopted` in Phase 4 for the
  occasional React component test where the state machine is worth
  exercising directly (`PlotPanel.dom.test.tsx`: plot-area add/remove,
  picking/moving signals, toggling measurements). uPlot and the Tauri
  `invoke` bridge are `vi.mock`-ed, so these don't need a real canvas or
  backend; the file opts into the `jsdom` environment via a
  `// @vitest-environment jsdom` docblock. MIT. Kept lightweight — the
  pixel-level overlay drawing and canvas event wiring stay untested at
  this layer; their maths live in tested pure modules.

_Profiling instrumentation TBD — populated in Phase 7._
