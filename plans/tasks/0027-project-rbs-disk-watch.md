# Task 27 — Live Disk-Watch for Project & RBS Files

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
721/6), frontend 2249 across 169 files (was 2238 across 165). `cargo
clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all`,
`pnpm --dir apps/gui test` and `pnpm --dir apps/gui build` clean on every
commit (the pre-commit gate ran them).

Phases 2 and 3 (the project and RBS watches) are untouched: this phase
implements ADR 0053's *what a reload must tell* half only.

## Blockers / side effects

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
