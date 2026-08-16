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
    then exit (`--perf-label <text>` names the scenario in the report);
  - `--app-data-dir <path>` — put this launch's whole user scope in a
    directory the run owns, so the measurement leaves the operator's
    state alone;
  - `--perf-interact <script>` — drive synthetic gestures at the heavy
    views for the length of the run. The saved project supplies the
    *views*, but not what a user does to them, and most of the render
    tier's cost is paid on interaction (the virtualiser re-windowing as
    the table scrolls, the plot re-fetching and re-decimating as its
    x-window moves). Without this a capture measures the resting cost
    and a regression in the interactive path passes it. The gestures are
    real DOM events dispatched at the real elements, so they reach the
    app through the listeners a mouse would — the same "the app is its
    own driver" argument as the rest of this decision.

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
- **A capture is only comparable to another capture of the same build
  kind.** A development build runs a debug host behind React's
  development bundle. Measured against an otherwise identical release
  run of the same commit, it reads ~1.5× the JS heap peak, ~1.9× the
  mean flush duration, ~2.4× the mean transmit-scheduler wake lateness,
  and — because React double-invokes renders under StrictMode in
  development — ~2× every render counter. Baselines are release
  captures, and a report's label records which kind it was.
- The `RenderReport` carries a `frontend` mode tag so it slots beside
  the model-tier modes in a measurement file. Because the app produces
  the report — a regression checker cannot re-run a GUI session the way
  it re-runs an in-process workload — gating compares the most recent
  GUI-produced summary against the baseline (the same "compare, don't
  re-run" treatment a hardware-only mode gets when the rig is absent).
- No dependency on `tauri-driver`, platform WebDriver binaries, or a
  separate browser-automation stack.
- **A `--perf-capture-secs` run under `--connect-on-start` cannot produce
  a passing-shaped report without a connection.** The connect is retried
  a bounded number of times (bounding only *when* the capture window
  starts, never its length); if the capture window would start without a
  session up, the run fails outright — no report is written (its absence
  is the one failure signal no consumer can misread) and the process
  exits non-zero. The frontend has no other way to set a process exit
  code, so this is the one host (Tauri) command in the automation surface
  that isn't just mirroring a user-clickable action — and the host runs
  its event loop with `run_return` so the requested code reaches the OS
  at all: the runtime turns an exit request into a plain "stop the loop",
  dropping the code, and a failed run that exits 0 is exactly the quiet
  success this contract exists to prevent. A marked-failed
  report was considered and rejected: every consumer would need to learn
  the marker, and an unaware one reads the fps-0 shape as real idle data
  — the trap this closes.
- The self-driving flags are an automation surface on the shipping
  binary. They default off (a normal launch is unaffected) and are
  additive; the manual console capture remains for interactive use.
- **A run must not write the operator's state.** Everything the app
  persists per user — the trust store, the project registry and
  recents, settings, window geometry — lives under one directory, and
  `--app-data-dir <path>` moves that directory for the launch. It is
  the whole isolation mechanism: no behaviour is special-cased for a
  measurement (a rule that said, for instance, "a loopback connection
  doesn't record anything" would change the product to suit the rig),
  and no read path elsewhere has to know a run is under way. The
  rolling log and crash records deliberately stay where they always
  are — they are the run's evidence, and a bug report wants them in
  the usual place.

  Two consequences to run with rather than around. A fresh directory
  starts from **default settings**, so a run measures the shipped
  configuration rather than whatever the operator's has drifted to —
  which makes runs comparable to each other but not to a capture taken
  before this flag existed under a customised profile. And each
  directory is its own profile: reuse one across the runs being
  compared, and a run that needs a server pinned pins it there once.
- The capture includes a **memory tier**. The frontend already reports
  the JS heap (`jsheap_mb`); while a capture is armed the host stamps its
  own process-memory split onto each per-second sample — host RSS
  (`mem.host_mb`, expected flat), the whole tree (`mem.tree_mb`), and the
  WebView renderer process (`mem.webview_renderer_mb`, where a native or
  GPU-side climb a JS heap snapshot can't see surfaces). The frontend
  can't read process RSS, so the host is the only place this split is
  available. Each gauge's reduction carries a linear `slope_per_min`
  (least-squares drift) alongside its peak, because a slow leak's
  signature is the *drift*, which a peak or final reading alone can't
  separate from a one-off spike. The checker gates renderer / JS-heap /
  host / whole-tree peak (and renderer / JS-heap / tree drift) the same
  lower-is-better way as the UX metrics — the per-process rows localize a
  leak while `mem.tree_mb` (host + every descendant) is the holistic
  backstop that catches growth in a process the named rows miss (the GPU
  process, a helper). The memory gates stay **inert until a baseline
  carries the memory tier** (a baseline lacking the fields gates nothing),
  so they arm on the next baseline regeneration. Drift only reads as signal over a
  representative-length capture — a multi-minute run, not the smoke-test
  span — so a memory baseline is captured at scenario length.
