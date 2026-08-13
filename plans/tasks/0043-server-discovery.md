# Task 43 — Server Discovery

Make cannet servers discoverable on the local network per
[ADR 0040](../../docs/adr/0040-production-cannet-server.md): the
server advertises `_cannet._tcp` via mDNS/DNS-SD; the GUI browses and
offers a fuzzy-searchable server list beside the manual `host:port`
field, which remains the path to servers beyond the local subnet.

**Blocking prerequisite — cleared 2026-08-12.** The
evaluate-dependency pass picked **`mdns-sd` 0.21** for both register
and browse; `technology-inventory.md` carries the adoption and the
four rejections. The grooming note and status log below record what
the spike measured and what phase 2/3 must build against.

## Decisions

- **Server advertises** instance name (`--name`, default hostname);
  TXT carries exactly one key, `ver=<release version>` (the vergen
  stamp). `--no-mdns` disables advertisement.
- **GUI browses** in the Tauri host (browse task pushes updates to
  the frontend by event — thin-view rule; no polling in JS), and the
  connect UI lists live servers (name, host:port, labels) with
  fzf-style fuzzy search over the list.
- **Discovery is convenience only** (ADR 0040): no security role;
  the connection layer (Task 42) is the boundary. Selecting a
  discovered server feeds the same connect path as a typed address.
- **No DNS-SD subtypes** — client-side filtering over names/labels
  covers the need (ADR 0040 rejected alternative).

## Grooming notes

- **2026-08-12 — no labels; TXT is one key (owner).** One server per
  host means the instance name already identifies it; `--label` was
  speculative surface and is dropped, as is a protocol-version key
  (the gRPC connect is the compatibility check, until a second
  protocol version exists). TXT still ships — RFC 6763 §6.1 wants a
  TXT record even when empty, and one key earns its place for
  network maintainers: `ver=<release version>` (the vergen stamp,
  zero config) makes fleet inventory answerable from `avahi-browse`
  without connecting. Revises ADR 0040's discovery bullet ("TXT
  metadata: protocol version, optional labels") — amend the ADR in
  the commit that implements this.
- Fuzzy search accordingly runs over instance names (+ host:port),
  not labels.
- **2026-08-12 — gone servers drop immediately (owner).** Either
  removal signal (goodbye packet or TTL expiry) removes the entry
  from the browse list; a re-announce re-adds it. No greyed-out
  linger state — the manual `host:port` field covers reaching a
  server that isn't currently advertising.
- **2026-08-12 — v4/v6 dedupe: key by instance name.** One list
  entry per DNS-SD instance name regardless of address family; the
  entry is live while any announcement for it is live.
- **2026-08-12 — crate eval (phase 1): `mdns-sd` 0.21 on both
  sides.** It is the only credible pure-Rust crate covering register
  *and* browse, so the server's advertisement and the GUI's browse
  share one implementation. `libmdns` (register-only), `zeroconf`
  (FFI; needs Bonjour installed on Windows), `simple-mdns` (~90
  downloads/month) and `agnostic-mdns` (17 months stale) are
  rejected in `technology-inventory.md`. Facts the phase-2/3
  implementers should build against, all measured in the spike
  (numbers in the status log below):
  - **Goodbye is ~1.0 s, and bare `shutdown()` is enough.**
    `ServiceDaemon::shutdown()` unregisters everything and sends
    goodbye packets, so the server's Ctrl-C path does not need an
    explicit `unregister()`. The ~1 s floor is RFC 6762 §10.1 (a
    TTL=0 goodbye is cached as TTL=1), not library lag — it cannot
    be tuned away. The process must not `exit()` the instant
    `shutdown()` returns; the goodbye still has to reach the wire.
  - **Hard kill costs the full 120 s host TTL.** `mdns-sd` stamps
    SRV/A records with 120 s and PTR/TXT with 4500 s
    (RFC 6762 defaults); removal fires on SRV expiry, so a killed
    server disappears ~120 s after its *last announcement*, not
    after the kill. The "gone servers drop immediately" decision
    above holds for the goodbye path only — a crashed server
    lingers for up to two minutes, and the connect UI should not
    imply otherwise.
  - **`ServiceResolved` fires many times per instance.** The spike
    saw 11 resolves for one registration as addresses accumulated
    across 6 interfaces, and 2 `ServiceRemoved` events for one
    expiry. The browse-list state machine must be idempotent and
    keyed by fullname — which is what the v4/v6 dedupe decision
    already requires; this is the mechanical reason it is
    mandatory rather than tidy.
  - **`enable_addr_auto()` announces on every interface**,
    including VM and WSL virtual adapters. Whether the server
    should instead bind the addresses it is actually serving on is
    a phase-2 decision, not a settled one.
  - **Windows: expect the firewall to bite cross-host.** See the
    status log — the spike was same-host and did not prove
    cross-machine reachability.

