# Task 80 — Plot Resample Churn Over a Stopped Capture

Opened by owner ruling 2026-08-15 ("yes, new task") out of Task 78
phase 1's side observation.

## Observation (recorded, unattributed)

Over a stopped, fully imported capture the plot re-samples
continuously: `plotarea.resample` at 28–30/s and `followwin.slide` at
14–16/s, held for the whole run, and the trace element still reads
`RUNNING` after a file import ends. Nothing is changing; the render
hot path is doing per-frame work for a static picture.

Investigation-first: attribute what keeps the resample loop alive
(the import path never leaving RUNNING is the named suspect, but that
is a hypothesis without an experiment), then fix so a stopped capture
costs no steady-state render work beyond what interaction asks for.

## Second stopped-capture serve cost: the by-id / signal window scan

Recorded by Task 75's investigation (2026-08-14, pre-existing) and
moved here at cycle-end housekeeping — same regime (a stopped capture
serving views), same shape (work sized to the capture rather than the
view).

`useByIdView` and `useSignalView` pass `scanEnd = winEnd` whenever the
trace is stopped, and `TraceStore::latest_in_window_where` takes its
O(keys) fast path only while `end == raw.len()`. On a fresh restore
those are equal; the moment the window stops covering the tip (Clear,
Start, a re-anchor) a stopped ~58 M-frame capture pays a full
O(buffer) pass **holding the trace-store append mutex**, blocking
every other command and the health sampler with it. Once per
descriptor change by design — but the design was sized before
captures this long. Fix shape: chunk the scan, or bound the snapshot
the way ADR 0049 bounds the pyramid catch-up.

## Exit criteria (draft — firm at grooming)

- The mechanism attributed with the confirming experiment's data in
  the status log.
- A stopped, fully imported capture holds the resample/slide counters
  at zero absent user interaction (tested at whatever seam the
  attribution shows is right); live captures unchanged.
- The import path ends in the state the trace element reports.
- The stopped-capture window scan no longer takes an unbounded pass
  under the append mutex: a descriptor change over a large stopped
  capture leaves commands and the health sampler responsive
  throughout, tested at the store seam.

## Status log

### 2026-08-27 — attribution and fix (branch `task-80-stopped-resample`)

**Observation (raw).** Recorded by task 78 phase 1 over a stopped,
fully imported capture: `plotarea.resample` 28–30/s, `followwin.slide`
14–16/s, held for the whole run; the trace element reads `RUNNING`.

**Hypothesis H1.** The import path never leaves the elements running:
`log-finished` moves only the app's load state, so `trace.status` stays
`"running"`, which is what `PlotArea`'s self-paced loop gates on.

**Experiment E1** (falsifiable: if the import path already stopped the
elements, the statuses read `stopped`). `App.importEndsStopped.dom.test.tsx`
drives a BLF import end to end and reads every `.trace-status`.

| point | statuses |
|---|---|
| after `open_log`, mid-pump | all `running` |
| after `log-finished: ok` | all `running` — **predicted `stopped`** |

H1 confirmed at the first link. `resetSession` → `startAllElements` gives
every element `freshTrace(0)` (`end === null`); the `log-finished` handler
only transitions `LogState` `loading → done`.

**Hypothesis H2.** A `running` element is *sufficient* to keep the loop
alive, and a `stopped` one costs nothing — i.e. the churn needs no second
cause.

**Experiment E2** (falsifiable: if a stopped panel also ticks, the run
state is not the gate). Two `PlotPanel` mounts, one per run state, both
left alone; `plotarea.resample` / `followwin.slide` deltas over 500 ms
after the mount's one-shot re-samples settle.

| trace state | resample Δ | slide Δ |
|---|---|---|
| `freshTrace(0)` (running) | > 0 | > 0 |
| `{start: 0, end: 60}` (stopped) | 0 | 0 |

