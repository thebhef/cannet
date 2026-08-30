# ADR 0031 — GUI performance automation drives the real app from within

Status: accepted (2026-06-22); amended (2026-08-19) —
`rx_gap_short_frac_worst`'s gate limit is set by the regression
magnitude it must catch, not `baseline x factor` off the last run; a
gate limit ratchets down only, and raising one needs an owner ruling
recorded here

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
  - `--rbs-run-on-start` — arm every RBS element the project loads,
    through the same host command the panel's Run toggle uses. A
    rest-of-bus simulation is what puts frames on the bus in a
    load-generating scenario, and its Run flag is session state a
    project file cannot carry (ADR 0028), so an unattended run asks for
    it as explicitly as a person would;
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
  configuration under test and its bindings choose the frame source.
  The load itself is a *flag*, not a project field —
  `--rbs-run-on-start` arms the simulation the project references — so
  a run that forgets it measures an idle bus and says so in its rates.
  For a hardware-free render run the project should bind to a virtual
  bus rather than physical adapters — that is a property of the saved
  project, not of the flags.
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

## Amendment (2026-08-19) — `rx_gap_short_frac_worst`'s limit is regression-sized, and gate limits ratchet down only

Owner ruling, correcting an earlier version of this amendment that made
`rx_gap_short_frac_worst` advisory (excluded from the pass/fail
aggregate) after a control measurement (15 healthy 60 s captures, one
rig, same day, across two branches) found it spreading 0.0022-0.0967
(44x, mode ~0.004) with no code regression present — a ~7% spurious
breach rate per run against the then-current limit — `baseline *
FACTOR + floor` = 0.046 off a baseline of 0.008 that was itself an
unlucky run.
The owner's correction: *"it's not advisory as much as it is optimized
and noisy. It should not get worse."* The metric is a real gate again,
re-set to the tolerance the noise actually requires.

**What the gate is for.** A "short" gap is one under half its id's
median gap — for a 10 ms-cycle id, a frame arriving under 5 ms after
its predecessor. Sub-5 ms per-frame deltas that don't accumulate are
not a defect a user feels, and chasing them costs more review time than
they're worth (*"we should not chase sub-5msec deltas unless they stack
over time and impact the user experience"*). The gate exists to catch
regressions that do stack: the cohort regression this metric was added
for measured `worst_short_frac` ~28%, not a handful of isolated frames.

**How the limit is set.** By the magnitude of the regression the gate
must catch, not by `baseline x factor` off whatever the last run
measured. The measured spread is the evidence for where the noise floor
sits: 15 healthy same-rig runs spread 0.0022-0.0967, mode ~0.004.
`ftol::RX_GAP_SHORT_FRAC_FLOOR` (`crates/cannet-perf-measurement/src/frontend.rs`)
moves from 0.03 to **0.15**, giving a limit of `baseline * FACTOR +
floor` = 0.008 * 2 + 0.15 = **~0.166** at the 0.008 baseline: about 1.6x
above the worst observed healthy run, well under the ~28% regression
the gate must still catch.

**Gate limits ratchet down only — the load-bearing rule.** Lowering a
limit as the rig or the code improves is ordinary work. **Raising one
requires an owner ruling recorded in this ADR** — no phase may widen a
gate to make its own run pass. This is the same principle as never
promoting a baseline to make a failure pass: a series of agents each
nudging a limit up a little, run after run, ends with a gate that means
nothing.

`_worst` / `_peak` metrics — `rx_gap_short_frac_worst` and
`rx_gap_p95_ratio_worst` among them, plus the memory peaks and
`flush_ms_max` / `tx_late_ms_max` — remain extreme-value statistics and
carry more run-to-run spread than a mean ever will, by construction: a
max over N samples gets noisier as the tail gets thinner, which is what
made the pre-correction limit above too tight. If a future `_worst`/
`_peak` metric needs more headroom than a floor can responsibly give
it, the principled path is the one already applied to the
`_mb_drift_per_min` family: gate the **median across the gate's
reports**, not the worst run (`check_frontend_gate` already carries the
mechanism; adding a metric to it is a `DRIFT_METRIC_NAMES`-shaped
change). That needs a **3-run minimum** — a two-run median is just the
average of the two runs, no less noisy than either alone; three is the
smallest sample where the median actually discards an outlier.

