# Task 104 — Real Load Progress, and Cancel That Can Be Found

> **Status 2026-08-23 — code-complete, awaiting acceptance.** Landed
> 2026-08-21 on the chain (nothing has merged). The five exit criteria are
> walked in the status log, all met. Findings still owed a verdict:
> owner-review-queue 3.11 and 3.12.

Opened by owner instruction 2026-08-20, while reviewing the status-bar
prototype:

> number of frames/progress on BLF and cache reload would be nice; we
> walk both on load so we actually already paid the tax for reporting a
> real progress.
>
> I wanna add a cancel button on the blf load; that doesn't seem like it
> should be a heavy enough lift that we need to do much grooming on it,
> but I would accept another task on our current stack.

**These are one task, not two.** Grooming found the same missing
mechanism under both: a cooperative checkpoint inside the census walk.

## What is actually true today

Loading a file has **two phases**, and the app treats them as one
indeterminate wait — a single sliding `.trace-scan-bar` chip.

### Phase 1 — census (`scan_blf_channels` → `cannet_blf::scan_blf`)

Walks the whole file to discover its channels, frame count, timestamp
bounds and markers. **Not cancellable, for a stated reason**
(`App.tsx`, `handleImportTrace`):

> the census phase stays plain-disabled, unchanged, since there's no
> cooperative checkpoint to cancel it at (a single opaque file walk,
> not a per-frame loop).

The launcher is `disabled: true` during it.

### Phase 2 — import (the pump)

**Already cancellable.** `state.kind === "loading"` routes a click on
the launcher to `invoke("cancel_import")`. The button is `busy` but not
disabled, and clicking it cancels.

## The two findings that shape the work

**1. Cancel is half-built and unfindable.** The import half exists and
works; it is spelled as "click the button that looks like it is doing
something and is greyed-ish". A user cannot discover that, which is
functionally the same as not having it. The task is therefore *give
cancel a real affordance*, not *build cancel*.

**2. Progress and census-cancel are the same change.** Both need
`scan_blf` to stop being a single opaque call and yield periodically —
a checkpoint that can report "bytes read so far" is a checkpoint that
can observe a cancel flag. Doing one and not the other would be
building the mechanism twice.

## What determinate progress can honestly be

The owner's point holds, with one refinement worth stating because it
changes the implementation:

| phase | denominator | known when? |
|---|---|---|
| census | **file size in bytes** | before the walk starts |
| import | **`scan.frame_count`** | after the census, exactly |
| cache rebuild | series and their sample counts | before the rebuild starts |

The census's total is *not* known in frames — discovering the frame
count is what the census is for — so it reports against bytes. The
import reports against frames, and `BlfScanResult::frame_count` already
carries the number. That is the tax already paid.

## Scope

- A **cooperative checkpoint in the census walk**: periodic progress
  (bytes read / total) and a cancel check. Cheap enough not to slow the
  walk measurably — measure it, since the census is on the critical
  path of every import.
- **Determinate progress** for census, import and cache rebuild,
  replacing the indeterminate chip in each case. The indeterminate chip
  stays for anything whose length genuinely is unknown.