## Non-goals

- Cross-subnet / wide-area discovery, mDNS repeaters/gateways.
- Advertising the GUI's local sidecar or in-process vbuses.
- Access control via discovery visibility.

## Exit criteria

- Evaluate-dependency pass done; `technology-inventory.md` records
  the chosen crate as `adopted` (and alternatives as `rejected`).
- A running server appears in the GUI's browse list with its name
  and version; selecting it connects (through the Task 42 flow);
  fuzzy search filters the list.
- `--no-mdns` server absent from browse but connectable manually.
- Server shutdown removes it from the list (goodbye packet honored).
- Integration coverage where CI permits multicast; unit coverage for
  the browse-list state machine regardless.
- `plans/features.md` "Discoverable on the network" checked; README
  documents `--name` / `--no-mdns`.

## Status log

### 2026-08-12 — phase 1: mDNS/DNS-SD crate eval

Landed on `task43a-mdns-eval`, off `task42d-gui-tofu` (`ecc1fa5`).
No production code — the eval verdict gates it.

**Verdict: `mdns-sd` 0.21 for both register and browse.** Rationale
and the rejections (`libmdns`, `zeroconf`, `simple-mdns`,
`agnostic-mdns`) are in `technology-inventory.md`.

The spike was a throwaway cargo project outside the repo: a
registrar and a browser as separate processes, plus a second
registrar built on `libmdns` to check interop. Host: Windows 11 Pro
26200, 6 interfaces (Ethernet, loopback, WSL/Hyper-V vSwitch, two
VMware adapters), rustc 1.96.0. Service `_cannet._tcp` with a single
`ver=0.0.0` TXT key, exactly the shape the Decisions call for.

Measured, `mdns-sd` registrar → `mdns-sd` browser:

| event | latency |
| ----- | ------- |
| register → first `ServiceResolved` | 0.80 s |
| `unregister()` → `ServiceRemoved` | 1.01 s |
| `shutdown()` (no `unregister`) → `ServiceRemoved` | 1.01 s |
| re-register same name → `ServiceResolved` | 0.50 s |
| hard kill (`SIGKILL`) → `ServiceRemoved` | 109.9 s after the kill; 121.9 s after registration |

The hard-kill figure is the 120 s SRV/A TTL running from the
registrar's announcement burst, so the kill landing 12 s in is why
the two columns differ. The browser re-queried on its own backoff
(+7/+15/+31/+63/+127 s) and got nothing; expiry, not a failed
refresh, is what removed the entry.

TXT survived intact — `get_property_val_str("ver")` returned
`"0.0.0"` on every resolve. Instance identity is the fullname
`spike-a._cannet._tcp.local.`, stable across the re-register and
across address families: a single resolve reported 6 IPv4 and 17
IPv6 addresses under one fullname. Both families were exercised;
IPv6 was link-local only (`fe80::/10`) on this host.

`libmdns` interop: its registration resolved through the `mdns-sd`
browser in 8 ms with the `ver` TXT intact, and dropping its
`Service` handle produced a `ServiceRemoved` 1.00 s later. It works;
it just cannot browse.

**Windows notes for phase 2/3:**

