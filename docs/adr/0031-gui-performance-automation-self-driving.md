# ADR 0031 — GUI performance automation drives the real app from within

Status: accepted (2026-06-22); amended (2026-08-19) —
`rx_gap_short_frac_worst` is advisory only, not a gate; the `_worst` /
`_peak` families are extreme-value statistics and are not all equally
trustworthy as desktop-rig gates

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
  - `--diag` — arm the frontend's diagnostic machinery (the counters and
    gauges, their burst logger, the `longtask` observer, the 1 Hz console
    line, and the `window.__cannetPerf` capture entry point). The four
    `--perf-*` flags imply it, since the capture's payload is those
    counters;
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
a capture from the devtools console — on a launch that armed the
machinery, which is what `--diag` is for.

**The measurement machinery is off unless a launch asks for it**, and
"off" means not scheduled, not registered, not installed — not "running
but doing nothing". This is a binding property of anything added to this
surface, because all of it ships in the product binary: an unarmed
launch counts nothing on a render path, registers no observer, logs no
line, installs nothing on `window`, and writes none of the host-side
capture atomics. The exceptions are named and budgeted product features
rather than instrumentation — the health sampler, and the UI-liveness
heartbeat that rides the reporter's timer (the host reads its arrival as
proof the renderer's main thread is turning, so it cannot be conditional
on a measurement flag).

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

  Default settings includes **default window geometry**, and that one
  needs correcting rather than accepting: every baseline captured before
  isolated profiles existed measured the operator's own ~2450×2080
  window, and Tauri's default size gives the plot canvas a materially
  lighter render workload than that. So the run procedure copies the
  operator profile's `.window-state.json` — `%APPDATA%\dev.cannet.app\.window-state.json`
  on Windows, `~/Library/Application Support/dev.cannet.app/.window-state.json`
  on macOS, `~/.config/dev.cannet.app/.window-state.json` on Linux — into the
  fresh `--app-data-dir` before its first run, the same one-time-per-directory
  treatment as pinning a server. A plain file copy, not a symlink, so the
  isolation still holds: the run can read the operator's real geometry but
  can never write back to it.
- **A capture measures the machine as much as the build, so the run
  procedure is part of the measurement.** Repeated runs of one
  unchanged release binary move the gated metrics by more than the
  differences a gate is asked to judge: over ten back-to-back runs
  `rx_gap_short_frac_worst` rose 9× with nothing varying but session
  position, and `renderer_mb_drift_per_min` measured a 2.2× lower mean
  in one session than in another two hours earlier. Three rules follow,
  and they are the procedure — not advice.

  - **Measure on a quiet machine, and not straight after heavy work.**
    Nothing else runs during a capture; a run started minutes after a
    full build measures a different machine than one started cold.
    Deliberate CPU contention alone has been shown to push
    `rx_gap_short_frac_worst` past its limit on an unchanged binary.
  - **Compare within one session.** Runs taken back to back on one
    machine state are comparable to each other. A number carried across
    sessions — or across the `--app-data-dir` change, which moved every
    run to default settings — is a weaker comparison than it looks.
  - **A single-run breach with the rest of the gate's runs clean is
    re-run, not ruled on.** Take a fresh run after letting the machine
    settle; the gate stands on the re-runs. A breach that repeats is
    real and blocks. This is what closes the ambiguity a lone failing
    first run used to create: the disposition no longer depends on
    attributing it, which may not be possible — the levers nominated
    for two such failures (cold page cache, a fresh profile,
    process-table polling) were each tested and each falsified.

  Drift metrics deserve particular suspicion here: a least-squares
  slope over a 60 s window is a property of where in a memory ramp the
  window landed, so its worst run across a gate is a noisier statistic
  than a latency maximum, which at least corresponds to something a
  user felt. Measured on one unchanged binary, the drift metrics'
  session-to-session spread (5.6×, one build) is wider than the margin
  a gate's limit leaves over its baseline (2.1×) — wide enough that the
  worst-run rule can fail a build that has not changed and pass one
  that has. So the drift family
  (`jsheap_mb_drift_per_min` / `renderer_mb_drift_per_min` /
  `tree_mb_drift_per_min`) is gated on the **median across a gate's
  runs** instead: `cannet-perf-measurement check` takes `--frontend-report`
  repeated once per run in the gate
  (`check --frontend-report run1.json --frontend-report run2.json …`),
  and judges the drift family's median against the same limit as
  before — every other metric keeps the worst-run rule above. This
  multi-report form is the canonical way to run `check` against a gate
  from here; a single `--frontend-report` still works exactly as it did
  (the median of one run is that run). The limits themselves are
  unchanged — only the statistic gated against them moved.
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

