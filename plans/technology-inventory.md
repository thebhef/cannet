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

- **Tauri 2** / **React 18 + Vite + TypeScript** — `adopted` in
  Phase 1. Tauri Rust host + system WebView; React/TS/Vite frontend
  inside the WebView. See [`../docs/adr/0003-tauri-shell-react-frontend.md`](../docs/adr/0003-tauri-shell-react-frontend.md).
- **`dockview`** (v6, MIT) — `adopted` in Phase 3 for the
  multi-panel shell. See [`../docs/adr/0005-dockview-panel-layout.md`](../docs/adr/0005-dockview-panel-layout.md).
  Alternatives considered (`flexlayout-react`, `rc-dock`,
  `react-mosaic`, `golden-layout`) all `rejected` — see ADR 0005.
- **`serde_json`** (Rust) / native JSON (frontend) — adopted Phase 3
  for the project file. Already in the dep graph via Tauri IPC; no
  new crate. See [`../docs/adr/0011-project-file-format.md`](../docs/adr/0011-project-file-format.md).
- **`@tanstack/react-virtual`** — `adopted` in Phase 1, `removed` in
  Phase 2. The library's count-based virtualizer doesn't handle the
  browser's CSS dimension cap (≈17M-33M px depending on the engine):
  past ~1.5M rows at 22 px each, scrollTo no longer resolves
  individual rows. Replaced with a hand-rolled scaled-scrollbar
  virtualizer (`apps/gui/src/TraceView.tsx`) that caps the scroll
  container at 16M px and maps scrollTop fractionally to absolute
  row index. ~120 lines, no external dep.
- **`@xyflow/react`** (formerly `react-flow`, MIT) — `adopted` in
  Phase 6 for the project graph view. See [`../docs/adr/0006-xyflow-project-graph.md`](../docs/adr/0006-xyflow-project-graph.md).
  Alternatives considered (`cytoscape.js`, `d3-force` / `d3-zoom`
  + SVG hand-roll, `reaflow` / `reagraph` / `nivo/network`) all
  `rejected` — see ADR 0006.
- **Filter predicates** — structured JSON in the project file (no
  new dep). See [`../docs/adr/0016-filter-predicates-structured-json.md`](../docs/adr/0016-filter-predicates-structured-json.md).
- **Electron** — `proposed (fallback)`. Documented fallback if
  Tauri's per-OS WebView fragmentation blocks us. See ADR 0003.
- **Qt 6** / **Dear ImGui + ImPlot** / **wxWidgets** — `rejected`.
  See ADR 0003.

### CAN / CANFD Abstraction

In-process: a hand-written `cannet-core` crate defines the frame types and
producer/consumer interfaces. No external dependency for the abstraction
itself — kept deliberately small so a network transport can slot in later
without reshaping callers.

- Network transport: **tonic / gRPC over HTTP/2** + **prost** —
  `adopted` (Phase 2). Schema in `crates/cannet-wire`, `tonic-build`
  codegen on both ends. See [`../docs/adr/0004-grpc-wire-protocol.md`](../docs/adr/0004-grpc-wire-protocol.md).
- Network transport (alternatives considered): raw TCP + prost,
  raw TCP + bincode/postcard, ZMQ, WebSockets via
  `tokio-tungstenite` — all `rejected`. See ADR 0004.
- **`async-stream`** crate (v0.3, MIT) — `adopted` in Phase 2.
  Wire-crate implementation helper for stream adapters; see
  ADR 0004 § Consequences.
- **`clap`** crate (v4, MIT/Apache) — `adopted` in Phase 2 for the
  `cannet-server` CLI (positional BLF path, `--bind` address). The
  Rust ecosystem standard for derive-macro CLI parsing; small
  enough not to be controversial.