H2 confirmed. Two intermediate readings refuted the *test*, not the
hypothesis, and are worth recording: a stopped panel is not quiet
immediately after mount (the build effect's pair of one-shot re-samples,
then the ~250 ms post-mount uPlot rebuild's pair), and jsdom delivers the
animation-frame half of each late — a trace of the stray call put it at
`PlotArea.tsx`'s post-build `requestAnimationFrame`, not at the loop. The
test waits for two consecutive quiet windows instead of a fixed settle.

**Attributed mechanism.** Import leaves every element running →
`live = true` → each `PlotArea` runs its `setTimeout` loop at
`plot_fetch_interval_ms` forever. The default is 67 ms ≈ 15/s per area,
so the recorded 28–30/s is two areas and the 14–16/s slide is the
per-frame `requestAnimationFrame` coalescing of both areas' reports —
the numbers are the mechanism, not an approximation of it.

**Fix.** `log-finished: ok` freezes every element, gated on the same
load state the `done` transition uses so a live session's pump exiting
(the event fires for that too, once per participant on a virtual bus)
freezes nothing.

Frozen at a count the event now carries. `trace-grew` is a ~10 Hz
sampler, so the count the frontend holds when the pump reports done is
up to a tick behind — tens of thousands of frames on a fast import — and
`reanchorToSession` clamps a window's `end` down to the session count,
which would make the short window permanent. `LogFinished::Ok` therefore
carries the store's own length beside `total`, and the handler sets the
session count from it in the same batch as the freeze. A second test
pins that: with the last tick at 4 and the event at 9, the by-id view's
`scanEnd` must come out 9. It reads 4 against a `countRef` implementation.

**Second half — the by-id / signal window scan.** No investigation owed
(attributed by task 75); fixed as scoped. `TraceStore::latest_in_window_where`
took its bounded-window path as one `raw.slice(start, end)` — a clone of
the whole window — plus the fold and the materialise, all under the inner
mutex. `useByIdView` / `useSignalView` pass `scanEnd = winEnd` whenever
the trace is stopped, so a stopped capture whose window stops covering
the tip paid that on every descriptor change, blocking `append`, every
other command, and the health sampler with it.

It now walks backward in `SCAN_CHUNK` (65 536) units through the existing
`TraceStore::scan_chunk`, taking the first occurrence it meets of each key
— going backward, the last one in the window — and stopping as soon as it
has as many distinct keys as the maintained per-key map has at or above
`start`. The mutex is taken per chunk, and the fold between chunks
happens with it released. Two store-seam tests: one walks a window
spanning three chunks with a key reachable only at index 0 and another
that exists only past the window's end; one asserts an appending thread
completes appends *during* the walk. Emulating the old whole-walk lock
hold fails the second with "no append completed while the window scan was
walking", and the first still passes — the lock hold was the defect, the
answer was always right.

**Not done, deliberately.** The frontend's `scanEnd = winEnd` rule is
unchanged: it is correct (a frozen snapshot must not show a frame that
arrived after its window), and with the walk chunked it is no longer
expensive in the way that mattered.

**CI:** seven jobs, all green — table in the phase report.

**Exit criteria.** All four met: mechanism attributed with E1/E2's data
above; a stopped capture holds both counters at zero and a running one
still ticks (`PlotPanel.dom.test.tsx`, "run state gates the self-paced
resample loop"); the import path ends in the state the element reports
(`App.importEndsStopped.dom.test.tsx`); the window scan is chunked and
tested at the store seam.

## Blockers / side effects

- **The host's `LogFinished::Ok { count }` has no Rust test.** The one
  line that reads it (`state.trace_store.len()` at the emit) is
  uncovered because the suite has no harness for the `AppHandle`
  `run_pump` needs — a gap `tests.rs` already documents at
  `an_out_of_order_blf_anchors_the_session_at_its_earliest_frame_and_keeps_every_one`.
  The frontend tests fake the event, so the *shape* is pinned on both
  sides but the *value* is not. Building that harness is its own piece
  of work.
- **The bounded-window walk's early exit is an upper bound, not an
  exact count.** A key whose occurrences all fall past the window's end
  counts as a candidate and is never found, so the walk runs to the
  window's start. Chunked, that costs lock time nothing, but a stopped
  window far behind a busy tip still pays a full O(window) walk on a
  descriptor change. Bounding it the way ADR 0049 bounds the pyramid
  catch-up would need a rule for what a key that is not found means.
- **Not reproduced here:** the `PlotPanel.dom.test.tsx` flake task 125
  is open on ("panel-local state" — one extra render) stayed green
  across three full frontend runs on this tree.
- **Not verified in the running app.** The change is on the import
  path, which needs a click to start; no UI automation, and no
  installer was built (both standing constraints on this phase). The
  ADR 0031 harness was not run either — it is under repair.

