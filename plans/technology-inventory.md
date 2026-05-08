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

- **Tauri** — `proposed`. Rust backend + system WebView frontend. Pairs well
  with our Rust-friendly server-tier work (ZMQ, binary protocols), fully
  permissive licensing (MIT + Apache-2.0), small footprint. Frontend stack
  TBD (likely TypeScript + a virtualized grid + a Canvas/WebGL plot lib).
  Risk: WebKitGTK feature/perf parity on Linux — validated in Phase 1
  spike.
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

_TBD — covers the in-process CAN message representation and the network
transport that lets clients exchange frames with a server._

- Candidate: ZMQ (transport for CAN frames between client and server).

### Hardware Drivers

_Populated when Vector / Kvaser / PEAK support lands. May include vendor SDKs
and/or community wrappers (e.g. `python-can`) depending on the client._

### File Formats

- DBC — CAN database, signal definitions and decoding rules.
- EDS — CANopen Electronic Data Sheet, used for SDO/PDO decoding.
- BLF — Vector binary log format, source for replay in early phases.

### Protocols

- CAN 2.0 A/B
- CAN FD
- CANopen (SDO, PDO)

### Plotting / Visualization

_TBD — selected when the plotting feature is implemented._

### Build / Packaging / CI

_TBD — populated as we set up cross-platform builds._

### Testing / Profiling

_TBD — populated alongside the performance profiling baseline phase._
