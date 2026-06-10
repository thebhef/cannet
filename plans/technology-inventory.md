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
- **`fzf-for-js`** (MIT) — `proposed` for Phase 10 Track 4 as the
  fuzzy / acronym matcher shared by the command palette
  (`Cmd/Ctrl+Shift+P`), the go-to-view palette (`Cmd/Ctrl+P`), and
  the DBC panel's search (Phase 10 Track 5). Port of VS Code / fzf's
  matcher — camelHump and abbreviation matching ("MyCanMessage"
  reachable from "mcmess"), ranking. Pending evaluation against
  `fuse.js` (popular, lower-quality acronym matching) and `kbar`'s
  built-in matcher; flip to `adopted` once Track 4's evaluation
  step confirms parity with the VS Code matcher we're emulating.
  See [`../docs/adr/0018-command-keybinding-framework.md`](../docs/adr/0018-command-keybinding-framework.md).

### CAN / CANFD Abstraction

In-process: a hand-written `cannet-core` crate defines the frame types and
producer/consumer interfaces. No external dependency for the abstraction
itself — kept deliberately small so a network transport can slot in later
without reshaping callers.

- Network transport: **tonic / gRPC over HTTP/2** + **prost** —
  `adopted` (Phase 2). Schema in `crates/cannet-wire`, `tonic-build`
  codegen on both ends. See [`../docs/adr/0004-grpc-wire-protocol.md`](../docs/adr/0004-grpc-wire-protocol.md).
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

- **`python-can`** (Apache-2.0) — `adopted` in Phase 8. Wrapped
  by the `cannet-python-can` sidecar. See [`../docs/adr/0008-python-can-sidecar.md`](../docs/adr/0008-python-can-sidecar.md).
- **`uv`** (Rust, Apache-2.0 / MIT) — `adopted` in Phase 8.
  Astral's Python package & project manager. Manages the
  sidecar's venv; `uv sync` materialises it lazily on first
  launch, `uv run` starts the sidecar. Fetching strategy: see
  [ADR 0015](../docs/adr/0015-fetched-runtime-binaries.md).
- **`grpcio`** + **`grpcio-tools`** (Python, Apache-2.0) —
  `adopted` in Phase 8 as the sidecar's gRPC runtime. See
  ADR 0008.
- **Vector XL Driver Library** / **Kvaser CANlib** /
  **PEAK PCAN-Basic** — `adopted` as runtime, user-installed
  vendor dependencies; not bundled. See ADR 0008.

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
  - **`blf_asc`** (v0.2, MIT/Apache) — `adopted` Phase 1, `retired`
    Phase 10 (Track 1). The native reader/writer in
    `cannet-blf::format::{reader, writer}` covers everything the
    wrapper used to. See ADR 0009.
  - **`vector_blf`** (Technica-Engineering, C++, GPL-3.0-or-later) —
    `adopted` Phase 10 (Track 1) as a test-only black-box oracle. Cloned at
    a pinned upstream ref into `target/` at test time, never
    vendored, never shipped in cannet's runtime binary; its GPL
    posture stays outside the runtime distribution. Gated behind
    the `vector-blf-oracle` cargo feature so default CI doesn't
    require a C++ toolchain. See ADR 0009 "Test coverage strategy"
    §4.
  - **`flate2`** (v1, MIT / Apache-2.0) — `adopted` Phase 10 (Track 1) for
    `LOG_CONTAINER` zlib inflate/deflate. Default
    backend (`rust_backend` → `miniz_oxide`) keeps the build
    pure-Rust and matches `vector_blf`'s on-the-wire format
    (raw zlib, not gzip). The crate is already in `Cargo.lock`
    transitively, so this is a direct-dep promotion rather than
    a new tree node.

### Storage

- **`memmap2`** crate (Rust, MIT / Apache-2.0) — `proposed` for
  Phase 12. Cross-platform `mmap` syscall abstraction for the
  disk-spill raw store. See [`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md).

### Protocols

- CAN 2.0 A/B
- CAN FD
- CANopen (SDO, PDO)

### Plotting / Visualization

- **uPlot** (MIT) — `adopted` in Phase 4 for the plot panel
  renderer. See [`../docs/adr/0007-uplot-plot-renderer.md`](../docs/adr/0007-uplot-plot-renderer.md).

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
