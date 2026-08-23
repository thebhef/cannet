# Task 27 — Live Disk-Watch for Project & RBS Files

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All three
> phases landed 2026-08-19 on the chain (nothing has merged). The exit
> criteria are walked at the end of the status log: five met and **one
> (criterion 4) only partially met** — the host functions that stitch the
> two watches together are covered by inspection, not by tests, because
> Tauri's mock runtime will not load on Windows. Nothing in this task was
> verified by driving the GUI. Findings still owed a verdict:
> owner-review-queue 3.44, 3.45.

Generalize the DBC auto-reload watcher (`apps/gui/src-tauri/src/dbc_watcher.rs`)
so that an externally-edited **project (`.cannet_prj`)** or **RBS
(`.cannet_rbs`)** file is picked up automatically, the same way a loaded
DBC already is. Today only DBCs are watched; project and RBS files
require a manual reload.

Reuse the existing watcher's semantics (parent-dir watch + refcount,
re-read + re-parse on any relevant event, parse failures log and leave
the in-memory copy intact, deletions don't unload). The hand-written
surface should stay small — register the project/RBS paths with the
same watch set and route events to the existing reload commands.

The reload contract is written down in
[`docs/adr/0053-reload-when-it-applies-and-what-it-tells.md`](../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
— when a disk change is applied, and what a reload must tell.

## Scope

- Project file: re-read and reconcile on external change.
- RBS file: re-read via the existing `.cannet_rbs` load/reload path
  (`rbs.rs`), preserving run/stopped state per the load contract.
- Emit the appropriate frontend change event so open panels refresh.
- **Fix the existing DBC propagation gap.** Today a DBC auto-reload
  fires (`auto-reloaded DBC …` logs, `dbc-changed` emitted) but edits to
  enum value *names* (`VAL_` value descriptions) don't reach the RBS or
  plot views. Leads (unconfirmed): RbsPanel listens for `rbs-changed`,
  not `dbc-changed`, so confirm `rbs::refresh_all_elements` actually
  re-fetches enum labels; and `state.signal_caches` is not cleared in
  `reload_one` (`dbc_watcher.rs`), so stale decoded/label state may be
  served. The right propagation/invalidation contract here is the
  reference for the project/RBS watches above.

## Exit criteria

- Editing a loaded `.cannet_prj` or `.cannet_rbs` on disk updates the
  GUI without a manual reload.
- A transient broken parse leaves the working copy intact (matches DBC
  behavior).
- Editing an enum value name (`VAL_`) in a loaded DBC on disk updates
  the label shown in the RBS and plot views without a manual reload.
  Driven by a failing test that renames a `VAL_` entry and asserts the
  new label surfaces.
- Tests cover the reload-and-swap pipeline for both file types.

## Grooming notes (2026-08-19)

Grilled with the owner ahead of implementation; this task came into
scope alongside tasks 81 and 86 (it runs last of the three).
Resolutions:

1. **This task owns the DBC-change propagation contract.** Task 86's
   item 3 (enum overlays only render after a view remount) is the same
   hole as the `VAL_`-rename gap recorded here: nothing tells the
   views that labels changed. Owner ruling — 27 owns it, so the RBS
   half is fixed with the plot half rather than after it.

2. **The project watch notifies; it applies only when safe.** A
   project file is not a DBC: the app writes it (explicit Save, plus
   autosave-on-exit), and the session can hold unsaved changes, so a
   blind auto-reload can discard the user's work and autosave-on-exit
   can discard the external edit. Apply silently only when nothing is
   at risk; otherwise surface "project changed on disk" with an
   explicit Reload action. **Mid-capture is never safe** (owner):
   reloading re-roots the session (ADR 0042) and drops the
   connection. The reload itself runs the existing `open_project`
   path — no new element-level reconciliation engine.

3. **An RBS file is safe to apply when it is clean and stopped.**
   Unsaved edits to that element, or the element actively
   transmitting, both mean do not swap underneath it — a running RBS
   is putting frames on a real bus. Otherwise notify, with
   apply-anyway as the explicit action in the notification.

4. **One ADR, covering reload end to end.** Two halves: when a disk
   change is applied (externally-owned inputs such as DBCs swap in
   place; app-owned documents apply only when safe and otherwise
   notify), and what a reload must tell (the invalidation and
   notification obligations, so every view rendering derived state —
   enum labels included — sees the change). One ADR rather than two:
   the gap recorded in this task exists because those halves were
   never written down together.

## Phases

1. **The reload ADR and the propagation contract.** Write the ADR
   (landed as ADR 0053),
   then implement the propagation half: a DBC-set change (add, remove,
   re-scope, watcher reload) invalidates and notifies every consumer
   of derived state, with the failing `VAL_`-rename test from the exit
   criteria driving it. Covers task 86 item 3's consumers.
2. **Project-file watch.** Register `.cannet_prj` with the existing
   watch set; the safety rule from note 2; notification UI and the
   explicit Reload action.
3. **RBS-file watch.** Same for `.cannet_rbs`, with the clean-and-
   stopped rule from note 3.

## Status log

### 2026-08-19 — Phase 1 (the reload ADR and the propagation contract)

Branch `task-27-phase-1-dbc-propagation`, off
`task-86-phase-3-dbc-replace`. Carries task 86 item 3 (enum overlays),
folded in here by owner ruling.

#### Investigation

**Observation 1 (the two leads this task recorded).** The task named two
suspects for the `VAL_`-rename gap: `reload_one` not clearing
`state.signal_caches`, and `RbsPanel` listening for `rbs-changed` rather
than `dbc-changed`.

**Experiment 1.** Read both paths end to end and pinned the host half
with a test: install a DBC, install it again under the same identity
with raw 0 renamed, and ask `list_value_tables_inner` what it answers.

**Data 1.** `reload_one` *does* call `invalidate_derived_caches`
(`dbc_watcher.rs`), which nulls the filter index and the descriptor
snapshot and re-judges every pyramid per ADR 0047; and the value-table
lookup reads the swapped `Database` with no cache in front of it
(`a_val_rename_reloaded_in_place_is_what_the_value_table_lookup_answers`,
passes as written). `rbs::refresh_all_elements` likewise rebuilds every
element's rows — an RBS row's `label` is taken from the freshly decoded
signal (`rbs/view.rs:318`), not cached — and emits `rbs-changed "*"`,
which the panel already refetches on (`RbsPanel.dom.test.tsx`, "recovers
when the host state lands after mount").

**Conclusion 1.** **Both recorded leads are refuted.** The host was not
serving stale labels, and the RBS rows were not un-refreshed. What was
stale is the *enum label list* the panel's picker renders, which comes
from the shared `useValueTables` fetch — the same fetch task 86 item 3
names — and that fetch keyed on the signal set alone. So task 27's gap
and task 86's item 3 are not merely the same family: they are the same
code path, reached from two different reports.

**Observation 2.** `add_dbc`, `set_dbc_buses`, `remove_dbc` and
`clear_dbcs` changed what the app decodes and announced nothing; only
the watcher reload and the MDF import emitted `dbc-changed`. Meanwhile
the frontend refreshed some views on a DBC-*set* change it made itself
and others on `dbc-changed`.

**Conclusion 2.** Neither half was complete, so which consumers heard
about a change depended on which path it came in by. That asymmetry —
not any one panel's subscription — is the defect. It is what ADR 0053 §2
and §3 close: the host announces every change without exception, and the
frontend subscribes once.

**Experiment 3 (an attempt, recorded because it failed).** Task 86
phase 3 recorded that `reload_one` is not unit-testable for want of a
Tauri mock-app harness. Tried to close that: added
`tauri = { features = ["test"] }` as a dev-dependency and wrote a probe
that emits `dbc-changed` on a `tauri::test::mock_app` and listens for it
Rust-side.

**Data 3.** The `cannet-gui` lib test binary then failed to start at all
— `process didn't exit successfully … (exit code: 0xc0000139,
STATUS_ENTRYPOINT_NOT_FOUND)`, before any test ran. Not one test
failing: the whole suite unable to load.

**Conclusion 3.** The mock runtime does not load on this platform
without more work than this phase can carry (a missing DLL export, most
likely the WebView2 loader the `test` feature links differently).
Reverted; the blocker stands, and the announcement's coverage is
frontend-side.

**Observation 4 (found by reading every windowed source against the
contract, not from a report).** `useByIdView`'s descriptor is
`${winStart}:${sort}:${filter}` — no model epoch — exactly like
`useFilteredTrace`'s, and a by-id row carries the message name and
decoded columns the DBC set defines. Measured red, then fixed by the
same one-line change (`traceWindowEpoch.dom.test.tsx`).

#### The carrier, and why

Two mechanisms existed and neither covered everything: the host's
`dbc-changed` event, and the frontend's trace-model re-anchor epoch.
**The event is the carrier** (ADR 0053 §3), for the one reason that
decides it — it is the only one of the two that can see a change the
frontend did not make: a file edited on disk, a capture's embedded
databases. The epoch conforms by becoming a consumer of it, subscribed
once in `App`, which is what carries a watcher reload to every windowed
view and to the plot. The frontend's own DBC gestures still re-anchor at
their call sites; that is a latency shortcut on a path the carrier also
covers, not a second contract.

The reverse choice was considered and rejected on plumbing: the epoch
lives in the trace-model context, and `SignalCatalogProvider` — one of
the consumers — is mounted *outside* `TraceDataProvider`, so making the
epoch the carrier would have meant either moving providers or coupling
the signal catalog to the trace model.

#### The four consumers (five, as it turned out)

| Consumer | Before | After | Red evidence |
| --- | --- | --- | --- |
| `useValueTables` (plot labels, RBS picker, colormap, transmit) | keyed on the signal set alone | folds the DBC generation | `expected +0 to be 1` — the map stayed empty across the announcement |
| RBS view | rows rebuilt (host + `rbs-changed`); *labels* stuck | served by the fetch above | `expected [ 'Off (0)', 'Standby (1)' ] to deeply equal [ 'Off (0)', 'Ready (1)' ]` |
| The plot, watcher path | epoch bumped only by frontend gestures | `App` translates the carrier | "the stopped view never re-asked the host"; for the overlay, `expected false to be true` |
| `useFilteredTrace` | `${winStart}:${filter}` | epoch leads the descriptor | `expected [ 'fetch_filtered_trace' ] to deeply equal [ …, …(1) ]` |
| `useByIdView` (not on the phase's list) | `${winStart}:${sort}:${filter}` | epoch leads the descriptor | `expected [ 'fetch_by_id_page' ] to deeply equal [ …, …(1) ]` |

Every red measurement above was taken on a **stopped** capture. That is
not a convenience: a live capture's window moves and re-keys these
fetches incidentally, which is why every one of these defects was
reported as intermittent.

#### Coalescing, stated rather than buried

The host now announces per *change* while the work it triggers is per
*set*, so the single subscription coalesces (ADR 0053 §5): a trailing
250 ms debounce for an editor save's burst of filesystem events, and an
explicit batch guard that `loadDbcSet` holds across a project open —
`clear_dbcs` plus an add and a re-scope per database, which need not
finish inside any debounce window. A project open therefore still costs
one re-anchor, as it did before the host started announcing. Pinned by
`dbcChanged.test.ts` ("a suppressed batch costs exactly one fan-out")
and at App level (one editor save's burst → one round of re-pages).

#### What landed

| Commit | Subject | Tests |
| --- | --- | --- |
| `bc4294d6` | Write down the reload contract: when a disk change applies, and what it tells | — |
| `3a2342d5` | Every DBC-set change announces itself, through one function | +1 (`cannet-gui`) |
| `42614710` | One frontend subscription to the DBC-change carrier, with the coalescing it needs | +5 (frontend) |
| `5b23774e` | Enum labels re-ask when the DBC set changes | +2 (frontend) |
| `ace5cfc3` | The filtered and by-id windows re-page when the DBC set changes | +2 (frontend) |
| `6ee01a7e` | A DBC changed on disk re-anchors the trace model | +1 (frontend) |
| `eec704f2` | The catalog and the Database view read the carrier, they do not listen for it | — |
| `9da0aa63` | Pin the plot's enum overlay against the DBC-set change that fills it in | +1 (frontend) |

Suite totals after the phase: `cannet-gui` 722 passed / 6 ignored (was
721/6), frontend 2249 across 168 files (was 2238 across 165). `cargo
clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all`,
`pnpm --dir apps/gui test` and `pnpm --dir apps/gui build` clean on every
commit (the pre-commit gate ran them).

Phases 2 and 3 (the project and RBS watches) are untouched: this phase
implements ADR 0053's *what a reload must tell* half only.

#### ADR-0031 perf gate

The phase adds invalidation and refetch traffic on a path every panel
consumes, so the gate was run rather than skipped. Two release runs on
the real rig (`pnpm --dir apps/gui tauri build --no-bundle`, then
`target/release/cannet-gui` with `--project <abs ev-zonal.cannet_prj>
--app-data-dir <the operator's seeded perf app-data dir>
--connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both connected and ran
59.0 s at rate — `rx_gap.ids_measured` 173 on both, rx 1599.8 / 1604.9,
tx 1606.4 / 1608.2 — so neither is the empty-capture failure mode.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed on both runs, 31 metrics gated.**
No baseline promoted or edited, no gate limit widened.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 1.350 | 1.183 | 1.350 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 28.300 | 2.000 | 28.300 | 41.000 |
| jank_fraction | 0.000 | 0.017 | 0.017 | 0.017 | 0.050 |
| jsheap_mb_peak | 70.300 | 70.900 | 72.700 | 72.700 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 8.663 | 4.436 | 8.663 | 24.094 |
| renderer_mb_peak | 299.363 | 309.098 | 305.035 | 309.098 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 50.492 | 35.108 | 50.492 | 85.336 |
| host_mb_peak | 59.227 | 58.441 | 58.371 | 58.441 | 182.453 |
| tree_mb_peak | 714.051 | 719.164 | 718.891 | 719.164 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 79.440 | 64.700 | 79.440 | 139.240 |
| flush_ms_mean | 25.000 | 4.617 | 4.783 | 4.783 | 25.000 |
| flush_ms_max | 23.772 | 11.293 | 10.873 | 11.293 | 72.544 |
| tx_late_ms_mean | 18.000 | 7.106 | 7.442 | 7.442 | 18.000 |
| tx_late_ms_max | 65.695 | 82.098 | 70.473 | 82.098 | 156.391 |
| rx_gap_p95_ratio_worst | 1.199 | 1.163 | 1.168 | 1.168 | 2.898 |
| rx_gap_short_frac_worst | 0.008 | 0.002 | 0.002 | 0.002 | 0.166 |
| rx_fps_retention | 0.998 | 0.994 | 0.996 | 0.994 | 0.800 |
| tx_fps_retention | 1.001 | 1.001 | 0.999 | 0.999 | 0.800 |

Means across the two runs sit between the per-run figures in every row
(`lag_ms_max` 15.2, `tx_late_ms_max` 76.3, `renderer_mb_drift_per_min`
42.8); nothing straddles a limit. The three host modes (`tracebuffer`,
`grpc`, `hardware-peak`) re-ran as part of `check` and passed on both.

Reading it against this change: the traffic this phase adds lands at
*project open*, not during a capture. The perf project loads two DBCs,
so the run exercises the batch guard — and the guard is why boot still
costs one re-anchor rather than five announcements' worth. Nothing
announces during the 60 s capture (no DBC is loaded mid-run), so the
steady-state rows should be unchanged, and they are: `flush_ms`,
`rx_gap`, retention and the host modes all sit at or below baseline.

`lag_ms_max` 28.3 on run 1 against 2.0 on run 2 is the widest spread in
the table and is not reproduced across the pair; both are inside the
41.0 limit. `tx_late_ms_max` is the row task 86's phases have been
tracking — 82.1 / 70.5 here against a baseline of 65.7 and a limit of
156.4, after phase 3's 73.3 / 72.5 and phase 2's 101.4 / 86.7. That is
now a **fourth** consecutive elevated reading across four unrelated
diffs, with `tx_late_ms_mean` moving with it and staying well inside its
own limit (7.1 / 7.4 against 18.0). Same reading as phase 3 recorded: a
rig whose scheduling tail has got longer, not a transmit path that has
got slower. It needs a bisect against an unchanged tree rather than an
attribution to any of these phases.

Reports were not committed (nothing under
`docs/performance-measurements/frontend/` is tracked); they are at
`task27-phase1-run{1,2}.json` in the operator's seeded perf app-data dir
(outside the repo).

### 2026-08-19 — Phase 2 (the project-file watch)

Branch `task-27-phase-2-project-watch`, off `task-27-phase-1-dbc-propagation`
(`fd32e604`). Implements ADR 0053 §1's app-owned half for the project
file; the RBS half (phase 3) is untouched.

#### Where the apply-vs-notify decision went, and the evidence

**The host announces; the frontend decides.** The host emits
`project-changed` (path payload) and applies nothing.

**Observation.** ADR 0053 §1 makes the decision read two facts: the
in-memory project is clean, and no session is up.

**Experiment.** Grepped the host for a project dirty flag and read the
session / connection state on both sides.

**Data.** `dirty` exists **only** in the frontend: `App.tsx:401`
(`const [dirty, setDirty] = useState(false)`) with fifteen
`setDirty(true)` call sites, all in `App.tsx` - layout changes, element
edits, bus / binding / vbus mutations, DBC re-scoping, signal colors.
The host's only `dirty` is per-RBS-element (`rbs/runtime.rs:29`,
`rbs/commands.rs`); nothing project-level. Connection state is the other
way round - the host owns it (`connection_state.rs`) - but the frontend
already holds the session map that Connect / Disconnect write and the
toolbar renders (`remoteSessions`), so the frontend has both facts and
the host has one.

**Conclusion.** The recommendation stands, and for a stronger reason than
convenience: the alternative is not a placement change but a model move.
For the host to hold the dirty bit it would have to see every project
mutation the frontend makes, none of which reaches it today - that is
the project model moving host-side, a defensible direction and far
larger than this phase. Against the GUI architecture rule: this is a
**policy over two booleans**, not domain computation over capture data.
The host keeps what only the host can know (the file changed on disk),
the frontend keeps what only it knows (whether applying is safe now),
and nothing capture-derived is computed in JS.

Applying is `openProjectAt`, the file picker's own open path, extracted
so the reload cannot drift from it (ADR 0053 §1: a reload is the
existing open path, not a merge). The DBC-set change it causes rides the
phase-1 carrier - `applyProject` -> `loadDbcSet` -> the host DBC
commands, each already announcing - so **no second frontend subscription**
was added.

#### Two things the grooming notes did not anticipate

**1. cannet writes this file, so its own Save looks like an edit.**
`save_project` (and autosave-on-exit) reach `write_json_atomic`, which
renames a temp file over the target - exactly the `Create(Any)` /
`Modify(Name)` that `reaction_to` classifies as a reload. And the
frontend clears `dirty` on a successful save. So an unguarded watch
would announce on every Save, and the state right after a Save (clean,
and often disconnected) is precisely the state that applies *silently*:
every Save would re-open the project, re-rooting the session (ADR 0042)
and dropping the restored capture. Reasoned from the code rather than
measured - it is a defect the design would have shipped, closed before
it existed rather than reproduced.

The guard is `WatchedProject`: the content the app last **exchanged**
with the file - what `open_project` read, what `save_project` wrote - and
an event is news only when what is on disk differs from it. Recording
after the write left a real race (the events the write raises could be
read against the pre-write record), so the write now runs inside
`record_own_write`, holding the lock the event path reads under
(`9cd91a6f`). Found by reading the code against its own rustdoc, which
already claimed the ordering it did not have.

**2. `clear_dbcs` unwatched everything, and a project open starts with
`clear_dbcs`.** The watch set was per-directory with a refcount, and
`unwatch_all` dropped every directory - so `loadDbcSet`, the first thing
`applyProject` does, would have silently unwatched the project file that
had just been registered (and a project's DBCs commonly live in the same
directory). `clear_dbcs` now unwatches the paths it actually unloaded,
and the watcher tracks the **files** it holds a watch for, so a
capture-embedded database - an identity, never watched - cannot decrement
a directory a real file is holding (which also used to underflow the
refcount in debug builds).

**Experiment (falsification).** Removed both guards and re-ran:
`unwatching_a_path_that_was_never_watched_leaves_the_directory_alone`
(`left: None, right: Some(1)`) and
`watching_the_same_file_twice_takes_one_refcount` (`left: Some(2),
right: Some(1)`) both fail; restored, both pass. The third watch-set test
(`unwatching_every_dbc_in_a_directory_leaves_the_project_file_watched`)
is *not* red under that mutation - it is the invariant `clear_dbcs` now
relies on, asserted at the watcher; `clear_dbcs` itself is covered by
inspection only (it takes an `AppHandle`; see Blockers).

**Experiment (the mid-capture rule).** Replaced
`!dirtyRef.current && !sessionUpRef.current` with `!dirtyRef.current` and
re-ran the frontend file: exactly one test failed - "notifies rather than
applying while a session is up, clean or not". So that test's project is
genuinely clean, and it measures ADR 0053's precondition rather than
dirtiness leaking in through the back door.

#### The notification

The app has no general banner to reuse, so the closest existing idiom was
taken rather than a new one invented: the **cache-rebuild chip**
(`.cache-rebuild` - a persistent statement in the header, divided from
the status readout, carrying the one action that ends it). `Dismiss` sits
beside `Reload` because the ADR requires the statement be dismissible;
`Reload` is the only thing that applies the change. The transient status
line was rejected - it dwells and then disappears, and this is a decision
waiting on the user, not a flash.

#### What landed

| Commit | Subject | Tests |
| --- | --- | --- |
| `45b8efd9` | The open project file rides on the DBC watch set, and says when it changed | +6 (`cannet-gui`) |
| `ce1413e8` | The frontend decides whether a project changed on disk may be applied | +5 (frontend) |
| `9cd91a6f` | A Save writes the project under the watch record's lock | - |

Suite totals after the phase: `cannet-gui` 728 passed / 6 ignored (was
722/6), frontend 2254 across 169 files (was 2249 across 168). `cargo
clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all`,
`cargo test -p cannet-gui`, `pnpm --dir apps/gui test` and `pnpm --dir
apps/gui build` clean on every commit (the pre-commit gate ran them).

Deliberate: the project watch is **not** gated by `dbc_auto_reload`. That
setting is the opt-out for a database swapping under an analysis
mid-edit; nothing is swapped here, and the announcement carries no change
with it. ADR 0053 §1 names an opt-out for the DBC swap only.

#### ADR-0031 perf gate

Two release runs on the real rig (`pnpm --dir apps/gui tauri build
--no-bundle`, then `target/release/cannet-gui` with `--project <abs
ev-zonal.cannet_prj> --app-data-dir <the operator's seeded perf app-data
dir> --connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both connected and ran
59.0 s at rate - `rx_gap.ids_measured` 173 on both, rx 1602.6 / 1607.7,
tx 1606.7 / 1611.9 - so neither is the empty-capture failure mode.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed on both runs, 31 metrics gated.**
No baseline promoted or edited, no gate limit widened.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 0.000 | 0.000 | 0.000 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 8.900 | 1.500 | 8.900 | 41.000 |
| jank_fraction | 0.000 | 0.000 | 0.000 | 0.000 | 0.050 |
| jsheap_mb_peak | 70.300 | 71.000 | 69.800 | 71.000 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 9.501 | 7.582 | 9.501 | 24.094 |
| renderer_mb_peak | 299.363 | 295.312 | 305.633 | 305.633 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 37.665 | 39.135 | 39.135 | 85.336 |
| host_mb_peak | 59.227 | 59.199 | 59.301 | 59.301 | 182.453 |
| tree_mb_peak | 714.051 | 709.914 | 721.918 | 721.918 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 68.770 | 71.014 | 71.014 | 139.240 |
| flush_ms_mean | 25.000 | 4.346 | 4.706 | 4.706 | 25.000 |
| flush_ms_max | 23.772 | 12.130 | 12.230 | 12.230 | 72.544 |
| tx_late_ms_mean | 18.000 | 5.731 | 6.814 | 6.814 | 18.000 |
| tx_late_ms_max | 65.695 | 23.582 | 73.416 | 73.416 | 156.391 |
| rx_gap_p95_ratio_worst | 1.199 | 1.201 | 1.140 | 1.201 | 2.898 |
| rx_gap_short_frac_worst | 0.008 | 0.004 | 0.006 | 0.006 | 0.166 |
| rx_fps_retention | 0.998 | 0.997 | 0.997 | 0.997 | 0.800 |
| tx_fps_retention | 1.001 | 1.000 | 1.000 | 1.000 | 0.800 |

The three host modes (`tracebuffer`, `grpc`, `hardware-peak`) re-ran as
part of `check` and passed on both.

Reading it against this change: nothing this phase adds runs during a
capture. The watch registers once at project open, and its event path is
idle unless the file is touched; the frontend's addition is one `listen`
and a boolean read inside it. The steady-state rows should therefore be
unchanged, and they are.

Worth recording against the standing observation: `tx_late_ms_max` came
in at **23.6 on run 1** - the first reading *below* the 65.7 baseline
after four consecutive elevated ones (task 86 phases 1-3 and task 27
phase 1) - with run 2 at 73.4. A 50 ms spread across a back-to-back pair
on the same binary is the rig-tail reading those phases proposed, now
evidenced from the other side: the row moves while the diff does not.
Still not this phase's to chase, and still wants a bisect against an
unchanged tree.

Reports were not committed (nothing under
`docs/performance-measurements/frontend/` is tracked); they are at
`task27-phase2-run{1,2}.json` in the operator's seeded perf app-data dir
(outside the repo).

### 2026-08-19 — Phase 3 (the RBS-file watch)

Branch `task-27-phase-3-rbs-watch`, off `task-27-phase-2-project-watch`
(`8da1e35e`). Implements ADR 0053 §1's app-owned half for the
`.cannet_rbs` files, and closes the notice side effect phase 2 recorded.

#### Where the apply-vs-notify decision went, and the evidence

**The host decides, and applies.** For the project, phase 2 put the
decision in the frontend. Here it is host-side — which is not a
divergence from phase 2 but the same rule reaching a different answer,
because the rule is *the decision is made where the facts are* and the
facts sit in different places.

**Observation.** ADR 0053 §1 makes an RBS's decision read two facts: the
element is clean, and the element is stopped.

**Experiment.** Grepped the host and the frontend for both, the same way
phase 2 measured the project's.

**Data.** Both are host state and neither is frontend state.
`RbsElementState` (`rbs/runtime.rs`) carries `dirty` — set by
`edit_file` and `rbs_set_enabled` on every override mutation, cleared by
`write_element` — and `run`, which `rbs_set_run` writes and
`sync_schedules` reads to decide what the scheduler transmits. The
frontend's `RbsPanel` holds neither: it renders `view.dirty` and
`view.run` out of `rbs_view`, and its Run checkbox writes through the
element registry to `rbs_set_run`. The mirror image of phase 2's
finding, where `dirty` existed *only* at `App.tsx:401`.

**Conclusion.** The decision is host-side, and so is the pending flag.
That has a consequence worth stating: because the flag lives in
`RbsElementState`, everything that resolves it — the load path, a save,
the dismiss — clears it in the same place, and the panel is a view over
it. The RBS notice therefore **cannot go stale**, which is the phase-2
side effect this phase had to fix (see below) solved structurally rather
than by wiring.

Applying is `load_into_element`, extracted from `rbs_load` so the
command and the watch run the one `.cannet_rbs` load path (ADR 0053 §1:
a reload is the existing load path, not a merge). It is also what
carries the element's Run flag across the swap — the load contract's
run/stopped preservation is a property of that function, not of the
watch.

**Falsification of the rule itself.** Replaced `outcome_for`'s body with
an unconditional `Outcome::Apply` and re-ran: three of its four tests
fail (`left: Apply, right: Notify` on dirty-clean-running, clean-running,
and dirty-stopped), the clean-and-stopped one still passes. Restored,
all four pass. The rule is measured, not asserted.

#### What the third watch did *not* need

Both traps phase 2 hit were already solved and were reused rather than
re-derived:

- **cannet writes this file too.** `WatchedProject` — the content the
  app last *exchanged* with a file it both reads and writes, with the
  write performed under the record's lock — generalised to
  `watched_file::WatchedFile` (`a087b4ed`), and each element now carries
  one. `write_element` writes through `write_recording`, holding the RBS
  lock the event path reads under, so a Save cannot be read as an
  external edit. Without it every Save of a *clean, stopped* element —
  which is exactly the state that applies silently — would have
  re-loaded the file cannet had just written.
- **The watch set's bookkeeping.** `clear_dbcs` already unwatches only
  the paths it unloaded, and `DbcWatcher` already tracks files rather
  than directories, so an RBS file in the project's directory survives a
  project open unchanged.

One thing the project did not have: **several files at once, and two
elements may hold the same one.** The record is therefore per element,
and `still_open` guards every give-up of a watch — an element unloading
must not unwatch a file another element is still holding
(`a_file_a_second_element_still_has_open_keeps_its_watch`).

#### The notice, extracted rather than copied a third time

Phase 2 added `.project-changed` and an inline `<span>` in `App.tsx`'s
header, shaped after the cache-rebuild chip. A third copy for the RBS
panel is the drift `CLAUDE.md` forbids, so the shape — statement,
primary action, dismiss — is now `ChangedOnDiskNotice`, with one CSS
class (`.changed-on-disk`) for both surfaces, and the project's notice
was re-pointed at it in the same commit (`01ca7100`).

The extraction carries a contract, not just markup: **a notice refers to
something and goes when that something is gone.** That is phase 2's
recorded side effect (a showing chip did not react to a subsequent save
or to the project being closed, so its Reload could re-open a project
the user had closed). The two surfaces meet it differently, and the
difference is the placement finding above:

| | where the pending state lives | how it stops being stale |
| --- | --- | --- |
| RBS | host (`RbsElementState.changed_on_disk`) | load / save / dismiss all clear it; the panel re-fetches |
| Project | frontend (the dirty bit that decides it is frontend-only) | `App` clears it on re-open, reload, save and close (`5fc0b440`) |

The RBS panel's Dismiss goes through a host command
(`rbs_dismiss_disk_change`) for that reason: a panel-local dismiss would
come straight back on the next `rbs_view`.

#### What landed

| Commit | Subject | Tests |
| --- | --- | --- |
| `a087b4ed` | Extract the record that tells cannet's own write from someone else's | +2 (`cannet-gui`) |
| `c3a11d0b` | An open .cannet_rbs rides the shared watch set, and applies when it is safe | +6 (`cannet-gui`) |
| `01ca7100` | One changed-on-disk notice, shared by the project header and the RBS panel | +5 (frontend) |
| `5fc0b440` | A changed-on-disk notice goes when the thing it names is saved or closed | +2 (frontend) |
| `eea341b6` | Document the RBS file's disk watch | — |

Suite totals after the phase: `cannet-gui` 736 passed / 6 ignored (was
728/6), frontend 2261 across 170 files (was 2254 across 169). `cargo
clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all`,
`cargo test -p cannet-gui`, `pnpm --dir apps/gui test` and `pnpm --dir
apps/gui build` clean on every commit (the pre-commit gate ran them).

Deliberate, and the same call phase 2 made: the RBS watch is **not**
gated by `dbc_auto_reload`. That setting is the opt-out for a *database*
swapping under an analysis; ADR 0053 §1 names it for the DBC swap only.

Also deliberate: the README / features / ADR update landed as its own
commit (`eea341b6`) rather than inside the code commits, because it
describes behaviour delivered across three of them. That is a looser
reading of "docs in the same commit as the code" than `CLAUDE.md`
states; nothing shipped undocumented, but it is recorded rather than
glossed.

`plans/tasks/roadmap.md` still lists task 27. Removing it is the
completion call, which is the owner's — and the file is being edited by
another session, so this phase touched only the paths it changed.

#### ADR-0031 perf gate

Two release runs on the real rig (`pnpm --dir apps/gui tauri build
--no-bundle`, then `target/release/cannet-gui` with `--project <abs
ev-zonal.cannet_prj> --app-data-dir <the operator's seeded perf app-data
dir> --connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both connected and ran
59.0 s at rate — `rx_gap.ids_measured` 173 on both, rx 1602.9 / 1607.2,
tx 1609.7 / 1611.0 — so neither is the empty-capture failure mode. The
perf project loads an RBS config (`opened … ev-zonal.cannet_rbs` on both
runs), so the boot path this phase changed is exercised rather than
merely compiled.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed on both runs, 31 metrics gated.**
No baseline promoted or edited, no gate limit widened.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 0.000 | 0.000 | 0.000 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 3.700 | 1.600 | 3.700 | 41.000 |
| jank_fraction | 0.000 | 0.000 | 0.000 | 0.000 | 0.050 |
| jsheap_mb_peak | 70.300 | 72.600 | 70.300 | 72.600 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 8.944 | 7.177 | 8.944 | 24.094 |
| renderer_mb_peak | 299.363 | 297.734 | 305.430 | 305.430 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 29.516 | 43.598 | 43.598 | 85.336 |
| host_mb_peak | 59.227 | 58.609 | 59.645 | 59.645 | 182.453 |
| tree_mb_peak | 714.051 | 711.973 | 720.801 | 720.801 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 59.464 | 75.151 | 75.151 | 139.240 |
| flush_ms_mean | 25.000 | 4.318 | 4.413 | 4.413 | 25.000 |
| flush_ms_max | 23.772 | 10.237 | 10.354 | 10.354 | 72.544 |
| tx_late_ms_mean | 18.000 | 5.124 | 5.146 | 5.146 | 18.000 |
| tx_late_ms_max | 65.695 | 18.624 | 26.055 | 26.055 | 156.391 |
| rx_gap_p95_ratio_worst | 1.199 | 1.163 | 1.187 | 1.187 | 2.898 |
| rx_gap_short_frac_worst | 0.008 | 0.003 | 0.003 | 0.003 | 0.166 |
| rx_fps_retention | 0.998 | 0.996 | 0.996 | 0.996 | 0.800 |
| tx_fps_retention | 1.001 | 1.000 | 1.001 | 1.000 | 0.800 |

The three host modes (`tracebuffer`, `grpc`, `hardware-peak`) re-ran as
part of `check` and passed on both.

Reading it against this change: nothing this phase adds runs during a
capture. Each RBS element's watch registers once at load and its event
path is idle unless the file is touched; the panel's addition is one
boolean read out of a view it already fetches. The steady-state rows
should therefore be unchanged, and they are — every one at or below
baseline except the memory-drift rows, which sit inside their limits and
move in opposite directions across the pair.

Against the standing observation: `tx_late_ms_max` came in at **18.6 and
26.1**, both well *below* the 65.7 baseline, after phase 2's 23.6 / 73.4
and the four consecutive elevated readings before that. Two pairs in a
row now include readings at a third of the baseline on the same rig with
unrelated diffs, which is what phase 2 read as the rig's scheduling tail
rather than any of these changes. The owner has since ruled on it (ADR
0031: the row is noisy, gated at its existing limit, and an elevated
reading is not a finding to report), so this phase's earlier suggestion
of a bisect is withdrawn — the readings above are recorded, not chased.

Reports were not committed (nothing under
`docs/performance-measurements/frontend/` is tracked); they are at
`task27-phase3-run{1,2}.json` in the operator's seeded perf app-data dir
(outside the repo).

### 2026-08-19 — Exit-criteria status check (end of phase 3)

Phase 3 is the last phase, so this walks the task's `## Exit criteria`
one by one. **This is a status check, not a completion declaration** —
the completion call is the owner's.

| Criterion | Status | Evidence |
| --- | --- | --- |
| Editing a loaded `.cannet_prj` or `.cannet_rbs` on disk updates the GUI without a manual reload | **Met, with a caveat** | Both watches exist and both are wired to the same `notify` backend (`project_watch::on_event`, `rbs::watch::on_event`, both called from `dbc_watcher::on_event`). "Updates the GUI" is deliberately *not* always an automatic swap: ADR 0053 §1 (and grooming notes 2 and 3, which the owner set) make an app-owned document apply silently only when nothing is at risk and **notify otherwise**, so a dirty project or a running RBS updates the GUI with a statement and an explicit action rather than a swap. The caveat is coverage, not behaviour: no test edits a file on disk and waits for the OS event (see Blockers) — what is tested is everything either side of that event. |
| A transient broken parse leaves the working copy intact | **Met** | Both watches parse before doing anything: `project_watch::announce_if_changed` runs `parse_project` and returns on `Err` without announcing; `rbs::watch::consider` runs `RbsFile::parse` and returns on `Err` without applying or raising the flag. Both log at `error`. Asserted by inspection of the two functions plus the parser's own tests; not by an end-to-end FS test, per the blocker below. |
| Editing an enum value name (`VAL_`) in a loaded DBC updates the label in the RBS and plot views without a manual reload, driven by a failing test | **Met (phase 1)** | Landed in phase 1 with the red measurements recorded in its status log — `expected [ 'Off (0)', 'Standby (1)' ] to deeply equal [ 'Off (0)', 'Ready (1)' ]` for the RBS view, and the plot's overlay `expected false to be true`. Commits `5b23774e`, `9da0aa63`. |
| Tests cover the reload-and-swap pipeline for both file types | **Partially met** | Covered: the record that decides whether an event is news at all (5 tests, `watched_file`); the watch-set bookkeeping both watches ride (4 tests, `dbc_watcher`, including the project-file-survives-`clear_dbcs` invariant); the apply-vs-notify rule for RBS (4 tests, falsified by mutation); the shared-file guard (2 tests); the frontend's whole project decision (7 tests, `App.projectWatch.dom.test.tsx`) and the RBS panel's whole notice contract (5 tests, `RbsPanel.diskWatch.dom.test.tsx`). **Not covered: the host functions that stitch them together** — `announce_if_changed`, `consider`, `load_into_element`, `write_element` — because every one takes an `AppHandle` and Tauri's mock runtime does not load on this platform (phase 1, Experiment 3). That is a standing blocker across all three phases, not something phase 3 introduced, and it is the honest reason this row is not "met". |
| Scope item: emit the appropriate frontend change event so open panels refresh | **Met** | Project: `project-changed`. RBS: the existing `rbs-changed`, which the panel already re-fetches on — no new subscription was added on either side. DBC-set changes ride phase 1's single carrier. |
| Scope item: fix the DBC propagation gap | **Met (phase 1)** | ADR 0053 §§2–5 and the five consumers in phase 1's table. |

Two things an overseer should weigh with the above:

- **Nothing here was verified by driving the GUI.** Every claim is from
  tests and code-level measurement, per the standing rule against UI
  automation on the owner's machine.
- **The `Partially met` row is the one to look at.** If the owner wants
  it closed, the work is whatever makes `tauri/test` link on Windows;
  it is worth its own task rather than a fourth phase here.

## Blockers / side effects

- **Phase 3: the notice-staleness side effect is closed, differently on
  each side.** Phase 2 recorded that a showing notice did not react to a
  subsequent save or close. The RBS notice is host state and so cannot
  go stale at all; the project's is frontend state and is now cleared on
  re-open, reload, save and close, covered by two tests. Nothing is left
  open here — the entry below is kept as the record of what was found.
- **Phase 3: `rbs_save_as` no longer assigns a path of its own.** The
  path now lives in the element's watch record, and the write re-points
  it. Anything that wants an element's file path reads
  `watch.path_string()`. Behaviourally identical; noted because the
  field it replaced (`RbsElementState.path`) was public and is gone.
- **Phase 3: two elements may hold the same `.cannet_rbs`.** Nothing
  prevents it, and the watch set is shared, so every give-up of a watch
  is guarded by `still_open`. If a future change adds another way an
  element lets go of its file, that guard has to be on it.
- **No host test covers the project announcement either.** Same shape as
  phase 1's blocker below, and the same cause: `set_open_project`,
  `record_own_write`, `on_event` and `clear_dbcs` all take an
  `AppHandle`, and Tauri's mock runtime does not load on this platform.
  What is asserted host-side is what does not need one - the record that
  decides whether an event is news, and the watch-set bookkeeping the
  project watch depends on (`DbcWatcher::inert()`, a real `notify`
  backend with a no-op callback). That the announcement *fires*, and that
  `clear_dbcs` leaves the project watched, are covered by inspection.
- **The OS-level watcher path is untested, as it always was.** No test
  edits a `.cannet_prj` on disk and waits for the event; `dbc_watcher`'s
  module docs already record why (FS watchers are timing-dependent enough
  to be flaky in CI). The event *classification* is shared with the DBC
  watch and is tested there.
- **A notice that is showing does not react to what happens next.**
  Saving or closing the project leaves a stale "Project changed on disk"
  chip up until it is dismissed or reloaded. Reloading a project that has
  since been saved over just re-opens the app's own bytes, which is
  harmless; Dismiss is the way out. Left alone rather than grown into a
  second state machine. **Closed in phase 3** (`5fc0b440`), as part of
  the shared notice's contract.
- **Scope notes, so phase 3 does not re-derive them.** No watch is
  installed for an unsaved project (there is no file); Save As re-points
  the watch onto the new path; opening a different `.cannet_prj` replaces
  the watch and unwatches the old file; `close_project` clears it.
- **No UI verification.** Every claim above comes from tests and
  code-level measurement; nothing was checked by driving the GUI, per the
  standing rule against UI automation on the owner's machine. The
  notice's presence, actions and wording are asserted through the DOM in
  `App.projectWatch.dom.test.tsx`, not seen.

- **The watcher reload's announcement is still not covered by a host
  test.** `reload_one` and every DBC command take an `AppHandle`, and
  Tauri's mock runtime does not load on this platform (Experiment 3
  above). What is asserted host-side is the state half — the swap, the
  invalidation, and what the value-table lookup answers afterwards; that
  the announcement *fires* is asserted frontend-side, where every
  consumer of it lives. Closing it properly needs whatever makes
  `tauri/test` link, and is worth its own look.
- **The `dbc-changed` payload is now sometimes `"*"`.** `clear_dbcs`
  announces a whole-set change and has no single path to name, matching
  `rbs-changed`'s convention. No consumer reads the payload (ADR 0053 §2
  says so explicitly), but anything that starts to has to handle it.
- **Frontend-initiated DBC changes now re-anchor twice**: once
  synchronously at the call site, once when the coalesced announcement
  arrives ~250 ms later. Deliberate — the call-site bump is what keeps a
  user's own gesture instant — but a user adding a DBC does pay two
  rounds of re-page. Removing the call-site bumps would make the carrier
  the single cause; not done here because it widens the change into
  `App`'s project lifecycle for no measured gain.
- **No UI verification.** Every claim above comes from tests and
  code-level measurement; nothing was checked by driving the GUI, per
  the standing rule against UI automation on the owner's machine.
