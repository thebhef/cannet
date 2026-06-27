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
  Also used by `cannet-spill` for the disk-store reopen manifest
  (`current/manifest.json`: valid-length watermarks, bus-intern table,
  by-id directory) so a prior scratch remaps without an O(capture)
  rebuild scan (ADR 0002 DS-4/DS-7) — same crate, no new dependency.
- **`uuid`** (v1, MIT / Apache-2.0) — `adopted` for `Project::project_id`,
  the stable per-project identity that gates disk-spill scratch reload
  across rename/move (ADR 0002 DS-7). `v4` (random) + `serde` features.
  New direct dependency of `cannet-gui`.
- **`@tanstack/react-virtual`** — `adopted` in Phase 1, `removed` in
  Phase 2. The library's count-based virtualizer doesn't handle the
  browser's CSS dimension cap (≈17M-33M px depending on the engine):
  past ~1.5M rows at 22 px each, scrollTo no longer resolves
  individual rows. Replaced with a hand-rolled scaled-scrollbar
  virtualizer (`apps/gui/src/TraceView.tsx`) that caps the scroll
  container at 16M px and maps scrollTop fractionally to absolute
  row index. ~120 lines, no external dep.
- **`tauri-plugin-window-state`** (v2, MIT / Apache-2.0) — `adopted`
  to persist the main window's size / position / maximized / fullscreen
  state across launches (machine-local app state, not project data, so
  it lives in `app_config_dir`, not the project file — see
  [`../docs/adr/0032-machine-local-ui-state-host-side.md`](../docs/adr/0032-machine-local-ui-state-host-side.md)).
  The host owns a small off-screen guard
  (`window_state::ensure_on_screen`) on top of the plugin's restore: the
  window is borderless, so a restored position that lands off every
  connected monitor would leave its title bar unreachable — the guard
  recentres it on the primary monitor.
- **`@xyflow/react`** (formerly `react-flow`, MIT) — `adopted` in
  Phase 6 for the project graph view. See [`../docs/adr/0006-xyflow-project-graph.md`](../docs/adr/0006-xyflow-project-graph.md).
