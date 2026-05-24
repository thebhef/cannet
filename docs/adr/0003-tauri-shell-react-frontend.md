# ADR 0003 — GUI is a single-window Tauri shell with a React/TypeScript frontend

Status: accepted (2026-05-24)

## Decision

The GUI is a single-window desktop application. The shell is
**Tauri 2** (MIT/Apache-2.0) — a Rust host process embedding the
operating system's native WebView. Inside the WebView the frontend is
**React 18** (MIT) authored in **TypeScript** (Apache-2.0) and bundled
with **Vite** (MIT).

The Rust host owns the data model — capture buffer, decoded-signal
caches, project state, system log, sidecar bridges. The WebView
renders views over that model through Tauri's IPC: views fetch
slices on demand and never hold the whole dataset. The shell and
frontend choice exists to serve that contract.

## Why

**System WebView, not a bundled one.** Tauri ships a thin host and
defers to the OS WebView (WebView2 on Windows, WKWebView on macOS,
WebKitGTK on Linux). The bundle stays small (single-digit MB) and the
WebView gets OS security updates.

**React + TypeScript.** The panels cannet needs — dock layout
([ADR 0005](0005-dockview-panel-layout.md)), graph editing
([ADR 0006](0006-xyflow-project-graph.md)), high-rate
plotting (ADR 0007) — are failure-mode-rich UI worth leaning on
vetted libraries for rather than hand-rolling. React has
first-class TypeScript packages for each. TypeScript surfaces
shape mismatches at the IPC boundary before they hit runtime.

**Vite.** The de-facto React/TS dev-loop tool — fast HMR, no
configuration mass. Mentioned by name because the project version
binds adjacent tool choices (Vitest is pinned to v2 because the app
is on Vite 5).

**Single window.** A CAN analyzer's workflows live in one place:
trace, plot, project graph, transmit, system log are simultaneously
visible facets of one capture. Multi-window adds OS-level state
(positions, focus, z-order) without a workflow that demands it.
Popout panels are a deferred dockview affordance, not an
architectural commitment.

## Consequences

- **WebView fragmentation is real.** Linux WebKitGTK is the friction
  point — its feature/perf parity lags Chromium-based engines. The
  build prerequisites in README § Prerequisites are the operational
  cost. If a panel can't keep up on WebKitGTK, **Electron** (MIT) is
  the documented fallback — same React frontend, swap the host;
  trade-off is a ~150 MB bundle.
- **The browser CSS dimension cap (≈17–33M px) bounds stock
  virtualizers.** Views over very large datasets — millions of trace
  rows — cannot use count-based virtualization library defaults;
  they need fractional scroll mapping. The hand-rolled scaled-
  scrollbar virtualizer in `TraceView.tsx` is the concrete instance.
  This reinforces the paged-model contract: views fetch slices, not
  totals.
- **The React component ecosystem is now a load-bearing surface.**
  Dock layout, graph, plotting, virtualization, and project-file
  layout-blob all flow from this choice. Each significant library
  gets its own ADR; each sits behind a thin adapter so swap cost
  stays bounded.
- **Tauri's permission model and IPC contract become part of the
  architecture.** Filesystem access, sidecar process launch, and
  custom command surface are gated through Tauri configuration
  rather than ambient process capability.

## Rejected alternatives

- **Electron** (MIT) — same React frontend works, but bundle weight
  (~150 MB vs single-digit MB). Kept as the documented fallback if
  Tauri's WebView fragmentation blocks us.
- **Qt 6** — LGPL relink discipline and the recurring commercial-
  license question add friction the project doesn't need; prior
  PySide experience surfaced ergonomic pain getting complex layouts
  right.
- **Dear ImGui + ImPlot** (MIT) — immediate-mode rendering is very
  fast, but the aesthetic and the reinvention of standard desktop
  chrome don't match user expectations for a CAN analyzer.
- **wxWidgets** — permissive license and native widgets, but dated
  tooling (wxAUI), a weaker plotting story, and a smaller community
  than the React/Tauri alternative.