- **`tracing`** + **`tracing-subscriber`** (Rust, MIT) — adopted
  Phase 7. `tracing` was already a transitive dep via tonic / tokio;
  `tracing-subscriber` is newly direct. Used by the host system log
  bus — see [ADR 0014](../docs/adr/0014-host-system-log.md).

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
  needed. **Fetched at a pinned version, not committed or
  bundled** — see [ADR 0015](../docs/adr/0015-fetched-runtime-binaries.md).
  `uv sync` materialises the sidecar's venv lazily on first launch,
  `uv run` starts the sidecar. Lets users replace the default
  driver library in-place (`uv pip install …`) without rebuilding
  the app. Fallback if Astral disappears is `python -m venv` +
  `pip`, a recoverable swap.
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
  evidence we need. Revisit only if Phase 14 profiling shows a
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

Decisions: [`../docs/adr/0009-dbc-blf-readers.md`](../docs/adr/0009-dbc-blf-readers.md)
— `can-dbc` for DBC parsing (semantics in `cannet-dbc`); for BLF,
our own focused reader/writer in `cannet-blf` (no third-party BLF
crate retained long-term).

- **DBC** — CAN signal database.
  - **`can-dbc`** (v9, MIT/Apache) — adopted Phase 1. See ADR 0009.
- **EDS** — CANopen Electronic Data Sheet. Library TBD; not in scope
  until CANopen work begins.
- **BLF** — Vector binary log format. Implementation lives in
  `cannet-blf`; the per-object-type coverage matrix is maintained
  in [`../docs/blf-feature-support.md`](../docs/blf-feature-support.md).
  - **`blf_asc`** (v0.2, MIT/Apache) — adopted Phase 1, retiring
    once `cannet-blf`'s own implementation reaches parity. See ADR 0009.
  - **`ablf`** — considered as an alternative; rejected. See ADR 0009.
  - **Technica `vector_blf`** (C++, GPL-3.0-or-later) — considered
    as a candidate via FFI; rejected because cannet is a Rust
    project and writing the focused subset we need from Vector's
    public spec is lower-friction than maintaining a Rust↔C++
    binding for a library we'd use ~20% of. See ADR 0009.

### Storage

- **`memmap2`** crate (Rust, MIT / Apache-2.0) — `proposed`
  (Phase 11). Cross-platform memory-mapped file access for the
  disk-spill raw store and its index files — POSIX `mmap` on
  Linux / macOS, `CreateFileMapping` / `MapViewOfFile` on Windows,
  behind one Rust API. Phase 11's store is write-through and reads
  through the kernel page cache (see
  [`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md),
  DS-2); `memmap2` is the syscall abstraction for that — the one
  failure-mode-rich part of the design worth a vetted library, while
  the on-disk format itself (fixed-size append-only records) stays
  hand-rolled and small. It is the maintained successor to the
  unmaintained `memmap` crate and the de-facto Rust standard.
  Windows constraints are handled in-design: a mapping has a fixed
  maximum size and a mapped file cannot be resized, so segments are
  pre-allocated fixed-size and mapped whole (ADR 0002, DS-4). The raw
  `libc` / `windows-sys` FFI alternative is `rejected` — re-creating
  this abstraction is exactly the hand-written failure-mode-rich
  surface `CLAUDE.md` says to avoid.

### Protocols

- CAN 2.0 A/B
- CAN FD
- CANopen (SDO, PDO)

### Plotting / Visualization

- **uPlot** (MIT) — `adopted` in Phase 4 for the plot panel
  renderer. See [`../docs/adr/0007-uplot-plot-renderer.md`](../docs/adr/0007-uplot-plot-renderer.md).
  Alternatives considered (dygraphs, Chart.js + plugins,
  lightweight-charts, Apache ECharts, Plotly.js, Highcharts /
  amCharts, hand-rolled canvas/WebGL) all `rejected` — see
  ADR 0007.

  Reference design: `plans/plot-panel-reference.html` — a
  standalone prototype (5 stacked panes × 4 signals, synced
  x-zoom across panes, per-pane y-zoom, global X cursors +
  per-pane Y cursors with Δt / 1/Δt / Δy readouts, event marker
  lines + user notes, a perf badge strip). The shape the plot
  panel should grow toward; the current single-pane
  `PlotPanel.tsx` is the first step, not the destination.

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
