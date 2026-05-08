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

_TBD — selected during Alpha0._

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