- **`fzf`** (BSD-3-Clause, npm: `fzf`, repo:
  [`ajitid/fzf-for-js`](https://github.com/ajitid/fzf-for-js)) —
  `adopted` in Phase 12 (DBC panel) as the fuzzy / acronym matcher
  used by the DBC panel's search; reused by Task 16's command
  palette (`Cmd/Ctrl+Shift+P`) and go-to-view palette
  (`Cmd/Ctrl+P`). Port of VS Code / fzf's matcher — camelHump and
  abbreviation matching ("MyCanMessage" reachable from "mcmess"),
  ranking, scored result ordering. Synchronous `Fzf` constructor +
  `find(query)` is plenty for the DBC panel's bounded-size
  candidate list; the async variant is available if the command
  palette ever needs it. The package's published name is `fzf` (not
  the `fzf-for-js` from earlier planning notes) — the repo name is
  `fzf-for-js` but it shipped on npm without the suffix. ~70 kB
  unpacked, ships its own TypeScript declarations.
  **Rejected alternatives:** `fuse.js` (popular but Bitap-based —
  no camelHump / acronym matching, lower-quality ranking for
  identifier-shaped haystacks); `kbar`'s built-in matcher
  (only ships as part of `kbar`'s command-palette package and would
  drag `kbar` in for the search-matcher use). See
  [`../docs/adr/0018-command-keybinding-framework.md`](../docs/adr/0018-command-keybinding-framework.md).

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
- **`crc`** crate (+ its `crc-catalog` companion; Rust, MIT /
  Apache-2.0) — `adopted` in Task 14 for calculated CRC fields on
  transmitted messages and decode-side verification
  ([ADR 0027](../docs/adr/0027-calculated-fields-counter-crc.md)).
  Table-driven, `no_std`, the de-facto Rust CRC implementation;
  `crc-catalog` supplies the named-algorithm catalogue
  (`CRC-8/SAE-J1850`, `CRC-8/AUTOSAR`, …) that cannet exposes
  directly, so the "which named configs ship" question costs zero
  curation. Custom Rocksoft parameter sets use the same
  `Algorithm` struct. **Rejected alternative:** a hand-rolled
  table — the crate is small, vetted, and parameterizable; rolling
  our own is review surface with no upside.

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
    Phase 10. The native reader/writer in
    `cannet-blf::format::{reader, writer}` covers everything the
    wrapper used to. See ADR 0009.
  - **`vector_blf`** (Technica-Engineering, C++, GPL-3.0-or-later) —
    `adopted` Phase 10 as a test-only black-box oracle. Cloned at
    a pinned upstream ref into `target/` at test time, never
    vendored, never shipped in cannet's runtime binary; its GPL
    posture stays outside the runtime distribution. Gated behind
    the `vector-blf-oracle` cargo feature so default CI doesn't
    require a C++ toolchain. See ADR 0009 "Test coverage strategy"
    §4.
  - **`flate2`** (v1, MIT / Apache-2.0) — `adopted` Phase 10 for
    `LOG_CONTAINER` zlib inflate/deflate. Default
    backend (`rust_backend` → `miniz_oxide`) keeps the build
    pure-Rust and matches `vector_blf`'s on-the-wire format
    (raw zlib, not gzip). The crate is already in `Cargo.lock`
    transitively, so this is a direct-dep promotion rather than
    a new tree node.

### Storage

- **`memmap2`** crate (Rust, MIT / Apache-2.0) — `adopted`.
  Cross-platform `mmap` syscall abstraction for the disk-spill raw
  store. See [`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md).
  Lives in the dedicated `crates/cannet-spill` crate, which owns the
  raw `RawStore` trait, the in-RAM `MemRawStore` test double, and the
  disk-backed `DiskRawStore`. That crate is the *only* place the
  workspace's `unsafe_code = "forbid"` policy is relaxed (to `deny`,
  with justified per-site `#[allow]`s): mapping a file is inherently
  `unsafe`, and containing it to one focused crate keeps the
  failure-mode-rich surface reviewable and every other crate
  `unsafe`-free.
- **`dirs`** crate (Rust, MIT / Apache-2.0) — `adopted`. Resolves the
  per-OS cache directory the disk-spill scratch lives under
  (`<cache>/cannet/current`, ADR 0002 DS-7). Already in the dependency
  graph transitively via `tauri`; the GUI host makes it a direct
  dependency. Picking the per-OS cache location (XDG on Linux,
  `Library/Caches` on macOS, `LocalAppData` on Windows) is a
  failure-mode-rich job better delegated to a vetted crate than
  hand-rolled from environment variables.
- **`notify`** crate (Rust, CC0-1.0 / Apache-2.0) — `adopted` in
  Phase 12 follow-up for the GUI host's DBC file watcher
  (`apps/gui/src-tauri/src/dbc_watcher.rs`). Wraps the OS-native
  watchers (FSEvents on macOS, inotify on Linux,
  ReadDirectoryChangesW on Windows) behind one interface; we use
  it to auto-reload a loaded DBC when its file changes on disk
  and emit a `dbc-changed` event the DBC panel + plot panel
  listen for. We watch parent directories with a refcount + filter
  events by exact path because watching a single file directly
  loses the watch on atomic-rename saves on several editors.

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

- **GitHub Actions** — `adopted` for CI and releases. `ci.yml` runs the
  test + lint suite on pull requests and pushes to main (Linux);
  `release.yml` is dispatched manually and builds bundles on
  `macos-latest` (Apple Silicon) and `windows-latest` (x64). Tauri
  cannot cross-compile, so each target builds on its native runner.
- **Pinned toolchains** — `adopted` so local and CI run identical
  versions (the workspace opts into `clippy::pedantic`, so a floating
  stable would keep breaking the `-D warnings` gate as new lints land).
  Rust is pinned in [`../rust-toolchain.toml`](../rust-toolchain.toml)
  (rustup auto-installs it); pnpm via the `packageManager` field in
  `apps/gui/package.json` (Corepack / `pnpm/action-setup` honour it).
  Bump either deliberately, fixing any new lints in the same change.
- **`tauri-apps/tauri-action`** (`v0`) — `adopted` to drive
  `tauri build` and upload the resulting bundles to a GitHub Release in
  the release workflow. MIT.
- **`vergen`** (v8, `git` + `gitcl` features; build-dependency in
  `cannet-gui`) — `adopted` to stamp the binary with
  `git describe --tags` at build time so a packaged build reports the
  exact tag/commit it was cut from. The committed version stays `0.0.0`;
  the installer/bundle version is injected from the release tag in CI.
  `gitcl` shells out to the `git` already required to build. MIT /
  Apache-2.0.
- **Code signing / notarization** — `proposed` (deferred). First alpha
  bundles ship **unsigned**; macOS Gatekeeper / Windows SmartScreen warn
  on first run. Signing needs external accounts (Apple Developer Program;
  a Windows OV/EV cert or Azure Trusted Signing) and is wired through
  `tauri-action`'s signing env vars once those exist.

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

- **ruff** + **mypy** (dev-dependencies in `servers/cannet-python-can`,
  pinned via its `uv.lock`) — `adopted` for the Python sidecar. ruff
  does both linting and black-compatible formatting in one tool;
  mypy type-checks the `cannet_python_can` package (the generated
  `_proto/` gRPC stubs are excluded — machine-emitted, not
  hand-maintained — and the dynamically-populated protobuf module is
  treated as untyped). pytest already covered the test suite. All four
  run in the CI `python` job. ruff is from Astral, like the `uv` already
  in use. MIT / (mypy) MIT.

- **`memory-stats`** crate — `proposed` then **`rejected`** (replaced by
  `sysinfo`, below) for the crash health recorder. It reads only the
  *current* process's RSS; the WebView runs in *separate* processes
  (WebView2 on Windows, WebKitGTK on Linux), which are the larger memory
  consumers and the ones a crash needs accounted for. Capturing those
  requires enumerating the process tree, which `memory-stats` can't do.
- **`sysinfo`** crate (v0.33, runtime dependency in `apps/gui/src-tauri`,
  `system` feature only) — `adopted` for the on-disk crash health
  recorder (`crash.rs`). Once a second it sums RSS over the host process
  and every descendant, so the WebView's processes are folded into the
  `tree_mb` figure on Windows / Linux; the rolling crash log then records
  memory growth up to an instant, uncatchable death (OOM `abort`, stack
  overflow, native crash). The workspace forbids `unsafe`, so a crate is
  required to wrap the per-OS process APIs. **macOS limitation:** the
  WebKit helpers are launchd-owned XPC services, not our descendants, so
  `tree_mb` counts the host only there — attributing them needs the
  private "responsible process" API + `unsafe`, deliberately not pulled
  in for a diagnostic. MIT.

- **`chrono`** crate (v0.4, runtime dependency in `apps/gui/src-tauri`,
  `default-features = false`, `std` only) — `adopted` to render
  ISO-8601 / RFC-3339 UTC timestamps in the on-disk crash log
  (`crash.rs`). Already present transitively, so this only makes the
  dependency direct; the `clock` feature is intentionally off (we format
  an epoch-ms value, never read the wall clock through chrono). MIT /
  Apache-2.0.

*Profiling instrumentation TBD — populated in Phase 7.*