## Amendment (2026-08-19) — `rx_gap_short_frac_worst` is advisory, not a gate

Owner ruling, on a control measurement (15 healthy 60 s captures, one
rig, same day, across two branches): `rx_gap_short_frac_worst` spread
0.0022-0.0967 (44x) with a mode near 0.004 and **no code regression
present**. Against its gate limit — `baseline * FACTOR + floor` = 0.046,
off a baseline of 0.008 that was itself an unlucky run — that is a ~7%
spurious breach rate per run, ~13% per two-run gate. Two facts rule out
code as the cause: the two highest values in the 15 are exactly the two
lowest-`rx_fps` runs (the short-gap fraction tracks a depressed on-wire
receive rate, not a code path), and one of those two is on a branch the
other spike isn't on. The argmax id also shuffles across three different
ids across the 15 runs rather than naming one hurt signal — the
fingerprint of an extreme-value statistic over a near-flat field, not of
one signal being hurt. `tree_mb_peak` shows the same shape (709-998 MB
across 7 runs, comfortably inside its limit): the `_worst` / `_peak`
families as a class are extreme-value statistics, gated here as if they
were means.

This cannot be resolved on a desktop PC — or at least not on every
desktop PC — so gating on it is a waste of time. `rx_gap_short_frac_worst`
**stops being a gate**: it is still computed, still written into every
report, and still printed by `check` (marked `advisory` in the result
column, per-run, same as before), but it no longer contributes to
`check`'s pass/fail verdict (`Verdict::advisory` in
`crates/cannet-perf-measurement/src/check.rs`).

**Realism about this harness's gate families on a desktop rig:**

- **Trustworthy as gates**: every mean/ceiling row (`longtask_*`,
  `lag_ms_max`, `jank_fraction`, `flush_ms_mean`, `tx_late_ms_mean`), the
  `*_retention` floors, the expected-rate bands, and
  `rx_gap_p95_ratio_worst` (a ratio, not a rare-tail fraction — this
  finding does not implicate it).
- **Advisory only**: `rx_gap_short_frac_worst`, per this amendment.
- **`_worst` / `_peak` extreme-value metrics generally** (this includes
  the memory peaks and `flush_ms_max` / `tx_late_ms_max`) carry more
  run-to-run spread than a mean ever will, by construction — a max over
  N samples gets noisier as the tail gets thinner, exactly what a
  60 s capture's per-id gap tail is. They are not shown to false-trip in
  practice the way `rx_gap_short_frac_worst` was, so they stay gates, but
  a future breach in one of them deserves the same control-measurement
  scrutiny before it is read as a regression.

If `rx_gap_short_frac_worst` — or another `_worst`/`_peak` metric — is
ever wanted as a gate again, the principled treatment is the one already
applied to the `_mb_drift_per_min` family above: gate the **median across
the gate's reports**, not the worst run (`check_frontend_gate` already
carries the mechanism; adding a metric to it is a `DRIFT_METRIC_NAMES`-shaped
change). That needs a **3-run minimum** — a two-run median is just the
average of the two runs, no less noisy than either alone; three is the
smallest sample where the median actually discards an outlier.
