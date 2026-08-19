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

### 2026-08-19 — Phase 2 (item 1, events-panel controls)

Branch `task-86-phase-2-events-panel-controls`, off
`perf-gate-rx-gap-regate`.

#### Investigation

**Observation 1 (the rendered DOM).** Rendered `EventsPanel` in jsdom
and dumped its markup: `.trace-scroll-content` carries
`--trace-content-width: 1144px` in a view that draws no frame columns —
`columnsFromParams(undefined)` is not an array, so it falls back
wholesale to the default frame layout.

**Hypothesis 1** (the candidate in item 1). The rows are
`position: absolute; left: 0; right: 0`, which resolves against the
scroller's padding box and contributes nothing to the scroll extent, so
each row ends at the viewport edge and its tail is unreachable.

**Experiment 1.** Took that dumped DOM, put it under the real
`index.css` in a 220 x 300 px group (a narrow vertical dock), and
measured in headless Edge — the WebView2 engine — with
`getBoundingClientRect`, `clientWidth` / `scrollWidth`, and `scrollLeft`
driven to its maximum.

**Data 1.** `.trace-rows`: `clientWidth` 220, `scrollWidth` **1163**,
`maxScrollLeft` **943**. The row's own box: 0 → 1163. `✎` at
x 1105-1128, `×` at x 1136-1154 — 885 px past the panel's right edge.
Scrolled to the maximum, both controls came fully into view
(`✎` 162-185, `×` 193-211).

**Conclusion 1.** Hypothesis 1 is **refuted**. The row is not clipped at
the viewport and the scroll extent does cover it: the row's containing
block is the sticky viewport, whose width is `.trace-scroll-content`'s,
and that box is `min-width: calc(var(--trace-content-width) + 2 *
var(--trace-row-padding-x))` = 1163.2 px — so the extent and the row
agree, and both are wrong. The mechanism is Observation 1's: **the
events view declares the default frame columns, and the layer sizes
every row for tracks that are never drawn.** The controls are pinned by
`margin-left: auto` to the right edge of a 1163 px row inside a 220 px
panel, behind 943 px of empty horizontal scroll.

**Not reproduced: "horizontal scrolling would not reach them."** In
Chromium they are reachable, at `scrollLeft` 943. What the measurement
does show is 943 px of blank scroll with nothing in it and — with only a
few events — no vertical overflow either, so the panel shows no
scrollbar until something scrolls it. Whether the owner's gesture never
moved that axis or was abandoned is an input-level question this
measurement cannot settle; the geometry defect above is sufficient to
explain the report, and is what the fix removes.

**Data 2 (after).** Same harness, same 220 px group, with no columns
declared: `--trace-content-width` 0, `.trace-scroll-content` 220 px,
`scrollWidth === clientWidth === 220`, `maxScrollLeft` **0** — nothing
to scroll at all. The label ellipsises to 40 px and both controls render
inside the panel, `✎` at x 161-185 and `×` at x 193-210.

#### Gridview verdict (ADR 0044)

These rows are on the gridview's **interaction** base and off its **row
template**. `EventRow` draws its own flex row, not a `GridviewRow` of
column cells; but it takes its DOM id from `grid.rowDomId`, sits in the
cursor's row space, and is kept out of the *selection* by the adapter's
`isSelectable` — so the layer governs it as a row without rendering it
as one. The column model still reaches it, through the width the view
publishes for its scrolled content: the rows are absolutely positioned
against that box, so a declared column set sizes every row, drawn cells
or not. The owner's "either not on gridview, or gridview still has
problems" therefore resolves as *both halves, narrowly* — not on the row
template, and the column half of the layer did size the row, off a
column set the panel should never have declared. Recorded in
`EventsPanel`'s doc comment.

#### What landed

| Commit | Subject | Tests |
|---|---|---|
| `826450cc` | The events view declares no columns, so its rows fit the panel | +2 (frontend) |

The fix is one panel-level change (`EventsPanel` hands `TraceView` an
empty column set instead of `columnsFromParams(undefined)`), because the
cause is not shared: every other `TraceView` / `ByIdTable` / signals view
publishes a column width it actually draws, and the shared machinery is
right for them. **No other panel is touched.**

