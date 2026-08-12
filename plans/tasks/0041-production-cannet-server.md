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

## Grooming notes

- **2026-08-11 — CLI shape (owner).** The entire existing behavior
  moves under a `debug` subcommand namespace: `cannet-server debug
  replay <blf>` and `cannet-server debug vbus`, help text marking
  them dev/test tooling. Bare `cannet-server` is the production
  hardware proxy. No production use is known for the server vbus;
  nothing is dropped, but everything pre-existing is explicitly
  debug.
- **2026-08-11 — proxy is pure 1:1 pass-through.** Each client
  `Session` opens exactly one upstream `Session` to the sidecar and
  relays envelopes verbatim both ways; `ListInterfaces` /
  `WatchInterfaces` forward likewise. No envelope interpretation, no
  re-termination: `Busy` / errors / `InterfaceState` propagate
  untouched and the sidecar's single-owner semantics arbitrate.
  Task 42's token check sits at RPC start (gRPC metadata), needing no
  envelope inspection.
- **2026-08-11 — archive via the existing release workflow.** The
  macOS arm64 and Windows x64 release legs additionally pack
  `cannet-server-vX.Y.Z-<target>` (server binary + the already-frozen
  `sidecar/` onedir) beside the GUI bundle; a new Linux x64 leg
  builds only the server archive (cargo build + sidecar freeze + tar,
  no Tauri bundling). One draft pre-release: 2 GUI bundles + 3 server
  archives.
- **2026-08-12 — proxy overhead perf criterion (owner).** The
  existing integrated perf harness (ADR 0031, two PEAK dongles,
  local-only) gains the ability to point at a locally spawned
  `cannet-server` instead of the sidecar — that retargeting is the
  whole scope. Both paths get the same timing/performance visibility
  so the comparison is straightforward; through-the-proxy must
  perform about the same as direct. Multiple runs, worst-to-worst as
  well as means, per the perf-gate discipline.
- **2026-08-11 — exactly one supervised sidecar; no id namespacing.**
  Single is the only planned direction: the python-can sidecar
  already lists all interfaces on the system and multiplexes
  connections, so multiple sidecars per host is wrong on its face.
  The multi-sidecar hypothetical (some future non-python-can vendor
  sidecar) gets its own task if it ever materializes.

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
- Perf comparison: local server proxying local hardware performs
  about the same as the sidecar reached directly (per the grooming
  note); result recorded in the status log.
- Per-OS archive containing server + frozen sidecar is produced by CI.
- ADR cleanup: remaining "test rig" phrasing scrubbed from ADRs
  touched by this work.
- README documents running the server on a server host; rustdoc on
  the new/changed public crate surfaces.

## Status log

### 2026-08-12 — phase 1, slice 1: the banner grammar moves to a crate

`crates/cannet-sidecar` exists, dependency-free, holding the half of
the sidecar contract that is pure parsing: the stdout banner grammar
(`classify_stdout_line`, `parse_listening_address`), the sidecar's
Python-logger stderr grammar (`classify_stderr_line`), the shared
`LogLevel` those classify into, and the two names both hosts must
agree on (`SOURCE`, `SIDECAR_LOG_FILE`). The GUI host renames the
crate's `LogLevel` into its own System Messages ladder at the two
stream pumps and is otherwise unchanged.

Tests: `cannet-sidecar` 0 → 8 (the eight moved verbatim);
`cannet-gui` 531 → 523, same eight, no net loss.
