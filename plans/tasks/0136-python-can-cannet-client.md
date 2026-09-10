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

## Status log

### 2026-09-06 — phase 1 of 2, "core bus" (branch `task136-core-bus`)

Criteria **1, 2, 5** met, plus the hardware-free test suite half of **6**
and — because the package build needed a README and the README needed the
example it names — **7**. Criteria **3** (SNTP clock sync), **4**
(`detect_available_configs`), and the gencode drift-guard half of **6**
are phase 2 and were deliberately not built.

**Landed.** `servers/cannet-python-client/`, a uv-managed sibling of the
sidecar: `CannetBus(can.BusABC)` under python-can's `can.interface`
entry point as `cannet`, a `trust` module that reads the GUI's
`servers.json`, a `tls` module that pins by certificate, and a `session`
module that owns the gRPC `Session` stream. 52 tests + 1 platform-gated
skip. The sidecar gained four public aliases (`message_to_frame` /
`frame_to_message`, `frame_to_proto` / `proto_to_frame`) and nothing
else: the client imports its gencode and its mappers by path dependency,
so there is one encoding of the wire in the repo and nothing to drift.

**Judgment calls, and why.**

- **Pinning is by certificate, not by fingerprint.** Python's gRPC
  exposes no verifier hook, so the library fetches the server's
  certificate over an unverified handshake, checks its SHA-256 against
  the stored fingerprint, and hands that exact certificate to gRPC as
  the channel's sole trust root. Equivalent in what it accepts. A second
  handshake — trusting the fetched certificate as its own root — reads
  back its SAN list, which is the only honest way to pick a
  `ssl_target_name_override` a self-signed certificate actually carries.
  Not exercisable in the hardware-free suite: both debug servers
  terminate no TLS, so the fingerprint form, the pin comparison and the
  name selection are unit-tested and the handshake is not. **Phase 2
  should know the TLS path has no end-to-end coverage.**
- **An ordinary subscribe is ready as soon as it is sent.** The wire
  does not acknowledge `Subscribe`, so a session-fatal
  `CODE_UNKNOWN_INTERFACE` surfaces as `can.CanOperationError` on the
  first `recv`, not out of the constructor — exactly `cannet-client`'s
  split. A *factory* subscribe is acknowledged, so its errors do come
  out of the constructor as `can.CanInitializationError`. The
  alternative (a settle window, or using `ClockProbe` as an ack) trades
  a definite behaviour for a stall against a peer that never answers.
- **`state` reads `ACTIVE` when the peer has reported nothing.**
  python-can's `BusState` has three members and no "unknown". The
  difference survives on `CannetBus.controller_state`, which is `None`
  until an `InterfaceState` arrives. The setter raises: the wire has no
  envelope for setting a fault-confinement state.
- **A bare name resolves only when the store holds exactly one entry for
  it**; two ports under one name raise `AmbiguousServer` rather than
  picking. Bare *loopback* names take port 50051, since nothing is ever
  stored for loopback and the debug servers all sit there.
- **Per-frame rejections log the first of a code at `warning` and the
  rest at `debug`.** `cannet-client` warns on every one; a lone
  rest-of-bus simulation on an empty virtual bus produces one per
  transmit, and the example proved it buries everything else. The tally
  (`bus.rejections`) is unchanged and is where the count lives.

**CI wiring.** A `python-client` job in `.github/workflows/ci.yml` and
four hooks in `.pre-commit-config.yaml`. The job builds
`cannet-server` and checks out LFS, because a suite that silently
skipped its integration half would be worth very little.

### 2026-09-06 — phase 2 of 2, "clock + detection" (branch `task136-clock-detect`)

Criteria **3, 4** and the gencode drift-guard half of **6** are met;
**7** picked up the two doc sections its new behaviour needed. No Rust
or frontend code changed — this phase is entirely the client package,
`.github/workflows/ci.yml`, and this file.

