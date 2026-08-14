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

- **Tauri 2** / **React 18 + Vite + TypeScript** — `adopted` in
  Phase 1. Tauri Rust host + system WebView; React/TS/Vite frontend
  inside the WebView. See [`../docs/adr/0003-tauri-shell-react-frontend.md`](../docs/adr/0003-tauri-shell-react-frontend.md).
- **`dockview`** (v6, MIT) — `adopted` in Phase 3 for the
  multi-panel shell. See [`../docs/adr/0005-dockview-panel-layout.md`](../docs/adr/0005-dockview-panel-layout.md).
- **`serde_json`** (Rust) / native JSON (frontend) — adopted Phase 3
  for the project file. Already in the dep graph via Tauri IPC; no
  new crate. See [`../docs/adr/0011-project-file-format.md`](../docs/adr/0011-project-file-format.md).
  Also used by `cannet-spill` for the disk-store reopen manifest
  (`current/manifest.json`: valid-length watermarks, bus-intern table,
  by-id directory) so a prior scratch remaps without an O(capture)
  rebuild scan (ADR 0002 DS-4/DS-7) — same crate, no new dependency.
- **`uuid`** (v1, MIT / Apache-2.0) — `adopted` for `Project::project_id`,
  the stable per-project identity that gates disk-spill scratch reload
  across rename/move (ADR 0002 DS-7). `v4` (random) + `serde` features.
  New direct dependency of `cannet-gui`.
