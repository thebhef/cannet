# cannet

A CAN-bus analyzer. Phase 1 (alpha0) ships a single-process GUI that
opens a Vector BLF log, decodes it against a DBC, and streams the
result into a virtualized trace view. Phase 2 splits the data source
out behind a network protocol; Phase 3 fills in a multi-panel docking
layout (dockable trace and project panels in arbitrary arrangements)
and JSON project files; Phase 4 adds a signal-plotting view; Phase 5
adds transmit; Phase 6 adds per-vendor hardware adapters. See
[`plans/`](plans/) for the detailed roadmap.

## Repository layout

```
crates/
  cannet-core/   CanFrame model + CanFrameSource / CanFrameSink traits.
                 Every other crate either produces or consumes through
                 these — the seam where future network transports and
                 hardware adapters slot in. See its rustdoc for the
                 contract.
  cannet-blf/    `BlfCanFrameSource`: Vector BLF files as a CanFrameSource.
                 Wraps `blf-asc` and translates each object into a
                 `cannet_core::CanFrame` (classic / FD / remote / error).
  cannet-dbc/    `Database::parse(text)` + `decode(frame)` + `signals()`
                 (the message/signal list a plot panel picks from).
                 Hand-rolled bit extraction (LE / Motorola sequential
                 BE), sign extension, multiplexed-signal filtering.
  cannet-wire/   Phase-2 wire protocol: tonic / gRPC service definition
                 (`proto/cannet.proto`), generated client + server
                 stubs, conversion helpers between `cannet_core`
                 frames and the wire types, and a batching adapter
                 layer so application code stays in `Stream<CanFrame>`.
  cannet-server/ Phase-2 BLF replay server. Loads a BLF into memory at
                 startup, exposes its channels as gRPC interfaces, and
                 streams them on a loop while a client is subscribed.
                 Single-client per server (multi-client deferred to
                 backlog); transmit envelopes are rejected. Ships a
                 `cannet-server` binary; lib is reusable.
  cannet-client/ Phase-2 gRPC client. `list_interfaces` is a one-shot
                 async RPC for the connection panel. `connect_and_
                 subscribe` returns a `RemoteCanFrameSource` (sync
                 `cannet_core::CanFrameSource`) backed by a worker
                 thread that owns its own tokio runtime, opens a
                 `Session`, and pumps incoming frames into a sync
                 mpsc queue. Drops cleanly on `Drop`.

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
                     by-ID is `ByIdTable.tsx`. Shared table bits — the
                     header (drag-resize, right-click show/hide,
                     click-to-sort) and the cell renderer — are in
                     `traceTable.tsx`; the column model + sort in
                     `traceColumns.ts`. `ProjectPanel.tsx` is the
                     project / elements / bus / DBC panel; `PlotPanel.tsx`
                     the Phase-4 signal plot (uPlot), with `plotData.ts`
                     merging independently-sampled series onto one
                     timeline. Each trace-style panel shows one *trace
                     element* — a window over the host-side session
                     buffer with pause / stop / clear; the elements live
                     in an in-memory registry (`projectElements.ts`),
                     persisted in the project, so closing a panel doesn't
                     destroy its element (`trace.ts`, `TraceControls.tsx`).
                     The scroll/stacking, column, trace-window, and
                     plot-data arithmetic live in `traceViewport.ts` /
                     `traceColumns.ts` / `trace.ts` / `plotData.ts`
                     (unit-tested alongside).
    src-tauri/       Rust host (`cannet-gui` crate). Owns the trace
                     model (`trace_store.rs` — the session buffer, plus
                     an O(1)-maintained latest-frame-per-id index and a
                     per-id message-rate estimate); the BLF and remote
                     pumps append frames, and the frontend pulls slices
                     via the `fetch_trace_range` command and the
                     latest-by-id snapshot (each id's latest frame + its
                     rate) via `fetch_latest_by_id` (both decoded against the
                     loaded DBCs — first match wins — at fetch time, both
                     off the main thread), plus a `trace-grew` IPC tick (~10 Hz:
                     count, rate, and a decoded tail of the newest rows
                     for flicker-free auto-scroll). `signal_sampler.rs`
                     walks the trace store for a chosen DBC signal and
                     yields a `(t, v)` series for the plot panel
                     (`list_signals` / `sample_signal` commands).
                     `src/ipc.rs` holds the IPC payload shapes;
                     `src/project.rs` the project-file model +
                     `open_project` / `save_project`.

plans/           Living planning docs (see CLAUDE.md).
```

## Prerequisites

All platforms need:

- **Rust** stable. Install via [rustup](https://rustup.rs/).
- **Node.js** 20+. Recommended: install [Node.js 24 LTS](https://nodejs.org/en/download)
  via the official installer or your platform's package manager.
- **pnpm** 9+. Once Node is installed, the simplest install is
  `npm install -g pnpm`. Alternatives:
  [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable && corepack prepare pnpm@latest --activate`),
  the [standalone pnpm installers](https://pnpm.io/installation) (`curl -fsSL https://get.pnpm.io/install.sh | sh -`
  on macOS/Linux, `iwr https://get.pnpm.io/install.ps1 -useb | iex` on Windows PowerShell),
  or your OS package manager (`brew install pnpm`, `winget install pnpm`, etc.).
  Verify with `pnpm --version`.

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

`pnpm tauri dev` boots Vite, compiles the Rust host, and launches the
cannet window. Use **Open BLF…** to pick a log; **Add DBC…** loads a
database for live decoding — load more than one and frames decode
against each in order, first match wins (every loaded DBC applies to
the one interface for now).

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
panel itself (it's a show/hide singleton). New panels arrive as a tab
in the active group — drag a
panel by its tab and drop it against an edge of the area to split it
side-by-side, or onto another panel to tab them together. Each trace
panel keeps its own scroll position, auto-scroll toggle (trace mode),
and column layout — drag the divider at a column header's right edge to
resize, and **right-click the header** to show / hide columns. Trace
panels carry the trace controls: the data lives in a session buffer
that fills while connected (lost when you disconnect / reconnect or
quit), and a *trace* is each panel's own window over it — **Pause**
freezes the view (**Resume** continues, including frames received while
paused), **Stop** freezes it (**Start** then begins a fresh, growing
trace), and **Clear** empties the window keeping whatever state it's in
(Clear doesn't imply Stop or Pause — a running trace stays running).
The session buffer keeps filling underneath regardless.
(Tearing a panel out into a separate OS window isn't supported yet —
docking is within the one window; the tear-out item is in
`plans/backlog.md`.)

A `.json` *project* file holds the panel layout (including each trace
panel's column layout and auto-scroll toggle), the project's elements
(traces — and later plots, transmit messages, …), the loaded DBC
paths, and the remote-server address. The **project panel** (or the
toolbar's **Open project…** / **Save project**) drives it: **Save** /
**Save As…** write one, **Open…** restores it (configures the remote
address and re-loads the DBCs by path — hit **Connect** to switch),
**New** starts a fresh workspace (default layout, no DBCs, disconnected,
buffer cleared). The panel also lists the configured bus(es) with
**Connect** / **Disconnect** and the loaded DBCs with **Add…** /
**Remove** / **Reload all from disk**. The
last opened/saved project is reopened on launch (with no project, the
layout is restored from local storage). Unsaved changes show a `●` in
the project panel, and closing the window with unsaved changes prompts
you (Save & close / Discard & close / Cancel). Not carried in the project: a trace's window
position (it re-anchors to the session buffer on each launch anyway),
the BLF replay path, the per-interface subscription set, and per-bus
DBC association (every loaded DBC applies to the one interface for now).

**Add plot panel** opens a signal plot (Phase 4): a uPlot time-series
view docked like any other panel. With a DBC attached, the panel's
**add signal…** dropdown lists every `(message, signal)` pair the
database defines — pick one or more and they're sampled out of the live
capture and drawn on a shared time axis. Drag on the plot to zoom the
time axis (double-click to reset); the legend reads out each trace's
value at the hovered point. **Follow live** keeps the view pinned to the
capture's growing edge; panning or zooming turns it off, the same way a
manual scroll leaves auto-scroll in a trace panel. Multiple plot panels
can be open, each with its own signal set. (Saving a plot panel's signal
set into a project file lands with the Phase 3 project-file work; for
now it persists via the same local layout blob as the trace panels. The
deeper oscilloscope feature set — multiple y-axes, cursors and Δ
measurement, triggers, math channels, enum/state plots — is sketched in
`plans/phased-implementation.md` under Phase 4 as later passes.)

> **Note:** plain `cargo run -p cannet-gui` will build the Rust host on
> its own but won't bring up a usable window — the host expects either
> a Vite dev server (which `tauri dev` starts for you) or a built
> frontend at `apps/gui/dist`. Use the `pnpm tauri` commands above.

### Phase-2 client / server demo

Phase 2 splits the data source out behind a gRPC service. The
`cannet-server` binary loads a BLF and replays it on a loop;
the GUI's toolbar grew a connection panel that consumes the
same protocol.

In one terminal, start a server:

```sh
cargo run -p cannet-server -- examples/cannet-demo.blf
# → loaded N interface(s) from examples/cannet-demo.blf
# → listening on 127.0.0.1:50051
```

It exposes the BLF's channels as gRPC interfaces (`blf:0`,
`blf:1`, …) and replays them on a loop while a client is
subscribed.

CLI flags:

- `--bind <addr>` — listen address (default `127.0.0.1:50051`).
- `--rate <multiplier>` — replay pacing. `1.0` plays the BLF at
  its recorded cadence (real-time emulation, the closest match
  to a hardware bus); `100` plays it 100× faster; `0` (the
  default) disables pacing entirely and emits frames as fast as
  the consumer drains. The default is intended for development
  and tests; for a realistic emulation, use `--rate 1`.

The server is single-client per process and rejects client
transmits with `Error::TX_REJECTED` (BLF is read-only). Stop
with Ctrl-C.

In another terminal, start the GUI as usual (`pnpm --dir
apps/gui tauri dev`). The toolbar's `host:port` input defaults
to `127.0.0.1:50051`; clicking **Connect** subscribes to every
interface the server lists and starts streaming frames into the
trace view. **Disconnect** ends the session. The GUI can
attach a DBC the same way it does for a local BLF — decoding
runs against whichever frames are currently flowing.

The `Open BLF…` and `Connect` flows share the same trace store,
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

Cross-platform builds aren't a thing today — produce each target on
the matching OS (or via cross-compilation in CI).

## Tests and lint

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm --dir apps/gui test           # frontend unit tests (vitest)
pnpm --dir apps/gui build          # type-checks and bundles the frontend
```

## License

cannet is free software: you can use, study, modify, and redistribute
it under the terms of the **GNU General Public License v3.0 only**
(`GPL-3.0-only`). Derivative works must stay under the same license.
See [`LICENSE`](LICENSE) for the full text.

Copyright © 2026 Ben Hefner.
