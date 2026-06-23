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
and offers a Recent BLFs list in the toolbar. See
[`plans/`](plans/) for the detailed roadmap.

## Downloads

Prebuilt **alpha** bundles are published to
[GitHub Releases](https://github.com/thebhef/cannet/releases):

| Platform                      | Artifact                      |
|-------------------------------|-------------------------------|
| macOS (Apple Silicon / arm64) | `.dmg` — drag to Applications |
| Windows (x64)                 | `.msi` or NSIS `-setup.exe`   |

These bundles are **unsigned**. On first launch:

- **macOS:** Gatekeeper blocks an unsigned, un-notarized app — right-click
  the app → **Open**, then confirm. (Or `xattr -dr com.apple.quarantine
  /Applications/cannet.app`.)
- **Windows:** SmartScreen shows a warning — click **More info → Run
  anyway**.

Signing/notarization is a planned follow-up. Building from source (below)
avoids the warnings entirely. Live hardware / virtual-bus capture also
needs `uv` present at runtime (see § `uv` resolution); BLF/file workflows
work without it.

## Repository layout

```
crates/
  cannet-core/   CanFrame model + CanFrameSource / CanFrameSink traits,
                 plus the `SharedBus` virtual-bus primitive (ADR 0021)
                 used in-process by the GUI host and over the wire by
                 `cannet-server --virtual-bus`. Every other crate
                 either produces or consumes through these — the seam
                 where network transports and hardware adapters slot
                 in. See its rustdoc for the contract.
  cannet-blf/    `BlfCanFrameSource`: Vector BLF files as a CanFrameSource.
                 Wraps `blf-asc` and translates each object into a
                 `cannet_core::CanFrame` (classic / FD / remote / error).
                 Phase 9 added `BlfCaptureWriter` — the inverse direction
                 for Save Capture, with an atomic temp-file + rename.
  cannet-dbc/    `Database::parse(text)` + `decode(frame)` + `signals()`
                 (the message/signal list a plot panel picks from).
                 Hand-rolled bit extraction (LE / Motorola sequential
                 BE), sign extension, multiplexed-signal filtering.
  cannet-wire/   Phase-2 wire protocol: tonic / gRPC service definition
                 (`proto/cannet.proto`), generated client + server
                 stubs, conversion helpers between `cannet_core`
                 frames and the wire types, and a batching adapter
                 layer so application code stays in `Stream<CanFrame>`.
  cannet-server/ BLF replay server + `--virtual-bus` server. The
                 replay mode loads a BLF into memory and streams its
                 channels on a loop while a client is subscribed
                 (transmits rejected, read-only; single-client).
                 The `--virtual-bus` mode (ADR 0021) hosts a multi-
                 client virtual CAN bus: one factory interface, fan-
                 out with sender attribution, `NoAcknowledger` on
                 zero-recipient transmits, runtime `ConfigureBus`.
                 Ships a `cannet-server` binary; lib is reusable.
  cannet-client/ Phase-2 gRPC client. `list_interfaces` is a one-shot
                 async RPC for the connection panel. `connect_and_
                 subscribe` returns a `RemoteCanFrameSource` (sync
                 `cannet_core::CanFrameSource`) backed by a worker
                 thread that owns its own tokio runtime, opens a
                 `Session`, and pumps incoming frames into a sync
                 mpsc queue. `into_parts()` exposes the receive +
                 shutdown halves alongside a Phase-5
                 `SessionTransmitter` for client TX. Drops cleanly on
                 `Drop`.
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
                     (unit-tested alongside). A command / hotkey
                     framework (`commands.ts`, `keybindings.ts`,
                     `PaletteModal.tsx` — ADR 0018) lifts every toolbar
                     action into a `Ctrl/Cmd+Shift+P` command palette
                     (recently used commands float to the top),
                     adds `Ctrl/Cmd+P` go-to-view (open panels by
                     display name), and the plot-panel hotkeys `f`
                     (fit x axis) / `l` (follow live). Element display
                     names are model-owned and resolved everywhere by
                     `elementLabel.ts` (ADR 0019), editable inline in
                     the project panel.
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

**Optional, for Phase 8 vendor drivers (Vector / Kvaser / PEAK):**

- [`uv`](https://docs.astral.sh/uv/) — manages the
  [`cannet-python-can`](servers/cannet-python-can/) sidecar's Python
  environment and installs Python on the fly. We do **not** commit
  `uv` binaries or pack them into the installer artefact; the host
  expects a `uv` to be available, either next to the GUI binary at
  `tools/uv/uv[.exe]` or on `PATH`. For local development, run
  [`scripts/fetch-uv.sh`](scripts/fetch-uv.sh) to drop the pinned
  binary into `tools/uv/`, or install `uv` per the upstream
  instructions. The end-user fetch mechanism (installer post-step
  vs. first-run host downloader) is a Phase-18 deliverable.
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

`pnpm tauri dev` boots Vite, compiles the Rust host, and launches the
cannet window. Use **Open BLF…** to pick a log; **Add DBC…** loads a
database for live decoding — load more than one and frames decode
against each in order, first match wins (every loaded DBC applies to
the one interface for now).

### Self-driving performance runs

The shipping GUI can drive itself for a render-tier performance
measurement, no operator and no external automation client — it covers
every platform the app ships on (incl. macOS, which has no WebDriver).
Pass the launch flags through to the binary (after a `--` separator under
`tauri dev`):

```sh
pnpm --dir apps/gui tauri dev -- -- \
  --project examples/ev-demo/ev-demo.cannet_prj \
  --connect-on-start \
  --perf-capture-secs 60 \
  --perf-out docs/performance-measurements/frontend/<date>-<hash>.json
```

- `--project <path>` opens a project deterministically (ahead of the
  last-opened pointer). Usable on its own to just open a project.
- `--connect-on-start` fires the same connect a user clicks, once the
  project's bindings (and, for a local binding, the sidecar) are ready.
- `--perf-capture-secs <n>` captures the frontend diagnostics for `n`
  seconds after the session settles, then writes the report and exits.
- `--perf-out <path>` is where the `RenderReport` JSON lands;
  `--perf-label <text>` names the scenario in it.

Everything else the run needs is already in the saved project: the panel
layout (the views under test), the bus bindings (the frame source), and
the rest-of-bus simulation's run flag (the load, which resumes on
connect). For a hardware-free run the project should bind to a virtual
bus. See [ADR 0031](docs/adr/0031-gui-performance-automation-self-driving.md).

The render report this writes is the frontend counterpart to the host
harness's baseline. The harness can't generate it (only the webview sees
the render tier), so it's fed in: `cannet-perf-measurement baseline
--frontend-report <report>` stores its gated UX-health metrics
(long-task time, lag, jank fraction) alongside the host modes, and
`cannet-perf-measurement check --frontend-report <fresh-report>` gates a
fresh run against them. `baseline` writes a dated
`<date>-<hash>[-dirty].json` snapshot; `check` compares against the
canonical `docs/performance-measurements/baseline.json` — promote a
snapshot to the reference by copying it there. Frontend render reports
live under `docs/performance-measurements/frontend/`, kept apart from the
host baseline they feed.

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
panel itself (it's a show/hide singleton). **DBC panel** opens (or
focuses, if it's already open) the discovery panel — a
tree-with-fuzzy-search over every loaded DBC, grouped by bus
(`bus → DBC → message → signal`; unscoped DBCs appear under each
bus group labelled "applies to all buses"). Type any fragment of a
signal name, comment, value-table label, message id (hex or decimal),
or attribute, and the matching rows surface with their ancestors
auto-expanded and unrelated rows dimmed. The toolbar's **details**
toggle reveals the full per-signal detail (bit positions, scale,
range, mux indicator, float kind, attributes, value table) and
per-message detail (length, FD/BRS, mux flag, attributes). Drag a
signal or message row onto a plot panel to add it as a series, or onto
the transmit panel to create a new TX frame for that message;
multi-select (click / Shift-click / Cmd-Ctrl-click) drags the whole
selection at once. The host watches every loaded DBC file and
auto-reloads the in-memory copy when the file changes on disk — no
need to click Reload after editing a DBC in another tool. Singleton
like the project panel, and read-only (DBCs are added / removed from
the project panel, not from here). New panels arrive as a tab
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
paths, the project's logical buses, and the interface bindings (each
of which names its own server address). The **project panel** (or the
toolbar's **Open project…** / **Save project**) drives it: **Save** /
**Save As…** write one, **Open…** restores it (re-loads the DBCs and
restores the bus / binding configuration — hit **Connect** to switch),
**New** starts a fresh workspace (default layout, no DBCs, disconnected,
buffer cleared). The panel also lists the configured server(s) with
**Connect all** / **Disconnect all** and the loaded DBCs with **Add…**
/ **Remove** / **Reload all from disk**. The
last opened/saved project is reopened on launch (with no project, the
layout is restored from local storage). Unsaved changes show a `●` in
the project panel, and closing the window with unsaved changes prompts
you (Save & close / Discard & close / Cancel). Not carried in the project: a trace's window
position (it re-anchors to the session buffer on each launch anyway),
and the BLF replay path.

**Add plot panel** opens a signal plot (Phase 4): a uPlot-based
oscilloscope-style view, docked like any other panel. It's backed by a
**trace element**, like the trace panels — same windowed view over the
session buffer with **Start / Stop / Pause / Clear** — it just renders
signal *values* over time instead of message rows: while running it
follows the live capture, Pause/Stop freeze the window (which also stops
the re-sampling), Clear re-anchors what's plotted to "now".

- **Y-axis mode.** Each plot area carries a y-axis-mode selector
  (next to **fit y**) with three values per ADR 0026: **unified**
  (one axis; all series overlaid), **per-unit** (one axis per
  declared unit; unitless series share an axis), and **individual**
  (one axis per series). On any axis, series sharing a declared unit
  share one y scale (the union of their observed ranges) and each
  unit group auto-scales independently to fill the axis; the y-tick
  labels always show the primary signal's real engineering values
  (click a series row to promote it). Switching modes re-stacks the
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
  and they flex to fill the panel (one fills it; several split it). Each
  plot area has a uPlot canvas (time axis at the bottom) plus a **signal
  panel** beside it listing that area's signals: a colour swatch (click
  to hide / show the line — the value keeps updating, the swatch dims;
  **right-click** the swatch to pick the series' colour from the
  browser's colour picker), the name, and the value — at cursor A when one is placed, else at the
  mouse crosshair, else the latest sample. The signal-panel head shows
  the H1/H2 Y-cursor values + ΔH when those are placed; y scales are
  always auto-derived (per ADR 0026) and **fit y** refits the
  auto-norm latch to the visible window. With a DBC
  attached, the toolbar's **add signal…** dropdown lists every
  `(message, signal)` pair the database defines; picking one drops it
  into the *focused* plot area (click an area to focus it). **Drag a
  signal row** to re-order it, onto another plot area, or onto another
  plot panel (cross-panel drops in a copy); **×** removes it. A signal
  keeps the colour it was given when added — re-ordering / moving
  doesn't recolour it. The shared x-axis spans 0 to the longest plotted
  signal across the panel's areas, so a signal added late still shows
  over the existing span.
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
- **Performance.** Each re-sample slices only the trace element's
  window out of the store by frame index (so the work is bounded by the
  window, not the whole capture), and the result is min/max-decimated
  host-side to ≈the plot's pixel width before it reaches uPlot (spikes
  survive the decimation), and the live plot re-samples **incrementally**
  on a self-paced loop at a configurable rate (default 15 Hz; pick it in the
  plot toolbar) — each tick only the frames appended since
  the previous one are decoded and appended to a bounded per-signal
  cache, so a long capture isn't re-decoded every tick. Pause stops the
  loop. The toolbar shows the update rate, the worst recent re-sample
  time, and the device-pixel ratio.

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
  `cannet-server --virtual-bus` server accepts transmits on its
  allocated participant id and fans them out to every other
  subscriber; a solo subscriber's transmit reaches no recipients and
  comes back as `Error::NO_ACKNOWLEDGER` instead.

**Enum / state signals** render symbolically wherever they appear:

- A trace row's expanded signal grid shows `<value> "<label>"` for
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

`cannet-server --virtual-bus` exposes one factory interface,
`virtual:bus0`, and hosts a multi-client virtual CAN bus (ADR 0021).
Each connecting client `Subscribes` to the factory, the server
allocates them a fresh participant (`virtual:bus0/p<n>` returned via
`InterfaceAllocated`), and every transmit from one participant fans
out as `Rx` frames to every other participant tagged with the
sender's allocated id.

```sh
cargo run -p cannet-server -- --virtual-bus
# → virtual-bus mode: factory virtual:bus0 (speed 500000 bit/s, fd data off)
# → listening on 127.0.0.1:50051
```

Tunable via `--speed-bps` (arbitration-phase bit rate, default
500 000) and `--fd-data-speed-bps` (data-phase bit rate for FD frames
with BRS; `0` leaves the bus classic-only). Runtime reconfiguration
goes through the wire's `ConfigureBus` envelope and takes effect on
the next arbitration round.

**Bridges.** Any session may install a bridge with `AttachBridge {
remote_address, interface_id, name }`. The server opens a session to
the remote endpoint, subscribes to the named interface, and wires the
resulting frame stream into the bus as a bridge participant. The new
bridge is published as `virtual:bus0/bridge-<name>` and every open
`WatchInterfaces` stream gets a fresh snapshot. `DetachBridge { name }`
tears it down; the same `WatchInterfaces` push announces the removal.
Pointing a bridge at another `cannet-server --virtual-bus`'s factory
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
source the project knows about — sidecar interfaces, remote
interfaces, and the project's virtual buses — plus *+ Add server…*
and *+ Add virtual bus*. Picking from the combo writes the binding.
Step 6's multi-client fan-out means the same source may be picked
for many logical buses; the GUI no longer hides "in use" options.
A dedicated *Virtual buses* section lets the user rename, configure,
add bridges to, or delete each virtual bus the project owns; the
host applies bus_config edits via `SharedBus::reconfigure` and
manages bridge teardown.

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
  it back to DBC-tracking. The fzf filter narrows by message /
  signal name.
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
BA_ "CannetCounter" SG_ 1042 AliveCtr "increment=1;rollover=15";
BA_ "CannetCrc" SG_ 1042 Crc8 "alg=CRC-8/SAE-J1850;range=0:56;prefix=A3";
```

(see `examples/cannet-demo.dbc`'s `BmsCommand` message). Both the
RBS panel and the transmit panel expose the same configuration
editor; a per-message override replaces the DBC default wholesale
per field. On the receive side, frames on a configured `(bus, id)`
are verified at ingest: a bad CRC or out-of-sequence counter paints
the trace row red, per-id validity is queryable
(`fetch_field_validity`), and a valid→invalid transition logs a
rate-limited Info system message. cannet's own transmissions are
exempt.

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
the target signal shows the colour. The expanded trace rows tint the
signal's value cell; a plot fills the **enum logic-analyzer lane box**
for each held value. Maps live in the project file and resolve
first-match — the first map (and within it, the first rule) that covers
a value wins. This is a first-cut prototype; the rule editor and
numeric-signal plot rendering will grow.

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
`bus_id`. **Disconnect** ends every session. Server addresses no
longer live in the toolbar — they're per-binding configuration. A
binding's `server` is either the literal `"local"` (sentinel meaning
"the local sidecar at whatever address it's bound to this session" —
the sidecar's port is randomised per launch, so persisting a literal
`host:port` would orphan the binding on every reload) or a
`host:port` for a specific remote `cannet-server`; the frontend
resolves `"local"` to the live sidecar address before invoking the
connect command.

**BLF channel mapping**. Opening a BLF now pre-scans the file for its
distinct channels (capped at 200k frames for huge BLFs) and shows a
modal where each channel is mapped to a logical bus or marked as
"skip". Skipped channels are dropped before they reach the trace
store; mapped channels stream in tagged with their bus.

**Per-bus DBC scoping**. Each DBC entry in the project panel grows a
row of checkboxes — one per defined logical bus — that control which
buses the DBC decodes for. A DBC with no boxes checked is *unscoped*
("all buses", the migration default for v2 projects). A DBC scoped to
bus A doesn't decode bus-B frames; an unassigned frame matches only
unscoped DBCs.

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
(`fetch_trace_range`, `fetch_latest_by_id`) accepts an optional
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
`dbc_paths` into `dbcs` (each unscoped) and defaults `buses` and
`interface_bindings` to empty; the on-disk version is rewritten the
next time you save.

### Phase-7 system messages

Phase 7 adds a structured log bus and a panel that surfaces it.

**Host-side log bus**. The Tauri host owns a bounded in-process ring
of `{ ts, source, level, message }` entries (`apps/gui/src-tauri/src/
system_log.rs`). `sys_info!` / `sys_warn!` / `sys_error!` macros fan
each event into both the ring and `tracing-subscriber`'s `fmt` layer
so dev stderr keeps working. A per-`(source, template)` rate
limiter caps any one emitter at five entries per second; the first
drop in a window records a single suppression note so the panel
doesn't go silent under a flood. Sources currently in use:
`project`, `dbc`, `connection`, `blf-import` (vendor sidecars will
use `sidecar:<vendor>` in Phase 8).

**System Messages panel**. Add it from the toolbar's *System
messages* button. The panel renders a virtualised list filterable by
source and by minimum level (default `warn` — informational entries
are visible only if you opt in). Copy-all and double-click-to-copy
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
(`apps/gui/src-tauri/src/sidecar.rs`); the user does not run anything
in `servers/cannet-python-can/` by hand. The sidecar binds to an
OS-assigned ephemeral port (`127.0.0.1:0`) and reports the actual
address back on its `sidecar\tlistening\t<addr>` banner; the host
parses it into `SidecarState` and exposes it through the
`get_sidecar_status` Tauri command and the `sidecar-status-changed`
event, which the project panel's "Local sidecar" row reads so the
user can bind interfaces without typing an address. The sidecar's
stdout / stderr and exit code feed the **System Messages** panel
tagged `sidecar:python-can`. A crashing sidecar gets up to three
auto-restart attempts per session; once the budget is exhausted,
the **Restart sidecar** Tauri command clears it.

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
   The end-user fetch mechanism that populates this same path on an
   installed copy is a Phase-18 deliverable.
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
3. Set `CANNET_DRIVER_MODULE=<your_module>` in the environment the
   GUI launches with.

The wire-level code does not change. See
[`servers/cannet-python-can/LICENSING.md`](servers/cannet-python-can/LICENSING.md)
for the LGPL analysis that motivates this layout.

### Phase-9 Save Capture, notes & Recent BLFs

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
third-party tools like CANalyzer see them too). Open BLF reads
those markers back into the session-scoped store. No sidecar
file is written, per [ADR 0010](docs/adr/0010-no-sidecar-files.md).

