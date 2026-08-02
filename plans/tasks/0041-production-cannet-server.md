# Task 41 — Production Cannet Server

Make `cannet-server` the production cannet server
([ADR 0040](../../docs/adr/0040-production-cannet-server.md)): a
headless CLI an operator launches on a server host to make that host's
CAN hardware reachable over the network. The server supervises the
frozen python-can sidecar ([ADR 0036](../../docs/adr/0036-frozen-python-can-sidecar.md))
on loopback and **proxies its interfaces under their real identities**
at one network endpoint — hardware-server semantics
([ADR 0022](../../docs/adr/0022-hardware-server-model.md)) pass
through unchanged. The GUI's contract stays "connect to an address";
its local fast path (in-process vbus, self-spawned sidecar) is
untouched.

## Decisions

- **Proxy, not a fronting virtual bus** — remote clients see
  `vector:0` / `socketcan:can0`, with `InterfaceState` /
  `ConfigureBus` / lifecycle intact (ADR 0040).
- **Shared sidecar supervision.** The spawn/supervise/parse-banner
  machinery in `apps/gui/src-tauri/src/sidecar.rs` factors into a
  crate both the GUI host and the server use — one implementation,
  including restart budget and stdin-EOF lifetime.
- **Operator-launched CLI only.** No systemd/Windows-service
  integration, no GUI-side bootstrap.
- **Distribution: per-OS archive** bundling the server binary + the
  frozen sidecar onedir. Dev flow stays `cargo run` + the existing
  sidecar discovery chain (source tree via `uv`, then PATH).
- **Prior modes are subordinate** (ADR 0040): BLF replay and
  `--virtual-bus` each roll in, get renamed as dev tooling, or drop —
  resolved in this task, not left ambiguous.
- Until Task 42 lands, non-loopback binds remain unprotected (status
  quo today); Task 42 flips the default.

## Open

- CLI shape: how hardware-proxy, virtual-bus, and replay roles are
  expressed (subcommands vs flags), and what plain `cannet-server`
  does.
- Interface-id namespacing if a server ever supervises more than one
  sidecar (id collisions); single sidecar is fine for v1.
- Whether the proxy is a generic gRPC pass-through or re-terminates
  sessions (affects `Busy`/error propagation and per-client
  bookkeeping).
- Archive layout and which CI job builds it.

## Non-goals

- TLS / auth ([Task 42](0042-server-connection-security.md)).
- mDNS discovery ([Task 43](0043-server-discovery.md)).
- Multi-client fan-out on one interface beyond what drivers already
  give (existing backlog item).
- Service integration, auto-start, GUI-driven remote launch.

## Exit criteria

- `cannet-server` (production role) spawns and supervises the sidecar,
  and a remote GUI connecting by `host:port` lists the real
  interfaces, subscribes, sees `InterfaceState`, and exchanges frames
  end-to-end.
- Sidecar supervision lives in one shared crate used by both the GUI
  host and the server; GUI behavior unchanged (existing tests green).
- The fate of BLF replay and `--virtual-bus` is decided and
  implemented (rolled in / renamed / dropped), docs updated to match.
- Per-OS archive containing server + frozen sidecar is produced by CI.
- ADR cleanup: remaining "test rig" phrasing scrubbed from ADRs
  touched by this work.
- README documents running the server on a server host; rustdoc on
  the new/changed public crate surfaces.
