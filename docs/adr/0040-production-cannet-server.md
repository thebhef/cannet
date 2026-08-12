# ADR 0040 — The production cannet server: operator-launched, sidecar-supervising, proxying real interfaces

Status: accepted (2026-08-02)

## Decision

`cannet-server` is the **production cannet server**: a headless CLI an
operator launches on a server host to make that host's CAN hardware
reachable over the network. One process, one network endpoint.

- **It supervises vendor sidecars.** The server spawns and supervises
  the frozen python-can sidecar ([ADR 0008](0008-python-can-sidecar.md),
  [ADR 0036](0036-frozen-python-can-sidecar.md)) on loopback, the same
  way the GUI host does for local hardware. The supervision machinery
  is one shared implementation, not two.
- **It proxies real interfaces.** The server publishes the union of
  its sidecars' interfaces under their real identities
  (`vector:0`, `socketcan:can0`, …) through `ListInterfaces` /
  `WatchInterfaces`, and routes `Session` subscriptions through to the
  owning sidecar. Hardware-server semantics
  ([ADR 0022](0022-hardware-server-model.md) — session-gated
  lifecycle, `ConfigureBus`, `InterfaceState`) pass through unchanged;
  the proxy adds no semantics of its own.
- **Launch is an operator running a CLI.** No system-service
  integration (no systemd unit, no Windows service), and no GUI-side
  bootstrap: the GUI talks to nothing but the server's endpoint. How
  the operator gets a shell on the server host is their business.
- **Discovery is mDNS/DNS-SD, and is convenience only.** The server
  advertises `_cannet._tcp` with an operator-chosen instance name
  (`--name`, default hostname) and TXT metadata (protocol version,
  optional labels); `--no-mdns` disables advertisement. The GUI
  browses and offers a fuzzy-searchable pick list beside the manual
  `host:port` field, which remains the path to servers beyond the
  local subnet. Visibility is not access control — the connection
  layer is the security boundary
  ([ADR 0041](0041-remote-connection-security.md)).
- **The GUI keeps its local fast path.** In-process `SharedBus` for
  local virtual buses and the GUI-spawned sidecar for local dongles
  ([ADR 0021](0021-virtual-bus-server.md)) are unchanged. The
  production server is the remote deployment unit, not a local
  dependency.
- **Prior server modes are subordinate.** BLF replay and
  `--virtual-bus` began as dev/debug tooling and are renamed as
  explicitly dev-facing subcommands, `cannet-server debug replay
  <blf>` and `cannet-server debug vbus`. Bare `cannet-server` is the
  production hardware proxy; none of the debug subcommands defines
  what `cannet-server` is.
- **Distribution is a per-OS archive** bundling the server binary and
  the frozen sidecar onedir; the dev flow stays `cargo run` plus the
  existing sidecar discovery chain.

## Why

**Proxy real interfaces, not a fronting virtual bus.** ADR 0021's
gateway shape (hardware claimed by bridges onto a virtual bus) masks
interface identity behind `virtual:*` ids and blurs
`InterfaceState` / `ConfigureBus` through an extra hop. Proxying keeps
ADR 0022's contract intact end-to-end: the remote client sees the
same interface it would see locally.

**One endpoint, one security surface.** Exposing sidecars directly
would require TLS, auth, and discovery to be implemented per vendor
sidecar, per language. A single fronting server gives those features
exactly one home.

**Operator-launched, not GUI-bootstrapped.** Having the GUI open SSH
sessions and start remote processes imports credential management,
per-OS shell differences, and a bootstrap protocol — for a machine the
operator already administers. The GUI's contract stays "connect to an
address."

**mDNS/DNS-SD, not a hand-rolled beacon.** Service discovery over
multicast is a solved, standardized problem (RFC 6762/6763) with
vetted Rust implementations; a custom UDP beacon reinvents it as
review surface. The service type alone filters out everything that
isn't a cannet server; instance names and TXT labels handle
filtering among many.

## Rejected alternatives

- **Expose the python-can sidecar directly** (`--bind` on a routable
  address). Works today, but multiplies the security/discovery
  surface across every current and future sidecar, and leaves nothing
  supervising the process.
- **Front hardware with a virtual bus** (ADR 0021's remote framing).
  Masks identity, blurs state/config semantics; bridges remain
  available for actual bus-composition use cases.
- **GUI always a client of a local server.** Uniform, but adds a
  process hop and lifecycle management to every local session for
  zero user benefit; reverses ADR 0021's in-process decision.
- **GUI-driven SSH bootstrap** (VSCode Remote model). See *Why*.
- **System-service integration.** Packaging and lifecycle surface for
  a process the operator can just run.
- **Custom UDP discovery beacon; manual entry only.** See *Why*;
  manual entry stays, but as the fallback rather than the whole
  story.
- **DNS-SD subtypes for protocol-level browse filtering.** Config
  surface without payoff at cannet's scale — client-side filtering
  over instance names/labels covers it.