- **A real Cancel affordance** for both phases, not a second meaning
  overloaded onto the launcher — an explicit button beside the progress
  bar, in the status bar task 103 built (`StatusBar.tsx`'s `notices`).
- The MDF counterpart (`scan_mdf_channels`, the "same one-pass-over"
  sibling of `scan_blf_channels`) gets the same treatment, or is
  recorded with the reason it cannot.
- Cancelling must leave **no partial capture** behind — confirm what
  `cancel_import` already guarantees rather than assuming, and pin it
  with a test.

## Open questions — grooming

- **How often should the checkpoint fire?** Too frequent costs walk
  throughput on the critical path; too rare makes cancel feel dead.
  Pick from a measurement of the walk's own rate, not a guess.
- **Does cancelling a census differ from cancelling an import?** A
  cancelled census has produced nothing and can simply stop. A
  cancelled import has frames in the store already — today's
  `cancel_import` has an answer; this task should state it rather than
  inherit it silently.
- **Is per-series or per-sample right for the cache rebuild?** "7 / 31
  series" is honest but lumpy when one series is far larger than the
  rest.

## Exit criteria (draft — firm at grooming)

- Census, import and cache rebuild each show determinate progress
  against a stated denominator.
- Both load phases can be cancelled from a control that looks like a
  cancel control; tested.
- The census checkpoint's cost is measured, not asserted.
- Cancelling leaves no partial capture; tested.

## Status log

### 2026-08-21 — (branch `task-104-load-progress-cancel`)

Branched from `task-105-unfinalized-blf` (`36a35359`).

Commits, in order:

| hash | subject |
| --- | --- |
| `5186d389` | A BLF census walk can be stopped, and says how far it has got |
| `9d8730d9` | An MDF census walk can be stopped, and says how far it has got |
| `c5811b9f` | Loading a capture shows how far it has got, and has a Cancel button |
| `e06afb62` | Rebuilding a restored capture's signal caches shows how far along it is |
| `a87cfce0` | A cancelled import applies none of what its walk collected |

#### What cancel already was, and what was missing

The framing above holds. `AppState::import_cancel` is the whole
mechanism: an `Arc<AtomicBool>` the import command installs before
spawning its pump, `run_pump`'s loop reads once per frame, and the
thread clears when it ends. That is the repo's one cancellation shape
(`remote_sessions`'s per-session `stop` flag is the same), and it is
reused rather than joined by a second one — the census now installs a
flag into the same slot, so `cancel_import` stops whichever phase is
running. The phases are sequential and only one trace open runs at a
time, so the slot never holds two.

What was missing was in three places, not one:

1. **The census could not be cancelled at all** — no checkpoint. Now
   `scan_blf_cancellable` / `scan_mdf_cancellable`.
2. **Cancel had no affordance.** It was a click on the busy launcher.
   It is now a `Cancel` button beside the progress bar, covering both
   phases, and the launcher went back to meaning one thing.
3. **A cancelled import kept working after it stopped.** See below.

#### The checkpoint's cost, measured

*Observation.* A census walk over a 2 000 000-frame BLF (11.3 MB) ran
at 75.6 ns/frame (min of 15 runs) before any change. The checkpoint
adds a decrement and a compare per object; that is around 1 ns, and the
run-to-run spread on this machine is ±20 %. **A before/after comparison
across two builds cannot resolve it** — the first attempt, on the MDF
side, showed +1.9 ns/record between two separate processes and the
in-process interleave later put the same change at +0.07.

*Hypothesis.* The checkpoint's per-object cost is below the harness's
resolution, and the harness's resolution can be established by giving
it a cost it is known to be able to see.

*Experiment.* Four arms over one file, in one process, interleaved so
drift hits all of them equally: **A** no checkpoint, **B** the shipped
stride (16 384), **C** the checkpoint on *every* object, **D** every
object plus an `Instant::now()` — the calibration arm, whose cost is
known to be tens of nanoseconds. If D is invisible the harness proves
nothing about B. Throwaway probes, deleted after the run.

*Data* (min of 11–15 interleaved runs, release):

| arm | BLF, ns/object | MDF, ns/record |
| --- | --- | --- |
| A — no checkpoint | 69.5 | 41.27 |
| B — stride 16 384 (**shipped**) | 70.9 | 41.34 |
| C — every object | 70.1 | 45.19 |
| D — every object + a clock read | 154.8 | 124.87 |

*Conclusion.* The calibration arm is unmistakable (+85 ns on both), so
the harness resolves single-digit nanoseconds. Against it, arm C — the
checkpoint fired on *every* object — costs +0.6 ns on the BLF walk and
+3.9 ns on the MDF one (the MDF checkpoint sums chunk lengths, the BLF
one reads a field). The shipped stride divides that by 16 384: +0.07
ns/record measured on the MDF side, and on the BLF side B lands within
noise of A, occasionally *below* it. **The checkpoint is free at the
stride it runs at.** `scan_blf` end to end after the change: 75.4 ns
min, against the 75.6 ns pre-change baseline.

The import pump's added work is one `Option` branch, one decrement and
one compare per frame. Measured over a 1 000 000-frame BLF through a
real `WindowedSource` and a real disk-backed `TraceStore` (min of 9
interleaved runs): **A** none 824 ns/frame, **B** shipped 806 ns/frame,
**C** a clock read every frame 931 ns/frame. This harness is much worse
than the census one — the store append dominates and brings disk noise
with it, so even the calibration arm is barely above the spread — and
its honest reading is only that the addition is far below a per-frame
cost of ~1 µs. The census measurement above is what pins the construct
itself.

#### Checkpoint stride: 16 384

Chosen from the walk's own rate, not guessed. The census runs at ~14 M
objects/s on a warm BLF and ~24 M records/s on an MF4, so the stride is
~1 ms of cancel latency there and stays inside a frame's worth even on
a walk an order of magnitude slower. The pump's cancel check is
unchanged at once per frame; its stride only governs how often progress
is worth reporting.

#### Emission rate: `live_update_interval_ms` (100 ms, 10 Hz)

Not a new number. `trace-grew` already runs the status line at that
cadence, and "how often may the status line change" is the same
question asked about a different figure; surfacing a second knob would
invite a combination neither was tuned for. The checkpoints fire
thousands of times a second — which is what makes the cancel land
promptly — and `ProgressPacer` lets one report through per period. At
10 Hz a percentage reads as continuous and a frame counter as live,
three orders of magnitude below the checkpoint rate.

The cache rebuild is polled, not pushed, at its existing 1 Hz: the
answer is where the decode cursors have reached and no single moment in
the host corresponds to it. Left as it was.

#### Denominators

- **Census — bytes.** Discovering the frame count *is* the census, so
  frames are not a total it knows before it starts; the file's length
  is. `BlfReader` now tracks bytes pulled off disk, advancing a whole
  top-level record at a time. The MDF walk reports record-stream bytes
  derived from the resolved data blocks — deliberately **not**
  `cg_cycle_count`, which is exactly the field an unfinalized writer
  leaves stale.
- **Import — frames**, and the count travels with the request
  (`open_log`/`import_mdf` gained `total_frames`). The numerator is
  frames *read from the source*, not appended:
  `CanFrameSource::frames_read` (defaulted to `None`, so live sources
  are untouched) counts what `WindowedSource` pulled in. Comparing
  appended frames against a whole-file count would make every windowed
  or channel-filtered import stall part-way and never finish.
- **Cache rebuild — frames decoded across the pyramids being rebuilt.**
  This answers the grooming question the other way round from how it
  was posed: there is no series "far larger than the rest", because
  every pyramid re-decodes the same store. Counting finished pyramids
  would sit still and then jump.

A phase with no denominator emits nothing and the chip stays
indeterminate: a live session's pump, an empty file, and a rebuild owed
before any plot has served (no cache exists yet to have a cursor).
`loadProgressReadout` returns `null` for all three rather than drawing
a bar at zero, which would claim a measurement nobody has made.

#### What a cancel unwinds — and the defect that turned up

The two phases differ, as grooming expected, but the import side was
not as clean as "today's `cancel_import` has an answer" implied.

- **A cancelled census unwinds nothing** because it produced nothing.
  Its command returns `null`, the frontend drops the gesture, no
  dialog opens. Confirmed by
  `a_cancelled_census_reports_nothing_and_clears_the_flag` (and its MDF
  twin), with
  `an_uncancelled_census_reports_the_whole_file_and_clears_the_flag` as
  the control that keeps the assertion about the cancel.
- **A cancelled import's frames are in the store, and the frontend
  clears them.** The pump exits through the same clean path an EOF
  takes, so the frontend — the only side that knows it asked — treats
  the next `log-finished` as an abandonment and runs the same clear a
  fresh open runs. Pinned by
  `cancels the running import from the Cancel button, cleans up, …`,
  now with a control (`leaves the capture alone when the import is let
  run to its end`) so "a cancel clears" is not satisfied by every load
  clearing.
- **Defect found: it did not stop there.** Everything an import gathers
  *alongside* the frames is applied after the pump, because none of it
  is fully known until the walk ends — a BLF's `GLOBAL_MARKER` notes,
  an MDF's file-backed signal series. By then the frontend has seen
  `log-finished` and is clearing. For BLF that is a narrow race; **for
  MDF it is a certainty**, because `fill_file_backed_signals` starts
  after the pump has announced it finished and takes as long as the
  content is big — so cancelling a large MDF import stopped the frames
  and then went on building signal caches for a capture the user had
  just discarded. Both threads now stop at that point
  (`import_was_cancelled`). What they ask is the flag clone they kept,
  not the slot in `AppState`, which the pump empties the moment its
  loop ends; a guard reading the slot would never fire, and
  `an_import_is_still_known_to_have_been_cancelled_after_its_slot_is_cleared`
  is what holds that.

#### Exit criteria

| criterion | verdict | earned by |
| --- | --- | --- |
| Census, import and cache rebuild each show determinate progress against a stated denominator | **met** | `census_progress_is_bytes_read_against_the_files_length` (BLF), `census_progress_is_record_bytes_walked_against_the_walks_own_total` (MDF), `frames_read_counts_what_the_window_pulled_in_not_what_it_let_through`, `a_cold_rebuild_reports_frames_decoded_across_the_pyramids_it_is_rebuilding`, `loadProgressReadout` (5 cases), and the three DOM tests that draw them (`shows the census as a fraction of the file…`, `shows the import as frames against the count the census returned`, `shows how far along the rebuild is once the host says`) with `stays indeterminate while the host has nothing to measure` as the control |
| Both load phases can be cancelled from a control that looks like a cancel control; tested | **met** | `stops a census that is still walking, and opens no mapping dialog` and `cancels the running import from the Cancel button, cleans up, and leaves a later open working`, both clicking `.trace-load-cancel`; controls `opens the mapping dialog when the census is let finish` and `leaves the capture alone when the import is let run to its end` |
| The census checkpoint's cost is measured, not asserted | **met** | the four-arm interleaved probes above, with a calibration arm that discriminates; numbers in the table |
| Cancelling leaves no partial capture; tested | **met** | frames: `cancels the running import…` (the clear runs) with its control; side content: `an_import_is_still_known_to_have_been_cancelled_after_its_slot_is_cleared` and `an_import_nobody_cancelled_is_not_treated_as_abandoned`; the census half: `a_cancelled_census_reports_nothing_and_clears_the_flag` |
| The MDF counterpart gets the same treatment, or is recorded with the reason it cannot | **met, same treatment** | a probe put the record walk at 89 % of the MDF census's wall clock and the whole-file read at 11 %, so checkpointing the walk is checkpointing the census; the 11 % prologue is uninterruptible and says so in `scan_mdf_cancellable`'s docs |

#### Counts

`cargo test -p cannet-gui` 853 → 862 passed, 6 ignored. `cargo test
--workspace` 0 failures. `pnpm vitest` 2513 → 2525 passed / 190 files.
`cargo clippy --workspace --all-targets` clean but for the pre-existing
`redundant_closure` in `crates/cannet-dbc/src/tests.rs`.

## Blockers / side effects

- **`scan_blf_channels` and `scan_mdf_channels` now return `null` for a
  cancelled census.** A wire-shape change: the frontend reads `null` as
  "the gesture was dropped" rather than as an error, since a cancelled
  census is neither a result nor a failure.
- **`open_log` and `import_mdf` gained a `totalFrames` argument.** The
  census's own count, handed back so the pump has a denominator. It is
  optional; without it the import runs and reports no progress.
- **`signal_pyramids_rebuilding` returns a record, not a bool.** The
  still-rebuilding fact plus `decoded` / `total`.
- **The MDF census's first ~10 % is not covered and cannot be
  cancelled.** `Mdf4File::open` reads the whole file and walks its block
  graph in one uninterruptible call, so a cancel raised during it lands
  when that finishes. Recorded rather than fixed: interrupting it means
  restructuring the reader around a chunked read, which is a change to
  how every MDF is read for the benefit of a fraction of one phase's
  wait.
