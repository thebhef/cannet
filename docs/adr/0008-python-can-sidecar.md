# ADR 0008 — Hardware drivers via a separate sidecar process wrapping `python-can`

Status: accepted (2026-05-24)

## Decision

Hardware CAN drivers — Vector, Kvaser, PEAK — are reached through
a **separate sidecar process**, `cannet-python-can`, which wraps
**`python-can`** (LGPL-3.0-only) for all three vendor families. The
GUI host auto-launches the sidecar.

The sidecar speaks the **gRPC wire protocol**
([ADR 0004](0004-grpc-wire-protocol.md)) as the universal driver
contract. Adding a second sidecar later — a Rust-native driver, a
different vendor, a remote test rig — needs no protocol change;
each speaks the same `.proto`.

**Vendor driver libraries are runtime, user-installed.** Vector,
Kvaser, and PEAK each provide their own driver library (Vector XL
Driver Library, Kvaser CANlib, PEAK PCAN-Basic). cannet does not
bundle them; the user obtains them from the vendor through
whatever channel the vendor offers, and the sidecar picks them up
at runtime through `python-can`'s vendor backends. Whatever
`python-can` supports, cannet supports.

## Why a sidecar, not in-process

**One wrapper library covers three vendors.** `python-can` exposes
one backend interface that wraps Vector, Kvaser, and PEAK uniformly.
Going in-process would mean three Rust↔C FFI shims (one per vendor
library) and the packaging surface that comes with each.

**Process isolation keeps the sidecar replaceable.** The sidecar
runs its own user-replaceable venv (managed by `uv` per
[ADR 0015](0015-fetched-runtime-binaries.md)) and presents a small
internal driver interface. A user who wants to swap `python-can`
out — for a different Python driver library, a different version,
or a patched local copy — can do it without touching `cannet-*`
code. This applies in both directions: `python-can`'s vendor
backends pull in LGPL-3.0 wrappers internally for some backends,
and process isolation plus the replaceable venv keep that
swappability intact.

**Cross-language is a non-issue because the wire is the contract.**
A Python sidecar today and a Rust-native sidecar tomorrow both
implement the same `.proto`; the host treats them identically.

## Why vendor driver libraries are runtime, not bundled

**The user already needs the vendor library to use their
hardware.** Bundling would either duplicate what's already on
their system or push them toward a cannet-bundled copy that
diverges from the vendor-supported one.

**cannet's support surface is whatever `python-can` supports.**
If `python-can` has a backend for a vendor library, cannet works
with that vendor's hardware. The library install path is the
vendor's, not cannet's.

## Consequences

- **`grpcio`** + **`grpcio-tools`** (Apache-2.0) become runtime
  deps of the sidecar — the Python implementation of gRPC, used
  to generate stubs from `cannet-wire`'s `.proto`. No realistic
  alternative for gRPC in Python.
- **Sidecar lifecycle and venv management ride on `uv`** per
  ADR 0015 — the **developer** flow. The sidecar's first launch
  materialises the venv; subsequent launches reuse it. End users
  instead run the frozen self-contained binary, which needs no venv,
  `uv`, or network ([ADR 0036](0036-frozen-python-can-sidecar.md)).
- **Adding a future second sidecar is a separate process
  speaking the same wire.** No host changes, no protocol changes
  — just a new binary that implements the `.proto`.
- **Performance: process boundary plus Python overhead.** A
  Rust-native in-process driver would be faster; cannet accepts
  the sidecar overhead because the gain isn't measured (no
  workload demonstrates the sidecar as a bottleneck yet) and the
  cost of avoiding it is three FFI shims to write and maintain.
  Revisit only if profiling shows a specific vendor's sidecar is
  the bottleneck on a real workload — and then swap *that*
  vendor to a native adapter on the same wire, not the whole
  shape.

## Rejected alternatives

- **Native Rust FFI per vendor** (`vector-xl-sys`,
  `kvaser-canlib-sys`, `pcan-basic-sys`) — three FFI shims plus
  per-vendor packaging is ≈3× the work of wrapping one
  `python-can` library, for a performance win cannet has no
  current evidence it needs. Revisit only as a per-vendor swap
  if profiling justifies it.
- **socketcan-only Linux path** — Linux-native and clean on
  Linux, but covers neither Windows nor macOS. cannet targets
  all three.
- **Multiple vendor sidecars now (one per vendor)** — deliberately
  deferred. One `python-can` sidecar covers all three vendors
  today; the wire's universal-driver-contract property
  (ADR 0004) means a multi-sidecar future is a packaging change,
  not a protocol change.

## See also

The wire-level contract this sidecar implements — session-gated
lifecycle, multi-client behavior, `ConfigureBus`, `InterfaceState`
— is specified in
[ADR 0022](0022-hardware-server-model.md). This ADR covers the
*process*, *language*, and *driver-library* choices; ADR 0022
covers what the sidecar does on the wire.
