# Task 86 — Usage Feedback: Import Time Origins, Enum Overlays, Events-Panel Width

Four observations from owner use of 0.8.1 / 0.9.0-dev, opened
2026-08-18, and first on the roadmap: every one of them has been seen
in the wild. They are unrelated to each other; they are collected here
(rather than scattered into `plans/backlog.md`) because each is a
user-visible defect report that needs reproduction before it needs a
fix. Except where an owner observation is quoted, the "candidate" lines
below are hypotheses from a code read, not attributed causes.

## Items

1. **The events panel clips its rename / remove controls, and the row
   cannot be scrolled to.** Owner observation: the panel was docked as
   a **narrow vertical** window; the ✎ / × controls were off the right
   edge of the row, **and horizontal scrolling would not reach them**.
   That second half is the sharper clue — the controls are not merely
   unrendered, they are outside a scroll extent that does not account
   for them.

   What the row is made of:
   [`TraceView.tsx:850-955`](../../apps/gui/src/TraceView.tsx#L850-L955)
   renders `.trace-event-row` as a flex row — time, goto, swatch,
   label, ✎, ×; the CSS
   ([`index.css:2092-2245`](../../apps/gui/src/index.css#L2092-L2245))
   gives the row `white-space: nowrap`, the label
   `flex: 0 1 auto; min-width: 0; overflow: hidden` and both buttons
   `flex: 0 0 auto` with `margin-left: auto`. On that reading the label
   should ellipsize and the buttons should survive any width — so
   something is stopping the row from being laid out at the width the
   user can actually reach.

   Candidate: the virtualized rows are absolutely positioned with
   `left: 0; right: 0` inside the scroller
   ([`TraceView.tsx:855-857`](../../apps/gui/src/TraceView.tsx#L855-L857)),
   which resolves against the scroller's **padding box** — its client
   width — not its scroll width. An absolutely positioned row also
   contributes nothing to the scroll extent, so whatever else makes the
   scroller scrollable, the row still ends at the viewport edge and its
   tail is unreachable by scrolling. That is exactly the observed
   shape. `EventsPanel` passes `columnsFromParams(undefined)` and
   `showHeader={false}`
   ([`EventsPanel.tsx:41-71`](../../apps/gui/src/EventsPanel.tsx#L41-L71)),
   so find what sets a width in an events-only panel at all.

   Second candidate is the gridview interaction base (ADR 0044) sizing
   the row; the owner's note was "either not on gridview, or gridview
   still has problems". Settle first *whether* these rows go through
   the gridview row contract, and say so in the panel's doc comment
   either way.

   Exit: a failing DOM test at a narrow panel width that shows the
   controls unreachable — asserting both rendered position and scroll
   extent, since scrolling to them is the half that failed — then the
   fix.

2. **Imported captures render negative timestamps; import time origins
   need one rule across formats.** Owner observation is on **BLF**
   imports, seen "generally". MDF is named here not because a defect
   was seen on it but because it is the other import path that can
   carry a start time: whatever rule this task settles has to be the
   same rule on both, and an MDF that states a start timestamp must
   have it honoured.

   The owner's ruling: an import either takes its origin from the
   file's own metadata or zeroes it out — consistently, per format.

   ADR 0024's invariant is that rendered time is never negative;
   [`0025-can-hw-vbus-bugfixes.md`](0025-can-hw-vbus-bugfixes.md)
   already owns the *post-clear live-capture* violation of it. This
   item is the **import** trigger and is a separate defect; whichever
   lands second should re-check the other's reproduction.

   What "relative to what" means on each path today:
   - **BLF.** Each object header carries an `object_timestamp` that is
     an **offset from the file header's `measurement_start_time`**, in
     units named by `object_flags` (nanoseconds, or 10 µs ticks scaled
     by 10 000 —
     [`format/object.rs:186-246`](../../crates/cannet-blf/src/format/object.rs#L186-L246)).
     The reader adds the two to get an absolute UNIX-ns stamp
     ([`lib.rs:69-141`](../../crates/cannet-blf/src/lib.rs#L69-L141)).
     A file whose header carries the all-zero "unset" sentinel
     therefore yields stamps that are offsets from zero — an absolute
     time in 1970.
   - **MDF.** `hd_start_time_ns` is already added to every master
     sample and every `##EV`
     ([`signals.rs:149`](../../crates/cannet-mdf/src/signals.rs#L149),
     [`events.rs:64`](../../crates/cannet-mdf/src/events.rs#L64)), so
     this path looks like it already does the right thing — confirm
     that with a test rather than changing it.
   - **Session origin.** A replay import takes the session start from
     the **first frame the pump appends**
     ([`session.rs:900-920`](../../apps/gui/src-tauri/src/session.rs#L900-L920));
     a signal-only MDF import takes it from the earliest sample in
     range (`signal_origin_ns`,
     [`capture.rs:1240-1252`](../../apps/gui/src-tauri/src/capture.rs#L1240-L1252)).

   Candidates for the negatives: (a) **BLF objects are not guaranteed
   chronologically ordered**, so a later object with a smaller stamp
   lands before the session start the first frame set, and every
   downstream reader renders it negative — note the census assumes
   order too, taking `first` / `last` in file order rather than as
   min / max
   ([`scan.rs:96-129`](../../crates/cannet-blf/src/scan.rs#L96-L129)),
   so the same assumption is already load-bearing in the import
   dialog's range fields; (b) markers / notes read from the census
   carry absolute stamps that can precede the first frame; (c) an
   import into a session whose start came from somewhere else
   (restore, a previous capture, wall-clock via `clear_trace_store`)
   never re-anchors — cross-check with
   [`0079-restore-then-import.md`](0079-restore-then-import.md).

   Exit: one stated rule for where an imported capture's origin comes
   from, written into ADR 0024 (or a new ADR if it is a new decision),
   applied identically on both format paths, with a regression test per
   format asserting no rendered timestamp is negative — including the
   unset-header and out-of-order-object cases.

3. **Enum overlays do not consistently render.** Reopening a project
   last saved by 0.8.1 under 0.9.0, one enum lane stayed numeric until
   the view was closed and reopened.

   Candidate: `useValueTables`
   ([`useValueTables.ts:42-95`](../../apps/gui/src/useValueTables.ts#L42-L95))
   keys its fetch effect on the **signal set** alone. Nothing re-runs
   it when the DBC set changes — no `dbc-changed` subscription, no
   value-table epoch — so a panel that mounts and fetches before its
   project's DBCs are installed caches "no table" for the whole session
   and only recovers when the signal list changes or the panel
   remounts. That matches "close and reopen the view fixed it"
   exactly, and it would apply to every `useValueTables` consumer
   (`PlotPanel`'s panel-level enum detection, `PlotArea`'s readout,
   `ColorMapPanel`, transmit, RBS) — so "not consistently everywhere"
   is the predicted shape, not a coincidence.

   Note the ordering dependency: `add_dbc` does **not** emit
   `dbc-changed`
   ([`dbc_commands.rs:108-142`](../../apps/gui/src-tauri/src/dbc_commands.rs#L108-L142));
   only the watcher reload and MDF import do. Whatever invalidation
   this item adds has to cover the plain project-open path too.

   **Related items found scrubbing the plans (owner ruling
   2026-08-18) — same family: who gets told that labels changed.**
   - [`0027-project-rbs-disk-watch.md`](0027-project-rbs-disk-watch.md)
     already owns a DBC propagation gap: an auto-reload fires and
     emits `dbc-changed`, but an edited `VAL_` value *name* does not
     reach the RBS or plot views; its leads are `RbsPanel` listening
     for `rbs-changed` only, and `reload_one` not clearing
     `state.signal_caches`. Task 27 calls that propagation contract
     "the reference for the project / RBS watches" — so this item
     should **settle the contract**, and task 27 consume it rather
     than re-derive one. Decide at grooming which task carries the
     fix.
   - [`0081-bus-scoped-decode.md`](0081-bus-scoped-decode.md) owns
     `list_value_tables` taking no `bus_id`: two buses whose DBCs
     define the same `(message_id, signal_name)` share whichever table
     answered first. Different bug, same command — a fix here that
     changes the call shape should land after, or with, that scoping.

   Exit: a test that mounts a value-table consumer before the DBCs are
   installed and asserts the labels appear once they are, the
   invalidation wired for every consumer, and the propagation contract
   written down where task 27 can cite it.

4. **"Signal rebuild doesn't always happen on DBC load" — and the
   design question behind it: what survives replacing a DBC?**
   Reported on 0.8.1; the owner notes (2026-08-18) it is unclear
   whether the DBC was being *replaced in the project* or *modified on
   disk* — different paths, so the first job is to pin down which was
   seen. Verify-first either way: 0.9.0-dev landed substantial work
   here, so establish whether the symptom still reproduces and record
   the reproduction regardless.

   The three paths to separate:
   - reload in place — same path, `add_dbc` with `reloaded = true`;
   - the on-disk watcher reload (`dbc_watcher::reload_one`, the one
     that emits `dbc-changed`);
   - replace — a different file added, the old one removed.

   Host side already invalidates on install (`install_dbc` →
   `invalidate_derived_caches`,
   [`app_state.rs:304-318`](../../apps/gui/src-tauri/src/app_state.rs#L304-L318)),
   and the rebuild is lazy by design (ADR 0049 — nothing decodes until
   a view asks), so a "no rebuild" report is as likely to be a *view
   not re-asking* as a cache not invalidating. Item 3's missing
   invalidation is one concrete instance of that shape; check whether
   they are the same bug before splitting the work.

   **The design question (owner, 2026-08-18): if an existing DBC is
   replaced with one that is mostly the same, do the signal and plot
   configs survive — and do the caches?** ADR 0047's per-signal
   encoding fingerprint says the cache half *should*: a DBC-backed
   pyramid is judged over its signal's candidate chain — start bit,
   length, byte order, sign, factor, offset, float kind, mux arm, the
   message's mux gate, bus scoping — so a signal whose encoding is
   unchanged keeps its pyramid, only genuinely changed signals
   rebuild, and the retention pool covers a definition that goes away
   and comes back. That is the conceptual answer, and it is untested
   against an actual replace-with-a-near-identical-DBC. The
   view-config half — which signals are plotted, their colors, axes,
   RBS bindings, all keyed by signal identity rather than by encoding
   — is a separate question with its own answer. Both belong in this
   item.

   Exit: the three paths distinguished and the reported one named;
   reproduction recorded; a test that replaces a loaded DBC with a
   near-identical copy and asserts (a) unchanged signals keep their
   pyramids, (b) changed signals rebuild, (c) plot / signal / RBS
   configs still resolve — with whatever falls out of that fixed, or
   recorded here as the owner's accepted behavior.

## Exit criteria (draft — firm at grooming)

- Each item is reproduced and fixed with a test, or explicitly ruled
  out / deferred by the owner at grooming with the verdict recorded
  here.
- Item 2 leaves a written rule (ADR-level) for import time origins,
  not just a patched call site, and its relationship to task 25's
  live-capture negatives is stated.
- Item 3 leaves the DBC-change propagation contract written down, and
  task 27's overlapping item is either folded in or explicitly left to
  task 27 with a pointer.
- Items touching render- or data-path behavior pass the ADR-0031 gate.

## Grooming notes (2026-08-19)

Grilled with the owner ahead of implementation. Resolutions:

1. **Import time origins: honour the file's wall clock, fall back to
   zero.** When the file states a start time (BLF
   `measurement_start_time`, MDF `hd_start_time_ns`) the capture keeps
   absolute wall-clock timestamps; when it is the unset sentinel or
   absent, the capture is anchored at zero and reads as relative. One
   rule, both formats.

2. **Reproduce before fixing, with real files.** The phase generates a
   small DBC plus BLF and MF4 fixtures that actually produce the
   negative timestamps (owner has seen them at least in the plot), and
   lands them as test fixtures / examples — the regression is pinned
   by files, not by synthetic in-memory frames.

3. **The session origin is the earliest timestamp in the imported
   range.** Today it is the timestamp of the first frame the pump
   appends, which assumes the file is chronologically ordered; BLF
   does not guarantee that, and the census makes the same assumption
   for its first/last range. The census already walks the whole file,
   so it reports min/max at no extra cost and the pump anchors to
   that — out-of-order objects then cannot produce a negative. If the
   reproduction in note 2 shows a different mechanism, the fix follows
   the data.

4. **Item 4 (what survives a DBC replace) is investigation plus a
   pinning test, not a feature.** Separate the three paths (reload in
   place, watcher reload, replace), reproduce the 0.8.1 report, and
   add a test that swaps a loaded database for a near-identical copy
   asserting unchanged signals keep their caches, changed ones
   rebuild, and plot / RBS configs still resolve. Small defects are
   fixed in the phase; anything structural becomes its own task, with
   the data to justify it.

5. **The DBC-change propagation contract belongs to task 27, which
   comes into scope with this work.** Item 3's missing invalidation
   and task 27's recorded `VAL_`-rename gap are one hole — nothing
   tells the views that labels changed — and fixing one consumer while
   the other stays broken is how it drifted. Task 27 owns the
   contract and its ADR; this task's item 3 is a consumer of it.
   Sequence: 81, then this task, then 27.

## Phases

1. **Item 2 — import time origins.** Reproduce with generated
   fixtures, then the origin rule and the census min/max, both
   formats, ADR 0024 amended (or a new ADR if the rule is new).
2. **Item 1 — events-panel controls.** Failing DOM test at a narrow
   width asserting both rendered position and scroll extent, then the
   fix.
3. **Item 3 — enum overlays.** The consumer half: every
   `useValueTables` consumer refetches when the DBC set changes.
   Gated on task 27's contract if that lands first; otherwise this
   phase states the contract task 27 then adopts.
4. **Item 4 — DBC replace.** Investigation and the pinning test per
   note 4.

## Status log

### 2026-08-19 — Phase 1 (item 2, import time origins)

Branch `task-86-phase-1-import-time-origins`, off
`task-81-phase-2-bus-scoped-value-tables`.

#### Investigation

**Observation 1 (fixtures).** `examples/cannet-demo.blf` and
`examples/extrapolation/extrapolation.blf` both carry the all-zero
"unset" `SYSTEMTIME` as `measurement_start_time`, and both start at
absolute timestamp exactly 0 (measured by walking them with `scan_blf`
and `BlfCanFrameSource`). `examples/cannet-demo.mf4` states
`hd_start_time_ns = 1709294400000000000`, and every frame, sample and
`##EV` in it is at or above that.

**Hypothesis 1.** A BLF whose first frame lands at absolute 0 anchors
the session at `session_start_ns == 0`, which the frontend reads as "no
origin at all", and every renderer then substitutes an origin of its
own.

**Experiment 1.** Traced the reported value through the host and the
frontend. `emitters.rs` sent `session_start_seconds = 0.0`; `App.tsx`
mapped it with `session_start_seconds > 0 ? … : null`;
`useDecimatedRange.ts:306` resolves `req.origin ?? res.from_seconds`.

**Data 1.** With `origin: null` the plot's cache latches its base to
`res.from_seconds` — the *window's* first frame — and every sample,
span, note and axis tick is rendered against that. The trace table
(base `null` → raw seconds) and the plot then disagree about the same
instant, and any content to the left of the window's first frame
renders negative.

**Conclusion 1.** Confirmed, and it is the "generally" the owner sees:
it needs no unusual file, only a capture-relative BLF — which is what
`python-can`'s `BLFWriter` produces, and what both of this repo's own
example BLFs are. This is candidate (c) in a sharper form: not "an
import into a session whose origin came from elsewhere", but *an import
whose origin was discarded* for being falsy. Fixed by making the wire
carry `Option<f64>` and the host answer it from
`TraceStore::session_started`.

**Hypothesis 2** (candidate (a) in the item above). Out-of-order BLF
objects land before the origin the first frame set and render negative.

**Experiment 2.** Generated `wall-clock-out-of-order.blf` (earliest two
frames written at the *end* of the file) and drove the pump body over
it with the first-frame anchor.

**Data 2.** 121 frames read, **119 appended**. They do not render
negative: `TraceStore::append`'s pipeline-drain guard drops any frame
stamped before `session_start_ns`.

**Conclusion 2.** The mechanism is real but the symptom is *silent data
loss*, not a negative time. Recorded as its own finding; the same fix
(anchor at the minimum) covers both. The census made the same ordering
assumption and reported the file's span inverted (first +500 ms, last
+300 ms) — that is what the import dialog's range fields were reading.

**Hypothesis 3** (candidate (b)). Annotations carry stamps that precede
the first frame and render negative.

**Experiment 3.** Same fixture, marker at +100 ms against an earliest
frame of +120 ms; and `wall-clock-signals.mf4`, whose signal group
starts 500 ms and whose first `##EV` sits 400 ms below the first
`CAN_DataFrame`.

**Data 3.** Notes and file-backed samples are not subject to the buffer
guard — nothing drops them — so they render at `ts − session_start` < 0.
Confirmed on both formats.

**Conclusion 3.** Confirmed. Grooming note 3's ruling ("the earliest
timestamp in the imported range") is right, and has to range over events
and file-backed signals, not only frames.

Relationship to [`0025-can-hw-vbus-bugfixes.md`](0025-can-hw-vbus-bugfixes.md):
that task's negatives are a *live-capture* symptom on repeated toolbar
Clear, attributed there to a non-null frontend
`traceStartOffsetSeconds` on restored panels. Different trigger,
different layer; nothing here touches it, and its reproduction should be
re-checked against this branch, since ADR 0024 now also forbids a
renderer substituting an origin of its own.

**Departure from the ruling, recorded.** Grooming note 3 says the census
reports min/max and the pump anchors to that. Implemented as the pump
tracking the minimum itself (`session::anchor_replay_session` plus
`TraceStore::lower_session_start`) rather than consuming a census
result: `open_log` / `import_mdf` are handed a range, not a census, and
re-walking the file inside the import to obtain one would double the
ingest cost on the path this phase's perf gate covers. The census
min/max landed anyway, because the import dialog's range fields read it.
Same outcome, no second walk.

#### What landed

| Commit | Subject | Tests |
|---|---|---|
| `65207a54` | Add the import-time-origin fixture set | — |
| `fd555a1d` | The BLF census reports the min and max of its walk, not first and last | +1 (`cannet-blf`) |
| `30ba6d98` | An import's session origin is the earliest timestamp it brings in | +5 (`cannet-gui`) |
| `07f33d4b` | A session origin of zero is an origin, and the wire now says so | +2 (`cannet-gui`), +1 (frontend) |
| `d86ccf33` | Write the import time-origin rule into ADR 0024, pinned per format | +1 (`cannet-blf`), +1 (`cannet-mdf`) |

Suite totals after the phase: `cannet-blf` 109, `cannet-mdf` 19 (lib)
plus 29 (integration), `cannet-gui` 717, frontend 2235 across 165 files.
`cargo clippy --workspace --all-targets -- -D warnings` clean on every
commit (the pre-commit gate ran it).

**Fixtures** — `examples/time-origins/`, ~19 kB total, openable by hand
and documented in its own README: `time-origins.dbc`,
`relative-zero.blf` (unset header, frames from 0),
`wall-clock-out-of-order.blf` (stated start, objects out of order,
marker before the first frame), `wall-clock-signals.mf4` (stated start,
signal group and event before the first frame). Generated by two
committed Rust examples (`cargo run -p cannet-blf --example
gen_time_origin_fixtures`, likewise for `cannet-mdf`) using cannet's own
writers, so regenerating needs no Python. Committed as binaries *and* as
generators: the owner asked to be able to open them, and the tests in
three crates address them by path.

#### ADR-0031 perf gate

Two release runs on the real rig (`pnpm --dir apps/gui tauri build
--no-bundle`, then `target/release/cannet-gui` with `--project <abs
ev-zonal.cannet_prj> --app-data-dir <the operator's seeded perf app-data dir>
--connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both connected —
`ids_measured` 173, rx 1608.5 / 1603.1, tx 1612.2 / 1607.6, 59.0 s each
— so neither is the empty-capture failure mode.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed on both runs, 30 metrics gated.**
No baseline promoted or edited.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 0.000 | 0.000 | 0.000 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 3.300 | 4.400 | 4.400 | 41.000 |
| jank_fraction | 0.000 | 0.000 | 0.000 | 0.000 | 0.050 |
| jsheap_mb_peak | 70.300 | 71.700 | 70.300 | 71.700 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 6.522 | 5.503 | 6.522 | 24.094 |
| renderer_mb_peak | 299.363 | 300.098 | 301.020 | 301.020 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 42.958 | 33.946 | 42.958 | 85.336 |
| host_mb_peak | 59.227 | 58.602 | 58.344 | 58.602 | 182.453 |
| tree_mb_peak | 714.051 | 711.926 | 713.004 | 713.004 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 73.787 | 64.839 | 73.787 | 139.240 |
| flush_ms_mean | 25.000 | 4.145 | 4.263 | 4.263 | 25.000 |
| flush_ms_max | 23.772 | 9.999 | 10.953 | 10.953 | 72.544 |
| tx_late_ms_mean | 18.000 | 5.755 | 5.587 | 5.755 | 18.000 |
| tx_late_ms_max | 65.695 | 25.730 | 16.820 | 25.730 | 156.391 |
| rx_gap_p95_ratio_worst | 1.199 | 1.142 | 1.146 | 1.146 | 2.898 |
| rx_gap_short_frac_worst (advisory) | 0.008 | 0.004 | 0.004 | 0.004 | 0.046 |
| rx_fps_retention | 0.998 | 0.998 | 0.997 | 0.997 | 0.800 |
| tx_fps_retention | 1.001 | 1.000 | 1.000 | 1.000 | 0.800 |

Means across the two runs sit between the per-run figures above in every
row; nothing straddles a limit. The three host modes (`tracebuffer`,
`grpc`, `hardware-peak`) re-ran as part of `check` and passed on both.
`rx_gap_short_frac_worst` is advisory per ADR 0031's 2026-08-19
amendment and came in at half the baseline, so there is nothing to
chase.

One abandoned run before run 1: `perf automation: connect preconditions
not ready after 30000ms (bindings=2, sidecar=not ready)`, with the
sidecar visibly listening in the same log 30 s earlier. No report was
written and the launch was simply repeated. Flagged as the
sidecar-readiness flake, not a result.

Reports were not committed (nothing under
`docs/performance-measurements/frontend/` is tracked); they are at
`task86-phase1-run{1,2}.json` in the operator's seeded perf app-data dir
(outside the repo).

## Blockers / side effects

- **`BlfCaptureWriter` clamps an out-of-order frame's timestamp** (found
  while building the fixtures; **not fixed here**). The writer anchors
  `measurement_start_time` on the first frame appended and encodes every
  later object as a `saturating_sub` against it, so a frame stamped
  earlier is written *at* the anchor. Measured: writing
  `[+1000 ms, +500 ms, +1100 ms]` reads back
  `[+1000 ms, +1000 ms, +1100 ms]` — 500 ms of silent error. This
  matters because ADR 0024 already records that a real multi-bus
  capture's arrival order dips ~1.1 s below its own max several times a
  minute, and Save Capture writes the store in arrival order. It is a
  *write*-path defect, so it is outside this phase's scope (import
  origins); fixing it needs either a two-pass write or a seek-back over
  the already-emitted objects. Needs its own task.
- **Notes outside the selected import range are now dropped.** A
  consequence of applying ADR 0046's range to the file's annotations as
  well as its frames, which is what stops an out-of-range marker
  dragging the origin below the range the user asked for. Not something
  the grooming ruled on explicitly; re-importing the full range brings
  them back, and BLF and MDF now behave the same way.
- **No UI verification.** Every claim above comes from generated files
  and code-level experiments; nothing was checked by driving the GUI,
  per the standing rule against UI automation on the owner's machine.
  The owner-visible confirmation is opening `examples/time-origins/` by
  hand.