**`tx_late_ms_max` is the same story, and gets the same treatment**
(owner ruling, 2026-08-19). It read above its 65.7 baseline on four
consecutive gate runs across four unrelated diffs, then 23.6 and 73.4
back-to-back on one binary — a 50 ms spread with nothing changing
between the two. Owner ruling: *"it's noisy. Same as the rx — don't
stop for it."* So: no bisect, no investigation, and an elevated reading
is not a finding to report. It stays **gated at its existing limit**
(156.4, with `tx_late_ms_mean` gated separately and sitting far inside
its own) on the same terms as `rx_gap_short_frac_worst` — optimized and
noisy, and it should not get worse. A run that actually breaches the
limit is still a stop; readings under it are not.

## Amendment (2026-08-20) — an unreproducible outlier is documented, not chased

A gate run occasionally produces a reading that no later run reproduces
and no mechanism explains: one observed case was `tree_mb_peak` at
8233 MB against a 1492 MB limit, on a build whose change was a
presentational component, with six subsequent runs on the same binary
reading 705–768 MB.

**The rule: document it in `plans/backlog.md` and move on. Do not
duplicate an outlier that is already recorded there.** Check the
backlog before writing a new entry; a second sighting of the same
metric belongs as a note on the existing entry, because the thing worth
knowing is how often it recurs, not how many times it was written down.

What this does *not* license: promoting a baseline, widening a limit,
or quietly dropping the failing run from the set that gets reported.
Limits still ratchet down only. The outlier run is reported with the
rest of the distribution — the record says "this happened once and
these five runs did not", and the next reader can see the pattern
forming if it is forming.

## Amendment (2026-08-22) — the baseline is re-taken at the end of a chain

Owner ruling: *"I'm good to baseline with the perf as it is right
now."* Taken after reviewing the whole render-tier series — 84 captures
across 19 builds — rather than after any single run.

**This is a re-baseline, not a promotion to clear a failure.** Every
run on the tree it was taken from passed at its old limits. Two things
made it due:

- The example projects grew, and `ev-zonal` is the harness's project,
  so the stored baseline described a project that no longer existed.
  A line-for-line comparison against it could not distinguish a
  regression from a bigger project.
- The frontend genuinely holds more than it did — `jsheap_mb_peak`
  +18.9 %, `renderer_mb_peak` +5.7 % — from a status bar, status
  chips, disclosed content rows and an event surface. The owner judged
  that increase marginal for the load and not worth chasing.

The rule it does **not** relax: a baseline is never promoted to make a
failing run pass, and a limit is never widened for one. Both remain
owner rulings recorded here.

### What the re-baseline tightened, and the one place to watch

Most limits moved with their metric. Two tightened sharply because the
old baseline was itself an unlucky reading:

| metric | old limit | new limit | worst ever seen |
|---|---|---|---|
| `tx_late_ms_max` | 156.391 | **55.686** | **102.774** |
| `flush_ms_max` | 72.544 | 64.481 | 32.398 |

**`tx_late_ms_max` is now gated below its own observed spread.** It has
read 102.8 ms on this rig on an unchanged build, and the new limit is
55.7. A future run may fail there with nothing regressing.

That is not a reason to widen it — limits ratchet down only, and the
metric has run 5–25 ms for the whole recent chain. It *is* a reason to
treat a single failure there as suspect: reach for a same-day control
build before believing it, the way the `lag_ms_max` and
`rx_gap_short_frac_worst` investigations did. If it fires repeatedly
on unchanged builds, that is the evidence for an owner ruling to
re-gate it, not a licence to raise it quietly.

### Provenance of this baseline

Frontend metrics come from a single capture — the median of four runs
on the chain head — and the three host modes were measured live on a
quiet rig at promotion time. The dated snapshot carries a `-dirty`
suffix from two stat-only working-tree entries with empty diffs, not
from uncommitted code.

**Check `hardware_peak.ingest_fps_overall` on any snapshot before
promoting it.** A first attempt at this re-baseline produced `0.000`
there, because another cannet instance held the PCAN dongles; promoting
it would have set a zero limit and killed the metric silently. A metric
that reads zero where it previously read a rate is a failed capture,
never a result.

## Amendment (2026-08-27) — a capture says whether it measured anything

