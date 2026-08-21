# cannet

A CAN-bus analyzer. Phase 1 (alpha0) ships a single-process GUI that
opens a Vector BLF log, decodes it against a DBC, and streams the
result into a virtualized trace view. Phase 2 splits the data source
out behind a network protocol; Phase 3 fills in a multi-panel docking
layout (dockable trace and project panels in arbitrary arrangements)
and JSON project files; Phase 4 adds a signal-plotting view; Phase 5
adds transmit, the `--loopback` server, and DBC value-table rendering
across views; Phase 6 introduces logical buses, per-bus DBC scoping,
a structured filter element, and a project graph panel showing the
project's wiring; Phase 8 adds per-vendor hardware adapters; Phase 9
makes captures persistable through Save Capture (notes ride inside
the BLF as `GLOBAL_MARKER` records — no sidecar files per ADR 0010),
and offers a Recent captures list in the toolbar. See
[`plans/`](plans/) for the detailed roadmap.

## Downloads

Prebuilt **alpha** bundles are published to
[GitHub Releases](https://github.com/thebhef/cannet/releases):

| Platform                      | GUI bundle                    | `cannet-server` installer           |
|-------------------------------|-------------------------------|-------------------------------------|
| macOS (Apple Silicon / arm64) | `.dmg` — drag to Applications | `cannet-server-vX.Y.Z-<target>.pkg` |
| Windows (x64)                 | `.msi` or NSIS `-setup.exe`   | `cannet-server_X.Y.Z_x64-setup.exe` |
| Linux (x64)                   | —                             | `cannet-server_X.Y.Z_amd64.deb`     |

The server installers are for hosting hardware on a machine that does
not need the GUI; § Running the production server describes what each
one does, and the plain archives stay available as the no-installer
path.

These bundles are **unsigned**. On first launch:

- **macOS:** Gatekeeper blocks an unsigned, un-notarized app — right-click
  the app → **Open**, then confirm. (Or `xattr -dr com.apple.quarantine
  /Applications/cannet.app`.)
- **Windows:** SmartScreen shows a warning — click **More info → Run
  anyway**.

Signing/notarization is a planned follow-up. Building from source (below)
avoids the warnings entirely. Live hardware / virtual-bus capture works
out of the box — these bundles ship a frozen, self-contained sidecar, so
no `uv` or Python is needed at runtime (`uv` is developer-only; see
§ `uv` resolution).

Every GUI install also **contains `cannet-server`**, beside that same
frozen sidecar — so any machine with the GUI on it is already a
potential hardware host, with nothing else to download. Running it stays
a terminal act (the app never starts a server for you); see § Running
the bundled server.

## Repository layout

```
crates/
  cannet-core/   CanFrame model + CanFrameSource / CanFrameSink traits,
                 plus the `SharedBus` virtual-bus primitive (ADR 0021)
                 used in-process by the GUI host and over the wire by
                 `cannet-server debug vbus`. Every other crate
                 either produces or consumes through these — the seam
                 where network transports and hardware adapters slot
                 in. See its rustdoc for the contract.
  cannet-blf/    `BlfCanFrameSource`: Vector BLF files as a CanFrameSource.
                 A native reader (ADR 0009) that owns the on-disk codec
                 end-to-end and translates each object into a
                 `cannet_core::CanFrame` (classic / FD / remote / error),
                 plus `BlfCaptureWriter` — the inverse direction for Save
                 Capture, with an atomic temp-file + rename — and
                 `scan_blf` for the import dialog's channel census.
  cannet-mdf/    `MdfCanFrameSource`: ASAM MDF 4.x bus-logging files as a
                 CanFrameSource, and `scan_mdf` for the same census.
                 Sorted / unsorted, finalized / unfinalized, classic /
                 FD, error + remote frames, DZ-compressed data. Follows
                 the `cn_composition` link `mdf4-rs` does not, which is
                 what turns a channel group into frames. Also exposes the
                 file's signal groups — message-independent and
                 per-message DBC-decoded alike, each tagged with which it
                 is — its `##EV` timeline markers and its `##AT`
                 attachments. A file with no bus-logging group at all
                 reads as exactly that: signals, no frames.
                 `MdfCaptureWriter` is the inverse
                 for Save Capture: sorted, finalized MDF 4.10 with the
                 bus-logging composition written out by hand, plus signal
                 groups, events and embedded databases.
  cannet-dbc/    `Database::parse(text)` + `decode(frame)` + `signals()`
                 (the message/signal list a plot panel picks from).
                 Hand-rolled bit extraction (LE / Motorola sequential
                 BE), sign extension, multiplexed-signal filtering.
  cannet-wire/   Phase-2 wire protocol: tonic / gRPC service definition
                 (`proto/cannet.proto`), generated client + server
                 stubs, conversion helpers between `cannet_core`
                 frames and the wire types, and a batching adapter
                 layer so application code stays in `Stream<CanFrame>`.
  cannet-log/    The rolling log file both hosts write — the GUI's
                 `cannet.log` and `cannet-server`'s
                 `cannet-server.log`. Append + size-rotate to a single
                 `.1` generation + flush on every write, and the
                 ISO-8601 timestamp a line is stamped with. Stateless
                 on purpose: the caller owns the directory, the file
                 name, the cap and any write lock, so the two hosts
                 share the semantics that must not drift without
                 sharing the policy that differs.
  cannet-server/ Bare `cannet-server` is the production hardware proxy
                 (ADR 0040): it supervises the `cannet-python-can`
                 sidecar on loopback and relays all three RPCs to it
                 1:1, so a remote client sees the host's real
                 interfaces under their real ids. `debug
                 replay <blf>` and `debug vbus` are dev/test tooling:
                 replay loads a BLF into memory and streams its
                 channels on a loop while a client is subscribed
                 (transmits rejected, read-only; single-client). vbus
                 (ADR 0021) hosts a multi-client virtual CAN bus: one
                 factory interface, fan-out with sender attribution,
                 `NoAcknowledger` on zero-recipient transmits, runtime
                 `ConfigureBus`. Ships a `cannet-server` binary; lib is
                 reusable.
  cannet-client/ Phase-2 gRPC client. Every entry point takes a
                 `ConnectConfig` — plaintext for a loopback server, or
                 TLS pinned to the server's certificate fingerprint
                 plus a bearer token (ADR 0041), verified by an
                 in-crate `rustls` `ServerCertVerifier`.
                 `list_interfaces` is a one-shot
                 async RPC for the connection panel. `connect_and_
                 subscribe` returns a `RemoteCanFrameSource` (sync
                 `cannet_core::CanFrameSource`) backed by a worker
                 thread that owns its own tokio runtime, opens a
                 `Session`, and pumps incoming frames into a sync
                 mpsc queue. `into_parts()` exposes the receive +
                 shutdown halves alongside a Phase-5
                 `SessionTransmitter` for client TX. Drops cleanly on
                 `Drop`.
  cannet-sidecar/
                 The python-can sidecar's host side (ADR 0036), shared
                 by every process that runs one: the launch chain
                 (frozen binary, else `uv` / `python3` over the source
                 tree), the stdout banner and stderr grammars, and
                 `SidecarSupervisor` — spawn, restart budget, piped
                 stdin as the parent-death signal, published phase. A
                 host supplies a `SidecarHost`: where its settings
                 come from and where a log line goes.
  cannet-perf-measurement/
                 Agent-runnable performance / integration harness. Runs a
                 rest-of-bus simulation of the `examples/ev-demo` workload
                 through the real host model and emits machine-readable
                 metrics diffed against a dated baseline
                 (`cargo run -p cannet-perf-measurement -- check`). Three
                 modes: `tracebuffer` (in-process `TraceStore`), `grpc`
                 (virtual bus over real gRPC), and `hardware-peak` (full
                 stack over PEAK hardware via the sidecar). See its README.

apps/
  gui/           Tauri 2 + React 18 + Vite trace viewer.
    src/             React frontend. `TracePanel.tsx` is a trace-style
                     panel with a chronological / by-ID mode toggle:
                     chronological is `TraceView.tsx`, a hand-rolled
                     scaled virtualizer (the scroll container caps at
                     16M px and maps scrollTop to an absolute row index,
                     so the scrollbar represents the whole trace
                     regardless of size; the wheel scrolls natively but
                     falls back to row-stepped scrolling when a notch
                     would skip a screenful in the compressed regime);
                     by-ID is `ByIdTable.tsx` (the same scaled
                     virtualizer, over the host-sorted by-ID snapshot).
                     Both views — chronological, filtered, and by-ID —
                     page through one windowed-source primitive
                     (`useWindowedQuery.ts`, ADR 0025); the by-ID and
                     filtered adapters are `useByIdView.ts` /
                     `useFilteredTrace.ts`. Shared table bits — the
                     header (drag-resize, right-click show/hide,
                     click-to-sort) and the cell renderer — are in
                     `traceTable.tsx`; the column model in
                     `traceColumns.ts` (the by-ID sort runs host-side).
                     `ProjectPanel.tsx` is the
                     project / elements / bus / DBC-load panel;
                     `DatabasePanel.tsx` the Database panel (ADR 0052),
                     browsing loaded DBC and file-backed signals
                     file → group → signal; `PlotPanel.tsx`
                     the Phase-4 signal plot (uPlot), with `plotData.ts`
                     merging independently-sampled series onto one
                     timeline; `SignalsPanel.tsx` the signal view — a
                     latest-per-signal snapshot table (mux-aware) whose
                     selection is manual picks + regex patterns over the
                     canonical `bus/ecu/message/signal` path (ADR 0038,
                     `signalSelection.ts`), evaluated host-side
                     (`fetch_signal_page`). Each trace-style panel shows one *trace
                     element* — a window over the host-side session
                     buffer with pause / stop / clear; the elements live
                     in an in-memory registry (`projectElements.ts`),
                     persisted in the project, so closing a panel doesn't
                     destroy its element (`trace.ts`, `TraceControls.tsx`).
                     The scroll/stacking, column, trace-window, and
                     plot-data arithmetic live in `traceViewport.ts` /
                     `traceColumns.ts` / `trace.ts` / `plotData.ts`
                     (unit-tested alongside). A command / hotkey
                     framework (`commands.ts`, `keybindings.ts`,
                     `PaletteModal.tsx` — ADR 0018) drives every toolbar
                     button, the `Ctrl/Cmd+Shift+P` command palette
                     (recently used commands float to the top),
                     `Ctrl/Cmd+P` go-to-view (open panels by display
                     name), and go-to-event (jump the trace/plot to a
                     timeline event) off one command registry — toolbar,
                     palette, and keyboard all dispatch the same
                     commands. Key bindings are user-editable and
                     persisted to `settings.json` (ADR 0034): the
                     shortcuts panel (`ShortcutsPanel.tsx`)
                     lists every command and lets you rebind, remove, or
                     add a chord (reused chords allowed only where they
                     can't both fire; conflicts refused), with reset to
                     the built-in defaults. It is the living reference for
                     what's bound. Element display names are model-owned
                     and resolved everywhere by `elementLabel.ts`
                     (ADR 0019), editable inline in the project panel.
    src-tauri/       Rust host (`cannet-gui` crate). Owns the trace
                     model (`trace_store.rs` — the session buffer, plus
                     an O(1)-maintained latest-frame-per-id index and a
                     per-id message-rate estimate); the BLF and remote
                     pumps append frames, and the frontend pulls slices
                     via the `fetch_trace_range` command and the
                     host-sorted, paged latest-by-id snapshot (each id's
                     latest in-window frame + its rate) via
                     `fetch_by_id_page` (both decoded against the
                     loaded DBCs — first match wins — at fetch time, both
                     off the main thread), plus a `trace-grew` IPC tick (~10 Hz:
                     count, rate, and a decoded tail of the newest rows
                     for flicker-free auto-scroll). `signal_sampler.rs`
                     walks the trace store for a chosen DBC signal and
                     yields a `(t, v)` series for the plot panel
                     (`list_signals` / `sample_signals` commands).
                     `src/ipc.rs` holds the IPC payload shapes;
                     `src/project.rs` the project-file model +
                     `open_project` / `save_project`. `src/system_log.rs`
                     (Phase 7) is the host-side structured log bus —
                     a bounded ring + rate limiter that the
                     `sys_info!` / `sys_warn!` / `sys_error!` macros
                     fan into alongside `tracing-subscriber`; the
                     System Messages panel renders it.

plans/           Living planning docs (see CLAUDE.md).
```

## Prerequisites

All platforms need:

- **Rust**, installed via [rustup](https://rustup.rs/). The exact
  toolchain is pinned in [`rust-toolchain.toml`](rust-toolchain.toml);
  rustup reads it and auto-installs that version (and the `clippy` /
  `rustfmt` components) the first time you run `cargo` in the repo, so
  local builds and CI use the same compiler.
- **Node.js**, version pinned in [`.node-version`](.node-version)
  (currently 24.x; pnpm 11 requires ≥ 22.13). Version managers like
  `fnm` / `nvm` / `asdf` read that file; otherwise install the matching
  [Node.js](https://nodejs.org/en/download) release yourself. CI reads
  the same file, so local and CI match.
- **pnpm**, pinned via the `packageManager` field in
  [`apps/gui/package.json`](apps/gui/package.json). The simplest way to
  get the matching version is [Corepack](https://nodejs.org/api/corepack.html)
  (`corepack enable`), which reads that field. Otherwise install pnpm
  10+ manually via the
  [standalone pnpm installers](https://pnpm.io/installation) (`curl -fsSL https://get.pnpm.io/install.sh | sh -`
  on macOS/Linux, `iwr https://get.pnpm.io/install.ps1 -useb | iex` on Windows PowerShell),
  `npm install -g pnpm`, or your OS package manager (`brew install pnpm`,
  `winget install pnpm`, etc.). Verify with `pnpm --version`.

**Required for `tauri build` (sidecar freeze) and Phase 8 vendor
drivers (Vector / Kvaser / PEAK):**

- [`uv`](https://docs.astral.sh/uv/) — manages the
  [`cannet-python-can`](servers/cannet-python-can/) sidecar's Python
  environment and installs Python on the fly. We do **not** commit
  `uv` binaries or pack them into the installer artefact; in a
  **development** build the host expects a `uv` to be available, either
  next to the GUI binary at `tools/uv/uv[.exe]` or on `PATH`. For local development, run
  [`scripts/fetch-uv.sh`](scripts/fetch-uv.sh) to drop the pinned
  binary into `tools/uv/`, or install `uv` per the upstream
  instructions. `uv` is **developer-only**: shipped builds run a
  frozen self-contained sidecar and fetch nothing
  (see [`docs/adr/0036-frozen-python-can-sidecar.md`](docs/adr/0036-frozen-python-can-sidecar.md)).
- A vendor SDK (only if you have the matching hardware): Vector XL
  Driver Library, Kvaser CANlib, or PEAK PCAN-Basic. None of these
  are bundled; see the Phase-8 section below for links.


Plus platform-specific build tooling for Tauri's WebView host:

### Linux (Ubuntu / Debian 24.04+)

```sh
sudo apt-get install -y \
    libwebkit2gtk-4.1-dev \
    libxdo-dev \
    libssl-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev
```

Other distros: install equivalents of the above (webkit2gtk-4.1,
libxdo, openssl-dev, libsoup3, javascriptcoregtk-4.1).

### macOS

```sh
xcode-select --install
```

The Xcode Command Line Tools provide the C/C++ toolchain and the
WebKit framework Tauri uses on macOS. Nothing else is needed.

### Windows

1. **Microsoft Visual C++ Build Tools.** Install the
   [Visual Studio 2026 Build Tools](https://visualstudio.microsoft.com/downloads/)
   (free) and select the **"Desktop development with C++"** workload.
   This provides `link.exe`, the Windows SDK, and the MSVC headers
   that the Rust MSVC toolchain (the default on Windows) links
   against. Without it `cargo build` fails with linker errors.
2. **Microsoft Edge WebView2 Runtime.** Preinstalled on Windows 11
   and current Windows 10. If missing, grab the Evergreen Bootstrapper
   from the [WebView2 page](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
3. **Rust MSVC toolchain.** `rustup` defaults to this on Windows; if
   you previously selected GNU, switch with
   `rustup default stable-x86_64-pc-windows-msvc`.

## Running

From the repo root:

```sh
pnpm --dir apps/gui install        # once, to fetch frontend deps
pnpm --dir apps/gui tauri dev      # development build with hot reload
pnpm --dir apps/gui tauri build    # release bundle
```

`tauri build` first freezes the `cannet-python-can` sidecar
([`scripts/build-sidecar.py`](scripts/build-sidecar.py)) and builds and
stages the release `cannet-server` the bundle ships
([`scripts/stage-server.py`](scripts/stage-server.py)) — both run by the
`beforeBuildCommand` hook, so it needs `uv` on `PATH`. Rebuilds of
either are incremental: an unchanged sidecar refreezes, and an
unchanged server restages, in seconds. `tauri dev` does neither — a
development build has no bundle to fill.

`pnpm tauri dev` boots Vite, compiles the Rust host, and launches the
cannet window. Use **Import trace…** to pick a log (a Vector `.blf`
or an ASAM MDF 4.x bus-logging `.mf4` — the dialog's filter list
offers both, plus "all supported"); **Add DBC…**
loads a database for live decoding — load more than one and frames
decode against each in order, first match wins (every loaded DBC
applies to the one interface for now).

**Every launch opens on a splash** carrying the safety disclaimer —
cannet transmits, and the system on the other end of the cable should
be in a state where disrupted CAN traffic is safe. It is a notice, not
a prompt: there is nothing to acknowledge and nothing is remembered.
It doubles as the loading screen, so it stays up for the longer of five
seconds and however long the reopened project takes to apply. The
previous session's capture is *not* part of that wait: reopening it
scales with the capture's size, so it loads in the background and its
history appears when it is ready. Connect waits for it (the reload
replaces the buffer wholesale); the rest of the app does not.

### Running the production server

`cannet-server`, invoked bare, is the production hardware proxy
([ADR 0040](docs/adr/0040-production-cannet-server.md)): run it on the
machine the CAN hardware is plugged into, and that hardware becomes
reachable over the network from a GUI anywhere else.

Prebuilt archives publish alongside the GUI bundles on [GitHub
Releases](https://github.com/thebhef/cannet/releases) (§ Downloads),
one per OS:

| Platform    | Archive                                                |
|-------------|--------------------------------------------------------|
| macOS arm64 | `cannet-server-vX.Y.Z-aarch64-apple-darwin.tar.gz`     |
| Windows x64 | `cannet-server-vX.Y.Z-x86_64-pc-windows-msvc.zip`      |
| Linux x64   | `cannet-server-vX.Y.Z-x86_64-unknown-linux-gnu.tar.gz` |

Each unpacks to one directory holding the `cannet-server` binary and,
beside it, the `cannet-python-can/` onedir it supervises — no `uv` or
Python needed at runtime, same as the GUI's frozen sidecar. Like the
GUI bundles, these binaries are unsigned: macOS Gatekeeper quarantines
a downloaded, un-notarized binary (right-click → **Open** and confirm,
or `xattr -dr com.apple.quarantine cannet-server`); Windows SmartScreen
shows the same warning the GUI installer does (**More info → Run
anyway**). Linux has no equivalent gate.

#### Installers

Beside the archives, one native server installer per platform. Each
keeps the `cannet-python-can/` onedir beside the binary — the layout
the server's own sidecar discovery expects — and puts `cannet-server`
where a terminal finds it. None of them installs a service, a
shortcut, or anything that starts a server: running one stays an
explicit act.

| Platform    | Installer                           | What it does                                                                                       |
|-------------|-------------------------------------|----------------------------------------------------------------------------------------------------|
| macOS arm64 | `cannet-server-vX.Y.Z-<target>.pkg` | Installs to `/usr/local/cannet-server` and adds an `/etc/paths.d` entry pointing there             |
| Windows x64 | `cannet-server_X.Y.Z_x64-setup.exe` | Installs to `%LOCALAPPDATA%\Programs\cannet-server` and appends that directory to your user `PATH` |
| Linux x64   | `cannet-server_X.Y.Z_amd64.deb`     | Installs to `/usr/lib/cannet-server` with `/usr/bin/cannet-server` a symlink into it               |

The macOS `.pkg` is **unsigned and un-notarized**, so Gatekeeper
refuses it on a double-click — right-click the package → **Open**, then
confirm, the same dance the `.dmg` needs. It installs system-wide (an
administrator password), and a flat package has no uninstaller: undo it
with `sudo rm -rf /usr/local/cannet-server /etc/paths.d/cannet-server`.
The `/etc/paths.d` entry reaches a shell through `path_helper`, which
runs from `/etc/profile`, so open a new terminal after installing.

The Windows installer is per-user, so it needs no administrator rights,
and it is **unsigned** — SmartScreen shows the same **More info → Run
anyway** warning the GUI installer does. It registers a normal
Add/Remove Programs entry; uninstalling removes the files and takes its
`PATH` entry back out. Open a new terminal afterwards — an existing one
keeps the `PATH` it started with.

The `.deb` is an ordinary unsigned package — `sudo apt install
./cannet-server_X.Y.Z_amd64.deb`, `sudo apt remove cannet-server` to
undo. It is not in any repository, so there is no signature to verify
and `apt` will say so.

On Windows, the first mDNS bind can trigger Defender Firewall to add
inbound *Block* rules for the binary on the Public profile without
prompting. Same-host discovery (the GUI and the server on one machine)
still works; reaching another machine's advertisement needs an
explicit inbound allow rule for UDP 5353.

```sh
cargo run -p cannet-server                      # from a source checkout
tar xzf cannet-server-vX.Y.Z-<target>.tar.gz    # macOS / Linux archive
# or: Expand-Archive cannet-server-vX.Y.Z-<target>.zip   # Windows archive
cd cannet-server-vX.Y.Z-<target>
./cannet-server --bind 0.0.0.0:50051            # from a distribution archive
# → 2026-08-13T09:12:44.108Z INFO hardware proxy: certificate fingerprint SHA256:qF3…RmA
# → hardware proxy: client token chug-pruning-unclad-hazard-morphine
# → 2026-08-13T09:12:44.109Z INFO hardware proxy: listening on 0.0.0.0:50051 (tls)
# → 2026-08-13T09:12:44.771Z INFO sidecar:python-can: sidecar started (pid 61024)
# → 2026-08-13T09:12:45.402Z INFO sidecar:python-can: upstream ready on 127.0.0.1:60481
```

Every line but the token one is also written to a rolling logfile — see
[Logs](#logs) below.

It spawns and supervises one `cannet-python-can` sidecar on loopback
(the same one the GUI runs for local dongles) and relays all three
RPCs to it 1:1. Nothing on the wire is reinterpreted: clients list
`pcan:PCAN_USBBUS1` and friends under their real ids, and
`ConfigureBus`, `InterfaceState`, `Busy` and every error pass through
as the sidecar sent them — the process that owns the hardware is still
the one arbitrating who gets it. Point the GUI's connection panel at
`host:50051` exactly as it would at a local sidecar.

Flags:

- `--bind <addr>` — listen address, default `127.0.0.1:50051`. Serving
  anything but loopback is a deliberate choice, and it auto-enables TLS
  and a bearer token with nothing else said
  ([ADR 0041](docs/adr/0041-remote-connection-security.md)): no
  certificate authority and no setup, the server generates a keypair
  and a self-signed certificate the first time it needs one and keeps
  them in its per-user data directory (`%LOCALAPPDATA%\cannet-server`
  on Windows, `~/.local/share/cannet-server` on Linux,
  `~/Library/Application Support/cannet-server` on macOS), so the
  identity is the same on every later run. The private key file is
  created readable by its owner only. A loopback bind stays plaintext
  by default, unchanged.
- `--no-tls` — serve a routable bind in the clear anyway: no TLS, no
  token. The one escape hatch, for an operator who wants the hardware
  unprotected and says so out loud. Has no effect on a loopback bind,
  which was already plaintext.
- `--cert <path>` / `--key <path>` — present operator-supplied PEM
  material instead of the generated identity; the two come as a pair
  and serve TLS regardless of the bind address, even loopback, and
  regardless of `--no-tls`. **Renewing this certificate changes the
  fingerprint**, and every client that pinned the old one has to
  accept the new one — the certificate as a whole is the identity, so
  re-keying and re-issuing look the same from the client's side.
- `--token <value>` — accept this bearer token from clients for this
  run instead of the generated one; nothing is written. A command line
  is visible to every process lister on the machine, so prefer
  `CANNET_TOKEN=<value>`, which the server reads the same way and which
  `--token` overrides. Either is ignored — with a warning — on a
  plaintext endpoint, because a bearer token must not ride an
  unencrypted channel.
- `--sidecar-log-level <level>` — the sidecar's own verbosity
  (default `info`). Its output, and the server's supervision events,
  are logged tagged `sidecar:python-can`. This is the only verbosity
  knob there is: the server's own sinks have no minimum level, because
  a log you have to configure before it is useful is a log that is
  empty when it matters.
- `--sidecar-restart-budget <n>` — how many times a crashing sidecar is
  restarted automatically before the server gives up and says so
  (default 3). Restarting the server hands the budget back.
- `--sidecar-dir <path>` — where to look for the sidecar's *source
  tree*, overriding the walk-up search from the server binary. This is
  the developer/field-engineer escape hatch, matching the GUI's
  **Sidecar directory** setting — not a way to pick a different frozen
  `cannet-python-can` onedir, which stays inexpressible on either host.
  `CANNET_SIDECAR_DIR` still wins when both are set.
- `--name <name>` — instance name to advertise via mDNS/DNS-SD
  (`_cannet._tcp`), default this machine's hostname. The GUI's browse
  list shows it; `host:port` is unaffected.
- `--no-mdns` — disable mDNS/DNS-SD advertisement entirely. The server
  drops out of the GUI's browse list but stays reachable at a typed
  `host:port`. `debug replay` and `debug vbus` never advertise, with
  or without this flag.

With TLS on, the server prints two strings at startup and both are
meant to be read off the console:

- **The certificate fingerprint** — `SHA256:` followed by unpadded
  base64, the same shape OpenSSH prints for a host key. That string is
  the server's identity: a connecting client compares what the server
  presented against it. It changes only when the certificate does.
- **The client token** — five lowercase words from the [EFF large
  wordlist](https://www.eff.org/dice), hyphen-separated (e.g.
  `chug-pruning-unclad-hazard-morphine`, ≈64.6 bits of entropy — ample
  against online guessing through the TLS endpoint, and there is no
  offline crack target since the token sits in plaintext on disk
  either way), that a client must present on every RPC, in an
  `authorization: Bearer <token>` header. Without it, or with the
  wrong one, every call is refused before it reaches the hardware.
  Like the certificate, it is generated the first time it is needed
  and kept in the same per-user directory, so it survives restarts and
  a client that stored it keeps working. **To rotate it, delete the
  `access-token` file in that directory** and restart; the next start
  prints a new one and every client has to be told the new value.
  `--token` / `CANNET_TOKEN` still accept any string the operator
  hands them — the passphrase format is generation-side only.

The two are treated differently on disk. The **fingerprint is public**
— it is what a client pins and what you compare out of band — so it is
an ordinary log line. **The token never reaches the logfile**: it is
printed to the console and nowhere else, and the log records only that
a token is required. A credential in a file people attach to bug
reports has a long tail. Whoever can read this console is authorized to
use the server's buses — that is the trust boundary
([ADR 0041](docs/adr/0041-remote-connection-security.md)).

### Running the bundled server

Every GUI install carries the same `cannet-server` binary, staged
beside the frozen `cannet-python-can/` onedir the app already ships —
so the server's own sidecar lookup finds it there with no extra
configuration, exactly as in a distribution archive. Nothing in the app
launches it: starting a server stays an explicit terminal act.

| OS      | Bundled server                                                |
|---------|---------------------------------------------------------------|
| Windows | `<install dir>\cannet-server.exe` (beside `cannet-gui.exe`)   |
| macOS   | `/Applications/cannet.app/Contents/Resources/cannet-server`   |

```powershell
# Windows, default per-user install location
& "$env:LOCALAPPDATA\cannet\cannet-server.exe" --bind 0.0.0.0:50051
```

```sh
# macOS
/Applications/cannet.app/Contents/Resources/cannet-server --bind 0.0.0.0:50051
```

Its flags, logs, certificate and token are the ones documented above —
it is the same binary the archives ship.

To type `cannet-server` instead of that path, run **Add cannet-server
to PATH** from the command palette (`Ctrl/Cmd+Shift+P`). It edits your
*user* environment only — no elevation, nothing machine-wide — and says
what it did in the System Messages panel; running it twice reports that
the directory is already there and changes nothing. On Windows it
appends the install directory to the `Path` value under
`HKCU\Environment`; on macOS it appends an `export` line to
`~/.zprofile`. Either way, open a new terminal for it to take effect.
Nothing about it starts a server.

### Logs

Everything the server says goes to two places: the console you started
it on, and a rolling `cannet-server.log` in the same per-user directory
that holds its certificate and token —

| OS | log file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\cannet-server\cannet-server.log` |
| Linux | `$XDG_DATA_HOME/cannet-server/cannet-server.log` (default `~/.local/share/cannet-server/…`) |
| macOS | `~/Library/Application Support/cannet-server/cannet-server.log` |

— with the same semantics the GUI host's `cannet.log` has, and for the
same reason: it is the artifact you attach to a bug report. Every line
is flushed as it is written, so a process that dies instantly still
leaves its last words; past 5 MB the file is renamed `.log.1` (one
generation, clobbering the previous) and a fresh one started, so disk
use is bounded to ~10 MB and never needs pruning. Both sinks carry the
same `<timestamp> <LEVEL> <source>: <message>` line. There is no
minimum level and no flag to set one.

The supervised sidecar writes its own `sidecar-python-can.log` beside
it — always at debug level, whatever `--sidecar-log-level` says, since
that flag governs the sidecar's *stderr*, which is the half that lands
in the server's log. The file records every gRPC command with its
arguments and outcome plus every driver traceback, which is where a
per-channel connect failure is diagnosable after the fact. It is the
same file the GUI's sidecar writes, in the same relationship to the
host's log. Attach both.

If the per-user directory cannot be resolved at all, the server logs to
the console only, the sidecar writes no logfile, and both carry on.

Neither protection exists on a plaintext endpoint: the token is
enforced exactly when TLS is, because presenting it over an
unencrypted channel would hand it to anyone on the path. That is why a
routable bind auto-enables both, and why a loopback bind — your own
machine, and the GUI's local path — needs neither.

### Connecting to a protected server

A client is given the two strings the server printed, and holds them
together as a `cannet_client::ConnectConfig`:

- `ConnectConfig::plaintext(address)` — the unprotected path, for a
  loopback server. No TLS, no credential.
- `ConnectConfig::pinned_with_token(address, pin, token)` — TLS
  verified against the fingerprint, with the token on every RPC.

There is no CA and no chain: the client compares the SHA-256 digest of
the certificate the server presents against the pinned one and accepts
nothing else, the way an SSH client treats a host key. Expiry dates
and host names are therefore ignored — an identity that never expires
is the point — but the handshake *signature* is verified in full, so
holding a copy of the server's (public) certificate is not enough to
impersonate it.

A fingerprint that does not match aborts the handshake before any
request is made and before the token is sent, and reports both the
pinned and the presented fingerprint so they can be compared. Nothing
is trusted on first sight: a server whose fingerprint has not been
accepted yet is refused in exactly the same way, with the fingerprint
to accept in hand.

The sidecar is found the same way the GUI finds it
([ADR 0036](docs/adr/0036-frozen-python-can-sidecar.md)): a release
build prefers the frozen `cannet-python-can/` onedir unpacked beside
the server binary and falls back to the source tree; a `cargo run`
build prefers the source tree, so sidecar edits take effect on its next
restart. `--sidecar-dir <path>` overrides where that source tree is;
`CANNET_SIDECAR_DIR` overrides the flag.

The sidecar dies with the server — it watches the stdin pipe it
inherited, so an EOF on that pipe, however it arrives, is its cue to
shut down. Ctrl-C therefore leaves nothing holding the hardware open,
and does it within a bounded window: the server closes the pipe by
hand, sends the mDNS goodbye at the same time, and gives the sidecar
five seconds to exit before killing its whole process tree. In practice
it takes about a second and the kill never fires. **A second Ctrl-C
during that window exits immediately** (code 130) instead of waiting —
the sidecar still sees the pipe close, because the pipe dies with the
process.

### Connecting the GUI to a protected server

The GUI does the same thing, with the comparison put in front of you.
Start the server on the bench machine and leave its console visible:

```sh
./cannet-server --bind 0.0.0.0:50051
# → 2026-08-13T09:12:44.108Z INFO hardware proxy: certificate fingerprint SHA256:qF3…RmA
# → hardware proxy: client token chug-pruning-unclad-hazard-morphine
```

In the GUI, open the **Servers** panel — *Go to view…* → *Servers*, or
the command palette's *Show servers*. It lists every server
advertising on this network beside every one this machine has already
accepted, one row per `host:port`, carrying the instance name, the
machine's host name, the address, the version, and a trust badge.
Press *Trust…* on the bench server's row. The server is dialled;
because nothing has been accepted for that address yet, the connection
is refused at the certificate and a dialog appears showing the
fingerprint the server presented:

1. **Compare the two strings.** The dialog shows the same
   `SHA256:` line the server printed — character for character. If they
   differ, something between you and the bench is answering; cancel.
2. **Paste the token** into the dialog's *Access token* field, from the
   `client token` line on the same console.
3. **Accept and connect.** The fingerprint is pinned for that
   `host:port` and the token stored with it, so subsequent launches
   connect without asking.

From then on, the server's identity is checked on every connection. If
it ever changes — the certificate was replaced, the machine
reinstalled, or something is impersonating it — the connection is
refused. There is no automatic retry and no fallback to plaintext: the
only ways forward are *Accept the new identity*, which overwrites the
pin, and cancel. A token the server refuses is treated the same way —
asked about once, never retried in a loop.

**A dialog appears only when you asked for the connection.** cannet
keeps watching servers it already knows, so it can find a changed
identity with nobody trying to connect; interrupting the window for
that would be a nuisance. Such a question shows up as an *indicator*
instead — the badge on the server's row reads `identity changed`, a
credential the server stopped accepting turns the row's token cell to
`token refused`, and every bus bound to that server says so on the bus
row — and the row's *Review…* puts the same dialog up whenever you are
ready, showing both fingerprints, the accepted one and the presented
one. Connecting,
*Trust…*, and *Add server…* are the acts that open it directly, because
each is a connection you asked for and the question is what blocked it.
Waving the dialog away leaves the indicator: the question is still
true, and the row still says so.

Both are stored per `host:port` in `servers.json` in the GUI's config
directory ([ADR 0032](docs/adr/0032-machine-local-ui-state-host-side.md)),
never in the project file, so a project shared with a colleague carries
no credential. The **Servers** panel is where that store is managed:
each row shows the same fingerprint string, whether a token is stored,
a *Token…* field that replaces or clears the stored credential, and a
*Forget* button that makes the next connection ask again. Both are on
every row, whatever the store holds for it: a row that is listed for
another reason answers instead of doing nothing — *Forget* says that
nothing was stored and names what is keeping the row there. A
trusted server that is switched off stays in the list, greyed, so it
can be forgotten without waiting for it to come back. Moving a server
to a different address or port is a new entry, and prompts again.

Two things put a row in this list besides the trust store: a server
advertising on the network, and a session connected to one — so a row
can be held by a live connection alone, and leaves when that session
ends. The GUI's own python-can sidecar is not one of them: it is dialled
on loopback for any bus bound to local hardware, but it is this app's
own child rather than a server the operator manages, so it never
appears here.

A server on another subnet, or one started `--no-mdns`, advertises
nowhere this machine can hear, so it never appears in the browsed list.
**Add server…** in the panel's toolbar is the way to it: type its
`host:port` and the address is dialled exactly as *Trust…* dials a
browsed row — refused at the certificate, with the same dialog to
compare the fingerprint in. Accepting it pins the identity, and the
server becomes a row like any other, greyed while it is not
advertising. Nothing is stored for an address that could not be
reached; the panel says what the attempt hit and the list is left
alone. The same goes for a question dismissed rather than answered —
nothing is stored, so nothing is added to the list, and reaching that
server is typing its address again. The panel also says which kind of
empty it is looking at: it
distinguishes a network with nothing on it from a browse that could
not start at all, and reports the error when the mDNS browser itself
complains, which is what a blocked UDP 5353 usually looks like.

**Windows firewall prompts.** The first time a binary opens the
socket its side of DNS-SD needs — the GUI's browse, the server's
advertisement (§ Installers above) — Windows prompts once for that
binary's install location: an Allow/Cancel dialog on the Private and
Domain profiles, or a silent Block on the Public profile. Allowing is
correct. The resulting rule is scoped to that exact path and network
profile, so a new install location, or switching onto a network
profile you have not answered for yet, prompts again. None of this
fails silently on the GUI side: a browse blocked by a Windows deny
shows as `degraded` or `failed` in the Servers panel rather than a
quiet empty list, and either way — blocked discovery, a server on
another subnet, or one that simply isn't advertising — **Add
server…** reaches it by `host:port` without depending on browse at
all.

**macOS local-network permission.** A macOS GUI build triggers the
OS's "find devices on your local network" prompt the first time it
browses. Denying it empties the browse list with no distinguishing
signal — the mDNS library exposes no "permission denied" event, so a
denied prompt reads as an ordinary `running` browse that happens to
see nothing, not a `degraded` or `failed` one. **Add server…** is the
workaround, reaching a server directly without depending on browse.
The permission can be re-granted at **System Settings → Privacy &
Security → Local Network**.

Loopback servers — the GUI's own sidecar, a `--bind 127.0.0.1` proxy,
the in-process virtual bus — are unaffected: they stay plaintext and
never prompt, exactly as before.

**Clock offset.** Once a session against a remote server is open,
cannet measures how far that server's wall clock is from this
machine's — a short probe exchange at connect, then a live re-probe
every 30 s so the number tracks a host that is independently
disciplining its own clock — and corrects every frame's timestamp by
it before the frame reaches the trace, slewing the correction smoothly
rather than jumping (a step of more than a second, or the session's
first measurement, applies at once instead). The measured offset shows
on the server's row in the Connection section, e.g. `+4.2 s`; above
100 ms it reads as a warning rather than routine health. A peer built
before this measurement existed shows nothing rather than an error.
The GUI logs one system-message line when the session's first
measurement settles (info below 100 ms, warn above) and one more each
time the offset crosses that threshold in either direction — never
once per probe round, and never per frame.

**Connecting to a server run `--no-tls`.** If the protected
connection never reaches a certificate, the GUI does not quietly fall
back. It reports the transport error and offers *Connect without
protection* as an explicit, per-server choice. Take it only on a
network you trust as much as the machine itself: the traffic is
readable by anyone on the path, and so is control of the bus — anyone
who can reach the port can transmit on your hardware. No token is
collected for such a server, because a credential must never ride an
unencrypted channel. The choice is remembered for that one address and
can be revoked with *Forget*.

### Self-driving performance runs

The shipping GUI can drive itself for a render-tier performance
measurement, no operator and no external automation client — it covers
every platform the app ships on (incl. macOS, which has no WebDriver).

**Build a release binary to measure.** `tauri dev` runs a debug Rust
host behind React's development build; the numbers it produces are its
own, not the app's, and are not comparable with a release capture. Build
the app, then run the binary directly:

```sh
pnpm --dir apps/gui tauri build --no-bundle       # release host + production bundle
./target/release/cannet-gui \
  --project /abs/path/to/examples/ev-zonal/ev-zonal.cannet_prj \
  --app-data-dir /abs/path/to/perf-app-data \
  --connect-on-start \
  --perf-capture-secs 60 \
  --perf-interact scrub \
  --perf-out /abs/path/to/docs/performance-measurements/frontend/<date>-<hash>.json
```

`cargo build --release -p cannet-gui` on its own is **not** a substitute:
without the `custom-protocol` feature the tauri CLI passes, the binary
still points at the Vite dev server, so it comes up with no frontend at
all (and the run captures nothing).

**Seed the isolated profile's window geometry**, once, before the first
run in a directory you'll reuse for comparable runs. A fresh
`--app-data-dir` starts every setting at default — including window
size — and Tauri's default window is materially smaller than an
operator's real one (the reference machine runs ~2450×2080), so an
unseeded run under-loads the plot canvas it's measuring. Copy the
operator profile's `.window-state.json` into the run's directory before
launching:

```sh
mkdir -p /abs/path/to/perf-app-data
cp "$APPDATA/dev.cannet.app/.window-state.json" \
   /abs/path/to/perf-app-data/.window-state.json      # Windows (Git Bash)
```

(`~/Library/Application Support/dev.cannet.app/.window-state.json` on
macOS; `~/.config/dev.cannet.app/.window-state.json` on Linux.) A plain
file copy, not a symlink — the run reads the operator's geometry once
and can never write back to it, so the isolation `--app-data-dir` gives
every other setting still holds for this one.

Use **absolute** paths for `--project` and `--perf-out`. They are
resolved against the process's working directory, which is the launch
directory here but is `apps/gui/src-tauri` under `tauri dev` — a
repo-relative `--project` there fails to open, the app boots idle, and no
report is written.

- `--project <path>` opens a project deterministically (ahead of the
  last-opened pointer). Usable on its own to just open a project.
- `--app-data-dir <path>` puts everything the app keeps per user —
  trust store, recents and project registry, settings, window geometry
  — under `<path>` for this launch, so a measurement never writes the
  state you use day to day. **Use it for every performance run.** The
  rolling log and crash records are not moved; they stay where a bug
  report expects them. A fresh directory starts from default settings,
  so keep one directory for the runs you compare against each other
  (and pin any server the run must reach in it, once).
- `--connect-on-start` fires the same connect a user clicks, once the
  project's bindings (and, for a local binding, the sidecar) are ready.
  Paired with `--perf-capture-secs`, a failed connect is retried a
  bounded number of times before the run is failed outright: **no report
  is written and the process exits non-zero** (the failure cause is
  logged to the System Messages panel / `cannet.log`), rather than the
  capture running over a session that never connected and writing a
  normal-shaped, empty report.
- `--perf-capture-secs <n>` captures the frontend diagnostics for `n`
  seconds after the session settles, then writes the report and exits.
- `--perf-out <path>` is where the `RenderReport` JSON lands;
  `--perf-label <text>` names the scenario in it.
- `--perf-interact <script>` drives synthetic gestures at the heavy
  views for the length of the run, so the capture measures interaction
  cost and not only resting cost. `scrub` zooms the plot to a working
  window and then cycles trace scrolls, plot pans and zooms; `follow`
  does the zoom and then leaves the view alone, which is the scenario
  the scroll-smoothness gauges are meaningful in (a pan moves the window
  further in one step than a stall would). Omit it for a resting run.
- `--diag` arms the frontend's diagnostic machinery: the per-event
  render / resample counters and gauges, their burst logger, the
  `longtask` observer, the once-a-second `[diag]` console line, and the
  `window.__cannetPerf` capture entry point. **The four `--perf-*` flags
  above imply it** — a capture's payload *is* those counters — so a
  measurement run never needs it spelled out. Ask for it on its own to
  watch the console stream during an interactive session, or to bracket
  a capture by hand from the devtools console.

Everything else the run needs is already in the saved project: the panel
layout (the views under test), the bus bindings (the frame source), and
the rest-of-bus simulation's run flag (the load, which resumes on
connect). For a hardware-free run the project should bind to a virtual
bus. See [ADR 0031](docs/adr/0031-gui-performance-automation-self-driving.md).

**What is running when you don't ask.** Measurement machinery ships in
the binary, so it is worth being able to see the whole of it in one
place. Off unless a flag turns it on:

| Machinery | Default | Turned on by |
|---|---|---|
| Frontend counters / gauges, burst logger, `longtask` observer, 1 Hz `[diag]` console line, `window.__cannetPerf` | off — nothing registered, nothing counted | `--diag`, or any `--perf-*` flag |
| Render-tier capture (`RenderReport`), and with it the host's process-memory sampler and the `flush_ms` / `tx_late_ms` max-recorders | off — no capture armed, no sampler, no atomics written | `--perf-capture-secs`, or `window.__cannetPerf.begin()` |
| Synthetic gesture driving | off — no interval scheduled | `--perf-interact` |
| Project auto-open / auto-connect / auto-exit | off | `--project`, `--connect-on-start` |
| User-scope redirection | off — the real profile | `--app-data-dir` |
| `tx-flush` / `tx-sched` dev-log lines (stderr only; they never reach the System Messages panel or `cannet.log`) | off — the default log filter excludes both targets, so the lines are never formatted | `RUST_LOG=tx-flush=info,tx-sched=info` |
| WebView DevTools / remote debugging port | closed — the release build has no inspector | the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable, read by the WebView2 runtime (what the screenshot harness sets) |

Always on, by design and with the cost accepted as a product budget:
the **health sampler** (a system process-table refresh and a memory /
buffer / cache summary into `cannet.log`, every 20 s — set
`health_sample_ms` to `0` to switch it off), the **UI-liveness
heartbeat** (one IPC call a second, whose *arrival* is the host's only
evidence the renderer's main thread is still turning), and the
background emitters that feed the live views (`trace-grew` at 100 ms,
the trace flusher at 2 s, clock status at 1 s).

**How to run one so the numbers mean something.** A capture measures
the machine as much as the build, by more than the margin a gate
judges — one unchanged binary has measured a 9× spread on
`rx_gap_short_frac_worst` across back-to-back runs and a 2.2× spread
on `renderer_mb_drift_per_min` between two sessions the same evening.

- **Run on a quiet machine**, with nothing else competing, and not
  immediately after a build or other heavy work. Concurrent CPU load
  on its own is enough to push `rx_gap_short_frac_worst` past its gate
  limit with no code change.
- **Compare runs from one session** to each other. Numbers carried
  across sessions are a weaker comparison than they look.
- **Take several runs per gate**, and when one run breaches while the
  others are clean, **re-run it** after letting the machine settle
  rather than trying to explain it: the gate stands on the re-runs,
  and a breach that repeats is real.

The render report this writes is the frontend counterpart to the host
harness's baseline. The harness can't generate it (only the webview sees
the render tier), so it's fed in: `cannet-perf-measurement baseline
--frontend-report <report>` stores its gated UX-health metrics
(long-task time, lag, jank fraction) alongside the host modes, and
`cannet-perf-measurement check --frontend-report <fresh-report>` gates a
fresh run against them. `baseline` writes a dated
`<date>-<hash>[-dirty].json` snapshot; `check` compares against the
canonical `docs/performance-measurements/baseline.json` — promote a
snapshot to the reference by copying it there. During development,
frontend render reports live under
`docs/performance-measurements/frontend/`, kept apart from the host
baseline they feed — but they are working artifacts, not records: when
a development campaign closes, its final gate is captured back into
`baseline.json` and the accumulated dated reports are deleted, so the
directory always holds one baseline describing what ships and the next
campaign gets a clean A/B reference. (Per-gate numbers survive in the
task files' status logs in git history.)

**Hand every run in the gate to one `check` invocation** — repeat
`--frontend-report` once per run, rather than checking each report on
its own:

```sh
cannet-perf-measurement check \
  --frontend-report run1.json --frontend-report run2.json --frontend-report run3.json
```

This is the canonical gate form. Every metric except the three
memory-drift ones (`jsheap_mb_drift_per_min` / `renderer_mb_drift_per_min`
/ `tree_mb_drift_per_min`) keeps the worst-run rule — one verdict per
report, any one report's regression fails the gate — but the drift
family instead gates the **median** of the given reports (ADR 0031: a
least-squares slope over a short capture window is a noisier per-run
statistic than a latency maximum, and its session-to-session spread has
been measured wider than a gate's own limit margin). Limits are
unchanged, only the statistic gated against them moved. A single
`--frontend-report` still behaves exactly as before — the median of one
run is that run.

The window below the toolbar is a dockable panel area. The default
layout has a **trace panel** and a **project panel** (the project's
*elements*, the configured bus(es), the loaded DBCs). A trace panel
has a **trace / by ID** mode toggle: *by ID* (the default) shows one
row per arbitration id with its latest frame and its current message
rate (the **msg/s** column, by-id only) — click a column header to
sort by it (click again to reverse, again to clear — ▲ / ▼ marks the
sorted column); *trace* is the chronological view (one row per frame,
follows the live edge). **Add trace** creates a new trace element and a
panel for it (in by-ID mode — toggle it anytime); the new trace starts
**empty and stopped** (hit **Start** to begin capturing), regardless of
what's already in the session buffer. The project panel
lists the elements — closing a panel doesn't destroy its element,
reopen or remove it from there. **Project panel** toggles the project
panel itself (it's a show/hide singleton). **Database panel** opens
(or focuses, if it's already open) the catalog of every
signal-defining artifact the session holds — one surface, each format
organised the way that format organises signals (ADR 0052). Loaded
DBCs form a tree-with-fuzzy-search grouped by bus
(`bus → DBC → ECU → message → signal`, per-transmitter grouping
like the RBS panel; messages with no `BO_` transmitter fall under
"(no transmitter)"; a database not assigned to a bus decodes nothing
and appears once, under an "(Unassigned)" group saying so — this row
is the only discoverability the app offers for an unassigned database,
by design. Two databases assigned to the same bus that define the same
message/signal id is a rare mistake the panel warns about, naming
which one wins the decode — by project load order, unless the signal
has been given a database of its own in the view-signals panel, in
which case that is the one named and the one that decodes). Type any fragment of a signal
name, ECU, comment, value-table label, message id (hex or decimal),
or attribute, and the tree filters to the matches: ancestors of a
match auto-expand and everything else is hidden, so a filtered
render stays bounded by the match set however large the database.
**Ctrl/⌘+F** puts the cursor in that search box from anywhere in the
panel. The whole tree is keyboard-navigable — arrow up/down move, right
expands, left collapses (or walks to the parent), Enter selects.
The toolbar's **details**
toggle reveals the full per-signal detail (bit positions, scale,
range, mux indicator, float kind, attributes, value table) and
per-message detail (length, FD/BRS, mux flag, attributes). Drag a
signal or message row onto a plot panel to add it as a series, or onto
the transmit panel to create a new TX frame for that message;
multi-select (click / Shift-click / Cmd-Ctrl-click, or Shift+↑/↓ from
the keyboard) drags the whole selection at once.

Beside the DBC branches, a capture that carried its own signal
definitions gets **one branch per source file**, named for the file and
organised the way that file organises signals: source file → signal
channel group → signal (name and unit). They are the capture's, not the
project's — they arrive with the import and go when the capture does,
and nothing about them is written into the project. Searching, keyboard
navigation and drag work exactly as they do for a DBC signal: drag one
onto a plot and it becomes a series like any other.

The host watches every loaded DBC file and
auto-reloads the in-memory copy when the file changes on disk — no
need to click Reload after editing a DBC in another tool. Turn
**`dbc_auto_reload`** off if you would rather choose the moment the
decoding changes while you are editing a DBC mid-analysis; a file that
disappears is still reported either way, and Reload DBC still works.
Singleton
like the project panel, and read-only (DBCs are added / removed from
the project panel, not from here).

**View signals** opens the signal-mapping panel: one row per signal the
open views reference, live — what decodes it today, which views use it,
and whether that still matches what the view was configured against
(Not Decoded / Scale / Ambiguous / Stale / Decoded, most severe first).
The launcher carries the count needing attention (Not Decoded, Scale,
Ambiguous) and is quiet when there is nothing to look at. Assigning or
unassigning a database moves rows without a reopen. It is a repair
surface as well as a report, and the **source** column is where both
repairs are made, with no apply step. Choosing the *same* signal under a
different database settles the ambiguous case: the choice is recorded in
the project against the signal, and is the one the decoder resolves it
through (ADR 0054). Choosing a *different* signal of the same message is
the **remap** — what a renamed signal needs — and it rewrites every
persisted reference to the old name at once: every plot's series, every
signals view's selection and sections, every colour map's target, the
transmit frames' calculated fields, and the signal's colour override.
One signal is one row, so a repair is never made per view, and nothing
durable is left behind mapping the old name onto the new one — revert
the database and the panel reports the difference the other way round.

Each RBS panel's toolbar carries its own **Signals** button, opening
that config's signals grid — the same gridview as View signals, scoped
to one `.cannet_rbs` instead of combined across every view (two RBS
sims are meant to hold different values and timings, so their rows
never merge). One row per field the config transmits, with the
encoder's own taxonomy naming where its bits came from: Not Encoded
(nothing defines it — an override naming a signal or message no
assigned database has), Out of Range (an applied override outside the
signal's declared range — flagged and clamped here, on entry, since
truncation on transmit is otherwise silent), Unknown Value (an
override the encoder couldn't resolve — a bad hex string, an
unrecognised enum label — so the default went out instead), Override,
Default (the DBC's start value, or the file's fill bit — neither is
something you set), and Muted (the message won't play). The value cell
is the same editor the RBS panel's own tree uses, so an edit here and
an edit there can never disagree.

New panels arrive as a tab
in the active group — drag a
panel by its tab and drop it against an edge of the area to split it
side-by-side, or onto another panel to tab them together. Each trace
panel keeps its own scroll position, auto-scroll toggle (trace mode),
and column layout — drag the divider at a column header's right edge to
resize, and **right-click the header** to show / hide columns. The
**time (s)** column shows elapsed time since the session start (ADR
0024); hover a row's time to read the same instant as that message's
local date and time. A capture with no wall clock behind it — a BLF
carrying no measurement start time, whose session is anchored on the
file's own zero — shows no tooltip, because there is no absolute instant
to name. Trace
panels carry the trace controls: the data lives in a session buffer
that fills while connected (reset when you disconnect / reconnect;
a quit or crash instead **persists** it to disk and reloads it on the
next launch — see *Indefinite-length capture* below), and a *trace* is
each panel's own window over it — **Pause**
freezes the view (**Resume** continues, including frames received while
paused), **Stop** freezes it (**Start** then begins a fresh, growing
trace), and **Clear** empties the window keeping whatever state it's in
(Clear doesn't imply Stop or Pause — a running trace stays running).
The session buffer keeps filling underneath regardless.
(Tearing a panel out into a separate OS window isn't supported yet —
docking is within the one window; the tear-out item is in
`plans/backlog.md`.)

**Undo / redo.** `Mod+Z` and `Mod+Y` (`Mod+Shift+Z` also works) step
back and forward through what you've done to your views — not just the
docking layout (a panel added, closed, or moved), but the elements
inside it: signals added, removed, or reordered on a plot or signal
view; a plot area dragged within a panel or onto another one; a filter
added; a rename; a visibility or collapse toggle; a color pick; a
column resize. The two chords share one timeline, so either always
reverses whatever you did most recently, layout or element. **One
gesture is one step**: however many changes a drag makes as it plays
out, or however many keystrokes a rename takes, undoing it takes
exactly one `Mod+Z`, and a plot area dragged from one panel to another
is a single step too. `Mod+Z` / `Mod+Y` are ordinary commands —
rebindable or removable from the shortcuts panel like any other — and
while a text field has focus they fall through to the field's own text
editing undo instead.

Undo never touches the bus. It reverses what a view looks like and
nothing else: an RBS element's Run flag, a transmit message's
schedule, the connection, and the capture itself sit outside it by
design ([ADR 0050](docs/adr/0050-undo-covers-view-state-only.md)) —
undoing the removal of an RBS or transmit element brings its view back
without re-arming it or re-adding its messages to the host, and undo
never re-runs a host side effect. Zoom, pan, and scroll aren't covered
either — they were never persisted view state to begin with.

### Indefinite-length capture

The session buffer is not held in RAM — it is a **memory-mapped store**
on disk, so a capture can run indefinitely (hours to days, well past
physical memory) with every historical frame still addressable for
scrolling, filtering, and plotting. Each frame is written straight
through to memory-mapped segment files in the open project's own cache
(`.cannet/cache/` inside the project directory, which links to
cannet-managed local storage under an OS cache directory —
`$XDG_CACHE_HOME/dev.cannet.app` on Linux, the platform equivalent
elsewhere); the kernel page cache keeps the hot part resident and pages
cold history out under pressure, so RAM stays roughly flat while
the on-disk cache grows (the status line shows both — `… RAM`, the
whole application's resident memory, and `… cache`, the scratch
footprint on disk). Decoded-signal plot data and the search indexes are built on
demand and memory-mapped the same way. See
[`docs/adr/0001-indefinite-length-capture.md`](docs/adr/0001-indefinite-length-capture.md)
and [`docs/adr/0002-disk-spill-store.md`](docs/adr/0002-disk-spill-store.md).

**The capture belongs to the project.** Each project gets its own
cache, so opening a second project doesn't destroy the first one's
capture — come back and it's still there. If you haven't given a
project a directory of its own (below), cannet keeps one for it in its
own cache space; nothing about that is a different mode.

Because it lives outside the process, the capture **survives a quit or
crash**: on the next launch the prior session reloads as a *stopped*
historical trace so nothing is lost. The decoded-signal caches behind
the plots normally come back with it, so plotting a restored capture is
immediate. When they can't — a DBC in the set changed, or the capture
came back truncated, so what was cached no longer describes it — they
are thrown away and rebuilt by decoding the capture's frames again,
which on a long session is minutes. The status line says so
(**Rebuilding signal caches…**) for as long as it takes, and offers
**Discard** beside it: that drops the restored capture — frames, caches
and events — leaving an empty session, and keeps the project, its DBCs,
your layout and your server configuration. It is wiped when you replace it —
**Start** a new capture or **Clear** — or, opt-in, on a clean exit
(**Settings → clear scratch cache on exit**, off by default). This
scratch is ephemeral working storage, not an archive: to keep a capture
permanently, use **Save Capture** to write a durable `.blf` or `.mf4`.

By default the scratch is **unbounded** (limited only by free disk). To
cap it, set a byte limit in **Settings**; over the cap the store drops
the oldest frames first (a windowed ring), keeping the most recent
history within budget. A reloaded capture that was truncated this way
shows a marker at the point where older history was dropped.

A `.json` *project* file holds the panel layout (including each trace
panel's column layout and auto-scroll toggle), the project's elements
(traces — and later plots, transmit messages, …), the loaded DBC
paths, the project's logical buses, and the interface bindings (each
of which names its own server address). The **project panel** (or the
toolbar's **Open project…** / **Save project**) drives it: **Save** /
**Save As…** write one, **Open…** restores it (re-loads the DBCs and
restores the bus / binding configuration — hit **Connect** to switch),
**New** starts a fresh unsaved project (default layout, no DBCs, disconnected,
buffer cleared). The panel also lists the configured server(s) with
**Connect all** / **Disconnect all** and the loaded DBCs with **Add…**
/ **Remove** / **Reload all from disk**. The
last opened/saved project is reopened on launch, unless you turn
**`reopen_last_project`** off — then a launch starts with nothing open,
in the auto-located project directory, and the pointer to your last
project is kept so turning it back on resumes there. A launch with no
project comes up on the default layout: view state is a project's, so
a session that opens nothing neither keeps nor restores one. The
window's own size and position always resume, project or not. Unsaved
changes show a `●` in
the project panel, and closing the window with unsaved changes prompts
you (Save & close / Discard & close / Cancel) — unless **Autosave on
exit** is on and the project has its own directory, in which case the
close saves silently instead; see below. Not carried in
the project: a trace's window
position (it re-anchors to the session buffer on each launch anyway),
and the BLF replay path.
The open project file is watched on disk, the way a loaded DBC is —
edit it in another tool (or pull a new revision) and cannet picks the
change up. Unlike a DBC it is not applied blindly, because cannet
writes this file too: it re-opens the project silently only when there
is nothing to lose — no unsaved changes and no session up — and
otherwise says *Project changed on disk* beside the status readout,
with **Reload** and **Dismiss**. Reload is the only thing that applies
it, and it is an ordinary project open: unsaved changes go, and the
session is dropped and re-rooted. Dismiss keeps what you have (and the
next Save overwrites the file). A project file that is mid-edit and
won't parse is logged and ignored, and one that disappears doesn't
close the project.

**The project directory.** To keep a project's data with the project
rather than in cannet's cache, make a `.cannet/` folder next to the
`.cannet_prj` file. That pair — a project file *beside* a `.cannet/` —
is what makes a folder a project directory. There is one other way one
comes into being — **Save project as…**, which makes the folder you
pick into a complete project directory and moves the open project's
data there with it. Otherwise cannet never creates a `.cannet/` in your
folders because you opened a file there. Inside it, cannet keeps that project's
settings overrides, its view state, and `cache/` — a link to the
machine-local storage the capture actually lands in, kept out of the
project directory itself so a memory-mapped multi-gigabyte scratch
never ends up on a network share. A `.gitignore` covering `cache/` is
written with it, since a project directory is plausibly a repository.
Settings resolve user-first, project-second: a value in
`.cannet/settings.json` overrides your own for that project, and every
other setting stays as you set it. **New project** hands the session
back to the auto-located directory an unsaved project gets, so what it
records from there — its recent captures, its view state — belongs to
it and not to the project you just left. See
[`docs/adr/0042-project-directory-and-scopes.md`](docs/adr/0042-project-directory-and-scopes.md).

**Settings.** The settings panel is a view over `settings.json`, not a
replacement for it — the file is the durable contract and editing it by
hand is a supported path (ADR 0034). Every row shows the field name it
writes, so the panel teaches the file.

- **Theme.** **General → Theme** switches between `dark` (the default),
  `light`, and `lighthk` (a pink theme). It applies immediately — no
  restart — and the whole window follows, plot canvases included.
  Colors you picked yourself (a bus color, a per-signal color, a
  color-map rule) are stored with the project and render exactly as
  chosen under any theme; only the colors the app derives follow the
  theme. **Clear project colors** in the command palette discards the
  picked bus and signal colors so they fall back to the current
  theme's defaults — it asks first, and it leaves color-map rules
  alone.
- **Autosave on exit.** **General → Autosave on exit**, off by default.
  On, a dirty close saves silently instead of prompting — but only for
  a project with its own directory (one you made a `.cannet/` folder
  beside, or reached via **Save project as…**). A project cannet
  auto-located, or one never saved at all, still prompts either way:
  nothing here mints a project file for you. Project-overridable, like
  the cache size cap.
- **Finding one.** Type in the search box. It matches a setting's name,
  its `settings.json` key, its help text, and its tags, so you can find
  a setting you can describe but can't name — searching *what it does*
  works. The list beside it groups settings by the part of the app they
  govern; picking a group narrows the list.
- **What you changed.** A setting that differs from its default is
  marked and offers **Reset to default**. One the open project
  overrides is marked as the project's, so a value that came from
  `.cannet/settings.json` never looks like a personal preference.
- **A value the app can't honour is refused, not repaired.** Every
  bounded field states its limit once, host-side; a hand-edit outside
  it is rejected on the way in, reported on the **System Messages**
  panel with the field named, and the field falls back to its default.
  Your file is left as you wrote it — nothing runs at a number the file
  doesn't show. A few fields treat `0` as "off" rather than as a
  minimum (`system_log_rate_limit`, `health_sample_interval_ms`,
  `sidecar_restart_budget`, the two recents depths); their help text
  says so. A value of the wrong *shape* — text where a number belongs —
  is refused the same way, and costs **that field only**: the rest of
  your file is untouched.
- **Environment variables win, and say so.** `CANNET_SIDECAR_DIR` and
  `CANNET_DRIVER_MODULE` have settings equivalents (**Sidecar
  directory**, **Driver module**), but the variable takes precedence
  for the run it is set in — it is the escape hatch, and a file
  shouldn't be able to disarm it. When one shadows a setting you have
  filled in, the **System Messages** panel says which variable
  overrode which key, with both values, so the file never quietly shows
  something the app isn't using. The three settings the sidecar is
  launched with — its directory, its driver module, its log level —
  are re-read on every spawn, so the project panel's **Local
  interfaces → Restart** applies a change without relaunching cannet.
- **Defaults you can still change per view.** Some settings only decide
  what a *new* view starts as — the trace panel's **Default trace
  view**, **Default auto-scroll**, and **Default events overlay**, the
  plot's **Default y-axis layout**, **Default trace columns** /
  **Default signal columns** (which columns a new table shows, in what
  order, how wide), the **Default server address** a new bridge
  form opens filled with, and the **Default bus bitrate** a bus you add
  starts at (blank — what ships — adds it with no bitrate at all, so
  the adapter's own applies, exactly as **Add bus** has always done).
  They are read once, when the view is created, and the view's own
  controls win from then on: changing one of these never reaches back
  into a panel you already have open, and a panel restored from a
  project keeps what you set in it. The column rows are the one setting
  with a purpose-built editor rather than a plain control — a table
  header adjusts the panel in front of you, so the default needs a home
  of its own; **Use the built-in layout** puts it back.
- **CAN-ID format.** The trace and by-ID tables spell an arbitration id
  in zero-padded hex by default; **`can_id_format`** switches them to
  decimal. The `s:` / `x:` prefix stays either way — 11-bit and 29-bit
  ids overlap as numbers, so it is the only thing saying which frame a
  row is. Display columns only: the transmit and filter editors still
  take hex.
- **`developer` settings.** Machine-load and internal-cadence knobs —
  the plot's fetch interval, the view refresh interval, the live-update
  rate, the reconnect backoff, the health-sample cadence, the status
  notice dwell. They exist so that every knob the app has lives in
  `settings.json`, not because tuning them is expected, and they are
  **hidden until you turn on `show_developer_settings`**. Revealed, they appear in their own
  **Developer** group rather than mixed into the others. Nothing is
  hidden from the file: they are all in `settings.json` whether the
  panel shows them or not.
- **Reclaiming disk — Storage › Project caches.** Every project keeps
  its own capture, so the panel lists every project directory cannet
  holds cached data for and what each one is currently using (measured
  when you look, not on a timer — the walk is not cheap). Two actions,
  and they differ: **Clear data cache** empties one project's cached
  data and keeps both the cache directory and the entry; **Delete**
  removes the cache directory and forgets the project. **Neither
  touches your project directory** — if the app won't create a
  `.cannet/` unasked, it won't remove one either. **Clear all data
  caches** empties every one and removes nothing. Clearing the open
  project discards the session in progress, and deleting it is
  unavailable while its cache is mapped. A project directory you
  deleted outside the app is listed as *project gone* until you delete
  its row, so Clear means the same thing everywhere; one whose
  `.cannet_prj` you moved away — leaving the `.cannet/` un-paired — says
  *no project file*, which is otherwise a cache with nothing pointing at
  it. And if the open
  project is living in cannet's cache space, its row offers **Save
  as…** — this list is the one place you see that it is.
- **Keeping decoded signals that lost their definition —
  `pyramid_retention_bytes`.** A plotted signal's decoded samples live
  in a cache that takes minutes to build over a long capture and
  milliseconds to reopen, so when a DBC is unloaded or edited so that a
  signal no longer decodes the way its samples were decoded, that cache
  is **parked rather than deleted**: load the database back and the
  samples come back with it, unbuilt. **Keep unreferenced signal
  caches** bounds what is parked, in bytes (default 16 GB, oldest given
  up first); `0` keeps none, which is what the app did before. It is a
  separate budget from **Cache size cap** on purpose — that one bounds
  the capture you are working on, this one bounds what is kept for a
  session that may never come.

**Add plot panel** opens a signal plot (Phase 4): a uPlot-based
oscilloscope-style view, docked like any other panel. It's backed by a
**trace element**, like the trace panels — same windowed view over the
session buffer with **Start / Stop / Pause / Clear** — it just renders
signal *values* over time instead of message rows: while running it
follows the live capture, Pause/Stop freeze the window (which also stops
the re-sampling), Clear re-anchors what's plotted to "now". **All data**,
beside Clear, is the other direction: it widens the window back out to
the whole session buffer (still following live if the trace was already
running) and fits the x-axis to it. This pairs with Clear for the
DBC-reload recovery workflow — replacing a DBC with a full capture buffer
is otherwise painful while re-picking every signal selection: **Clear**
first, so each re-pick resamples against a near-empty window instead of
the whole buffer; then **All data** once, for a single full-history
resample at the end.

- **Y-axis mode.** Each plot area carries a y-axis-mode selector
  (next to **fit y**) with three values per ADR 0026: **unified**
  (one axis; all series overlaid), **per-unit** (one axis per
  declared unit; unitless series share an axis), and **individual**
  (one axis per series). On any axis, series sharing a declared unit
  share one y scale (the union of their observed ranges) and each
  unit group auto-scales independently to fill the axis; the y-tick
  labels always show the primary signal's real engineering values
  (click a series row to select it and promote it). Switching modes
  re-stacks the
  area's canvases; the side panel for each derived axis lists only
  the signals it draws. The area-level chrome (filter editor,
  y-axis-mode selector itself, remove ×) appears only on the top
  derived axis so there's one source of truth per logical area.
  An enum-only axis renders as a **logic-analyzer lane**: the line
  is stepped, the y-tick labels are symbolic (`<raw> "<label>"`),
  and each held segment carries an opaque label box, all sat in a
  centered horizontal band down the middle of the plot
  (`│ Idle │ Running │`). Decoupling the label band from the
  value's y position means a value table with many entries still
  gets readable labels rather than collapsing each label to a few
  pixels — the line shows the held value, the ribbon shows the
  label. The lane activates whenever a single enum signal sits on
  its own axis — i.e. an area with one enum signal in any mode, or
  any enum that ends up alone under `individual`. Enum break-out
  onto its own axis under `per-unit` is still pending — see
  `plans/backlog.md`.
- **Plot areas.** A plot panel is a **stack of plot areas** — it starts
  with one; **add plot area** appends more, all sharing one time axis,
  and they flex to fill the panel (one fills it; several split it).
  The **grip (⠿)** at the left of an area's signal-panel heading drags
  the whole area: **within the panel**, onto another area's position in
  the stack; **onto another plot panel**, where it lands at the drop
  position and *leaves* the source panel — hold **Ctrl** as you let go
  to copy it instead. A moved or copied area brings its series, its
  patterns, its y-axis mode, its primary signal, its collapsed state and
  its manual y ranges with it; the stack's vertical weights stay behind.
  A panel that gives up its last area keeps a fresh empty one. Dropped
  on a panel that understands only *signals*, the same drag reads as an
  add of the area's signals and patterns there, and the source keeps its
  area. Each
  plot area has a uPlot canvas (time axis at the bottom) plus a **signal
  panel** beside it listing that area's signals: a color swatch (click
  to hide / show the line — the value keeps updating, the swatch dims;
  **right-click** the swatch to pick the series' color from the
  browser's color picker), the name, and the value — at cursor A when one is placed, else at the
  mouse crosshair, else the latest sample. A hidden row drops to a
  single line — swatch and name only, nothing else to read while
  nothing draws — and returns to the full row when shown again; the
  swatch stays the way back either way. While the pointer is over the
  panel, the bottom-most area's **`time (s)` axis label** also carries
  the crosshair's own time — the instant those readouts are taken at —
  as elapsed time on the shared timeline (ADR 0024); it reverts to the
  plain label when the pointer leaves. (Cursors A and B already label
  their own lines with their times.) The signal-panel head shows
  the H1/H2 Y-cursor values + ΔH when those are placed; y scales are
  always auto-derived (per ADR 0026) and **fit y** refits the
  auto-norm latch to the visible window. Signals are added by **drag**
  — from the Database panel, the signal view, the trace, or another plot
  area or panel — or by an area's **patterns…** regex editor; there is
  no separate add-signal picker. **Drag a signal row** to re-order it,
  onto another plot area, or onto another plot panel (cross-panel drops
  in a copy); **×** removes it. A series' color comes from the signal's
  own identity, so the same signal reads the same in every area, every
  panel and the signal view, and re-ordering or moving it changes
  nothing; right-clicking its swatch pins a color of your own, and that
  pick is the only thing stored. The shared
  x-axis spans 0 to the longest plotted signal across the panel's
  areas, so a signal added late still shows over the existing span.
- **Selecting signal rows.** A **plain click** on a signal row selects
  that row *and* promotes it to the area's primary (the signal whose
  units label the y axis) — the long-standing promote gesture, now with
  a highlight. **Ctrl/⌘-click** adds or removes a row from the
  selection and **shift-click** takes the range from the last row
  clicked; neither of those moves the primary. **Shift+↑/↓** extends
  the selection a row at a time from the same anchor, the gridview
  panels' keyboard range gesture — it works from anywhere in the plot
  panel except a text box (which keeps Shift+arrow for selecting text).
  A selected signal's line
  is drawn **bold** in the plot, so the selection reads on the canvas
  and not only in the side panel. A selection belongs to
  **one plot area**: clicking a row in another area starts that area's
  selection and clears the first, and a shift-range runs over the whole
  area's signal list — in `per-unit` / `individual` mode that means
  across every axis the mode splits the area into. The selection is
  view state; it is not saved with the project. The swatch's hide/show
  click and its right-click color picker are not selection gestures and
  leave the selection where it is.
  **Right-click** a row in the selection for a context menu with
  **Hide** / **Show**, applied to the whole selection in one batch (no
  bulk recolor, and no dedicated bulk-remove — drag the selection out
  instead). Right-clicking a row outside the selection selects just
  that row first, then opens its menu. **Dragging** a row already in
  the selection carries every selected row in the drag payload — drop
  it on another area or panel to move or copy the whole selection at
  once, the same convention the Database panel's multi-select drag uses;
  dragging a row that isn't selected drags only that row and leaves the
  selection as it was. The same context menu carries **Sort area**, a
  one-shot reorder of the whole area's signal list by generator index,
  then name (case-insensitive) — unlike Hide/Show it ignores the
  current selection and acts on every signal in the area. It's a single
  reorder, not a live sort mode: drag stays the way to reorder
  afterward, and a signal a pattern added (not a manual pick) keeps
  following its pattern rather than moving.
- **Solo (show only these series).** The toolbar's **solo** box takes a
  regex over the canonical signal path `bus/ecu/message/signal` — the
  same dialect an area's pattern filter speaks, case-sensitive and
  partial, so `Cell16` still finds a bare name as the path's tail while
  `/EngineData/` selects a whole message. Every series it doesn't match
  is masked out of the *view*. It is a view mask, not a bulk hide: no
  series' own hide state is touched, so clearing the box (or
  **Escape**, or the **×**) brings the full view back exactly as it
  was, and a signal you really did hide stays hidden. An unparseable
  pattern is inert — the box marks itself **bad regex** and nothing is
  filtered — so a half-typed regex never blanks the plot. Solo applies
  **only to the areas it matched something in**: an area with no match
  renders exactly as if solo were off, and a pattern matching nothing
  anywhere changes nothing at all — the toolbar read-out says
  `no matches`, styled distinctly (muted) from an ordinary position
  label. Inside an area it does apply to, being left with no visible
  series gives up the plot height like any all-hidden area, without
  touching its own collapse toggle; a row solo is why you can't see it
  compacts to the single-line hidden treatment above, with its own
  marker instead of the plain dimmed/italic look, so it doesn't read as
  something you hid yourself — that's the whole matched set, or a
  captureless pattern's flat filter, on show. Stepping to a page is
  stricter still: see "Stepping by group" below. An area solo
  applies to also shows a small `3 of 12 match` chip beside its label —
  how many of that area's own series matched — and a zero-match area
  shows no chip at all. The pattern is saved with the panel in the
  project file. **Ctrl/⌘+F** focuses the box from anywhere in the plot
  panel.
- **Stepping by group.** A solo pattern's **capture groups** decide
  what one step covers: each match's key is what the pattern captured,
  and every signal sharing that key steps as one — so `Cell(\d+)` walks
  cell indices however many areas they are spread across. Keys sort
  numerically (`Cell2` before `Cell10`); several groups make a tuple
  key, in the order they are written, which a `$N` suffix on a *named*
  group overrides (`Cell(?<cell$2>\d+)_Bank(?<bank$1>\d)` keys by bank
  first, and the suffix is not shown). `(?:…)` captures nothing, so it
  opts a group out of the key. **A pattern with no capture groups has
  no pages at all** — there is no index to page by, so it is a plain
  flat filter: everything it matches is on show at once, in every area
  that holds a match (and an area with none is left alone, as ever), the
  read-out says `all (96)`, and the step controls are disabled because
  there is nowhere to step.
  For a capturing pattern, a **page** is *Solo groups per page*
  consecutive groups (Settings →
  Plot; 1 by default), so `Cell0*(\d+)` at 5 per page gives cells 0–4,
  then 5–9. The **‹ / ›** controls beside the box — and **PgUp / PgDn**
  anywhere in the plot panel, clicking any part of it, the canvas
  included, gives the panel focus — walk the cycle **all → page 1 → …
  → page N → all**, so the whole matched set is always one press away.
  The read-out between them says which: `all (96)`, or
  `2/12 · cell=07 (16 of 96)` — page, the group it covers, and how many
  of the matches that is (a page spanning several groups reads as the
  range, `1/2 · "0"–"4" (40 of 96)`). It says `no matches` when the
  pattern selected nothing. Typing or editing the pattern lands on page
  1; **Escape** (or clearing the box) drops the whole solo view at
  once. **A page is the working set**: a match on any other page has no
  row in the side panel at all — not dimmed, not there — so the list
  stays short and the page indicator carries the "there's more"
  context. Stepping scrolls each area's signal panel back to the top,
  so the new page's first row is always where you land. A signal both
  hidden on its own and on the current page still shows, compact, same
  as ever — solo only ever narrows what's visible, it never brings a
  hidden signal back.
- **Picking a subset by hand.** **Right-click the solo control, or left-
  or right-click the position read-out,** for the match list, and
  **tick any subset of it** to show exactly those — the groups for a
  capturing pattern, the individual matched series (labelled
  `Area 2 · Cell1`, so two of a name read apart) for one that captures
  nothing. The menu stays open while you tick, so a subset is built in
  one visit; unticking the last item is the whole matched set again. The
  read-out names the subset — `2 groups · cell=03, cell=07 (12 of 96)`,
  counting instead of listing past two — and the subset is saved with
  the panel in place of a page. A ticked subset is the same working set
  as a page: what isn't in it has no row in the side panel either.
  Stepping **leaves** a subset: **›**
  resumes at the page after the last ticked group's, **‹** at the page
  before the first ticked group's. Editing the pattern drops it.
- **Collapse / expand an area.** The **▾ / ▸ toggle** at the left of a
  plot area's signal-panel heading (beside the grip) collapses that
  area down to **one heading row** — its name, how many series it holds,
  and how many its patterns match — and gives everything else back:
  the canvas, the signal rows, the per-area controls, and, in per-unit
  or individual mode, the extra axis strips. Expanding restores the
  layout exactly as it was, splitter-dragged axis heights included. One
  toggle per plot area however many axes its y-axis mode stacks, and the
  state persists in the project file. An area whose signals are **all
  hidden** collapses on its own (there is nothing to draw); that one
  *keeps* its rows — a swatch in them is how you un-hide a signal — and
  its toggle is inert until you do. Stacked collapsed areas leave a band
  of empty canvas column with **one drag handle for the whole run** —
  grab it to drag the run's first area, reordering it here or moving it
  to another panel like any grip; to move a specific area buried inside
  a run, drag its own grip or drop onto its side-panel strip.
- **Collapse / expand one axis.** In per-unit or individual mode each
  axis carries **its own ▾ / ▸ toggle**, on its own label (`Area 1 ·
  [V]`). Collapsing leaves that axis as a label strip: its height goes
  to the axes still drawing, and the splitter it would have traded with
  disappears since there is nothing left to trade. Its series keep
  running and keep their visibility — this is layout, not hiding — and
  the state persists per axis alongside the axis heights. Collapsing
  every axis of an area is fine; each strip keeps its own toggle.
- **Zoom, pan & follow.** **Wheel** zooms x on every area; **shift +
  wheel** pans x (synced); **right-drag** box-zooms x; **⌘/ctrl +
  wheel** zooms y on the hovered area (buried — y is usually set with
  the per-area range control); **fit data** refits x to the full signal
  extent. **Follow live** keeps every area pinned to the capture's
  growing edge while keeping the current visible x-width (it just slides
  right); a manual x pan/zoom turns it off, the same way a manual scroll
  leaves auto-scroll in a trace panel.
- **Show points.** A tri-state toggle on the toolbar (`auto` / `off` /
  `on`) that applies to every series on every axis of every area in
  the panel: `auto` (default) defers to uPlot's density-aware mode
  (points appear only when the sample-to-pixel ratio is low enough),
  `off` forces no points, `on` forces points always. Persists in the
  project file.
- **Cursors & measurements** (both **off by default**). The toolbar's
  **cursors** selector turns on **X** cursors (left-click places A,
  right-click places B, drawn through every area — a small **Δt** chip
  shows on the plot between them), **Y** cursors (per-area H1 / H2 —
  values and **ΔH** show in the area's signal-panel head, plus a chip on
  the plot), or **+ note** (left-click drops an event note at that
  time); **clear cursors** removes them all. The **measurements** toggle
  reveals a readout strip whose cells are configurable (the
  **measurements ▾** checklist): A, B, Δt, 1/Δt, and per-trace value@A /
  value@B / Δ / min / max / mean over [A, B]. Event markers — the
  capture-start "T0" plus your notes — draw as vertical lines across the
  areas; the event log under the panel renames (click the label) and
  removes notes.
- **Number formatting.** Every float the plot shows — the signal
  panel, the cursor readouts, the measurement strip, the y-axis tick
  labels — reads under **one magnitude rule**, so a value can't read
  `0.0001` in the panel and `1.0e-4` on the axis beside it. It goes
  exponential only when it is *small or large*: below **`1e-4`** or at
  **`1e6`** and up (both are settings — **Exponential below** /
  **Exponential from**). Otherwise it is written out in full, to six
  significant figures in a readout and three on a tick, with no
  trailing padding — so a six-figure reading just above the small
  threshold writes nine decimals (`0.000123456`) rather than
  switching. Zero always reads `0`. In exponential form the mantissa
  carries a fixed five decimals with the trailing zeros kept
  (`1.00000e-6`), so two readings of one magnitude are one width;
  **Exponential mantissa decimals** changes that width. A signal whose
  DBC gives it a fixed precision keeps that precision instead, and one
  the DBC marks as a raw bit field still reads in hex. A **log-scaled
  y-axis always labels exponentially** — its ticks are decades, and
  mixing the two notations on one axis reads as two quantities.
- **Performance.** Each re-sample slices only the trace element's
  window out of the store by frame index (so the work is bounded by the
  window, not the whole capture), and the result is min/max-decimated
  host-side to ≈the plot's pixel width before it reaches uPlot (spikes
  survive the decimation), and the live plot re-samples **incrementally**
  on a self-paced loop at ≈15 Hz — each tick only the frames appended
  since the previous one are decoded and appended to a bounded per-signal
  cache, so a long capture isn't re-decoded every tick. Pause stops the
  loop. The toolbar shows the realised update rate, the worst recent
  re-sample time, and the device-pixel ratio.

Multiple plot panels can be open, each independent; the areas, signal
assignments, y-ranges, follow-live, cursor mode, and measurement
selection round-trip through the project file (the play state, like a
trace panel's window, is session-only). Notes are session-scoped (the
plot panels read and write a shared host store) and persist to disk
inside the BLF as `GLOBAL_MARKER` records (no sidecar — ADR 0010) —
see the Phase-9 section below. (Still pending — see
[`plans/tasks/0023-plot-measurements-and-triggers.md`](plans/tasks/0023-plot-measurements-and-triggers.md) and `plans/backlog.md`:
per-trace y offset/gain and log scale, triggers, math channels,
CSV/image export.)

### Transmit panel + enum signals

**Add transmit panel** opens the transmit panel: a single column of
collapsible frame-tiles, each composing one CAN / CAN FD message that
can be sent on demand or scheduled cyclically.

The transmit messages are a **host-owned model**, not panel state: the
Rust host holds the single TX-message pool (`transmit_frames`), runs
periodic schedules on host threads, and persists the pool in the
project file (`Project.transmit_frames`). The panel is a thin view —
it lists the pool, renders the subset its element's `frameIds` group
names (in that order), and routes every edit / send / start / stop
through a Tauri command. So a running periodic keeps emitting at its
true cadence regardless of UI frame-rate, edits to a running message
take effect on the next emitted frame without a stop/start, any number
of messages can share an id/bus, and two transmit panels grouping the
same message stay consistent. (Phase 13 Step 9; ADR 0003.)

Each tile carries an id (hex), addressing mode (standard / extended),
destination bus, kind (classic / FD / remote / error), payload, BRS
where applicable, DLC for remote frames, a manual-vs-periodic mode
toggle, a cycle-time when periodic, and an optional free-text
**description** (the message's *name* is the DBC message name resolved
from its id). Tiles drag-reorder via a bus-tinted handle on the left
edge (which rewrites the group order).

The collapsed face is the everyday control surface:

- **Per-byte hex cells.** The payload is shown as a row of two-digit
  hex cells (8 for classic, up to 64 for FD; FD wraps). `Tab` /
  `Shift+Tab` traverses cells.
- **Send / cycle controls.** A manual/periodic toggle picks between
  a `send` button (one-shot) or a period-ms input + `start` / `stop`
  pair (cyclic). The periodic schedule runs on a **host thread** at
  the message's cycle-time (not a UI-rate `setInterval`); removing
  the message, flipping back to manual, or stopping it ends the loop,
  and reopening a project leaves every periodic stopped until you
  press `start`.
- **Identity strip.** Description, bus, hex id, the DBC message name
  when the id matches a loaded DBC, and a per-frame `×` remove
  (confirm-on-click so an accidental tap doesn't drop a frame).

Expanding a tile reveals the **frame-shape strip** (kind, extended,
BRS / DLC) and — when the id binds to a DBC message — the **signals
table**. Rows are spreadsheet-dense: `name · value · unit · range`.
Range comes from the DBC `SG_` min/max when set, else derived from
the signal's `factor / offset / size / signed`. Plain signals show a
numeric input; **enum signals show a combobox** that filters the
`VAL_` labels as the user types and also accepts a raw number for
out-of-table values. Multiplexed messages show only the *active arm*
of the mux — switching the multiplexor zeroes the new arm's bits so
it starts fresh. Messages that declare *extended* multiplexing
(`m<N>M`) fall back to bytes-only editing with a note in the
expanded face.

Per-signal edits go through the host's `encode_frame` Tauri command,
which partial-encodes the named signals into the current payload
without disturbing any other byte. See
[ADR 0017](docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)
for the ownership and source-of-truth rules.

Where a sent frame goes:

- **Always** into the trace as a `Tx`-direction tx-confirm row, just
  like a real analyzer shows for its own transmits. The transmit
  pipeline is observable end-to-end even with no remote source open.
- **If a remote session is open**, also onto the wire as a one-frame
  `FrameBatch` envelope on the bus's bound interface. The BLF replay
  server is read-only and rejects the transmit with
  `Error::TX_REJECTED`, which surfaces in the system messages log
  (no per-frame status panel — successful sends show as Tx-confirm
  rows in the trace; failures are visible in the log). A
  `cannet-server debug vbus` server accepts transmits on its
  allocated participant id and fans them out to every other
  subscriber; a solo subscriber's transmit reaches no recipients and
  comes back as `Error::NO_ACKNOWLEDGER` instead.

**Enum / state signals** render symbolically wherever they appear:

- A trace row's expanded signal lines show `<value> "<label>"` for
  signals with a matching `VAL_` row; numeric signals are unchanged.
- The transmit panel's signals table renders enum signals as a
  combobox of labelled values (above).
- A plot area that contains *exactly one* signal with a value table
  switches to **enum mode**: the line is rendered stepped (no
  interpolation between codes) and the y-axis ticks become symbolic
  (`<raw> "<label>"`, one per value-table row), with auto-norm
  disabled. Multi-signal areas / mixed enum + numeric areas keep
  the numeric rendering.

#### Virtual-bus server demo

`cannet-server debug vbus` is dev/test tooling that exposes one
factory interface, `virtual:bus0`, and hosts a multi-client virtual
CAN bus (ADR 0021). Each connecting client `Subscribes` to the
factory, the server allocates them a fresh participant
(`virtual:bus0/p<n>` returned via `InterfaceAllocated`), and every
transmit from one participant fans out as `Rx` frames to every other
participant tagged with the sender's allocated id.

```sh
cargo run -p cannet-server -- debug vbus
# → virtual-bus mode: factory virtual:bus0 (speed 500000 bit/s, fd data off)
# → listening on 127.0.0.1:50051
```

Tunable via `--speed-bps` (arbitration-phase bit rate, default
500 000) and `--fd-data-speed-bps` (data-phase bit rate for FD frames
with BRS; `0` leaves the bus classic-only). Runtime reconfiguration
goes through the wire's `ConfigureBus` envelope and takes effect on
the next arbitration round. `--bind` defaults to loopback and, like
`debug replay`, terminates no TLS — a routable bind needs `--insecure`,
which this dev/test tooling keeps; the production proxy no longer has
one (§ Running the production server).

**Bridges.** Any session may install a bridge with `AttachBridge {
remote_address, interface_id, name }`. The server opens a session to
the remote endpoint, subscribes to the named interface, and wires the
resulting frame stream into the bus as a bridge participant. The new
bridge is published as `virtual:bus0/bridge-<name>` and every open
`WatchInterfaces` stream gets a fresh snapshot. `DetachBridge { name }`
tears it down; the same `WatchInterfaces` push announces the removal.
Pointing a bridge at another `cannet-server debug vbus`'s factory
yields the **CAN-over-IP gateway shape**: traffic on one server fans
out across the bridge to the other and vice-versa.

**`cannet-client` factory subscribes.** The Rust client now
understands `InterfaceAllocated`: a `Subscription::factory(id, ch)`
sends the factory subscribe, waits for the server's response, and
surfaces the allocated participant id through
`Subscription::effective_id()` on the resolved session. Frames the
server fans out (tagged with each sender's allocated id) are routed
back to the originating factory subscription by prefix-match so the
caller's `channel` mapping holds.

**GUI integration (Phase 13 Step 7).** A *logical bus* (project
state) routes from a *source* (a host-side data path) — see
[ADR 0023](docs/adr/0023-logical-bus-vs-interface.md). The project
schema (v6) carries three source kinds on each binding:

- `kind: "remote"` — a `(server, interface)` on a remote
  `cannet-server` or the local sidecar. v5 entries migrate here.
- `kind: "remote-virtual-bus"` — subscribe to a remote virtual-bus
  server's factory id; the GUI uses the allocated participant id
  when transmitting.
- `kind: "local-virtual-bus"` — bind to a virtual bus defined in
  `Project.local_virtual_buses` (id + name + bus_config + bridges).
  The Tauri host instantiates one `SharedBus` per definition on
  project open; many bindings may target the same virtual bus.

Each logical bus has a single combo on its row that lists every
source available to it — the local driver's interfaces, the
interfaces of each server this machine trusts (grouped under that
server; when two servers advertise the same name, each group header
carries what tells them apart — the machine it runs on, or its
address), and the project's virtual buses — plus *+ Add virtual bus*
and *Manage servers…*. Picking from the combo writes the binding.
Step 6's multi-client fan-out means the same source may be picked
for many logical buses; the GUI no longer hides "in use" options.
A dedicated *Virtual buses* section lets the user rename, configure,
add bridges to, or delete each virtual bus the project owns; the
host applies bus_config edits via `SharedBus::reconfigure` and
manages bridge teardown.

The panel's *Connection* section mirrors that: **Local interfaces**,
then one collapsible section per trusted server, headed by the name it
advertises, the machine it runs on, its `host:port`, and what the last
attempt to reach it saw. A section stands open while one of its
interfaces is bound to a bus and is folded away otherwise — a manual
fold or unfold holds until that answer changes. A trusted server that
is switched off keeps its header, greyed, so a project never points at
something invisible.

A project carries only the `host:port` a bus is bound to — never a
fingerprint or a token — so opening one on a machine that has not
accepted that server is the ordinary case, not an error. The bus row
says so in as many words: *`host:port` is not trusted on this machine —
add it in the Servers panel* for an address this machine has no record
of, and the same line ending *trust it in the Servers panel* for a
server it can see but has not accepted. One fact, two fixes. A server
whose identity has changed since it was pinned, or one that refused the
token stored for it, gets its own line. Each carries the same *Manage
servers…* jump. Whether an address needs an answer at all is
the host's call, so a loopback proxy — reached in the clear and never
asked about — is not flagged.

*Manage servers…* opens the **Servers** panel, and that is the only
server affordance a bus row has. Which servers this machine talks to
is a decision it makes once, not part of wiring a bus: the panel
lists what is advertising itself via mDNS/DNS-SD (`_cannet._tcp`)
merged with what has already been accepted here, and a server becomes
a source on a bus once it is trusted there
([ADR 0041](docs/adr/0041-remote-connection-security.md)). Discovery
is convenience and never a trust signal
([ADR 0040](docs/adr/0040-production-cannet-server.md)): a browsed
server is checked exactly as one added by address is. A server started
with `--no-mdns`, or on another subnet, never appears from discovery —
**Add server…** reaches it directly. One that was killed rather than
shut down can linger in the discovered list until its DNS-SD record
expires (up to two minutes); an orderly shutdown drops out of it
within about a second.

### Rest-of-bus simulation + calculated fields

**Add RBS panel** opens a rest-of-bus simulation (ADR 0028): cannet
transmits a configured set of DBC messages on their cadence with
live, editable signal values — playing every node except the device
under test.

The configuration is a human-editable **`.cannet_rbs`** JSON
document of *sparse overrides* nested `bus → ecu → message`, keyed
by the project's logical bus names and hex CAN ids (trailing `x` =
extended). A signal absent from the config keeps tracking its DBC
default (`GenSigStartValue`, else the config's `fill_bit`);
`period_ms` falls back to `GenMsgCycleTime`. A fresh RBS panel is
immediately usable — the config starts in memory, pre-seeded with
the project's current buses — and **Save** prompts for a
`.cannet_rbs` path the first time. The project then references the
file **by path** through a nameable RBS element (multiple per
project), so simulation configs are switched and forked with
ordinary file operations.

In the panel:

- The tree-grid lists every DBC message on each configured bus,
  grouped per transmitter ECU, with **ANDed enable checkboxes** at
  bus / ECU / message level. Messages are **enabled by default**
  (rest-of-bus: everything plays unless muted — mutes persist as the
  config's flat `disabled_messages` list). Buses whose name doesn't
  match a project bus render inert (greyed) rather than failing the
  load.
- Signal cells show the live decode of the message's payload buffer;
  editing partial-encodes into it (enum labels and `0x…` raw hex are
  accepted), an overridden cell is marked and a light **×** clears
  it back to DBC-tracking. A plain numeric entry is **clamped to the
  signal's declared range on entry** — truncation to the signal's bit
  width is correct on transmit, so this is where an out-of-range value
  is caught before it's ever sent. The fzf filter narrows by message /
  signal name; **Ctrl/⌘+F** focuses it from anywhere in the panel.
- **Signals** (toolbar) opens this config's signals grid — every field
  it transmits and where each value came from, with the encoder's own
  taxonomy (Not Encoded / Out of Range / Unknown Value / Override /
  Default / Muted). See the View signals section above for the shared
  gridview it reuses.
- **Run** (persisted in the project, default off) starts the enabled
  messages on the host scheduler; actual transmission gates on
  per-bus connectivity (a bus that connects starts its messages, a
  drop stops them). A project saved with RBS running resumes on
  open; the global **kill-switch** (runtime-only) stops every RBS
  transmission at once.
- **Save** writes the override edits back to the file; **Save all**
  (command palette) saves the project plus every dirty
  `.cannet_rbs`, and the exit prompt covers both. Save dialogs
  default to `.cannet_prj` / `.cannet_rbs`; `.json` is still
  accepted on open.
- The file is **watched on disk**, the way the project file and a
  loaded DBC are — edit it in another tool and cannet picks the
  change up. It is re-read silently only when there is nothing to
  lose: the element has no unsaved overrides *and* is not running. A
  running element is putting frames on a real bus, so cannet will not
  swap its definitions underneath it; that case, and unsaved
  overrides, get *RBS file changed on disk* in the panel toolbar with
  **Apply anyway** and **Dismiss**. Apply anyway is an ordinary load
  of the file — unsaved overrides go, and an element that was running
  keeps running with the file's definitions. A config mid-edit that
  won't parse is logged and ignored, and one that disappears doesn't
  unload the element.

**Calculated fields** (ADR 0027) are signals recomputed on every
send: a **sequence counter** (increment + rollover) and/or a **CRC**
(a `crc-catalog` named algorithm or raw Rocksoft parameters,
computed over a byte-aligned bit range of the just-encoded payload,
optionally prefixed with hex bytes — the AUTOSAR E2E Data ID case).
The designation lives in the DBC as cannet attributes on the
destination signal:

```text
BA_DEF_ SG_ "CannetCounter" STRING ;
BA_DEF_ SG_ "CannetCrc" STRING ;
BA_DEF_ SG_ "CannetDisplay" STRING ;
BA_ "CannetCounter" SG_ 1042 AliveCtr "increment=1;rollover=15";
BA_ "CannetCrc" SG_ 1042 Crc8 "alg=CRC-8/SAE-J1850;range=0:56;prefix=A3";
BA_ "CannetDisplay" SG_ 1042 Crc8 "radix=hex";
```

(see `examples/cannet-demo.dbc`'s `BmsCommand` message, or
[`docs/cannet-attributes-reference.dbc`](docs/cannet-attributes-reference.dbc)
— a minimal, self-describing reference DBC exercising every
attribute, kept parseable by test). Both the
RBS panel and the transmit panel expose the same configuration
editor; a per-message override replaces the DBC default wholesale
per field. On the receive side, frames on a configured `(bus, id)`
are verified at ingest: a bad CRC or out-of-sequence counter paints
the trace row red, per-id validity is queryable
(`fetch_field_validity`), and a valid→invalid transition logs a
rate-limited Info system message. cannet's own transmissions are
exempt.

That block is the full set of cannet's DBC attributes (ADR 0043).
They are all per-signal `STRING`s taking a `key=value;` value, an
empty value means unconfigured, and **cannet reads them but never
writes a DBC** — a hand-edited file, or whatever generates yours,
authors them. `CannetDisplay` is a render mode rather than a
transmit designation: `radix=hex` shows a raw integer bit field (an
unscaled, unitless, non-enum signal — an id, a serial, a flag word)
as `0xDEADBEEF` instead of base 10, which is what such signals read
as by default. Asking for it on a signal that has a unit, a scale
factor or a `VAL_` table logs a warning and changes nothing, as does
an unrecognised key or value.

> **Note:** plain `cargo run -p cannet-gui` will build the Rust host on
> its own but won't bring up a usable window — the host expects either
> a Vite dev server (which `tauri dev` starts for you) or a built
> frontend at `apps/gui/dist`. Use the `pnpm tauri` commands above.

### Signal value→color maps

**Add color map** opens a value→color map config panel (ADR 0029).
A color map is a standalone, DBC-informed project element that targets
one signal and assigns colors to its values — enum states each get a
color (seeded from the DBC `VAL_` table), or a numeric band can be
given a color over an inclusive `[min, max]` range. Unlike a filter it
isn't wired through the graph: it's **ambient**, so any view rendering
the target signal shows the color. The expanded trace rows tint the
signal's value cell; a plot fills the **enum logic-analyzer lane box**
for each held value. Maps live in the project file and resolve
first-match — the first map (and within it, the first rule) that covers
a value wins. This is a first-cut prototype; the rule editor and
numeric-signal plot rendering will grow.

### Generator rules (signal colors from the name)

**Add generator** opens the generator-rules editor (ADR 0026). A
generator is an ambient project element — like a color map, not wired
through the graph — holding an ordered list of regexes matched against
signal **names**. The rule's first capture group, read as an integer,
is the signal's slot on the shared 16-color wheel:

| rule | `Cell1` | `Cell5` | `Cell5Temperature` | `EngineRpm` |
| --- | --- | --- | --- | --- |
| `Cell(\d+)` | slot 1 | slot 5 | slot 5 | no rule → hash |

So `Cell1…Cell16` come out as sixteen distinct, stable colors in every
view, and a second rule capturing the same number lands on the same
slot — `Cell5Voltage` and `Cell5Temperature` share a hue on purpose.
Rules are tried top to bottom and the first one that both matches and
captures a number wins; a rule can be parked with its toggle instead of
deleted, and a signal no rule claims keeps its identity-hash color.
Signal color resolves **explicit pick → generator → hash**, so editing
a rule recolors the signal view and every plot series live, with
nothing stored.

Matching is partial (the pattern doesn't have to cover the whole name)
and case sensitive; write `(?i)` at the front of a pattern for
case-insensitive matching. Patterns are compiled and evaluated by the
Rust host on the `regex` crate — linear time, no backtracking, under a
pattern-length and compiled-size cap — and never by the frontend; the
editor shows the host's compile error inline as you type.

### Phase-6 logical buses, filters & project graph

Phase 6 makes "logical bus" the abstraction frames belong to and
introduces filter elements + a visual project graph.

**Logical buses**. The project panel grows a *Logical buses* section
where you can add / rename / remove project-owned buses (each carries
a stable id, display name, and optional speed / FD hints). Buses are
project state — they round-trip through the project file alongside
the panel layout.

**Interface bindings**. The project panel also lists *Interface
bindings*: each binding maps a `(server, interface_id)` pair onto a
logical bus. The section's **Add binding** form takes a server address,
optionally **Discover**s its interfaces, and pairs a chosen interface
with one of the project's buses. Each bus is allowed at most one
binding (one interface per bus); a bus that already has a binding is
hidden from the picker.

The toolbar's **Connect** button (or **Connect all** in the project
panel) iterates every unique server in `interface_bindings`, opens one
gRPC session per server, and subscribes only to the bound interfaces.
The host's pump thread stamps every received frame with the chosen
`bus_id`. **Disconnect** ends every session, and so does quitting the
app — the host hangs up on every server (briefly, so an unreachable
one can't hold the exit up) before the process goes away, rather than
leaving the server to notice a socket that stopped answering. Server
addresses no
longer live in the toolbar — they're per-binding configuration. A
binding's `server` is either the literal `"local"` (sentinel meaning
"the local sidecar at whatever address it's bound to this session" —
the sidecar's port is randomised per launch, so persisting a literal
`host:port` would orphan the binding on every reload) or a
`host:port` for a specific remote `cannet-server`; the frontend
resolves `"local"` to the live sidecar address before invoking the
connect command.

**Connection feedback.** Connecting, failing, and configuring are all
visible where the action is, not only in System Messages. Each
logical-bus row carries a marker for its binding — `unbound`, `not
connected`, `connecting…`, `connected`, or `error: <reason>` — and so
does each bound interface row in the *Connection* section, so a
multi-channel device shows which of its channels actually came up. The
state is the host's (`connection_state.rs`, read through
`get_connection_states` and the `connection-states-changed` event) and
only moves on a real outcome: the interface list, the subscribe, the
pump's exit. A binding whose interface the server doesn't expose gets
its own error rather than being dropped silently.

A connected bus also shows a `live:` line with the hardware
configuration the host **actually sent** for it, which is not always
what the fields below say. `ConfigureBus` is only pushed at connect
(edit while connected and the row's `pending` chip says so — reconnect
applies it), and a bus with neither a bitrate nor FD pinned sends no
`ConfigureBus` at all, so the row reads `driver default (nothing
sent)` rather than echoing the input's greyed placeholder. The wire
has no applied-config response (ADR 0022 makes `ConfigureBus`
fire-and-forget), so this is "what was sent", not "what timing
registers the controller landed on" — which no layer of the stack
reports.

**BLF channel mapping**. Opening a BLF pre-scans the file for its
distinct channels and shows a modal where each channel is mapped to a
logical bus or marked as "skip". Skipped channels are dropped before
they reach the trace store; mapped channels stream in tagged with their
bus. Dropping is the whole of what "skip" does — silently, with no
confirmation step: a user who skips a channel is saying they are not
interested in those messages. A frame without a bus is not a thing the
store holds, so a channel the mapping never names is dropped on the
same terms. The scan is header-only — it reads each object's channel field
without decoding the frame — so it covers the **whole** file however
large: a channel that first appears near the end still gets a mapping
row. The same scan also carries the capture's frame count, duration,
wall-clock start, and every `GLOBAL_MARKER` event, so the modal shows
that metadata and a collapsible list of the file's events alongside the
channel rows, and offers a start/end time range to narrow the import.
The import itself is then a single pass through the shared ingest pump
([ADR 0046](docs/adr/0046-one-ingest-pathway.md)): the capture's
`GLOBAL_MARKER` notes are collected on that same pass, and a selected
time range is a filter at that pass's frame source rather than a
second pipeline — frames outside the range never reach the trace
store, and the pass itself stops early once it walks past the range's
end.

**MDF import** (`import_mdf` / `scan_mdf_channels`) mirrors BLF import
end to end, reusing the same channel-mapping modal (`BusChannel` plays
the role a BLF channel number plays — [ADR
0023](docs/adr/0023-logical-bus-vs-interface.md)) and the same shared
ingest pump for the actual pass. An MDF also carries signal content a BLF
cannot, in two shapes: **signal channel groups** (signals recorded with
no bus message behind them) and **per-message DBC-decoded groups**
(what a tool writes when it decodes a capture with a DBC and saves the
result — one group per CAN message, its signals as plain channels).
Both are imported as **file-backed signals**: the decoding tool's
database is not this project's, so nothing here can re-derive the
second shape from the raw frames. The dialog says how many signals
arrive and names the messages the decoded groups came from, and the
same list goes to System Messages.

Because the two contents are independent, the dialog offers **a
checkbox per content** — *Signals* and *CAN messages* — and imports
what is ticked. Signals are on by default; CAN messages are opt-in,
except on a file with no signal content at all, where the frames are
all there is and defaulting them off would make the dialog's default
import nothing. Ticking neither disables Open. The channel → bus
mapping only decides where frames land, so it is inert while CAN
messages is unticked. An import that brings in signals and no frames
still gets a timeline: with no first frame to anchor it, the earliest
sample the import lands becomes the session's start
([ADR 0024](docs/adr/0024-trace-like-view-timing.md)). A signal-shape MF4 (a
post-processed measurement with no bus-logging group at all) imports
that way too — the dialog offers *Signals* and no *CAN messages*
checkbox, there being no frames to offer.

**Databases the capture carries** (`##AT` attachments — what every
Save Capture to MDF embeds) are streamed straight into the loaded DBC
set at import, through the same machinery a DBC picked off disk goes
through. Nothing is extracted: the definitions are usable where they
lie ([ADR 0010](docs/adr/0010-no-sidecar-files.md)). Each is loaded
under `<capture>#<attachment name>`, which is deliberately not a path —
nothing reloads it from disk, re-importing the same capture replaces it
in place, and it is a session load rather than a project file, so it is
not added to the project's DBC list.

A coded channel — a DBC enumeration, the shape most state signals in a
decoded group take — stores its value-to-text table as the channel's
own conversion. The **code** is what lands in the series, since that is
the numeric part, and the table rides along with it as that signal's
value table — the same thing a DBC's `VAL_` block is. So an imported
enumeration reads as one everywhere a DBC-backed enumeration does:
symbolic y-axis ticks and labelled tiles on a plot, the label beside
the value in the signal grid, and named rows in a colormap. The table
is written back out on an MDF save, so the round trip keeps it.

**File-backed signals** are value series the capture file carries
already decoded: no bus message holds them and no DBC produces them.
They live in the same model as DBC-decoded signals — one cached series
each, with the same resolution pyramid, the same paged serve and the
same on-disk persistence — and differ only in how they fill. A
DBC-decoded signal fills incrementally by decoding frames for as long
as frames arrive; a file-backed one is read once, at import, and is
then complete. So they appear wherever a *series* appears — the signal
catalog and picker, plots, and the signal grid, marked `file` and
labelled with their source channel group — and never in the trace
views, which list frames. Loading, reloading or removing a DBC leaves
them exactly as they are, in the session and across a relaunch.

**Save Capture writes BLF or MDF.** One gesture, one host command; the
save dialog's filter list offers **Vector BLF (`.blf`)** and **ASAM MDF
(`.mf4`)**, and the filter you pick travels to the host as an explicit
format — nothing is inferred from the path, so a "save as MDF" can
never produce a BLF wearing an `.mf4` name.

| | BLF | MDF |
| --- | --- | --- |
| frames (classic / FD / remote / error) | yes | yes |
| logical bus assignment | channel number | `CAN_DataFrame.BusChannel` |
| notes / event markers | `GLOBAL_MARKER` | `##EV` blocks |
| file-backed signals | **dropped** | signal channel groups |
| the project's DBCs | no | embedded `##AT` attachments |

Saving a capture that holds file-backed signals as BLF drops them: BLF
carries frames and has nowhere to put a signal series. The save still
happens, and names in System Messages what will not be in the file.
MDF is the full-fidelity save — import → save → re-import gives back the
same frames (payloads, DLC, FD flags, remote and error frames), the same
absolute nanosecond timestamps, the same buses, the same markers and the
same signal series, and the DBCs the capture was decoded against ride
inside the file ([ADR 0010](docs/adr/0010-no-sidecar-files.md)). What it
deliberately does *not* write is DBC-decoded signals as channels: the
frames plus the attached DBC already say all of that, and writing both
would double-count every signal on re-import.

The MDF a save writes is always **sorted and finalized**, uncompressed
`##DT`. Timestamps are `f64` seconds against the capture's own
`hd_start_time_ns`, which reproduces absolute nanoseconds exactly for
any capture spanning less than about 26 days.

**Bus assignment governs decode**. Each DBC entry in the project panel
grows a row of checkboxes — one per defined logical bus — that control
which buses the DBC decodes for. A DBC with no boxes checked is
assigned to nothing and **decodes nothing**: loading a file makes it
available, checking a bus makes it decode. A DBC assigned to bus A
doesn't decode bus-B frames. A project saved before this rule opens
with its databases unassigned and decodes nothing until they are
assigned — deliberately, since an old or different-version DBC
legitimately stays in a project and auto-assigning one would silently
activate it alongside the current one. Assignment governs every DBC
answer, not just the trace: the transmit panel's signal table (its
message descriptor, its decoded values, its encoder and its enum
labels) and the rest-of-bus panel's enum labels all resolve through the
databases assigned to the row's bus — the same set that would decode
the frame once it is on the wire.

**Unchecking a bus is reversible.** Unassigning a DBC parks the decoded
samples it produced rather than deleting them, and checking a bus again
hands them back instead of re-decoding the capture. Views keep their
configuration throughout: a plot series, a colour-map lane or a transmit
row names a signal by bus, message id and name and never by the file that
defined it, so it sits empty while nothing is assigned and comes back
whole when something is. What restores it is the signal, not the file —
any assigned database defining that signal brings the view back, and one
defining it exactly as the parked samples were decoded brings the samples
back with it.

**Unchecking a bus stops what it was driving.** A periodic transmit row
or a rest-of-bus row that is *transmitting* is putting frames on a real
bus, so once no database assigned to that bus defines its message any
more, it stops — one line in the System Messages panel says how many
did, and there is no prompt and no per-row notice. The unassign itself
always proceeds: it is a deliberate gesture, and refusing it would make
assignment conditional on first hunting down what is transmitting. A row
the databases never described — a CAN id typed by hand — keeps firing,
and so does one another database still on the bus defines. Removing a
database from the project removes it from its buses and reaches the same
rule the same way. A stopped transmit row keeps its configuration and is
restarted with its own Run control; a rest-of-bus row is rebuilt by its
element, so it resumes when the element's Run is still on.

**Reloading a database stops what it was driving, too.** A DBC is
re-read whenever the file changes on disk (with `dbc_auto_reload` on) or
when you reload it from the Database panel, and the new definitions
replace the old ones in place. What a periodic transmit row is
transmitting can therefore change — or disappear — without anyone
asking, so every row the reloaded database was driving stops first, and
a rest-of-bus element driven by it has its Run turned off. The reload
still applies, and one line in the System Messages panel says how many
rows stopped. Rows another database on the bus defines, and hand-typed
CAN ids no database describes, keep firing: the reload is only ever the
business of what it was actually driving.

**Default: receive from every bus**. Each consumer (trace, plot, filter) carries a
`sources: string[]` list of upstream producer ids — bus ids or filter
ids — with the literal `"*"` as a wildcard meaning "every bus in the
project, including ones added later." Freshly created consumers
default to `["*"]`, so a new trace or plot starts wired to every
bus without any explicit configuration. Transmit elements mirror
this on the producer side via `sinks: string[]`, but without the
wildcard — a fresh transmit pre-fills with every currently-known bus
and a future bus added later is a deliberate choice (firing onto an
unintended bus is more surprising than missing one).

**Configuring a consumer's sources**. **Right-click anywhere in a
trace or plot panel** to open a context menu with checkboxes for
each project bus (and an "All" toggle that re-collapses to the
wildcard) plus any defined filter elements. Unchecking a bus
narrows the consumer; re-checking everything snaps back to
`["*"]`. The transmit panel has the same right-click affordance
for its `sinks` list.

**Filter elements**. A new project element `{kind: "filter"}` carries
a structured predicate (`{all | any | bus | id_range | id_list |
name_regex | signal_equals}`) and its own `sources` list so it can
chain after other filters or buses. The fetch path
(`fetch_trace_range`, `fetch_by_id_page`) accepts an optional
predicate that drops records that don't pass; the trace store stays
one filter-agnostic session buffer, and each consumer scopes what
it renders. There's no expression DSL — the predicate is built in
the filter node's inline editor (see below) or by hand in the
project file.

**Project graph panel**. Add one from the toolbar's *Add graph
panel* button (or restore a saved one from the project file). Each
project element gets a shape that matches what it is:

- **Bus** — a wide horizontal rail (the logical aggregator);
- **Gateway** — an interface binding linking a wire-level interface to
  a bus (bidirectional);
- **Transmit** — frames composed and sent onto each bus in `sinks`;
- **Sink** — `trace` and `plot` panels consume the buses + filters
  listed in `sources`;
- **Filter** — same consumer shape as sink, plus a predicate that
  drops non-matching frames; downstream consumers reference it via
  their own `sources`.

The panel's toolbar exposes a **+ filter** button that creates a
filter element fanning in from every bus. Each consumer node carries
a **+ filter** affordance that does the same thing *but* inherits
the consumer's current `sources` and inserts the filter between the
consumer and its previous inputs ("Insert filter upstream"). Each
filter node has an inline predicate editor (caret to expand) that
builds the structured predicate without touching JSON.

Edges encode the wiring: gateway ↔ bus (bidirectional), bus →
consumer, filter → consumer, transmit → bus. **Right-click an edge**
to delete it (the wildcard `"*"` source expands into the explicit
"all buses except this one" list on first removal). Node positions
and the viewport persist in the panel's dockview `params`. The
graph is the spatial view onto the same project state the project
panel shows as lists — see
[`docs/adr/0012-project-panel-graph-split.md`](docs/adr/0012-project-panel-graph-split.md)
for the split of responsibilities.

**Transmit by bus**. The transmit panel composes a frame per
project bus listed in the transmit element's `sinks`; the host
resolves each `bus_id` to the matching session's wire channel via
the project's interface bindings. There's no per-frame "channel"
control anymore — that was the leaky Tauri-host detail.

**BLF round-trip preserves bus assignment**. Save Capture writes
each frame on the BLF channel matching its bus's position in the
project's bus list, so a multi-bus capture can be reloaded into the
same project with the channel-map modal pre-seeded to the right
bus per channel — no manual remap.

**Project schema version**. `PROJECT_SCHEMA_VERSION` bumped 2 → 3. A
v2 project opens by way of an in-memory migration that lifts
`dbc_paths` into `dbcs` (each assigned to no bus) and defaults `buses` and
`interface_bindings` to empty; the on-disk version is rewritten the
next time you save.

### Phase-7 system messages

Phase 7 adds a structured log bus and a panel that surfaces it.

**Host-side log bus**. The Tauri host owns a bounded in-process ring
of `{ ts, source, level, message }` entries (`apps/gui/src-tauri/src/
system_log.rs`). `sys_debug!` / `sys_info!` / `sys_warn!` /
`sys_error!` macros fan each event into both the ring and
`tracing-subscriber`'s `fmt` layer so dev stderr keeps working.
`info` is reserved for what the user's own actions produced — an app
nobody is touching emits none; the app's own chatter (health
samples, lifecycle breadcrumbs, sidecar status) is `debug`. A
per-`(source, template)` rate
limiter caps any one emitter at five entries per second; the first
drop in a window records a single suppression note so the panel
doesn't go silent under a flood. The ring's depth and the limiter's
budget are settings (`system_log_ring_capacity`,
`system_log_rate_limit`), and setting the budget to `0` turns the
limiter off — diagnosing a message flood is exactly when you want all
of it. Sources currently in use:
`project`, `dbc`, `connection`, `blf-import` (vendor sidecars will
use `sidecar:<vendor>` in Phase 8).

**System Messages panel**. Add it from the toolbar's *System
messages* button. The panel renders a virtualised list filterable by
source and by minimum level (default `info` — a session's worth of
what you did; drop it to `debug` for the app's internal breadcrumbs,
which reach the rolling log file either way). Copy-all and
double-click-to-copy
put entries on the clipboard; Clear empties the ring. Per-panel
filter state lives in dockview `params`; the bus itself is
session-scoped (it isn't written into the project file).

**Unread-error indicator**. The toolbar button doubles as a badge:
the red pill shows the number of warn+error entries that arrived
since the panel last gained focus. Clicking the button focuses
the panel (or opens one) and clears the badge.

**Wire-level surface**. `cannet-wire`'s `Envelope` grew a fifth
variant — `LogMessage { ts, level, source, message }` — alongside
`Error`. The two are distinct: `Error` still ends the session, a
`Log` is informational and the session continues. The host's
`system_log::bridge_wire_log` translates an incoming wire log into
the local bus; Phase 8's vendor sidecar is the first real producer.

### Phase-8 vendor drivers (Vector / Kvaser / PEAK)

Phase 8 plugs in real hardware sources by way of a single auto-launched
[`python-can`](https://python-can.readthedocs.io/) sidecar that lives at
[`servers/cannet-python-can/`](servers/cannet-python-can/). The sidecar
speaks the same `cannet-wire` gRPC protocol as `cannet-server`, so the
host pipeline is unchanged — interfaces show up in the project graph
view the same way the BLF replay fixture's do, just under
vendor-prefixed names with a paren-delimited `key:value` metadata
list. Examples:
- `vector:VN1640A(SN:12345, ch:0)` — Vector card serial + per-card
  channel.
- `kvaser:1(SN:67890, ch:0)` — Kvaser card serial + per-card channel.
- `pcan:PCAN_USBBUS1(h:0x51, ch:0)` — PEAK slot constant + channel
  handle integer + controller number. PCAN-Basic doesn't standardly
  expose a per-device factory serial, so the handle integer is the
  stable per-attached-channel anchor; `uid:<n>` joins the list when
  the user has set a non-default device ID in PCAN-View.

For Kvaser and PCAN, the body alone (everything before `(`) is what
python-can needs to open the channel — the paren metadata is
identity for the GUI, and `_bus_kwargs_for` strips it before handing
the body off. Vector is different: the open path reads `SN:` and
`ch:` out of the parens and passes `serial=` + `channel=` to
python-can's vector backend, so the driver resolves the physical
channel via `get_channel_configs` and never calls `xlGetApplConfig`.
That bypasses Vector Hardware Config's application-channel mapping
entirely, so an unmapped slot in the VHC app view can't break open
or close.

**Auto-launch**. The GUI's Tauri host spawns the sidecar at startup
(`crates/cannet-sidecar` does the supervising;
`apps/gui/src-tauri/src/sidecar.rs` supplies the GUI's settings and
log surface); the user does not run anything
in `servers/cannet-python-can/` by hand. The sidecar binds to an
OS-assigned ephemeral port (`127.0.0.1:0`) and reports the actual
address back on its `sidecar\tlistening\t<addr>` banner; the host
parses it into the supervisor's status and exposes it through the
`get_sidecar_status` Tauri command and the `sidecar-status-changed`
event, which the project panel's "Local sidecar" row reads so the
user can bind interfaces without typing an address. The sidecar's
stdout / stderr and exit code feed the **System Messages** panel
tagged `sidecar:python-can`. A crashing sidecar gets a budget of
auto-restart attempts per session (`sidecar_restart_budget`, three by
default); once the budget is exhausted, the `restart_sidecar` Tauri
command — the project panel's **Local interfaces → Restart** button —
clears it.

**Detailed sidecar logfile**. Stderr is not the whole story: it is
what the panel shows, so it stays at `sidecar_log_level`. The host
also launches the sidecar with `--log-file`, pointing at
`sidecar-python-can.log` in the same per-OS log directory as the
host's own rolling `cannet.log` (`%LOCALAPPDATA%\<id>\logs` on
Windows, `~/Library/Logs/<id>` on macOS, `~/.local/share/<id>/logs` on
Linux). That file **always records at debug**, whatever the panel is
set to: every gRPC command with its arguments and outcome
(enumerated interface ids, subscribe attempts, configure with the
requested values *and* the ones the driver was handed, disconnects)
plus every driver traceback — which is what a per-channel connect
failure needs to be diagnosable after the fact. It rotates at 1 MB
across five generations, so it costs at most ~5 MB of disk. The
frame streams are the deliberate exception: transmit and receive log
their lifecycle and faults, never per-frame content. The sidecar
reports the path back on startup, so the System Messages panel says
`detailed log: <path>` — that plus `cannet.log` is what to attach to
a bug report. Running the sidecar by hand (`uv run
cannet-python-can`) writes no file unless you pass `--log-file`
yourself.

**Lifecycle: dies with the host**. The host pipes the sidecar's
stdin and writes nothing to it. When the host process exits (clean
or not), the OS closes the pipe and the sidecar's stdin-EOF watcher
calls `server.stop(grace=2.0)` — no orphaned sidecar holds hardware
open. The same mechanism covers panics and SIGKILL; it does not
require a `RunEvent::Exit` handler or a Windows job-object.

**`uv` resolution**. `uv` is fetched, not bundled — see
[`docs/adr/0015-fetched-runtime-binaries.md`](docs/adr/0015-fetched-runtime-binaries.md).
The host launcher resolves `uv` in this order:

1. **Local fetch** — `tools/uv/uv[.exe]` next to the GUI executable.
   [`scripts/fetch-uv.sh`](scripts/fetch-uv.sh) downloads the pinned
   binary for the current OS / arch into `tools/uv/` for local dev.
   This is a **developer** convenience; shipped builds run a frozen
   sidecar instead (see
   [`docs/adr/0036-frozen-python-can-sidecar.md`](docs/adr/0036-frozen-python-can-sidecar.md)).
2. **`uv` on `PATH`** — install via
   [`https://docs.astral.sh/uv/`](https://docs.astral.sh/uv/).
3. **`python3 -m cannet_python_can`** — last-resort fallback when
   neither is available. The host logs a warn-level System Message
   asking the user to install `uv` for the supported flow.

`uv` materialises the sidecar's venv lazily on first launch and
installs Python itself if missing, so there is no pre-installed-Python
prerequisite.

**Per-vendor prerequisites**. None of the vendor SDKs are bundled —
they are runtime, user-installed dependencies:

| Vendor | SDK | OS                    | python-can backend |
|--------|-----|-----------------------|--------------------|
| Vector | [XL Driver Library](https://www.vector.com/int/en/download/vector-driver-disk/) | Windows (full), Linux (partial) | `vector` |
| Kvaser | [CANlib SDK](https://www.kvaser.com/downloads/) | Windows, Linux, macOS (partial) | `kvaser` |
| PEAK   | [PCAN-Basic API](https://www.peak-system.com/PCAN-Basic.239.0.html) | Windows, Linux, macOS | `pcan` |

A vendor with no SDK installed contributes zero channels and does not
break the others. The full per-vendor smoke-test procedure lives in
[`servers/cannet-python-can/SMOKE.md`](servers/cannet-python-can/SMOKE.md);
CI cannot run it.

**Swapping the driver library**. The sidecar's
[`driver.py`](servers/cannet-python-can/cannet_python_can/driver.py)
defines a small adapter protocol (`list_channels`, `open`, `recv`,
`send`, `close`). To replace `python-can`:

1. `uv pip install <your-driver>` into the sidecar venv (or edit
   [`servers/cannet-python-can/pyproject.toml`](servers/cannet-python-can/pyproject.toml)
   and re-run `uv sync`).
2. Write a module exposing a top-level `Driver` callable returning a
   matching object.
3. Name it in **Settings → Connection → Driver module**, which the host
   forwards to the sidecar. `CANNET_DRIVER_MODULE=<your_module>` in the
   environment the GUI launches with still works and takes precedence
   for that run (the override is reported in System Messages).

A patched or replaced sidecar *build* is reachable the same way:
**Settings → Connection → Sidecar directory** points cannet at a
`cannet-python-can` package directory of your own, and
`CANNET_SIDECAR_DIR` overrides it for one run.

The wire-level code does not change. See
[`servers/cannet-python-can/LICENSING.md`](servers/cannet-python-can/LICENSING.md)
for the LGPL analysis that motivates this layout.

### Phase-9 Save Capture, notes & Recent captures

Phase 9 makes captures persistable and re-loadable, with user-placed
notes round-tripping alongside.

**Save Capture**. The toolbar grows a **Save capture…** action
(disabled when the session buffer is empty). It writes the *entire*
session buffer — every frame on every bus, classic / FD / error /
remote — to a single `.blf` file via the new
[`BlfCaptureWriter`](crates/cannet-blf/src/lib.rs) wrapper. Writes
stream to `<file>.blf.part` and rename into place on completion
(atomic — a mid-write crash leaves no half-file behind at the
destination). Save confirmation, frame count, and byte size all
surface in the **System Messages** panel tagged `capture`. The BLF's
underlying f64-seconds timestamp storage drops sub-microsecond
precision for modern absolute timestamps; the host warns at save
time when that drift measurably exceeds 1 µs (the documented
precision floor).

**Notes**. Notes are placed by the plot panel's `+ note` cursor
mode (left-click on the canvas drops a labelled marker at that
time). They now live in a single, session-scoped store on the
host (`apps/gui/src-tauri/src/notes.rs`) — a note placed in plot
panel A is visible in plot panel B over the same timeline. Edits
flow through `add_note` / `rename_note` / `remove_note` Tauri
commands; the host broadcasts the updated chronological list via
the `notes-changed` event. Clearing the trace store wipes the
notes with it.

Save Capture writes notes inside the BLF as `GLOBAL_MARKER`
records (BLF object type 96 — Vector's native annotation type, so
third-party tools like CANalyzer see them too). Import trace reads
those markers back into the session-scoped store. No sidecar
file is written, per [ADR 0010](docs/adr/0010-no-sidecar-files.md).

**Recent captures**. The toolbar grows a **Recent** dropdown next to
**Import trace…** that lists the last 8 opened BLF and MDF paths
alike, persisted host-side
([ADR 0032](docs/adr/0032-machine-local-ui-state-host-side.md)).
Picking one fast-paths through the standard Import-trace flow,
routed to the right format by the path's own extension (the
channel-mapping modal still runs because each capture can route
differently onto the current project's buses); a successful Save
Capture promotes the saved path too, so "what did I just save?" is
a one-click re-open.

**Project schema v3 → v4**. `PROJECT_SCHEMA_VERSION` bumps to 4.
Notes used to live in each plot panel's dockview `params`; the v4
migration strips them out (the host's session-scoped store owns
them now). Phase-4-vintage projects open cleanly with the
migration running on parse; the on-disk version is rewritten the
next time you save.

### Phase-2 client / server demo

Phase 2 splits the data source out behind a gRPC service. The
`cannet-server` binary's `debug replay` subcommand (dev/test tooling)
loads a BLF and replays it on a loop; the GUI's toolbar grew a
connection panel that consumes the same protocol.

In one terminal, start a server:

```sh
cargo run -p cannet-server -- debug replay examples/cannet-demo.blf
# → loaded N interface(s) from examples/cannet-demo.blf
# → listening on 127.0.0.1:50051
```

It exposes the BLF's channels as gRPC interfaces (`blf:0`,
`blf:1`, …) and replays them on a loop while a client is
subscribed.

CLI flags:

- `--bind <addr>` — listen address (default `127.0.0.1:50051`).
  Dev/test tooling terminates no TLS, so binding anything but
  loopback needs `--insecure`. The production proxy no longer has one —
  it auto-enables TLS on a routable bind instead (§ Running the
  production server).
- `--insecure` — bind a routable address unprotected anyway.
- `--rate <multiplier>` — replay pacing. `1.0` plays the BLF at
  its recorded cadence (real-time emulation, the closest match
  to a hardware bus); `100` plays it 100× faster; `0` (the
  default) disables pacing entirely and emits frames as fast as
  the consumer drains. The default is intended for development
  and tests; for a realistic emulation, use `--rate 1`.

The server is single-client per process and rejects client
transmits with `Error::TX_REJECTED` (BLF is read-only — the
rejection surfaces inline on the GUI's transmit panel). Stop with
Ctrl-C.

In another terminal, start the GUI as usual (`pnpm --dir
apps/gui tauri dev`). In the project panel's *Interface bindings*
section, type the server address (the Add-binding form defaults to
`127.0.0.1:50051`), hit **Discover** to list its interfaces, pick one,
pair it with a bus, and **Add binding**. Clicking the toolbar's
**Connect** subscribes to every bound interface across every server
in the project and starts streaming frames into the trace view.
**Disconnect** ends every session. The GUI can attach a DBC the same
way it does for a local BLF — decoding runs against whichever frames
are currently flowing.

The `Import trace…` and `Connect` flows share the same trace store,
so frames from either source render through the same view.

### Build artifacts

`pnpm --dir apps/gui tauri build` produces a single platform-native
executable (with the React bundle embedded) plus an installer for each
target's distribution format. Sizes below are from the Phase-1 build —
they'll grow as features land.

| Path (relative to repo root) | Platform | Size | Notes |
|---|---|---|---|
| `target/release/cannet-gui` | host platform | ~11 MB | The standalone executable. Links dynamically against the platform's WebView library. |
| `target/release/bundle/deb/cannet_<ver>_amd64.deb` | Linux (Debian/Ubuntu) | ~3.3 MB | `apt install ./cannet_*.deb`. |
| `target/release/bundle/rpm/cannet-<ver>-1.x86_64.rpm` | Linux (Fedora/RHEL/openSUSE) | ~3.3 MB | `dnf install ./cannet-*.rpm`. |
| `target/release/bundle/appimage/cannet_<ver>_amd64.AppImage` | Linux (any glibc-compatible distro) | ~80 MB* | Self-contained: bundles WebKitGTK and friends. `chmod +x` and run. |
| `target/release/bundle/dmg/cannet_<ver>_x64.dmg` | macOS | — | Drag-to-Applications disk image. |
| `target/release/bundle/macos/cannet.app` | macOS | — | The raw `.app` bundle, codesignable. |
| `target/release/bundle/msi/cannet_<ver>_x64_en-US.msi` | Windows | — | MSI installer. |
| `target/release/bundle/nsis/cannet_<ver>_x64-setup.exe` | Windows | — | NSIS installer. |

\* AppImage size is approximate; the bundling step needs FUSE on the
build host, so it doesn't run in some sandboxed CI environments. The
`.deb` / `.rpm` paths above are confirmed sizes from a recent local
release build.

The bare `cannet-gui` binary is **not** statically self-contained:

- **Linux:** depends on `libwebkit2gtk-4.1-0` at runtime (same package
  family installed during the build prerequisites). If you want a
  hand-it-to-someone-else single file, ship the AppImage.
- **Windows:** depends on the Microsoft Edge WebView2 runtime. Win11
  and current Win10 ship it; older systems install it once.
- **macOS:** uses the system WebKit framework; no extra runtime.

Tauri can't cross-compile — each target is built on the matching OS.
The release workflow does this automatically: run it from the Actions
tab with the version you want, and it first runs the full CI suite, then
(only if it passes) builds the macOS arm64 and Windows x64 bundles on
native GitHub Actions runners and publishes them to a draft pre-release
(see § Downloads and
[`.github/workflows/release.yml`](.github/workflows/release.yml)). The
committed version stays `0.0.0`; the binary stamps its own
`git describe --tags --dirty` version (shown in the settings panel's
About section) and the installer takes its version from the tag.

The runner writes that version into `tauri.conf.json` — a tracked file —
so it commits the edit to its throwaway checkout *before* tagging, and
asserts the stamp is exactly `vX.Y.Z` before building. Otherwise the
edit would still be uncommitted when vergen reads the tree and every
released binary would report `vX.Y.Z-dirty`. The `-dirty` suffix is
meaningful and stays: a binary you build yourself from a tree with
uncommitted changes to tracked files says so.

## Tests and lint

These run automatically on every pull request and push to main via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml); run them locally
with:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm --dir apps/gui test           # frontend unit tests (vitest)
pnpm --dir apps/gui build          # type-checks and bundles the frontend
```

The Python sidecar ([`servers/cannet-python-can`](servers/cannet-python-can))
is checked with [ruff](https://docs.astral.sh/ruff/) (lint + format),
[mypy](https://mypy-lang.org/), and pytest — run from that directory:

```sh
uv sync --extra dev
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

### Regenerating the MDF fixture corpus

`cannet-mdf`'s tests read committed `.mf4` files and a committed
`expected/*.json` per file, so `cargo test` needs no Python. The pair
is produced by
[`crates/cannet-mdf/tests/fixtures/gen_fixtures.py`](crates/cannet-mdf/tests/fixtures/gen_fixtures.py),
which only has to run when a fixture changes:

```sh
cd crates/cannet-mdf/tests/fixtures
uv run --with asammdf --with numpy python gen_fixtures.py
```

It rewrites every fixture and expectation, then re-reads each result
through asammdf and checks it against the JSON it just wrote; a
non-zero exit means the corpus does not match its own ground truth.

### Validating an MDF export against asammdf

The MDF **writer** is proved against `cannet-mdf`'s own reader by the
default suite. asammdf — the ecosystem's reference implementation — is
the independent second opinion, and it runs as its own CI job so
`cargo test --workspace` stays Python-free. Locally:

```sh
cargo run -p cannet-mdf --example export_sample -- /tmp/sample.mf4
uv run --with asammdf --with numpy python \
    crates/cannet-mdf/tests/fixtures/validate_export.py /tmp/sample.mf4
```

The example writes a deterministic capture plus a `sample.json` listing
exactly what went into it; the script opens the `.mf4` with asammdf and
compares the two — the bus-logging map, every frame field for field, the
signal groups, the events and the embedded attachment.
asammdf is a dev-time oracle only — never a runtime dependency.

### Pre-commit hook

A [`pre-commit`](https://pre-commit.com/) config
([`.pre-commit-config.yaml`](.pre-commit-config.yaml)) runs the same
tools as CI as a local commit gate. Every hook is a local
`language: system` hook that invokes the tools this repo already pins
(`uv`, `cargo`, `pnpm`) — there are no third-party hook repos to keep in
sync, and the checks match `ci.yml`. Two extra hooks stop machine-local
paths leaking into the repo: one **rewrites** absolute paths in
`.cannet_prj` files to project-relative form (ADR 0030), and one
**blocks** any staged file still carrying an absolute path from your
home directory or clone location.

Enable it once per clone (needs the `pre-commit` tool — e.g.
`uv tool install pre-commit` or `pipx install pre-commit`):

```sh
pre-commit install
```

Linters that take file arguments (ruff) run only on the staged files;
the sidecar's whole-project checks (mypy, pytest) and `cargo clippy`
run when files in their area are staged. `cargo test` is **scoped to
the crates the commit touches**, so a break in a crate that merely
*depends* on what you changed is caught by CI rather than locally — the
trade-off, and the measurements behind it, are written out in
`.pre-commit-config.yaml`. The frontend hook runs the `vitest` suite
and the `build` typecheck concurrently. Run everything on demand with
`pre-commit run --all-files`.

## License

cannet is free software, distributed under the terms of the
**MIT License** (`MIT`). See [`LICENSE`](LICENSE) for the full text.

Copyright © 2026 Ben Hefner.
