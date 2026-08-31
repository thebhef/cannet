# 0136 — python-can Cannet Client

> **Opened 2026-09-05** from owner usage feedback (split out of task 134). **Groomed 2026-09-06**: trust-store-fed factory,
> python-can `BusABC` integration; all design questions ruled, exit criteria set.

A Python library that uses python-can abstractions for a cannet client — an easy way to integrate cannet into stafl Python apps.
Drop-in replacement for python-can; should be easy to compose alongside it.

## Shape

- `CannetBus(can.BusABC)`, registered under python-can's `can.interface` entry-point group: `can.Bus(interface="cannet", ...)` just works.
- Full `BusABC` citizenship: `_recv_internal` (so `recv`, iteration, `Listener`/`Notifier` work), `send` (a one-frame `FrameBatch`),
  `shutdown`, `state` (fed by `InterfaceState`), `channel_info`.
- A factory resolves the server from the **canonical server trust store** — the machine's accepted servers (`host:port`, pinned cert,
  bearer token) — so callers name a server, never paste credentials.
- One gRPC `Session` stream per bus: `ConfigureBus` sent before `Subscribe`; a factory id (`virtual:bus0`) waits for `InterfaceAllocated`;
  per-frame error codes (`TX_REJECTED`, `NO_ACKNOWLEDGER`) surface per-message while session-fatal codes raise (`cannet-client`'s split).
- Reuse from `servers/cannet-python-can`: the checked-in `_proto` gencode and the `can.Message` ↔ wire `Frame` mappers; the client is a
  sibling uv-managed package.
- TLS: the pinned server cert as the sole root plus target-name override (Python gRPC's closest equivalent of the Rust client's
  fingerprint pin); the token as `authorization: Bearer` metadata on every RPC.
- Hardware-free tests against `cannet-server debug replay` / `debug vbus` (both default `127.0.0.1:50051`).

## Rulings (2026-09-06)

- **Trust store is a read contract.** The library reads the GUI's `servers.json` directly. Verified: it lives at user scope in the
  platform-standard config dir (`persisted_json::config_dir` → Tauri `app_config_dir()` — XDG `~/.config` on Linux, `%APPDATA%` on
  Windows, `~/Library/Application Support` on macOS; `server_trust.rs`). No relocation needed; document location + schema as stable.
- **Do the time sync.** Port the SNTP clock-probe correction (the Rust client's `clock.rs` behaviour) so `Message.timestamp` matches
  the client's clock — fix-ups happen in the library, not in every consumer that cares about time.
- **Repo-only packaging.** No PyPI; gencode shared with the sidecar plus the drift-guard CI check the backlog already wants.
- **Detection dials the servers.** `_detect_available_configs()` reads the trust store, dials each trusted server (short timeout),
  and returns one config per offered interface; unreachable servers contribute nothing.

## Non-goals

- Not the ADR 0051 Extension API — an Extension talks only to the GUI host, never a bus source; this is the opposite direction.
- No mDNS browsing: addresses come from the trust store; discovery can layer on later if ever needed.

## Exit criteria

1. `can.Bus(interface="cannet", server=..., channel=...)` opens a bus against a trusted server with no cannet-specific import;
   `recv`, iteration, `Listener`/`Notifier`, `send`, `shutdown`, and `state` behave as `BusABC` promises.
2. The trust-store read contract (location + schema of `servers.json`) is documented; the factory resolves a server by name or
   address from it and applies the pinned cert and bearer token.
3. Delivered `Message.timestamp` values are corrected to the client's clock via the SNTP probe/slew the Rust client uses; a peer
   that answers no probes degrades to raw stamps without blocking.
4. `can.detect_available_configs()` lists one config per interface offered by each reachable trusted server.
5. Session semantics match `cannet-client`: `ConfigureBus` before `Subscribe`, factory ids awaiting `InterfaceAllocated`, per-frame
   rejections surfaced per-message while session-fatal errors raise.
6. A hardware-free test suite runs against `cannet-server debug replay` / `debug vbus`; CI guards the shared gencode against drift.
7. Docs: README names the new package and how to run its tests; the package carries a usage example for a stafl-style app.
