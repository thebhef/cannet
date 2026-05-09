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

- Network transport: ZMQ — `proposed` (Phase 2). Transport for CAN frames
  between client and server. Not pulled in yet.

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

_Profiling instrumentation TBD — populated in Phase 4._