Three of this harness's checks passed while measuring nothing, in three
different ways. Each is now reported rather than absorbed.

**Memory is attributed against creation time, and an impossible zero
fails the capture.** The memory tier walked the OS's parent links to
decide which processes were ours. Windows recycles PIDs and never clears
a dead parent's `ParentProcessId`, so an unrelated orphan could claim
the PID this process now holds and be billed to us whole — a 4 GB
foreign app was once measured as ours. And when a second cannet already
owns the shared `WebView2` browser process, our own renderer descends
from *its* host, not ours: the whole `WebView` family falls outside our
subtree, `webview_mb` reads `0.0`, and every memory gate passes on a
reading of nothing.

Both are now handled in the walk. A parent link counts only when the
child's creation time is known and not earlier than the parent's — the
one fact a stale link cannot fake. (An unreadable creation time counts
as *not ours*: on Windows it is unreadable only for a process we cannot
open a handle to, which never applies to our own family, while a
stranger we cannot open still reports memory. Excluding it is the cheap
mistake.) And a family that ends up containing no `WebView` process at
all — impossible for a running window, on the platforms where the
`WebView` is our descendant — **fails the capture** with the reason,
writing no report. Absence is the one signal no consumer can misread as
a healthy number. macOS is exempt: its `WebKit` helpers are
launchd-owned XPC services and are never our descendants, which is the
documented normal there.

**The interaction script's gestures are counted, and the tally rides in
the report.** Every gesture function names what it did, and a gesture
whose target is not on screen is skipped — deliberately, since a layout
with no plot is a legitimate capture. But nothing recorded how often
that happened, so a run that gestured at *nothing* produced a report
structurally identical to a hard-scrubbed one, and read as "interaction
is free". A target has gone missing before: the follow-live chip spills
into the plot toolbar's overflow menu at narrow widths, where the script
cannot reach it.

The render report now carries an `interact` block — the script, the tick
count, and how many gestures were performed, went missing, or were
deliberate idle slots, each broken down by gesture label. `performed: 0`
is the disarmed signature; `missing_by_gesture` names the control that
moved. `check` and `baseline` print a warning for any report with a
missed gesture in it. It does not gate: a quiet layout is a legitimate
capture, and what the tally supplies is the evidence a reader needs to
tell the two apart.

**The screenshot walk's `__shot` helpers have a guard test.** They are
JS the harness injects into the page, so every selector in them is a
claim about the app's markup that only a full capture run exercised —
`importIdle()` once returned true mid-import because the label it polled
for had been restyled away. The helpers now live in their own file
(`shot-prelude.js`, embedded with `include_str!`) and the frontend suite
loads that exact file, evaluates it, and drives each helper against
markup rendered by the real components. Breaking a selector fails a test
rather than a capture nobody re-reads.

## Amendment (2026-08-30) — `lag_ms_max` and `rx_gap_short_frac_worst` gate on the median across a gate's runs

Owner ruling, made on charted evidence: **both metrics move from
worst-run to the median across a gate's reports**, on the same terms as
the `_mb_drift_per_min` family. The limits are untouched — only the
statistic judged against them changes — and limits still ratchet down
only.

The evidence (206 stored render reports across 91 commits; the full
distributions are in the 2026-08-27 mining): within *one unchanged
binary*, `lag_ms_max` spread 4.3× its median (27× at the worst — eight
captures spanned 2.8–37.6 ms against a 41 ms limit) and
`rx_gap_short_frac_worst` spread 2.3× (1163× at the worst, breaching on
a byte-identical GUI). A worst-of-N rule over 3–4 runs therefore fails
an unchanged build at a rate the medians do not support, while a median
rule would have passed every cohort mined.

Mechanically this is the `DRIFT_METRIC_NAMES`-shaped change this ADR's
2026-08-19 amendment anticipated: the list is now `MEDIAN_METRIC_NAMES`
(`crates/cannet-perf-measurement/src/frontend.rs`), carrying the three
drift metrics plus these two. Arming is unchanged per metric —
`rx_gap_short_frac_worst` stays baseline-armed (a sim-only baseline
holds 0 ⇒ inert), `lag_ms_max` stays always-armed like the rest of the
render tier. A single-report `check` is unchanged; the 3-run minimum
for a meaningful median stands. Worst runs are still visible — every
report's value is printed — they just no longer gate alone.