**Clock sync (criterion 3).** `cannet_python_client/clock.py` is a
straight port of `crates/cannet-client/src/clock.rs`'s math and state
machine — `ClockSample`/`sample`/`best_sample` (RFC 4330 § 5),
`SessionClock` (the per-session record, thread-safe via one lock
instead of an atomic + mutex split — Python has no data race on a
single attribute read, so the extra type wasn't worth carrying over),
and `OffsetSlew` (the bounded-rate correction). 27 tests port the
Rust suite's cases 1:1, minus the `u64`/`i128` overflow-saturation
tests: Python integers don't overflow, so there was nothing there to
pin. `Session` in `session.py` drives it from a dedicated
`cannet-clock` thread rather than folding it into the `_pump` thread's
receive loop — Python has no equivalent of `tokio::select!` over a
stream and a timer at once, and a thread with blocking waits is the
straightforward way to get the same two guarantees: a session comes
up at the speed of its subscribe (the probe never gates readiness),
and a peer that never answers a round costs nothing but an
`Unsupported`/`STATUS_UNSUPPORTED` reading once the round's 2 s
deadline passes. `close()` wakes that thread immediately via the same
event the round waits on, so shutdown never pays the deadline.
`Session._handle_batch` applies the correction to every delivered
frame before it reaches `recv`; `Session.clock` is the read surface,
matching `cannet-client`'s `Session::clock()`. Not ported:
`ProbeRounds`, the Rust state machine for alternating a single timer
between "await this round's replies" and "wait for the next round" —
a dedicated thread just runs that as a loop with blocking waits, and
carrying the class over would have meant re-deriving in Python a
design that exists to work around Rust's single-timer constraint,
which this code doesn't have. `tests/test_session_clock.py` proves
both halves against real wire behaviour: a `debug vbus` server's
probe gets measured within the round, and — against a fake in-process
gRPC service that answers `Subscribe` but drops every `ClockProbe`,
because neither debug server can be made to do that — a session
delivers its frame and closes in well under the 2 s deadline, with
the timestamp unmodified.

**Detection (criterion 4).** `session.list_interfaces()` is the
one-shot `ListInterfaces` helper phase 1 left as a gap: dial, ask,
hang up, reusing `open_channel`'s TLS-pinning path. `bus._detect_configs`
takes a trust-store mapping the way `trust.resolve` does (the test
seam) and is what `CannetBus._detect_available_configs()` — the
`BusABC` hook behind `can.detect_available_configs()` — calls with the
real store. A server that raises for any reason (unreachable, refused
pin, not trusted) is skipped rather than failing the scan, matching
the ruling. Returned configs carry a `server` key beyond what
`can.typechecking.AutoDetectedConfig` declares — this interface can't
be reopened without it — so the static method's return is a `cast`,
documented as such; the internal helper stays a plain `list[dict]` so
the extra key needs no per-call `# type: ignore`.

**Gencode drift guard (criterion 6, remainder).** A step in the
`python` (sidecar) CI job re-runs `scripts/regen_proto.sh` — already
the contributor path for editing `cannet.proto` — and
`git diff --exit-code`s the tree. No new tooling, and the check is as
strong as the regeneration itself already is. Verified locally
content-clean (`git diff --ignore-space-at-eol` reports nothing); a
byte-for-byte local run showed CRLF-only churn from Python's text-mode
write on Windows, irrelevant to the `ubuntu-latest` runner this job
actually uses.

**Docs (criterion 7).** The package README gained "Clock correction"
and "Detecting servers" sections; the top-level README already named
the package and its test commands from phase 1 and needed nothing
further.

## Blockers / side effects

- **`cargo fmt --all --check` was already red on `feedback-capture`**, in
  `apps/gui/src-tauri/src/interfaces.rs`, introduced by `7d18a421` (#460)
  and still unformatted through `0dfbe070` (#461) and `128cecfd` (#462) —
  three commits that used `--no-verify` in the shared tree. Not fixed
  here: it is not one of the six CI jobs (there is no fmt job), the file
  belongs to work another branch in this tree is actively on, and the
  next commit that touches Rust will have the hook sweep it. Named so it
  does not ride another chain.
- **17 inherited `(task 129)` references in `apps/gui/src/` comments**,
  from `24e76fb6` (#450), which `CLAUDE.md` § Documentation forbids.
  Fixed here: every one was a bare parenthetical carrying only the task
  number, so dropping it loses nothing. The `comment-references` grep is
  clean over `apps/` and `crates/`.
- **(phase 2) `cargo fmt --all --check` is still red** on the same file,
  for the same reason — re-checked, not newly introduced; this phase
  touched no Rust. The `comment-references` grep is still clean,
  including over this phase's new files.

## Exit criteria verdicts (orchestrator walk, 2026-09-06)

1. **Met** (phase 1): `can.Bus(interface="cannet", ...)` via the entry point; recv/iteration/Listener/Notifier/send/shutdown/state
   exercised by the vbus/replay suites.
2. **Met** (phase 1): read contract documented in the package README + `trust.py`; resolution by name or host:port with pin + token.
3. **Met** (phase 2): `clock.py` ports `clock.rs` (RFC 4330 math, `SessionClock`/`OffsetSlew`); no-answer peers degrade to raw
   stamps without blocking (fake-peer test).
4. **Met** (phase 2): `_detect_available_configs` dials trusted servers via `list_interfaces`; unreachable servers contribute nothing.
5. **Met** (phase 1): ConfigureBus-before-Subscribe, factory ids await `InterfaceAllocated`, per-frame vs session-fatal split.
6. **Met** (phases 1+2): hardware-free suites against debug replay/vbus (87 client tests); `python` CI job re-runs `regen_proto.sh`
   and diffs `_proto` as the drift guard.
7. **Met** (phases 1+2): top-level README names the package; package README + `examples/rest_bus_sim.py` carry the stafl-style usage.

**Caveat carried in the review queue**: the TLS handshake has no end-to-end coverage (both debug servers are plaintext).
Awaiting owner acceptance.
