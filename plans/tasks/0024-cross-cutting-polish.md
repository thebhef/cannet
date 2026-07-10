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

The **end-user runtime-tool fetch flow** that used to live here (fetch
`uv` at install time or first launch) is **removed** — it was never
built, and [Task 31](0031-frozen-sidecar-binary.md) obsoletes it by
shipping the sidecar as a frozen self-contained binary
([ADR 0036](../../docs/adr/0036-frozen-python-can-sidecar.md)). End users
fetch nothing.
