# Task 24 — Cross-Cutting Polish

The remaining small UX and infrastructure items that don't deserve
their own task: the **trace virtualizer rework** (real windowed
virtualizer with a synthetic-height spacer vs. the current scaled
approach), the **auto-scroll re-pin race** under fast streams, the
**by-ID paused-snapshot tighten** (return latest of each id within
`[since, end)` rather than reading the global latest index), a
**GUI-wide dark "scope" restyle**, **dock / undock** a panel as a
separate OS window, a **global UI FPS / responsiveness readout**,
**`cannet-server` multi-client** support, the **plot vs trace divider
drag** fix, and the **BLF f64-timestamp precision** documentation note
(if it hasn't already been folded into a user-facing surface message
by then).

**Third-party runtime tool fetching strategy.** The architectural
decision is recorded in
[ADR 0015](../../docs/adr/0015-fetched-runtime-binaries.md): external
runtime binaries are fetched from upstream at a pinned version, not
committed or bundled. This task's deliverable is the **end-user**
fetch flow — pick between:

1. **Installer post-step** — the installer (Tauri's per-OS bundler
   target, or a thin wrapper around it) downloads `uv` at install
   time into the app's install dir.
2. **First-run host downloader** — the GUI fetches `uv` on first
   launch into the user's app-data dir and points the launcher at
   that path; offline first-run shows a clear error with the manual
   `uv` install link.

Both keep the runtime lookup chain in `sidecar.rs` unchanged
(`tools/uv/uv` → `PATH` `uv` → `python3` fallback). The pin
(`UV_VERSION` in [`scripts/fetch-uv.sh`](../../scripts/fetch-uv.sh),
already in use on the dev side) is the single source of truth in
either flow.

**ADR cleanup:** point the dangling `plans/phased-implementation.md`
reference in [ADR 0015](../../docs/adr/0015-fetched-runtime-binaries.md)
at this task / the roadmap instead — ADRs describe what *is*; task
tracking lives here, not in the ADR.