**Recent BLFs**. The toolbar grows a **Recent** dropdown next to
**Open BLF…** that lists the last 8 opened BLF paths, persisted
in `localStorage`. Picking one fast-paths through the standard
Open BLF flow (the channel-mapping modal still runs because each
BLF can route differently onto the current project's buses); a
successful Save Capture promotes the saved path too, so
"what did I just save?" is a one-click re-open.

**Project schema v3 → v4**. `PROJECT_SCHEMA_VERSION` bumps to 4.
Notes used to live in each plot panel's dockview `params`; the v4
migration strips them out (the host's session-scoped store owns
them now). Phase-4-vintage projects open cleanly with the
migration running on parse; the on-disk version is rewritten the
next time you save.

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

Tauri can't cross-compile — each target is built on the matching OS.
The release workflow does this automatically: pushing a `vX.Y.Z` tag
first runs the full CI suite, then (only if it passes) builds the macOS
arm64 and Windows x64 bundles on native GitHub Actions runners and
publishes them to a draft pre-release (see § Downloads and
[`.github/workflows/release.yml`](.github/workflows/release.yml)). The
committed version stays `0.0.0`; the binary stamps its own
`git describe` version (shown in the title bar) and the installer takes
its version from the tag.

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

## License

cannet is free software: you can use, study, modify, and redistribute
it under the terms of the **GNU General Public License v3.0 only**
(`GPL-3.0-only`). Derivative works must stay under the same license.
See [`LICENSE`](LICENSE) for the full text.

Copyright © 2026 Ben Hefner.