- **`@tanstack/react-virtual`** — `adopted` in Phase 1, `removed` in
  Phase 2. The library's count-based virtualizer doesn't handle the
  browser's CSS dimension cap (≈17M-33M px depending on the engine):
  past ~1.5M rows at 22 px each, scrollTo no longer resolves
  individual rows. Replaced with a hand-rolled scaled-scrollbar
  virtualizer (`apps/gui/src/TraceView.tsx`) that caps the scroll
  container at 16M px and maps scrollTop fractionally to absolute
  row index. ~120 lines, no external dep.
  **Re-confirmed `rejected` for the DBC panel** (Task 41): that panel's
  row list is bounded by the DBC set (thousands of rows, not millions),
  so it needs neither the scroll cap nor the fractional mapping — a
  plain prefix-offset window over the flat row array covers it
  (`apps/gui/src/dbcPanelViewport.ts`, ~110 lines with doc comments,
  unit-tested without a DOM). Variable row heights (the "details"
  toggle's per-row detail block) fall out of the prefix table, and the
  same hand-rolled shape is already in use by `SystemMessagesPanel` —
  not worth a dependency for one more call site.
- **`dnd-kit` / `react-dnd`** (drag-and-drop libraries) — `rejected`
  for the gridview cross-panel drag work (task 51). Rationale in
  [`../docs/adr/0045-cross-panel-drag-payloads.md`](../docs/adr/0045-cross-panel-drag-payloads.md):
  raw HTML5 DnD must interoperate with dockview's native tab drag,
  and the hand-rolled surface (one mime type, payload
  encode/decode, dragover feedback) is small and mime-scoped.
- **`tauri-plugin-window-state`** (v2, MIT / Apache-2.0) — `adopted`
  to persist the main window's size / position / maximized / fullscreen
  state across launches (machine-local app state, not project data, so
  it lives in `app_config_dir`, not the project file — see
  [`../docs/adr/0032-machine-local-ui-state-host-side.md`](../docs/adr/0032-machine-local-ui-state-host-side.md)).
  The host owns a small off-screen guard
  (`window_state::ensure_on_screen`) on top of the plugin's restore: the
  window is borderless, so a restored position that lands off every
  connected monitor would leave its title bar unreachable — the guard
  recentres it on the primary monitor.
- **`@xyflow/react`** (formerly `react-flow`, MIT) — `adopted` in
  Phase 6 for the project graph view. See [`../docs/adr/0006-xyflow-project-graph.md`](../docs/adr/0006-xyflow-project-graph.md).
- **`fzf`** (BSD-3-Clause, npm: `fzf`, repo:
  [`ajitid/fzf-for-js`](https://github.com/ajitid/fzf-for-js)) —
  `adopted` in Phase 12 (DBC panel) as the fuzzy / acronym matcher
  used by the DBC panel's search; reused by Task 16's command
  palette (`Cmd/Ctrl+Shift+P`) and go-to-view palette
  (`Cmd/Ctrl+P`). Port of VS Code / fzf's matcher — camelHump and
  abbreviation matching ("MyCanMessage" reachable from "mcmess"),
  ranking, scored result ordering. Synchronous `Fzf` constructor +
  `find(query)` is plenty for the DBC panel's bounded-size
  candidate list; the async variant is available if the command
  palette ever needs it. The package's published name is `fzf` (not
  the `fzf-for-js` from earlier planning notes) — the repo name is
  `fzf-for-js` but it shipped on npm without the suffix. ~70 kB
  unpacked, ships its own TypeScript declarations.
  **Rejected alternatives:** `fuse.js` (popular but Bitap-based —
  no camelHump / acronym matching, lower-quality ranking for
  identifier-shaped haystacks); `kbar`'s built-in matcher
  (only ships as part of `kbar`'s command-palette package and would
  drag `kbar` in for the search-matcher use). See
  [`../docs/adr/0018-command-keybinding-framework.md`](../docs/adr/0018-command-keybinding-framework.md).
- **`react-jsonschema-form`** (@rjsf, Apache-2.0) — `rejected` (Task 18
  Step 6). Schema-driven settings form generator; the obvious "VS Code-like
  settings" candidate. Rejected as premature: the frontend stack is
  deliberately lean (no component/form library) and the initial settings
  count is two, so a schema-driven framework is an abstraction for
  single-use code with generic styling that fights the app's bespoke
  panels. A flat in-repo panel is used instead. **Revisited when settings
  did proliferate, and still `rejected`:** the answer was an in-repo
  per-setting descriptor served by the host, with the panel generated
  from it, reusing `fzf` for search — no dependency, a schema that lives
  beside the struct it describes, and the app's own styling. See
  [`../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md`](../docs/adr/0034-settings-vs-state-and-custom-settings-panel.md)
  decision 4.

### CAN / CANFD Abstraction

In-process: a hand-written `cannet-core` crate defines the frame types and
producer/consumer interfaces. No external dependency for the abstraction
itself — kept deliberately small so a network transport can slot in later
without reshaping callers.

- Network transport: **tonic / gRPC over HTTP/2** + **prost** —
  `adopted` (Phase 2). Schema in `crates/cannet-wire`, `tonic-build`
  codegen on both ends. See [`../docs/adr/0004-grpc-wire-protocol.md`](../docs/adr/0004-grpc-wire-protocol.md).
- **tonic `tls` feature (rustls 0.23, `ring` backend)** — `adopted`
  (Task 42) on `cannet-server` and `cannet-client`.
  Transport security for the production cannet server's public
  endpoint per
  [ADR 0041](../docs/adr/0041-remote-connection-security.md). Not a
  mere feature flip: rustls was absent from the lock; enabling
  `tonic/tls` added rustls 0.23 + tokio-rustls + rustls-webpki +
  rustls-pki-types + subtle. `cannet-server` also takes `rustls` as a
  direct dep (`default-features = false, features = ["ring", "std",
  "logging", "tls12"]` — the defaults would pull `aws-lc-rs`) to
  install the process-level crypto provider explicitly at startup;
  everything in the tree stays on that one backend (see the Task 42
  plan review, B1). Loopback links stay plaintext; the wire
  crate does not hard-require TLS.
- **A hand-written pinning connector, not `hyper-rustls`** —
  `adopted` (Task 42) for `cannet-client`; `hyper-rustls` 0.27
  `rejected`. tonic 0.12's `ClientTlsConfig` cannot carry a custom
  `ServerCertVerifier`, so a fingerprint-pinning client has to dial
  through `Endpoint::connect_with_connector` with its own
  `rustls::ClientConfig` (and set `alpn_protocols = [b"h2"]` itself —
  nothing on that path does it for you). Both candidates were weighed
  on tree cost and on hand-written surface: `hyper-rustls` is a crate
  the lock does not have, and it buys ~25 lines — connect a
  `TcpStream`, wrap it in `tokio_rustls::TlsConnector`, hand tonic a
  `hyper_util::rt::TokioIo`. `cannet-client` therefore takes `rustls`,
  `tokio-rustls`, `hyper-util` and `tower` as direct deps, all four
  already in the lock as tonic's own dependencies, so the dependency
  tree does not grow at all. `ring`, `base64` and `subtle` become
  direct deps for the same reason (fingerprint digest, its display
  form, constant-time pin compare) — likewise already present.
  Spike outcome that fixed the shape: with tonic's `tls` feature
  compiled in, its internal `Connector` intercepts any `https://` URI
  and refuses it unless *tonic's* TLS config is set, so the pinned
  endpoint is dialled as `http://` and the connector does the TLS.
- **`rcgen` 0.14** (Rust, MIT / Apache-2.0) — `adopted` (Task 42),
  direct dep of `cannet-server`. Generates the server's self-signed
  keypair/certificate on first run (ADR 0041). The de-facto Rust
  cert-generation crate (used by rustls' own test infra); alternative
  is shelling out to `openssl`, which reintroduces a runtime binary
  dependency. Taken with
  `default-features = false, features = ["crypto", "pem", "ring"]` —
  its default `aws-lc-rs` backend would collide with rustls-`ring`
  at runtime (plan review, B1) and cost a cmake/C toolchain.
- **`ring` 0.17** — `adopted` (Task 42), direct dep of
  `cannet-server`; already in the tree as rustls' crypto backend.
  Supplies SHA-256 for the certificate fingerprint (and later the
  token's CSPRNG and constant-time compare), so no `sha2`.
- **`rustls-pemfile` 2** — `adopted` (Task 42), direct dep of
  `cannet-server`; already in the tree under `tonic/tls`. Extracts
  the end-entity certificate's DER from the PEM the fingerprint is
  taken over. The alternative was hand-rolled PEM/DER scanning, which
  is exactly the kind of surface we don't hand-roll.
- **`dirs` 6** (Rust, MIT / Apache-2.0) — `adopted` (Task 42), direct
  dep of `cannet-server`; already in the lock via Tauri. Resolves the
  per-user data directory the generated identity is persisted in. The
  headless server has no Tauri path API, and hard-coding
  `%LOCALAPPDATA%` / `$XDG_DATA_HOME` / `~/Library` per OS is the
  same surface with more ways to be wrong.
- **`base64` 0.22** — `adopted` (Task 42), direct dep of
  `cannet-server`; already in the lock via the perf harness. Renders
  the fingerprint's standard-alphabet unpadded form (and later the
  token's base64url). Pinned to the version already in the lock so the
  build does not carry two `base64` majors.
- **Token-auth support crates** — resolved (Task 42). `ring`'s
  `SystemRandom` mints the 256-bit token and `base64` (above) renders
  it, so neither is a new dependency. `getrandom`/`rand`/`sha2` —
  `rejected` as direct deps (redundant with ring). No
  structured-token library (JWT/PASETO) — there are no claims to
  carry (ADR 0041 rejected accounts/tiers).
- **`subtle` 2.6** (Rust, BSD-3-Clause) — `adopted` (Task 42), direct
  dep of `cannet-server`; already in the lock as rustls' own
  constant-time primitive. Compares a presented bearer token against
  the server's. It was listed `rejected` as redundant with
  `ring::constant_time` until the code met the crate: ring 0.17.14
  renamed that module `deprecated_constant_time` and deprecated
  `verify_slices_are_equal` as "internal, no promises regarding side
  channels" — precisely the promise a credential compare needs. Both
  crates were named as acceptable when the token was groomed; the
  remaining alternative is hand-rolling the XOR-fold, which is the
  kind of primitive we don't hand-roll.
- **`mdns-sd` 0.21** (Rust, Apache-2.0 OR MIT) — `adopted` (Task 43)
  for **both** sides of discovery per
  [ADR 0040](../docs/adr/0040-production-cannet-server.md): the
  server's `_cannet._tcp` advertisement and the GUI host's browse.
  It is the only credible pure-Rust crate covering register *and*
  browse, so one dependency and one wire behaviour serve both
  consumers instead of two mDNS stacks contending for UDP 5353.
  Runs its own daemon thread and communicates over `flume` channels,
  so the tokio server registers without blocking and the Tauri
  host's browse task awaits `recv_async()` — no async runtime is
  imposed on either side, and none is pulled in. Dep tree is seven
  crates (`fastrand`, `flume`, `if-addrs`, `log`, `mio`,
  `socket-pktinfo`, `socket2`); no tokio. Actively maintained —
  0.21.0 landed 2026-08-10, two days before this eval — with ~157
  direct dependents. Exercised in a two-process spike on Windows 11;
  the Task 43 status log carries the measured latencies and the
  event-shape notes the implementation has to honour.
- **`libmdns` 0.10** (Rust, MIT) — `rejected` (Task 43).
  Register-only: no querier surface at all, so adopting it would
  still leave the GUI needing `mdns-sd`, and the GUI-plus-sidecar
  case would run two mDNS implementations in one process tree. The
  spike confirmed it advertises correctly and that dropping its
  `Service` handle emits a goodbye (`mdns-sd`'s browser removed the
  instance ~1.0 s later), so this is a scope rejection, not a
  quality one. Last release 2025-09-06, ~11 months stale against
  `mdns-sd`'s active cadence. It also always answers with the real
  system hostname unless the `_and_hostname` constructor variant is
  used, which is one more thing to get right for no gain.
- **`zeroconf`** (Rust, FFI) — `rejected` (Task 43). Covers register
  and browse, but binds native stacks: Avahi on Linux, Apple's
  Bonjour / `mDNSResponder` on Windows and macOS. Windows does not
  ship Bonjour, so adopting it would add a third-party runtime
  install to cannet's prerequisites on its primary development
  platform. The repo prefers permissive-license pure Rust, and a
  pure-Rust option that works is on the table.
- **`simple-mdns`** (Rust, MIT) — `rejected` (Task 43). Covers both
  sides and is maintained (0.7.0, 2026-05-15), but has ~90
  downloads/month and 3 direct dependents against `mdns-sd`'s ~684k
  and 157. For a protocol whose failure modes are all in the field —
  interface enumeration, cache expiry, goodbye handling — field
  exposure is the evidence that matters, and there is no
  differentiating capability to trade for it.
- **`agnostic-mdns`** (Rust, Apache-2.0 OR MIT) — `rejected`
  (Task 43). Covers both sides, but its last release is 0.4.2 on
  2025-03-16, ~17 months stale, and it exists to abstract over async
  runtimes — a generality cannet has no use for, since it needs mDNS
  from exactly one tokio process and one Tauri process.
- A **hand-rolled UDP beacon** remains `rejected` — see ADR 0040.
- **`hostname` 0.4** (Rust, MIT) — `adopted` (Task 43 phase 2), direct
  dep of `cannet-server`. Supplies `--name`'s default: the system
  hostname, for the `ServiceInfo` DNS-SD instance name and SRV host.
  No `std` equivalent exists; the crate is a thin, permissively
  licensed wrapper over the platform call (`gethostname(2)` /
  `GetComputerNameExW`) rather than hand-rolled per-OS FFI. Small
  dependency footprint: `cfg-if` plus `libc` on Unix or
  `windows-link` on Windows, both already common in the tree.
- **MDF 4.x library** — evaluated 2026-08-12 for Task 38, covering
  **read and write** in one pass. Outcome is an explicit split:
  **`mdf4-rs` 0.6 `adopted` for reading; the writer is ours.** The
  eval exercised a user-provided logger corpus (14 MF4 4.10 files)
  and a synthetic asammdf-generated fixture matrix
  (sorted/unsorted × finalized/unfinalized × classic/FD × DZ),
  with Python **asammdf** as the oracle.
  - **`mdf4-rs` 0.6** (MIT/Apache-2.0, pure Rust,
    `#![forbid(unsafe_code)]`, ~19.5k LOC) — `adopted` for read.
    Its block layer, record iteration, record-ID demultiplexing,
    unfinalized-file recovery and conversion (CC) handling are
    sound: over the user corpus its decode of plain signal channel
    groups matched asammdf on every one of 3,731 channel rows.
    Two gaps qualify the adoption:
    - **It does not follow `cn_composition`** (the `##CN`
      `component_addr` link), so its own `channels()` never exposes
      `CAN_DataFrame.ID`/`.DLC`/`.DataBytes`/… and it yields no
      frames from any conformant bus-logging file. It *does* parse
      and expose that link, expose the parent structure channel's
      whole record slice, and expose the mmap and block parsers —
      so **cannet owns a thin bus-logging composition layer** on
      top of it. A spike of that layer decoded frames
      byte-identically to asammdf on all 14 corpus files and on 6
      of 7 synthetic fixtures (classic, FD, error + remote frames,
      unsorted, and unsorted-plus-unfinalized).
    - **DZ-compressed data blocks fail to read.** `DzBlock` and its
      `decompress()` exist behind the `compression` feature, but the
      data-block resolver used by the record iterator accepts only
      `##DT`/`##DV`/`##DL`/`##HL` and errors on `##DZ`. CANedge
      writes DZ and the task requires it.
  - **What `cannet-mdf` ends up using** (settled when the reader
    landed, and the reason both gaps above cost less than they
    look). `mdf4-rs`'s *reader* types (`MDF`, `ChannelGroup`,
    `Channel`) are unusable here on their own terms: they borrow a
    file struct the crate only builds privately from a path
    (`MdfFile` and friends are `pub(crate)`), so a streaming
    `CanFrameSource` holding a position across calls would need a
    self-referential struct, and the DZ-aware
    `resolved_data_blocks` is out of reach behind the same privacy.
    So cannet walks `HD → DG → CG → CN` itself and holds records as
    `(chunk, offset)` indices — which makes DZ just another chunk,
    with no temp-file pre-pass and no byte patching, and makes the
    composition layer fall out of the same walk. What stays
    borrowed is the part worth borrowing and 90% of the risk:
    every block parser (`##ID`/`##HD`/`##DG`/`##CG`/`##CN`/`##SI`/
    `##TX`/`##CC`/`##DT`/`##DL`/`##DZ`), the bit-level value
    decoder, the CC conversion machinery, and the DZ inflate with
    its inverse transposition.
    - Cost paid: mdf4-rs 0.6 declares MSRV **rustc 1.97.0**, so
      `rust-toolchain.toml` moved **1.96.0 → 1.97.1** when the crate
      was adopted. The bump was clean — no new clippy pedantic lints
      anywhere in the workspace.
  - **`mdf4-rs`'s writer** — `rejected`. Its bus-logging writer
    emits a proprietary layout: one opaque `CAN_DataFrame` byte
    array per record, no composition, groups split by IDE, and
    `cg_flags` left at 0 with the bus-event bit unset. asammdf opens
    the output but its bus-logging map comes back empty — it does
    not recognise the file as CAN bus logging, so neither would
    Vector or CANape. mdf4-rs's *block serializers* do write
    `component_addr`, so the in-repo writer can build conformant
    composition on top of them; only the high-level writer API is
    unusable. **Settled when the writer landed**: `MdfCaptureWriter`
    does exactly that — `mdf4-rs` serializes every block
    (`##ID`/`##HD`/`##DG`/`##CG`/`##CN`/`##SI`/`##TX`/`##MD`/`##EV`/
    `##AT`/`##FH`), cannet lays them out and writes the composition,
    and asammdf reads the result as CAN bus logging with a non-empty
    `bus_logging_map`.
  - **`mdflib` (ihedvall) via the `mdflib` / `mdflib-sys` crates** —
    `rejected`. The C++ library is the mature reference and covers
    everything the task needs (including `Edl`/`Brs`/`Esi`), but the
    binding does not. Measured costs: `mdflib-sys` vendors ~13 MB of
    C++ and its build script drives **cmake** plus a C++ compiler,
    with **zlib and expat as external `find_package(REQUIRED)`
    dependencies** — vcpkg on Windows, distro packages on
    Linux/macOS — on every developer machine and CI runner across
    three OSes. The Rust binding is ~4.6k LOC with ~326 `unsafe`
    sites, three releases, and is described by its own author as a
    proof of concept; it **does not expose the CAN FD flags at all**,
    which the round-trip fidelity contract makes non-negotiable, so
    adoption would begin by extending someone else's unsafe FFI.
    This is the same shape of gap that
    [ADR 0009](../docs/adr/0009-dbc-blf-readers.md) rejected
    `vector_blf` for.
  - Confirmed still dead on crates.io: `mdf4` 0.0.1 (2022, single
    release) and `asammdf` 0.1.0 (2024, single release); `mdfr` is
    not published on crates.io at all.
  - Python **asammdf** remains a dev/CI-time oracle and fixture
    generator only — never a runtime dependency.
- **`async-stream`** crate (v0.3, MIT) — `adopted` in Phase 2 as a
  wire-crate stream-adapter helper; **removed 2026-07-26**: its last
  consumer (`cannet-wire`'s `batch.rs` stream adapters) was deleted as
  dead code, and `cannet-server` streams via `tokio-stream`'s
  `ReceiverStream` instead. See ADR 0004 § Consequences.
- **`clap`** crate (v4, MIT/Apache) — `adopted` in Phase 2 for the
  `cannet-server` CLI (positional BLF path, `--bind` address). The
  Rust ecosystem standard for derive-macro CLI parsing; small
  enough not to be controversial.
- **`tracing`** + **`tracing-subscriber`** (Rust, MIT) — adopted
  Phase 7. `tracing` was already a transitive dep via tonic / tokio;
  `tracing-subscriber` is newly direct. Used by the host system log
  bus — see [ADR 0014](../docs/adr/0014-host-system-log.md).
- **`crc`** crate (+ its `crc-catalog` companion; Rust, MIT /
  Apache-2.0) — `adopted` in Task 14 for calculated CRC fields on
  transmitted messages and decode-side verification
  ([ADR 0027](../docs/adr/0027-calculated-fields-counter-crc.md)).
  Table-driven, `no_std`, the de-facto Rust CRC implementation;
  `crc-catalog` supplies the named-algorithm catalogue
  (`CRC-8/SAE-J1850`, `CRC-8/AUTOSAR`, …) that cannet exposes
  directly, so the "which named configs ship" question costs zero
  curation. Custom Rocksoft parameter sets use the same
  `Algorithm` struct. **Rejected alternative:** a hand-rolled
  table — the crate is small, vetted, and parameterizable; rolling
  our own is review surface with no upside.

### Hardware Drivers

- **`python-can`** (LGPL-3.0-only) — `adopted` in Phase 8. Wrapped
  by the `cannet-python-can` sidecar. Now **redistributed** — frozen
  into the sidecar onedir, making the installer a Combined Work under
  LGPL-3.0 §4. See [`../docs/adr/0008-python-can-sidecar.md`](../docs/adr/0008-python-can-sidecar.md),
  [ADR 0036](../docs/adr/0036-frozen-python-can-sidecar.md), and
  [`../servers/cannet-python-can/LICENSING.md`](../servers/cannet-python-can/LICENSING.md).
- **PyInstaller** (GPL-2.0-or-later **with** the bootloader exception)
  — `adopted` in Task 31 as the freeze tool that builds the sidecar
  onedir. A build tool only: its terms do not attach to our shipped
  artifact (the bootloader exception permits distributing the frozen
  output under any license). See
  [ADR 0036](../docs/adr/0036-frozen-python-can-sidecar.md).
- **`uv`** (Rust, Apache-2.0 / MIT) — `adopted` in Phase 8, now
  **developer-only**. Astral's Python package & project manager. Manages
  the sidecar's venv for local dev (`uv run cannet-python-can`) and feeds
  the frozen sidecar build (Task 31). No longer an end-user runtime
  dependency — end users get the frozen sidecar binary. See
  [ADR 0036](../docs/adr/0036-frozen-python-can-sidecar.md), which
  supersedes the end-user-fetch part of
  [ADR 0015](../docs/adr/0015-fetched-runtime-binaries.md).
- **`grpcio`** + **`grpcio-tools`** (Python, Apache-2.0) —
  `adopted` in Phase 8 as the sidecar's gRPC runtime. `grpcio` is now
  **redistributed** (frozen into the sidecar onedir). See
  ADR 0008.
- **Vector XL Driver Library** / **Kvaser CANlib** /
  **PEAK PCAN-Basic** — `adopted` as runtime, user-installed
  vendor dependencies; not bundled. See ADR 0008.
- **`windows-sys` (job objects)** / **`libc` (`setpgid` + `killpg`)** —
  `rejected` as the way a host kills a wedged sidecar's whole process
  tree (the backstop when the graceful stdin-EOF stop times out). Both
  are `unsafe` FFI, which the workspace forbids outside
  `crates/cannet-spill`, and a job object additionally has to be created
  and assigned at spawn time. `cannet-sidecar` stays dependency-free
  instead: `std::os::unix::process::CommandExt::process_group` (safe,
  stable) makes the child a group leader on Unix, and each OS's own tool
  does the walking — `kill -KILL -<pgid>` there, `taskkill /T /F` on
  Windows, which follows the parent link Windows already records.

### File Formats

Decisions: [`../docs/adr/0009-dbc-blf-readers.md`](../docs/adr/0009-dbc-blf-readers.md)
— `can-dbc` for DBC parsing (semantics in `cannet-dbc`); for BLF,
our own focused reader/writer in `cannet-blf` (no third-party BLF
crate retained long-term).

- **DBC** — CAN signal database.
  - **`can-dbc`** (v9, MIT/Apache) — adopted Phase 1. See ADR 0009.
- **EDS** — CANopen Electronic Data Sheet. Library TBD; not in scope
  until CANopen work begins.
- **BLF** — Vector binary log format. Implementation lives in
  `cannet-blf`; the per-object-type coverage matrix is maintained
  in [`../docs/blf-feature-support.md`](../docs/blf-feature-support.md).
  - **`blf_asc`** (v0.2, MIT/Apache) — `adopted` Phase 1, `retired`
    Phase 10. The native reader/writer in
    `cannet-blf::format::{reader, writer}` covers everything the
    wrapper used to. See ADR 0009.
  - **`vector_blf`** (Technica-Engineering, C++, GPL-3.0-or-later) —
    `adopted` Phase 10 as a test-only black-box oracle. Cloned at
    a pinned upstream ref into `target/` at test time, never
    vendored, never shipped in cannet's runtime binary; its GPL
    posture stays outside the runtime distribution. Gated behind
    the `vector-blf-oracle` cargo feature so default CI doesn't
    require a C++ toolchain. See ADR 0009 "Test coverage strategy"
    §4.
  - **`flate2`** (v1, MIT / Apache-2.0) — `adopted` Phase 10 for
    `LOG_CONTAINER` zlib inflate/deflate. Default
    backend (`rust_backend` → `miniz_oxide`) keeps the build
    pure-Rust and matches `vector_blf`'s on-the-wire format
    (raw zlib, not gzip). The crate is already in `Cargo.lock`
    transitively, so this is a direct-dep promotion rather than
    a new tree node.

### Storage

- **`memmap2`** crate (Rust, MIT / Apache-2.0) — `adopted`.
  Cross-platform `mmap` syscall abstraction for the disk-spill raw
  store. See [`../docs/adr/0002-disk-spill-store.md`](../docs/adr/0002-disk-spill-store.md).
  Lives in the dedicated `crates/cannet-spill` crate, which owns the
  raw `RawStore` trait, the in-RAM `MemRawStore` test double, and the
  disk-backed `DiskRawStore`. That crate is the *only* place the
  workspace's `unsafe_code = "forbid"` policy is relaxed (to `deny`,
  with justified per-site `#[allow]`s): mapping a file is inherently
  `unsafe`, and containing it to one focused crate keeps the
  failure-mode-rich surface reviewable and every other crate
  `unsafe`-free.
- **`dirs`** crate (Rust, MIT / Apache-2.0) — `rejected` as a direct
  dependency. Was briefly adopted to resolve the per-OS cache directory
  the disk-spill scratch lives under, but that put the scratch at a bare
  `<cache>/cannet/current` while config and logs sat under the app
  identifier (`dev.cannet.app`). The scratch now resolves through
  Tauri's `PathResolver::app_cache_dir()` (ADR 0002 DS-7), which already
  handles the per-OS location (XDG on Linux, `Library/Caches` on macOS,
  `LocalAppData` on Windows) and roots under the same identifier as the
  other host dirs — so no separate crate is needed. `dirs` remains in
  the graph transitively via `tauri`; we just no longer depend on it
  directly.
- **`notify`** crate (Rust, CC0-1.0 / Apache-2.0) — `adopted` in
  Phase 12 follow-up for the GUI host's DBC file watcher
  (`apps/gui/src-tauri/src/dbc_watcher.rs`). Wraps the OS-native
  watchers (FSEvents on macOS, inotify on Linux,
  ReadDirectoryChangesW on Windows) behind one interface; we use
  it to auto-reload a loaded DBC when its file changes on disk
  and emit a `dbc-changed` event the DBC panel + plot panel
  listen for. We watch parent directories with a refcount + filter
  events by exact path because watching a single file directly
  loses the watch on atomic-rename saves on several editors.

### Protocols

- CAN 2.0 A/B
- CAN FD
- CANopen (SDO, PDO)

### Plotting / Visualization

- **uPlot** (MIT) — `adopted` in Phase 4 for the plot panel
  renderer. See [`../docs/adr/0007-uplot-plot-renderer.md`](../docs/adr/0007-uplot-plot-renderer.md).

  Reference design: `plans/plot-panel-reference.html` — a
  standalone prototype (5 stacked panes × 4 signals, synced
  x-zoom across panes, per-pane y-zoom, global X cursors +
  per-pane Y cursors with Δt / 1/Δt / Δy readouts, event marker
  lines + user notes, a perf badge strip). The shape the plot
  panel should grow toward; the current single-pane
  `PlotPanel.tsx` is the first step, not the destination.

### Build / Packaging / CI

- **GitHub Actions** — `adopted` for CI and releases. `ci.yml` runs the
  test + lint suite on pull requests and pushes to main (Linux);
  `release.yml` is dispatched manually and builds bundles on
  `macos-latest` (Apple Silicon) and `windows-latest` (x64). Tauri
  cannot cross-compile, so each target builds on its native runner.
- **Pinned toolchains** — `adopted` so local and CI run identical
  versions (the workspace opts into `clippy::pedantic`, so a floating
  stable would keep breaking the `-D warnings` gate as new lints land).
  Rust is pinned in [`../rust-toolchain.toml`](../rust-toolchain.toml)
  (rustup auto-installs it); pnpm via the `packageManager` field in
  `apps/gui/package.json` (Corepack / `pnpm/action-setup` honour it).
  Bump either deliberately, fixing any new lints in the same change.
- **`tauri-apps/tauri-action`** (`v0`) — `adopted` to drive
  `tauri build` and upload the resulting bundles to a GitHub Release in
  the release workflow. MIT.
- **`vergen`** (v8, `git` + `gitcl` features; build-dependency in
  `cannet-gui`) — `adopted` to stamp the binary with
  `git describe --tags` at build time so a packaged build reports the
  exact tag/commit it was cut from. The committed version stays `0.0.0`;
  the installer/bundle version is injected from the release tag in CI.
  `gitcl` shells out to the `git` already required to build. MIT /
  Apache-2.0. Also a build-dependency of `cannet-server` since Task 43
  phase 2, stamping the same version string into the mDNS TXT record's
  `ver=` key — same pattern, no new crate.
- **PyInstaller** (Python, GPL-2.0-with-bootloader-exception; the
  exception lets the frozen output ship under any license) — `adopted`
  in Task 31 to freeze the `cannet-python-can` sidecar into a
  self-contained onedir binary (embedded CPython + `grpcio` / `protobuf`
  / `python-can`), so an installed cannet launches the sidecar with no
  Python, `uv`, or network. Run via `uv run --with pyinstaller`; the
  dynamic-import collection recipe is pinned in `scripts/build-sidecar`.
  See [ADR 0036](../docs/adr/0036-frozen-python-can-sidecar.md).
- **`pre-commit`** (Python, MIT) — `adopted` as the local commit-gate
  runner ([`../.pre-commit-config.yaml`](../.pre-commit-config.yaml)).
  Used purely as an orchestrator: every hook is `repo: local` /
  `language: system` and invokes the tools already pinned elsewhere
  (`uv`, `cargo`, `pnpm`), so no third-party hook repos / versions are
  imported and the checks mirror `ci.yml`. Also carries two local
  guard hooks (`scripts/check_local_paths.py`,
  `scripts/relativize_project_paths.py`) that keep machine-local
  absolute paths out of the repo, and two hook drivers
  (`scripts/cargo-test-touched.sh`, `scripts/frontend-gate.sh`) that
  scope the Rust test run to the crates a commit touches and run the
  frontend typecheck and vitest suite concurrently. Installed per-clone via
  `pre-commit install`; the tool itself is a dev-only dependency
  (`uv tool install pre-commit` / `pipx`).
- **`cargo-packager` 0.11.8** (CrabNebula; Rust CLI, MIT / Apache-2.0)
  — `adopted` in Task 64 for the **Windows NSIS server installer only**,
  as a CI/dev tool (`cargo install cargo-packager --locked --version
  0.11.8`), never a workspace dependency. It downloads and caches its own
  pinned NSIS 3.09 toolchain, so no runner needs a separate NSIS install.
  Evaluated hands-on, then shipped: the committed config
  (`crates/cannet-server/packaging/`) installs to
  `%LOCALAPPDATA%\Programs\cannet-server` with the onedir exe-adjacent,
  appends the install dir to the user `PATH`, writes a standard
  uninstall entry, and on uninstall restores the user `PATH`
  byte-for-byte and leaves nothing behind; the installed server,
  launched from an unrelated working directory, found its sidecar and
  enumerated PCAN hardware.
  - The user-`PATH` append has no config field. It rides in
    `nsis.preinstallSection`, which injects verbatim NSIS at top level —
    room for both an install section and an `un.` section, so the entry
    is added and removed symmetrically. The edit itself goes through
    PowerShell's `[Environment]::SetEnvironmentVariable(…, 'User')`: the
    bundled NSIS is built with `NSIS_MAX_STRLEN=1024`, so reading and
    rewriting `PATH` in NSIS strings would silently truncate a long one.
  - The "no Start-menu shortcut" ruling needs `nsis.template` — a
    vendored copy of the upstream 671-line `installer.nsi`. The fork is
    deletion-only (48 lines removed, 623 remain, no line added), so it
    re-applies cleanly across version bumps and a `diff` against the
    pinned upstream copy showing any added line means the fork drifted —
    but it does commit us to re-diffing the template whenever
    `cargo-packager` moves.
  - The install directory has no config field either; `preinstallSection`
    carries an `InstallDir` line, since NSIS accepts that attribute at
    top level. The template's `currentUser` default,
    `$LOCALAPPDATA\<product name>`, is the directory the running server
    already keeps its state in.
  - `rejected` for the Linux `.deb` leg. Its deb writer copies
    `binaries` into `/usr/bin` as real files and `resources` into
    `/usr/lib/<binary>/`, exposes no maintainer-script hook, and its
    `deb.files` map copies through `fs::copy` — so the agreed layout
    (everything under `/usr/lib/cannet-server/`, `/usr/bin/cannet-server`
    a symlink so `current_exe` still resolves beside the onedir) is not
    expressible. The module is `cfg`-gated to Linux/BSD besides, so it
    cannot be exercised on a Windows dev box at all.
  - No macOS flat-package output (formats are `app`, `dmg`, `wix`,
    `nsis`, `deb`, `appimage`, `pacman`), which is why the `.pkg` leg
    uses Apple's `pkgbuild`.
  - Maintenance: 468 stars, repo actively tended (dependency bumps land
    weekly), but the last crates.io release is 0.11.8 from 2025-11-27 and
    62 issues are open. Company-backed (CrabNebula, the Tauri bundler
    extracted for arbitrary binaries), so no single-person bus factor.
  - Rough edges worth knowing: auto-discovery of a standalone
    `packager.toml` fails with an I/O error unless the config sets
    `name`, and the CLI has no version override — the release version
    gets patched into the config (or passed as raw JSON to `-c`) the way
    `tauri.conf.json`'s already is.
- **`cargo-deb` 3.7.0** (Rust CLI, MIT) — `adopted` in Task 64 for the
  Linux `.deb` server package, after `cargo-packager`'s deb writer proved
  unable to express the agreed layout (above). `assets` entries carry an
  explicit target path and octal mode, and a symlink is an asset table of
  `dest` + `link_name` — exactly the shape needed (binary + onedir under
  `/usr/lib/cannet-server/`, `/usr/bin/cannet-server` a symlink). It
  reads `[package.metadata.deb]` from the crate it packages, so the
  config lives with `cannet-server`, and `maintainer-scripts` are
  available if a `postinst` ever becomes necessary (none is planned).
  Single-maintainer project (bus factor 1) but nine years of releases,
  ~2.1M downloads, 23 open issues, 3.7.0 released 2026-05-02.
  - It is pure Rust, so it **built a real `.deb` on the Windows dev
    box** (with a stand-in binary), which is how the layout was checked
    without a Linux runner. Two things only Linux can do: read each
    onedir file's mode (asset `mode` is therefore left off, so the
    frozen launcher keeps its exec bit) and run `dpkg-shlibdeps` for
    `$auto` dependency resolution.
  - `target/release/…` is a magic asset prefix that cargo-deb rewrites
    for whatever `--target` it was given — spelling a cross-compilation
    triple into the config is rejected outright.
  - `--no-strip` is passed so the packaged binary is byte-for-byte the
    one in the tar.gz; the default would strip it, and on this repo's
    profile that also means splitting out debug symbols.
- **`pkgbuild`** (Apple, ships with macOS) — `adopted` in Task 64 to
  build the macOS server `.pkg`. Present on every macOS runner, so it
  adds no dependency; chosen because `cargo-packager` emits no flat
  package and `.pkg` is the canonical installer for a CLI tool.
- **Code signing / notarization** — `proposed` (deferred). First alpha
  bundles ship **unsigned**; macOS Gatekeeper / Windows SmartScreen warn
  on first run. Signing needs external accounts (Apple Developer Program;
  a Windows OV/EV cert or Azure Trusted Signing) and is wired through
  `tauri-action`'s signing env vars once those exist.

### Testing / Profiling

- **`tempfile`** crate — `adopted` in Phase 1 (dev-dependency only). Used by
  `cannet-blf` tests to round-trip BLF fixtures through a real file. MIT /
  Apache-2.0.
- **Vitest** (v2, dev-dependency in `apps/gui`) — `adopted` in Phase 2 for
  frontend unit tests. Most suites are the pure logic modules
  (`traceViewport.ts`, `traceColumns.ts`, `trace.ts`, `plotData.ts`,
  `plotCursors.ts`) running without a DOM. Pinned to v2 because v3+
  requires Vite 6+ while the app is on Vite 5. MIT. Run via
  `pnpm --dir apps/gui test`.
- **`@testing-library/react` + `@testing-library/jest-dom` + `jsdom`**
  (dev-dependencies in `apps/gui`) — `adopted` in Phase 4 for the
  occasional React component test where the state machine is worth
  exercising directly (`PlotPanel.dom.test.tsx`: plot-area add/remove,
  picking/moving signals, toggling measurements). uPlot and the Tauri
  `invoke` bridge are `vi.mock`-ed, so these don't need a real canvas or
  backend; the file opts into the `jsdom` environment via a
  `// @vitest-environment jsdom` docblock. MIT. Kept lightweight — the
  pixel-level overlay drawing and canvas event wiring stay untested at
  this layer; their maths live in tested pure modules.
- **`cargo-nextest`** (v0.9.143, MIT / Apache-2.0) — `proposed` then
  **`rejected`** as the runner for the local commit gate. Evaluated
  because it parallelises across test binaries and reports better than
  `cargo test`; measured on Windows (warm target dir), it is *slower*
  here, because it spawns one process per test and Windows process
  creation is expensive:

  | run (warm) | `cargo test` | `cargo nextest run` |
  | --- | --- | --- |
  | `--workspace` (814 tests) | 17.3 s | 18.3 s |
  | `-p cannet-gui` (443 tests) | 4.7–5.2 s | 8.9–9.3 s |
  | `-p cannet-dbc` (111 tests) | 1.0–2.1 s | 3.1 s |

  There is also nothing left to win: the commit gate runs the tests of
  the *touched* crates only, so its test-execution share is 1–5 s, and
  the rest of its cost is codegen and linking, which nextest does not
  change. Against that it would add an unpinned prerequisite for every
  clone (`cargo install cargo-nextest --locked` took 3 m 35 s from
  source here) and would silently stop running doctests — the workspace
  has none today, so nothing is lost yet, but a future one would be
  invisible locally while CI kept running it. Revisit if the workspace's
  test *execution* time (not build time) becomes the gate's bottleneck.

- **`tungstenite`** (v0.30, no default features, `handshake` only) +
  **`ureq`** (v3, no default features) + **`png`** (v0.18) +
  **`base64`** (v0.22), all in `crates/cannet-perf-measurement` — `adopted`
  for the harness's visual-parity check (`screenshot` /
  `screenshot-diff`). The capture drives the shipping GUI's WebView2 over
  the Chrome DevTools Protocol: `ureq` does the one plain-HTTP GET that
  finds the page target (`/json/list`), `tungstenite` carries the CDP
  command channel, `base64` decodes the returned image, and `png`
  decodes/encodes for the pixel diff and its artifact. All four are
  TLS-free here (the endpoint is `127.0.0.1`), which is why the two
  network crates are taken with default features off — no rustls /
  native-tls enters the tree. The alternative, a platform window-capture
  crate, would have added an OS-API dependency for something WebView2
  already exposes, and would have photographed whatever occluded the
  window. Chromium-only by construction, so the check is Windows-only;
  see the crate README. MIT / Apache-2.0.

- **ruff** + **mypy** (dev-dependencies in `servers/cannet-python-can`,
  pinned via its `uv.lock`) — `adopted` for the Python sidecar. ruff
  does both linting and black-compatible formatting in one tool;
  mypy type-checks the `cannet_python_can` package (the generated
  `_proto/` gRPC stubs are excluded — machine-emitted, not
  hand-maintained — and the dynamically-populated protobuf module is
  treated as untyped). pytest already covered the test suite. All four
  run in the CI `python` job. ruff is from Astral, like the `uv` already
  in use. MIT / (mypy) MIT.

- **`memory-stats`** crate — `proposed` then **`rejected`** (replaced by
  `sysinfo`, below) for the crash health recorder. It reads only the
  *current* process's RSS; the WebView runs in *separate* processes
  (WebView2 on Windows, WebKitGTK on Linux), which are the larger memory
  consumers and the ones a crash needs accounted for. Capturing those
  requires enumerating the process tree, which `memory-stats` can't do.
- **`sysinfo`** crate (v0.33, runtime dependency in `apps/gui/src-tauri`,
  `system` feature only) — `adopted` for the on-disk crash health
  recorder (`crash.rs`). Once a second it sums RSS over the host process
  and every descendant, so the WebView's processes are folded into the
  `tree_mb` figure on Windows / Linux; the rolling crash log then records
  memory growth up to an instant, uncatchable death (OOM `abort`, stack
  overflow, native crash). The workspace forbids `unsafe`, so a crate is
  required to wrap the per-OS process APIs. **macOS limitation:** the
  WebKit helpers are launchd-owned XPC services, not our descendants, so
  `tree_mb` counts the host only there — attributing them needs the
  private "responsible process" API + `unsafe`, deliberately not pulled
  in for a diagnostic. MIT.

- **`chrono`** crate (v0.4, runtime dependency in `crates/cannet-log`,
  `default-features = false`, `std` only) — `adopted` to render
  ISO-8601 / RFC-3339 UTC timestamps on rolling-log lines. Already
  present transitively, so this only makes the dependency direct; the
  `clock` feature is intentionally off (we format an epoch-ms value,
  never read the wall clock through chrono). Held by `cannet-log` rather
  than by each host, so the GUI's `cannet.log` and the server's
  `cannet-server.log` stamp instants identically by construction.
  MIT / Apache-2.0.

- **A dedicated log-file crate rather than `tracing-appender`** —
  `rejected` (2026-08-13) for the server's rolling logfile. The workspace
  already has `tracing` / `tracing-subscriber` (the GUI's dev-stderr
  layer), and `tracing-appender`'s rotation is time-based with a
  background writer thread — neither the size cap nor the
  flush-on-every-write that make an instant death still leave evidence.
  The behaviour wanted is ~40 lines of `std::fs`, so it lives in the
  first-party `crates/cannet-log` and both hosts share it. No new
  external dependency was taken.

*Profiling instrumentation TBD — populated in Phase 7.*