The red evidence is the first of the two new tests, which failed with
`expected '1144px' to be '0px'`; jsdom does no layout, so it asserts the
width the view publishes — the same pattern as `ByIdTable`'s
content-width test and `dockPanelScrolling`'s stylesheet assertions —
with the Chromium geometry above recorded in its comment. Frontend suite
2237 tests across 165 files (was 2235); `pnpm --dir apps/gui build`
clean. Nothing under `apps/gui/src-tauri` changed, so the Rust suites are
untouched.

#### ADR-0031 perf gate

Two release runs on the real rig (`pnpm --dir apps/gui tauri build
--no-bundle`, then `target/release/cannet-gui` with `--project <abs
ev-zonal.cannet_prj> --app-data-dir <the operator's seeded perf app-data
dir> --connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both connected and ran
59.0 s at rate — rx 1605.1 / 1608.6, tx 1611.5 / 1610.4.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed on both runs, 31 metrics gated.**
No baseline promoted or edited.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 1.750 | 0.000 | 1.750 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 20.600 | 3.700 | 20.600 | 41.000 |
| jank_fraction | 0.000 | 0.017 | 0.000 | 0.017 | 0.050 |
| jsheap_mb_peak | 70.300 | 71.300 | 65.500 | 71.300 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 8.276 | 3.122 | 8.276 | 24.094 |
| renderer_mb_peak | 299.363 | 296.930 | 301.742 | 301.742 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 32.912 | 35.757 | 35.757 | 85.336 |
| host_mb_peak | 59.227 | 59.074 | 60.172 | 60.172 | 182.453 |
| tree_mb_peak | 714.051 | 711.742 | 716.055 | 716.055 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 64.182 | 67.967 | 67.967 | 139.240 |
| flush_ms_mean | 25.000 | 5.017 | 4.976 | 5.017 | 25.000 |
| flush_ms_max | 23.772 | 14.338 | 12.421 | 14.338 | 72.544 |
| tx_late_ms_mean | 18.000 | 8.435 | 8.121 | 8.435 | 18.000 |
| tx_late_ms_max | 65.695 | 101.368 | 86.653 | 101.368 | 156.391 |
| rx_gap_p95_ratio_worst | 1.199 | 1.168 | 1.146 | 1.168 | 2.898 |
| rx_gap_short_frac_worst | 0.008 | 0.004 | 0.010 | 0.010 | 0.166 |
| rx_fps_retention | 0.998 | 0.994 | 0.997 | 0.994 | 0.800 |
| tx_fps_retention | 1.001 | 0.999 | 0.999 | 0.999 | 0.800 |

Means across the two runs sit between the per-run figures in every row
(`tx_late_ms_max` 94.0, `lag_ms_max` 12.2); nothing straddles a limit.
The three host modes (`tracebuffer`, `grpc`, `hardware-peak`) re-ran as
part of `check` and passed on both. `rx_gap_short_frac_worst` is now
gated at ADR 0031's re-gated 0.166 limit and came in at 0.004 / 0.010.
See the `tx_late_ms_max` note under blockers.

Reports were not committed (nothing under
`docs/performance-measurements/frontend/` is tracked); they are at
`task86-phase2-run{1,2}.json` in the operator's seeded perf app-data dir
(outside the repo).

### 2026-08-19 — Phase 3 (item 4, what survives a DBC replace)

Branch `task-86-phase-3-dbc-replace`, off
`task-86-phase-2-events-panel-controls`.

#### The three paths, as they stand in 0.9.0-dev

| Path | Where | DBC set | Bus scoping | Priority order | Derived caches | `dbc-changed` |
| --- | --- | --- | --- | --- | --- | --- |
| Reload in place | `add_dbc` -> `install_dbc`, path already loaded (`reloaded = true`) | the slot's `db` is swapped | **kept** (the entry is mutated, not replaced) | kept | `invalidate_derived_caches` | **no** |
| Watcher reload | `dbc_watcher::reload_one` | same swap, on an FS event | kept | kept | `invalidate_derived_caches` | yes |
| Replace | `add_dbc` (new path) then `remove_dbc` | two set changes, both databases loaded in between | **lost** — a new entry gets `buses: Vec::new()` | **lost** — a new entry is pushed to the end | `invalidate_derived_caches`, twice | **no** |

`reload_one` differs from `install_dbc`'s reload branch in exactly two
things: it emits `dbc-changed`, and it does not re-arm the file watch
(already armed). Not exercised by a test — it takes an `AppHandle` and
this crate has no Tauri mock-app harness — so its row above is a code
read, not a measurement.

#### Investigation

**Observation 1.** Every DBC path — `add_dbc`, `set_dbc_buses`,
`remove_dbc`, `clear_dbcs`, the watcher reload, the MDF import's
embedded install — ends at `invalidate_derived_caches`, which re-judges
the pyramids per signal and nulls the filter index, the descriptor
snapshot and the mux extractor. There is no path that changes the DBC
set and skips it.

**Hypothesis 1.** The 0.8.1 report is therefore a *view not re-asking*
rather than a cache not invalidating (the shape item 4 predicted, and
ADR 0049's lazy rebuild is what makes it possible: nothing decodes until
a view asks).

**Experiment 1.** Render `PlotPanel` in jsdom over a **stopped** panel —
one signal, a window that does not move — settle it past every
post-mount fetch, then bump the trace model's re-anchor epoch, which is
what `App.invalidateCache` bumps on every frontend-initiated DBC change
(add, remove, reload-in-place, re-scope, open project). Count
`sample_signals` round-trips.

**Data 1.** `expected 2 to be greater than 2`. Zero further round-trips.

**Conclusion 1.** Confirmed, and there are *two* independent reasons, so
fixing either alone would not have been enough:

- The decimated source's memo keys on `winStart`, `winEnd`, the visible
  slice, the point budget and the render mode (`useDecimatedRange.ts`'s
  `fetchKey`). That is the right question — "could this request return
  different bytes?" — asked without one of its inputs. A live capture's
  `winEnd` moves every tick and re-keys it incidentally, which is
  exactly why the report is *"doesn't **always** happen"*; a stopped
  capture, or a plot zoomed into history (where the key is deliberately
  `"parked"`), never re-keys at all.
- On a stopped panel `PlotArea`'s resample loop is **off**. Even a
  re-keyed memo would not have been consulted, because nothing ticks.

Fixed here: the model epoch rides in front of the decimated source's
descriptor, and a change to it forces a resample the way a programmatic
x-window change already does. This is the plot catching up with what
every row-addressed trace window has done all along (`trace.ts`'s
`${model.epoch}:${offset}`) — the plot was the one view over the model
that ignored the re-anchor signal.

**What is still not covered:** the *watcher* path. `dbc-changed` is not
translated into an epoch bump anywhere, so an on-disk edit still leaves
the plot on the old decode. That is the propagation contract task 27
owns (grooming note 5) and is left to it, with the plot named as a
consumer — not patched here, because patching one consumer while the
others stay broken is how this drifted.

#### The design question: what survives replacing a DBC?

**The cache half — yes, and it is the parked-cache pool that does it,
not the fingerprint match.**

**Experiment 2.** At `AppState` level, over a 200-frame capture of one
message with two signals (`A` and `B`): install `a.dbc`, build both
pyramids, stamp them with `persist`, then install `b.dbc` with `A`
defined identically and `B` rescaled, then remove `a.dbc`. Serve each
afterwards against a capture **nothing decodes**, so a returned sample
is a pyramid's rather than a rebuild's.

**Data 2.**

| Step | live | parked | revivals |
| --- | --- | --- | --- |
| built + stamped under `a.dbc` | 2 | 0 | 0 |
| `b.dbc` installed alongside | **0** | **2** | 0 |
| `a.dbc` removed | 1 | 1 | 1 |

`A` then answers with its 200 samples off the undecodable capture; `B`
answers with none.

**Conclusion 2.** The answer is yes, but by a different mechanism than
ADR 0047's summary suggests. A replace is *two* set changes, and the
intermediate set — both databases loaded — is a two-candidate chain for
every signal, so **both** pyramids re-encode and park, the unchanged one
included. What brings `A` back is the pool: the removal restores a
one-database chain whose fingerprint is the one `A` was parked with, and
`revive_retained` hands it straight back in the same call. Without the
pool a near-identical replace would rebuild *everything*. Falsified by
skipping `revive_retained`: `A's chain is what it was, so A comes back`
fails, `left: 0, right: 1`.

The contrast is the **reload-in-place** path, which does not churn at
all: one database, `A`'s chain never moves, and its pyramid never leaves
the live set (live 1, parked 1, **revivals 0**). Falsified by making a
fingerprint match count as a mismatch: the revival count goes to 1 — the
samples still survive, through the pool, but the per-signal judgement
stops being what saved them.

**Precondition worth naming:** a pyramid is parked only if it carries an
encoding stamp, and the stamp is written by `persist` (periodic, and at
exit). A pyramid built since the last manifest write is **dropped**, not
parked, by any DBC-set change — ADR 0047 says so on purpose (the safe
direction), but it means "a near-identical replace keeps your caches" is
true of a session that has been running and not of one that has just
plotted a signal.

**The cache half — no, on a project that scopes its databases.**

**Experiment 3.** The same replace with a **byte-identical** file, on a
project whose database is scoped to one bus and whose series is scoped
to that bus.

**Data 3.** The replacement's bus list is `[]`. After the replace:
live 0, parked 2, revivals 0 — *nothing* is reused. Re-scoping the
replacement the way the replaced file was scoped: live 2, parked 0,
revivals 2, and both series answer off an undecodable capture.

**Conclusion 3.** The pyramids are right and the project state is wrong.
`install_dbc` gives a newly-added entry the "applies to every bus"
default, because it has no way to know this file stands in for another —
so the replacement genuinely decodes differently (it now answers for
every bus), the encoding fingerprint moves with it, and every pyramid it
backs rebuilds. The samples are not lost, only unreferenced; re-scoping
puts the chain back and the pool answers for both. The same is true of
**load priority**: a new entry is pushed to the end, so replacing the
first of several overlapping databases silently re-prioritises the set,
which is part of the candidate chain and so part of the fingerprint.

Neither is a defect in the cache. Both are the honest answer to "what
survives replacing a DBC": **the bus scoping and the priority position
do not.** Written up under blockers as a candidate for its own task,
with the ruling left to the owner — the app has no notion of "replace",
and inventing one is a feature, not a fix.

**The view-config half — yes, everywhere it was checked.** Plot series,
signal-view patterns and RBS entries all name a signal by *identity* —
bus, message id, extended flag, signal name — never by the database that
defined it, and the descriptor universe every one of them resolves
through is rebuilt by the same invalidation. Asserted host-side: after
the replace the descriptor snapshot still names `(p, 256, A)` and
`(p, 256, B)`, and an RBS entry with a signal-value override still
registers its row through each step of the replace (falsified by giving
the replacement a database that does not define the message — the row
goes unregistered and the rebuild warns).

#### What landed

| Commit | Subject | Tests |
| --- | --- | --- |
| `a5521981` | Pin what a DBC replace keeps, and what it does not | +3 (`cannet-gui`) |
| `c49495ba` | The plot re-asks the host when the DBC set changes | +1 (frontend) |
| `5a5fef99` | An RBS entry outlives the database file that defined it | +1 (`cannet-gui`) |

Suite totals after the phase: `cannet-gui` 721 passed / 6 ignored (was
717), frontend 2238 across 165 files (was 2237). `cargo clippy
--workspace --all-targets -- -D warnings`, `cargo fmt --all`, `pnpm
--dir apps/gui test` and `pnpm --dir apps/gui build` clean on every
commit (the pre-commit gate ran them).

The only production change is the plot's: one prop threaded from
`PlotPanel` into `PlotArea`, folded into the decimated source's
descriptor, plus a forced resample on it. Everything else is tests.

#### ADR-0031 perf gate

The phase changes a render path (`PlotArea`'s fetch identity and one
extra forced resample), so the gate was run rather than skipped. Two
release runs on the real rig (`pnpm --dir apps/gui tauri build
--no-bundle`, then `target/release/cannet-gui` with `--project <abs
ev-zonal.cannet_prj> --app-data-dir <the operator's seeded perf app-data
dir> --connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both connected and ran
59.0 s at rate — `rx_gap.ids_measured` 173 on both, rx 1600.8 / 1603.3,
tx 1606.1 / 1606.9 — so neither is the empty-capture failure mode.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed on both runs, 31 metrics gated.**
No baseline promoted or edited.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 1.217 | 1.183 | 1.217 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 3.800 | 1.500 | 3.800 | 41.000 |
| jank_fraction | 0.000 | 0.017 | 0.017 | 0.017 | 0.050 |
| jsheap_mb_peak | 70.300 | 71.500 | 75.400 | 75.400 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 9.816 | 4.758 | 9.816 | 24.094 |
| renderer_mb_peak | 299.363 | 297.723 | 324.480 | 324.480 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 41.430 | 66.988 | 66.988 | 85.336 |
| host_mb_peak | 59.227 | 58.680 | 58.062 | 58.680 | 182.453 |
| tree_mb_peak | 714.051 | 711.352 | 730.527 | 730.527 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 73.439 | 97.101 | 97.101 | 139.240 |
| flush_ms_mean | 25.000 | 4.719 | 4.527 | 4.719 | 25.000 |
| flush_ms_max | 23.772 | 12.992 | 12.807 | 12.992 | 72.544 |
| tx_late_ms_mean | 18.000 | 7.436 | 7.712 | 7.712 | 18.000 |
| tx_late_ms_max | 65.695 | 73.343 | 72.520 | 73.343 | 156.391 |
| rx_gap_p95_ratio_worst | 1.199 | 1.189 | 1.161 | 1.189 | 2.898 |
| rx_gap_short_frac_worst | 0.008 | 0.004 | 0.003 | 0.004 | 0.166 |
| rx_fps_retention | 0.998 | 0.996 | 0.993 | 0.993 | 0.800 |
| tx_fps_retention | 1.001 | 1.000 | 0.999 | 0.999 | 0.800 |

Means across the two runs sit between the per-run figures in every row
(`tx_late_ms_max` 72.9, `tree_mb_drift_per_min` 85.3,
`renderer_mb_drift_per_min` 54.2); nothing straddles a limit. The three
host modes (`tracebuffer`, `grpc`, `hardware-peak`) re-ran as part of
`check` and passed on both.

Reading it against this change: the perf project's layout does open
plots, so the changed path *is* exercised — but the change adds no work
to a running capture. The epoch it now folds into the fetch key does not
move during a run (nothing loads a DBC mid-capture), and the extra
effect fires once at mount. The rows above baseline are the memory
tiers on run 2 (`renderer_mb_drift_per_min` +67 % over baseline,
`tree_mb_drift_per_min` +45 %) and they are *not* reproduced on run 1
(+3 % and +9 % on the same binary) — run-to-run spread, not a signal,
and both far inside their limits.

`tx_late_ms_max` is the row phase 2 flagged, and this is its **third**
consecutive elevated reading: 73.3 / 72.5 here against a baseline of
65.7 and a limit of 156.4, after phase 2's 101.4 / 86.7 and phase 1's
25.7 / 16.8 on the same rig. Reported as asked. What the three phases
have in common is not their diffs — phase 1 touched the import path,
phase 2 one prop on a panel the perf project never opens, this phase the
plot's fetch identity — so a common *cause in the code* is not
available. `tx_late_ms_mean` has moved with it and stayed well inside
its own limit throughout (5.8 / 5.6 → 8.4 / 8.1 → 7.4 / 7.7 against
18.0), which is the shape of a rig whose scheduling tail has got longer
rather than of a transmit path that has got slower. It is a rig
observation and it now has three data points; whoever runs the gate next
should keep reporting it, and if it keeps climbing it needs a bisect
against an unchanged tree rather than an attribution to a phase.

Reports were not committed (nothing under
`docs/performance-measurements/frontend/` is tracked); they are at
`task86-phase3-run{1,2}.json` in the operator's seeded perf app-data dir
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
- **`tx_late_ms_max` ran above baseline on both phase-2 perf runs**
  (101.4 / 86.7 ms against a baseline of 65.7 and a limit of 156.4; no
  gate breached, and `tx_late_ms_mean` was 8.4 / 8.1 against a limit of
  18.0). Phase 1's runs on the same rig were 25.7 / 16.8. This phase
  changes one prop on the events panel, which the perf project's layout
  never opens, so a causal link is implausible — recorded as a rig
  observation for whoever runs the gate next, not as a finding against
  this change.
- **The chronological trace panel keeps the same geometry for its event
  rows, by design.** A note rendered inside `TracePanel` is as wide as
  the frame columns (~1163 px with the default layout), so its ✎ / ×
  sit at the far right there too — reachable by exactly the horizontal
  scroll the columns already require. Item 1's report is the events
  panel, whose columns are phantom; nothing here changes `TracePanel`.
- **One half of the item-1 report is not reproduced.** "Horizontal
  scrolling would not reach them" is false in Chromium as measured: the
  controls came into view at `scrollLeft` 943. The measured defect
  (885 px of misplacement behind 943 px of blank scroll) explains the
  report without it; if a control is still unreachable after this phase,
  that is a second, input-level defect and needs its own reproduction.
- **A replacement DBC inherits neither the bus scoping nor the priority
  position of the file it replaces** (measured, **not fixed here** —
  needs its own task and an owner ruling). `install_dbc` gives a
  newly-added entry `buses: Vec::new()` and pushes it to the end of the
  loaded list, because the host has no notion of "replace" — a replace
  is an add and a remove that happen to be adjacent. Two consequences,
  in order of severity: (1) on a project that scopes its databases the
  replacement **decodes the wrong frames** until the user re-scopes it
  by hand, silently; (2) every pyramid it backs rebuilds, correctly, for
  the same reason. Measured on a byte-identical replacement: live 0,
  parked 2, revivals 0, and the replacement's bus list `[]`. Re-scoping
  it recovers everything (live 2, revivals 2) — the samples are
  unreferenced, not lost. Fixing it means deciding what a "replace"
  *is*: a gesture in the project panel that swaps a path in place and
  keeps the entry, or a rule that a new entry inherits the scoping of a
  removed one (which cannot be right in general). That is a feature, and
  grooming note 4 sends features out of this phase.
- **The plot's watcher-path gap is left to task 27.** After this phase
  the plot re-asks on every *frontend-initiated* DBC change, because
  those bump `App.invalidateCache`'s epoch. An on-disk edit picked up by
  `dbc_watcher::reload_one` emits `dbc-changed`, and nothing translates
  that into an epoch bump, so the plot still shows the old decode.
  Deliberately not patched here: it is the same hole as item 3's, and
  grooming note 5 gives the contract to task 27. That contract has three
  consumers to cover — `useValueTables` (item 3), the signal catalog
  (already covered), and the plot's decimated source.
- **`useFilteredTrace`'s descriptor has the same shape of gap** (code
  read, **not measured, not fixed**). It is
  `${winStart}:${JSON.stringify(filter)}` — no model epoch — so a
  filtered chronological view on a stopped capture would not re-page
  after a DBC change either, and a signal-value predicate is decoded
  against the DBC set. The chronological `useTrace` already folds the
  epoch in; this is the one windowed source left that does not. Needs
  its own reproduction before anyone changes it; recorded here rather
  than fixed because it is a different view from item 4's report.
- **A pyramid built since the last `persist` is dropped, not parked.**
  ADR 0047's stated safe direction (an unstamped cache was never held
  alongside a loaded set, so what decoded it is unknown), and the reason
  "a near-identical replace keeps your caches" is true of a session that
  has been running and not of one that has just plotted a signal. No
  change proposed; naming it because it is the difference between the
  design question's conceptual answer and what a user sees in the first
  minute after plotting something.
- **The watcher reload path is not unit-testable.** `reload_one` takes
  an `AppHandle` and this crate has no Tauri mock-app harness, so the
  third path's row in the table above is a code read. Its cache
  behaviour is `install_dbc`'s reload branch verbatim; what is untested
  is that it is, and that it emits `dbc-changed`.