- Windows already has processes bound to UDP 5353 (the OS resolver,
  plus browsers' mDNS rules). `mdns-sd` shared the port without
  complaint — no `SO_REUSEADDR` work needed on our side. No Apple
  Bonjour / `mDNSResponder` is installed on this host, and none was
  required.
- **On first bind, Windows silently created inbound *Block* rules
  (UDP and TCP, Public profile) for each spike binary.** No prompt
  appeared. The active profile is Public with
  `BlockInbound,AllowOutbound`. The spike still passed because both
  processes were on one machine — **it did not exercise
  cross-machine inbound filtering, and must not be read as proof of
  cross-host reachability.** Packaging needs an explicit inbound
  allow rule for UDP 5353, and the exit criterion "a running server
  appears in the GUI's browse list" should be walked on two
  machines, not one.
- Those auto-created Block rules still name the spike's temp paths;
  deleting them needs elevation, so they were left in place.

### 2026-08-12 — phase 2: the server advertises

Landed on `task43b-server-advertise`, off `task43a-mdns-eval`
(`8761a8e`). Two commits:

- `3fa3e4c` — `cannet-server::discovery` module:
  `Advertisement::register` (builds the `ServiceInfo` — instance
  name, bound port, single `ver=` TXT key — and registers it with
  `enable_addr_auto()`) and `Advertisement::shutdown` (sends the
  goodbye and awaits the daemon's own completion signal before
  returning, per the phase-1 finding that a bare `shutdown()` with no
  wait can lose the goodbye to process exit). `advertised_name`
  resolves `--name` against the system hostname. `cannet-server`
  gained `vergen` as a build-dependency (`build.rs` mirrors
  `apps/gui/src-tauri/build.rs`) and `hostname` 0.4 as a direct dep
  (new adoption — no `std` equivalent; see
  `technology-inventory.md`). 6 unit tests on the service-info
  assembly and name defaulting.
- `3b96abb` — wired into `main.rs`: `--name` / `--no-mdns` flags,
  `build_version()` (same `VERGEN_GIT_DESCRIBE`-or-`CARGO_PKG_VERSION`
  fallback as the GUI), registration in `run_proxy` (warns and
  continues on failure — discovery is convenience only, never a
  startup refusal), and a `tokio::select!` between the server future
  and `tokio::signal::ctrl_c()` so Ctrl-C awaits
  `Advertisement::shutdown` before the process exits. `debug replay`
  and `debug vbus` never call `discovery` — confirmed by reading the
  call graph, not by a runtime check, since there is nothing to
  assert against. 2 more CLI-parsing unit tests.

**`enable_addr_auto()` is the phase-2 answer to the open point in the
Grooming notes above** (binding only the interfaces actually served,
vs. every interface): went with the simple default, unchanged from
the phase-1 spike. No evidence surfaced that VM/WSL adapter noise is
a real problem worth the extra config surface.

**Live integration test**: `discovery::tests::register_and_browse_round_trip`,
`#[ignore]`d (binds real multicast sockets). Registers an
`Advertisement`, browses for it with a second `ServiceDaemon` in the
same process, asserts the `ver` TXT and port on resolve, calls
`shutdown()`, and asserts `ServiceRemoved` follows. Run once locally
(Windows 11, same machine as the phase-1 spike):
`cargo test -p cannet-server --lib -- --ignored register_and_browse` →
1 passed in 1.81 s. Same-host only, consistent with the phase-1
spike's own finding — not evidence of cross-machine reachability,
which still needs the Windows inbound UDP 5353 allow noted below.

**Manual smoke test**: `cargo run -p cannet-server` (bare, loopback,
plaintext) printed `hardware proxy: advertising "RIPPY" (v0.8.1-83-
g3fa3e4c-dirty) via mDNS (_cannet._tcp)` before the sidecar banner —
vergen's `git describe` reached the TXT record as designed, hostname
defaulting worked with no `--name` given. Process tree (including the
spawned sidecar) exited cleanly under `timeout`; no leftover
processes.

**Docs**: ADR 0040's discovery bullet amended to the resolved TXT
shape (single `ver=` key, no labels) in the module commit. README
§ Running the production server documents `--name` / `--no-mdns`; the
prebuilt-archive paragraph carries the Windows inbound UDP 5353 note
for cross-machine discovery.

**Not done in this phase** (phase 3, GUI browse):
`plans/features.md`'s "Discoverable on the network" stays unchecked —
the GUI does not browse yet, so the exit criterion isn't met.

### 2026-08-12 — phase 3: the GUI browses

Landed on `task43c-gui-browse`, off `task43b-server-advertise`
(`b16fe8a`). Two code commits, plus the docs commit carrying this
entry:

- `fa0cf7b` — `cannet-gui::server_browse`: a `mdns-sd` browse task
  spawned in `setup` for the app's lifetime, folding every
  `ServiceResolved` / `ServiceRemoved` into `BrowseList`, keyed by
  DNS-SD fullname per the dedupe ruling above. Merge rules: addresses
  union across resolves (a responder reports what it has answered on so
  far), port and `ver` latest-wins, either removal signal drops the
  entry, a re-announce re-adds it clean. Every mutation returns whether
  the *rendered snapshot* moved, so the eleven-resolves-per-instance
  burst costs one event, not eleven, and the duplicate `ServiceRemoved`
  costs none. Each entry renders one dialable `host:port` from a ranked
  address choice — routable IPv4, then routable IPv6, then loopback
  (which must never win: a remote server's advertised `127.0.0.1` would
  silently dial the GUI's own machine), with link-local IPv6 skipped
  because its scope id has nowhere to go in a `host:port` string. State
  reaches the frontend the way the trust prompts do: a
  `get_discovered_servers` snapshot command plus a
  `discovered-servers-changed` event. 18 unit tests over synthetic event
  sequences (multi-resolve merge, no-op resolve, two families one
  fullname, removal, duplicate removal, removal of an unknown instance,
  re-announce, restart on a new address, interleaved instances, address
  ranking, nothing-dialable, name extraction, wire shape). `mdns-sd`
  0.21 becomes a direct `cannet-gui` dependency — already `adopted` for
  both sides in `technology-inventory.md`, so no inventory change.
- `52650c6` — the connect surface: `serverDiscovery.ts`
  (`useDiscoveredServers` mirrors the host list snapshot-then-event, no
  polling; `matchDiscoveredServers` filters through the same `fzf` the
  rest of the GUI searches with, over instance name + `host:port`) and
  an *on this network* list inside `AddServerInline`, beside the address
  field. Picking a row fills that field and runs the same
  `refresh_interfaces` pull a typed address does — one path, so the Task
  42 trust machinery is untouched by discovery. The empty state says the
  address field is the way to a server that isn't advertising. 11
  frontend tests (6 filter, 5 list/pick/event). Two existing
  `AddServerInline` tests answered `invoke` by call order, which the
  form's new mount-time host read displaced; they now answer by command
  name.

**Test counts**: `cargo test -p cannet-gui` 545 passed, 6 ignored;
`pnpm --dir apps/gui test` 1907 passed across 146 files;
`cargo clippy -p cannet-gui --all-targets` and `pnpm --dir apps/gui
build` clean.

**Live coverage.** `server_browse::tests::browse_a_live_advertisement`,
`#[ignore]`d for the same reason the server's round-trip test is:
registers a `cannet-server`-shaped `ServiceInfo` on a real
`ServiceDaemon`, browses it with a second one, and drives the real
adapter + reducer off the result — asserting the row carries the name,
the `ver`, and the advertised port, then that the goodbye drops it. Run
locally (Windows 11, same host as the phase-1 spike):
`cargo test -p cannet-gui --lib -- --ignored browse_a_live_advertisement`
→ 1 passed in 1.83 s.

Walked once against a **real spawned `cannet-server`** with a temporary
probe (not committed): `cannet-server --bind 127.0.0.1:50099` reduced
through the same code path to

```text
DiscoveredServer { fullname: "RIPPY._cannet._tcp.local.", name: "RIPPY",
                   address: "10.10.10.50:50099", version: Some("v0.8.1-87-g52650c6") }
```

— one row for a machine with six interfaces, the routable IPv4 chosen
out of the pile `enable_addr_auto()` announces, and the vergen stamp
intact. Re-run against `cannet-server --name mdns-off-probe --no-mdns`:
nothing on the wire, so the `--no-mdns` exit criterion holds from the
browse side. Both server processes (and their sidecars) were killed
afterwards; nothing was left running.

**Observation, not a blocker: the advertised address is not the bind
address.** That probe bound `127.0.0.1` and still advertised
`10.10.10.50`, because `enable_addr_auto()` announces every interface
regardless of what the listener is bound to (the phase-2 decision, left
as the simple default). Selecting such a row would offer an address the
server is not listening on. It does not bite a real deployment — a
server meant to be reached binds `0.0.0.0` — and the fix, if it ever
matters, is server-side (advertise the bound addresses), not in the
browse list.

**Not walked here**: the exit criterion's GUI-window half — seeing the
row in a running GUI and connecting through it — and the cross-machine
walk the phase-1 log asks for. Both need the app launched (and, for
cross-machine, the Windows inbound UDP 5353 allow), which is the
owner's to do. Everything below the window is covered by the tests
above.

**Docs**: `plans/features.md`'s "Discoverable on the network" is
checked. README § the connection panel documents the *on this network*
list, the fuzzy search, that a pick is the same path as a typed
address, and both directions of what the list will not show (another
subnet or `--no-mdns` never appears; a killed server can linger to its
TTL). The TOFU walkthrough now names the browse list beside typing an
address. No ADR changed — ADR 0040's discovery bullet was already
amended in phase 2, and the browse is what it described.
