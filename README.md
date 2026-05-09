# cannet

A CAN-bus analyzer. Phase 1 (alpha0) ships a single-process GUI that
opens a Vector BLF log, decodes it against a DBC, and streams the
result into a virtualized trace view. Phase 2 splits the data source
out behind a network protocol; Phase 3 adds per-vendor hardware
adapters. See [`plans/`](plans/) for the detailed roadmap.

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
  cannet-dbc/    `Database::parse(text)` + `decode(frame)`.
                 Hand-rolled bit extraction (LE / Motorola sequential
                 BE), sign extension, multiplexed-signal filtering.

apps/
  gui/           Tauri 2 + React 18 + Vite trace viewer.
    src/             React frontend. `TraceView.tsx` virtualizes the
                     row list with @tanstack/react-virtual; rows expand
                     to show decoded signals.
    src-tauri/       Rust host (`cannet-gui` crate). The single Tauri
                     command `open_log` spawns a worker that pushes
                     frames at the frontend in 256-frame batches via
                     a `can-frame-batch` IPC event.
                     `src/ipc.rs` defines the IPC payload shapes;
                     `wire` is reserved for the Phase-2 cannet-wire
                     network protocol.

plans/           Living planning docs (see CLAUDE.md).
```

## Prerequisites

All platforms need:

- **Rust** stable. Install via [rustup](https://rustup.rs/).
- **Node.js** 20+ and **pnpm** 9+. `npm i -g pnpm` if you don't have it.

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

1. **Microsoft Visual C++ Build Tools.** Install
   [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
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
cannet window. Use **Open BLF…** to pick a log; **Attach DBC…** before
opening attaches a database for live decoding.

> **Note:** plain `cargo run -p cannet-gui` will build the Rust host on
> its own but won't bring up a usable window — the host expects either
> a Vite dev server (which `tauri dev` starts for you) or a built
> frontend at `apps/gui/dist`. Use the `pnpm tauri` commands above.

## Tests and lint

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm --dir apps/gui build          # type-checks and bundles the frontend
```
