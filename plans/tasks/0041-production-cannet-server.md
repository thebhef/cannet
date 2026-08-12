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

### 2026-08-12 — phase 1, slice 2: the discovery chain follows

The launch half moves too: the frozen-vs-source decision, the
`uv` → PATH-`uv` → `python3` fallback chain, the per-flavour command
shapes, the `--log-level` / `--log-file` / driver-module arguments, the
CWD-independent sidecar-directory walk-up, the Windows
no-console flag, and the environment-beats-setting precedence rule.
The seam is a `SidecarHost` trait with two methods — `config()` for
what this spawn should be, `log()` for where a line goes — so the crate
owns *how* a sidecar is found and run while the host keeps what only it
can answer: `settings.json`, Tauri's `resource_dir()`, and the System
Messages ring. `cannet_sidecar::resolve_command(&host)` returns the
configured `Command`; the GUI still spawns and supervises it.

Tests: `cannet-sidecar` 8 → 28; `cannet-gui` 523 → 503, the same
twenty moved. Still 531 across the two.

### 2026-08-12 — phase 1, slice 3: supervision itself

`SidecarSupervisor` now owns the process: spawn with stdin piped (the
parent-death signal), the stdout/stderr pumps, the `listening`-banner
phase transitions, the `try_wait` loop, the crash budget, and the
manual restart that kills the previous child first. The `SidecarHost`
trait grew the three things supervision needs from a host —
`restart_budget()`, `status_changed(previous, current)`, and
`spawn_blocking()` for the thread the wait loop lives on — plus
`log_sidecar_output()`, separate from `log()` because the GUI mirrors
its own lifecycle lines to `tracing` and the child's output (orders of
magnitude more of it) only to the ring, exactly as before.

The GUI keeps what is genuinely its own: the `SidecarStatus` /
`SidecarPhase` wire shapes its frontend reads, the `STATUS_EVENT`
emit, and the `interfaces::watch` / `unwatch` moves a phase change
implies. `sidecar.rs` is 489 lines lighter and holds no process
handling at all.

Supervision arrived untested — it needed a live `AppHandle` — so the
extraction brought six tests with it, against a recording host: a
crash inside the budget asks for a respawn and numbers it, a crash
past the budget refuses and says how to recover, a manual restart
hands the full budget back, and a phase change is published once,
with both sides, and again when a restart re-binds a new ephemeral
port.

Tests: `cannet-sidecar` 28 → 34; `cannet-gui` 503, unchanged. 537
across the two, up six from the 531 this phase started at.

### 2026-08-12 — phase 2: replay and vbus move under `debug`

The 2026-08-11 CLI-shape grooming note is implemented. `cannet-server`
gained a `debug` subcommand namespace holding the prior positional-BLF
replay (`debug replay <blf>`) and `--virtual-bus` (`debug vbus`)
modes, flags and behavior unchanged, help text marked dev/test
tooling. Bare `cannet-server` — no subcommand — is the production
hardware-proxy entry point; it prints a `debug replay` / `debug vbus`
pointer and exits 1 until phase 3 implements the proxy. README's run
instructions and ADR 0040's "prior server modes" bullet now name the
resolved shape.

Tests: `cannet-server` 22 → 31 (nine new CLI-parsing tests: each
subcommand's defaults and flags, the removed top-level
`--virtual-bus` flag and bare positional BLF path no longer parsing,
and the bare-invocation error message).

### 2026-08-12 — phase 3: bare `cannet-server` is the proxy

The 2026-08-11 pass-through grooming note is implemented.
`ProxyServerImpl` relays all three RPCs 1:1 and interprets nothing:
`ListInterfaces` returns the upstream's list unchanged, each
`WatchInterfaces` forwards one upstream watch stream, and each client
`Session` opens exactly one upstream `Session` and relays envelopes
verbatim both ways. The proxy adds no arbitration — a second client is
offered to the upstream and gets back whatever it answers, in-band
`Busy` included — and the two session directions run to completion
together, so a client hanging up ends the upstream's request stream
(releasing what it held) while an upstream error reaches the client as
the same `Status`.

The upstream address is a closure resolved per RPC, because a
supervised sidecar re-binds a different ephemeral port on every
restart. That seam is also the test seam: the default suite points the
proxy at this crate's own in-process servers — the virtual bus for the
traffic cases, the single-client BLF replay for `Busy` and for the
hang-up case — and never at Python.

Bare `cannet-server` now runs it. The CLI is the `SidecarHost`: flags
where the GUI has `settings.json` (`--sidecar-log-level`,
`--sidecar-restart-budget`, both with defaults matching the GUI's),
stderr where the GUI has System Messages, and
`tokio::runtime::Handle::spawn_blocking` for the wait loop's thread.
`--bind` defaults to `127.0.0.1:50051`, so a routable bind stays a
deliberate act while Task 42 is outstanding. Frozen resolution is the
one thing the shared crate cannot do for a CLI: it looks for
`cannet-python-can/<launcher>` beside the executable, and a
`debug_assertions` build prefers the sidecar source tree so `cargo run`
picks up sidecar edits.

Verified once against the real sidecar on the dev machine
(`cargo test -p cannet-server --test proxy_sidecar -- --ignored`,
`uv`-launched source tree): the proxy came up, the supervisor caught
the `listening` banner, and `ListInterfaces` through the proxy returned
both PEAK PCAN-USB FD channels under their real ids. That test stays
`#[ignore]`d.

Tests: `cannet-server` 31 → 39 (six proxy integration tests, one unit
test for the no-upstream-yet window, and the CLI-parsing tests for the
proxy's flags replacing the removed bare-invocation error message),
plus one ignored real-sidecar test. Commits: `6e52517`, `4fa1a1f`.

## Blockers / side effects

- **`cannet-perf-measurement` has its own sidecar spawn**
  (`crates/cannet-perf-measurement/src/sidecar.rs`: its own
  `CANNET_SIDECAR_DIR` read, its own `uv run` invocation, its own
  banner wait). It is a third would-be consumer of
  `cannet-sidecar` and was left alone — phase 1's scope is the GUI
  host and the crate. Worth folding in when the harness is touched
  for the proxy-overhead comparison, which already has to point at a
  spawned `cannet-server`.
- **The frozen onedir's name in the archive is `cannet-python-can/`,
  not `sidecar/`.** The 2026-08-11 archive grooming note calls it "the
  already-frozen `sidecar/` onedir"; what
  `scripts/build-sidecar.py` actually emits is a directory named
  `cannet-python-can` (which is also where the GUI looks inside its
  resource dir). Phase 3 resolves the launcher at
  `<exe dir>/cannet-python-can/<launcher>`, so phase 4's archive must
  pack the onedir under that name — renaming it in the archive would
  cost a per-consumer rename for no gain.
- **ADR 0021 still says `cannet-server --virtual-bus` throughout**
  (it uses the flag as the concept's identifying label in a dozen-odd
  places, not as runnable examples). Phase 2's doc scope was
  README + ADR 0040; ADR 0021 was left alone rather than churning an
  architectural document beyond this phase's CLI-rename brief.
  Readers copy-pasting `cannet-server --virtual-bus` out of ADR 0021
  today get a parse error — worth a pass when ADR 0021 is next
  touched for its own reasons.
