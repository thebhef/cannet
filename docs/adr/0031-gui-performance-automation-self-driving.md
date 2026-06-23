# ADR 0031 — GUI performance automation drives the real app from within

Status: accepted (2026-06-22)

## Decision

The automated GUI performance measurement runs **the real shipping GUI**
— the actual OS WebView fronting the actual Rust host — and drives it
**from within the process**, not from an external automation client and
not against a stand-in renderer.

Two halves make this work:

- **Data out — host-captured pushed summary.** During a bracketed
  capture the frontend diagnostic reporter pushes one per-second snapshot
  (UI-thread `lag` / `longtask`, render / resample counters, gauges) to
  the host. The host accumulates the series and reduces it to a
  `RenderReport` of UX-facing metrics (long-task ms/s mean·max·p95, lag,
  jank-second fraction, estimated frames-late/s, per-counter and
  per-gauge spreads), written as JSON beside the host-side performance
  baselines so a render-tier run is diffable the same way the model-tier
  runs are.

- **Drive in — a self-driving launch mode.** Command-line flags put the
  app into an unattended measurement run:
  - `--project <path>` — open a known project deterministically (rather
    than relying on the last-opened pointer);
  - `--connect-on-start` — fire the same connect action a user clicks;
  - `--perf-capture-secs <n>` / `--perf-out <path>` — after connect
    settles, auto-capture for `n` seconds and write the `RenderReport`,
    then exit (`--perf-label <text>` names the scenario in the report).

  Everything else the measurement needs is already persisted project
  state: opening the project restores the panel layout (so the views
  render), the bus/interface bindings, and the rest-of-bus simulation's
  `run` flag (which resumes transmitting on connect, per
  [ADR 0028](0028-rest-of-bus-simulation.md)). So the only actions the
  flags add over a normal launch are *connect* and *capture* — the
  workload itself falls out of the saved project.

The manual path stays available for ad-hoc use: an operator can bracket
a capture from the devtools console without the flags.

## Why

The point of a *frontend* perf measurement is to characterize what the
user actually experiences — the real renderer under the real IPC load.
That rules out the two cheaper-looking options:

- A **browser / dev-server render** of the frontend (e.g. Playwright) is
  a different rendering engine talking to a mocked host. It measures
  something, but not the shipping render tier, so a regression there
  needn't show up and a number there needn't reproduce.
- An **external WebDriver client** (`tauri-driver`) drives the real
  webview, but only on Windows and Linux. macOS uses WKWebView, which
  has no WebDriver server for `tauri-driver` to attach to, so this path
  cannot cover all three target platforms.

Driving the real app from within covers every platform the app ships on
(the app is its own driver — there is nothing external to be missing),
keeps the renderer and the host exactly as a user runs them, and needs
no new automation infrastructure. It is viable here specifically because
the project format already persists the entire workload configuration
([ADR 0028](0028-rest-of-bus-simulation.md) for the RBS run state; the
panel layout and bus bindings in the project document), and checked-in
example projects open from any clone location
([ADR 0030](0030-project-relative-file-references.md)). The flags only
have to supply the two things that are deliberately *not* persisted —
the decision to touch interfaces, and the decision to record.

## Consequences

- The measurement input is a saved project: its layout is the view
  configuration under test, its bindings choose the frame source, and
  its RBS run flag drives the load. For a hardware-free render run the
  project should bind to a virtual bus rather than physical adapters —
  that is a property of the saved project, not of the flags.
- The `RenderReport` carries a `frontend` mode tag so it slots beside
  the model-tier modes in a measurement file. Because the app produces
  the report — a regression checker cannot re-run a GUI session the way
  it re-runs an in-process workload — gating compares the most recent
  GUI-produced summary against the baseline (the same "compare, don't
  re-run" treatment a hardware-only mode gets when the rig is absent).
- No dependency on `tauri-driver`, platform WebDriver binaries, or a
  separate browser-automation stack.
- The self-driving flags are an automation surface on the shipping
  binary. They default off (a normal launch is unaffected) and are
  additive; the manual console capture remains for interactive use.
