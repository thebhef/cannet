# Task 81 — Bus-Scoped Decode Identity

Opened by owner ruling 2026-08-15 on Task 76 phase 1's recorded
divergence: "this seems probably wrong; if a signal is on two busses
it's not necessarily expected to be the same thing, could be a
different instance of same ECU, for example."

## The divergence

The pyramid decode path ignores DBC bus scoping — `sampling.rs` hands
every loaded database to the cache regardless of `LoadedDbc::buses`,
while `dbc_commands.rs`, `app_state.rs`, `transmit_commands.rs` and
`verification.rs` all filter through `filter::dbc_applies`. A series
scoped to bus A can therefore be decoded by a DBC scoped only to
bus B — wrong exactly when the same message/signal name on two buses
is a different instance (the owner's ECU example). Fixing it changes
decoded values, which is why Task 76 recorded rather than fixed it.

Same family, second seam: `list_value_tables` takes no `bus_id` on
either branch (DBC- or file-backed), so two buses whose DBCs define
the same `(message_id, signal_name)` share whichever table the first
loaded DBC answers with. If decode identity becomes bus-scoped, the
label lookup scopes with it.

Note: Task 76's per-signal fingerprint already includes each
contributing DBC's bus scoping (recorded as "conservative today,
still correct if the path is fixed"), so pyramids invalidate correctly
when this lands.

Third seam, added by owner ruling 2026-08-16 ("we shouldn't have
duplicate data. A signal should include the entire path though since
it may be different per bus, so maybe that gets fixed when we resolve
that"): the retention pool can hold two parked entries for one signal
(each park records the fingerprint it left with). Bus-scoping the
decode identity resolves the cross-bus half of that ambiguity; when
it lands, revisit the pool key so a signal's parked entries are keyed
by the full identity — and decide whether the same-identity
two-fingerprint case (a definition edited A → B and back) still earns
two entries or collapses.

## Exit criteria (draft — firm at grooming)

- The pyramid decode consults the same `dbc_applies` scoping as every
  other decode consumer; a signal scoped to bus A is never decoded by
  a DBC scoped only to bus B; tested.
- `list_value_tables` resolves per bus; lanes/labels on two
  differently-scoped buses read their own tables; tested.
- The behavior change is called out in the status log with a
  before/after decode comparison on a two-bus fixture.

## Grooming notes (2026-08-19)

Grilled with the owner ahead of implementation. Resolutions:

1. **Retention pool key — keep every parked cache (no code change).**
   The seam's stated ask ("key parked entries by the full identity")
   is already satisfied: `SignalKey` carries `bus_id`, so the same
   signal on two buses is already two pool entries, before and after
   this task. What was left was the same-key/different-fingerprint
   case, and reading `invalidate_dbcs` narrows it further: parking
   runs before `revive_retained` in the same call, so an A -> B -> A
   edit ends with **one** park (the return revives A and leaves B).
   Two persistent parks of one key need a third distinct encoding
   (A -> B -> C). Owner ruling: keep them all — each park is real
   samples, and a user who wants the disk back lowers the cache
   bound. This phase proves it with a test rather than changing code.

2. **`list_value_tables` with no bus resolves against every loaded
   database.** The command gains a `bus_id` and otherwise resolves
   only through databases that apply to it. `bus_id: None` means "the
   bus is unknown", not "on no bus", so it keeps today's
   first-match-across-all-databases behaviour rather than taking
   `dbc_applies`'s literal answer (which would strip labels from a
   null-bus signal in a project where every database is scoped).
   Owner note: MDF-imported content is the case that reaches this
   today, and those signals have no DBC — recorded against task 84,
   which should revisit it when an MDF's embedded DBC becomes
   durable.

3. **The encoding fingerprint tightens to the databases that can
   apply.** Today it mixes every database that *defines* the signal,
   including ones whose scoping means they could never decode it — so
   after phase 1, editing a chassis-scoped database still invalidates
   a powertrain signal's pyramid and forces a rebuild that provably
   cannot change a sample. Mix only the applying databases instead.
   A project with no scoping sees no fingerprint change at all (the
   chain is identical), so the one-time rebuild lands only on projects
   that use scoping. **Exception:** a signal with `bus_id: None` keeps
   the whole chain — its frames arrive from every bus and are decoded
   by whichever database applies to each, so its fingerprint must
   cover all of them. Amends ADR 0047.

4. **Phase 1 (decode scoping) is written but not commit-ready.** The
   `&[&Database]` -> `&[DbcScope<'_>]` change is workspace-visible
   through `cannet-gui-lib`: `crates/cannet-perf-measurement/src/
   signal_bench.rs` no longer compiles, so the pre-commit gate
   (`cargo clippy --workspace --all-targets -D warnings`) fails.
   Fixing that is part of the first phase's first commit, along with
   these task-doc updates.

## Phases

1. **Bus-scoped pyramid decode.** The decode path takes `DbcScope`s
   and filters per frame through `filter::dbc_applies`; fix
   `cannet-perf-measurement`; tighten the fingerprint per note 3 and
   amend ADR 0047; the parked-pool proof test per note 1; refresh the
   stale rustdoc in `signal_fingerprint.rs` (it still says the decode
   path ignores scoping). Ends with the ADR-0031 gate.
2. **Bus-scoped value tables.** `list_value_tables` takes a `bus_id`
   and resolves through applying databases only, per note 2; `busId`
   plumbed from `useValueTables` and `ColorMapPanel`; tests both
   sides.

## Status log

### 2026-08-19 — phase 1, slice 1: bus-scoped pyramid decode lands green

Branch `task-81-phase-1-bus-scoped-decode`.

What landed:

- `signal_cache::scan_chunk` selects, per frame, the databases that
  pass `filter::dbc_applies(scope.buses, frame.bus_id)` — memoised
  until the frame's bus turns over, so the common unscoped set costs
  one rebuild for the whole chunk. The decode path's parameter is
  `&[DbcScope<'_>]` instead of `&[&Database]` all the way up through
  `slice` / `slice_many` / `min_max_many`; `sampling.rs` passes
  `app_state::dbc_scopes`, the same helper `invalidate_dbcs`,
  `restore` and `persist` already used.
- `crates/cannet-perf-measurement/src/signal_bench.rs` builds
  `DbcScope`s with an **empty** bus list — the bench declares its
  databases unscoped on purpose (it characterizes one signal's
  decimation, so every database should stay a candidate for every
  frame, which is also the eligible set its existing baselines were
  measured against). Without this the workspace clippy gate did not
  compile.
- Rustdoc refreshed where the old behaviour was written down:
  `scan_chunk`'s "Bus scoping" bullet now separates the two questions
  (which frames a *target* takes vs. which databases may decode a
  *frame*), `slice`'s "first DBC that decodes wins" gains "among the
  databases whose bus scoping admits the frame in hand", and
  `signal_fingerprint::dbc_encoding` no longer claims the decode path
  ignores scoping.

Before/after decode comparison (exit criterion), on the two-bus
fixture `a_scoped_database_never_decodes_another_bus`: message 256
signal `A` defined twice — a powertrain-scoped DBC at unit scale, a
chassis-scoped DBC at ×10 — with one frame on each bus carrying raw
`A` = 3 (powertrain) and 4 (chassis).

Experiment: with the `dbc_applies` filter removed from `scan_chunk`
and nothing else changed, run the three scoping tests.

| Series | Before (no scoping) | After |
| --- | --- | --- |
| `chassis` / 256 / `A` | `[4.0]` — unit scale from the *powertrain* DBC, because it loaded first | `[40.0]` — ×10 from the chassis DBC |
| any-bus / 256 / `A` | `[3.0, 4.0]` | `[3.0, 40.0]` — each frame decoded by the DBC that applies to *its* bus |
| any-bus / 256 / `A`, one unassigned frame, one powertrain-scoped DBC | `[3.0]` — decoded by a DBC the frame is outside the scope of | `[]` |

Conclusion: the reported divergence is real and is exactly a
factor-of-scale (and, for signal `B`, an existence) error on a
project that scopes its DBCs. The chassis series read a powertrain
value.

Tests: `cargo test -p cannet-gui` 704 passed / 0 failed / 6 ignored;
`cargo test -p cannet-perf-measurement` 1 passed. Gate
`cargo clippy --workspace --all-targets -- -D warnings` clean.

### 2026-08-19 — phase 1, slice 2: the encoding fingerprint tightens

Grooming note 3, implemented test-first.

- `signal_fingerprint::dbc_encoding` skips a database whose bus scoping
  means it can never decode the series — `filter::dbc_applies(dbc.buses,
  Some(bus))`. A signal with `bus_id: None` keeps the whole chain: its
  frames arrive from every bus and are decoded by whichever database
  applies to each, so all of them bear on its samples.
- ADR 0047 amended (dated line in the status header plus a new
  "Amendment (2026-08-19) — the candidate chain is bus-scoped"
  section). It records the exception and the cost: a project that
  **scopes** a DBC pays a one-time rebuild of the signals whose chain
  shrank; a project that scopes nothing pays nothing, because an
  unscoped database applies to every bus and was never skipped.
- Module and function rustdoc in `signal_fingerprint.rs` follow.

Red-first evidence: with the tests written and the filter not yet
added, `only_the_databases_that_can_decode_the_series_bus_are_in_the_chain`
failed — `d5dabd653c0ffe6b` (pt-scoped database alone) vs
`a3c9fc09168c0bd2` (with a ch-scoped database mixed in). The other two
new tests were green before and after by design: they pin what must
*not* move (the null-bus exception, and three literal fingerprints an
unscoped set produced before the change).

Tests: `cargo test -p cannet-gui` 707 passed / 0 failed / 6 ignored.

### 2026-08-19 — phase 1, slice 3: the parked-cache ruling, proved

Grooming note 1 said "no code change expected". Reality agreed with
both facts; the tests are new, the behaviour is not.

- `one_signal_on_two_buses_parks_as_two_independent_entries` — one
  unscoped database, two series on message 256 signal `A` scoped to
  `pt` and `ch`, one edit under both. Two parks, both named `A`, told
  apart by `bus_id`, with two distinct level-file bases.
- `an_a_to_b_to_a_edit_leaves_one_park_not_two` — build under A, edit
  to B (A parks), rebuild and stamp under B, edit back to A. One park
  remains and it is B's; `revivals == 1`. A third distinct encoding
  (A -> B -> C) is what it takes for one key to hold two parks, and
  the pool then keeps both, per the ruling.

Both passed on first run, so each was falsified to show it is
load-bearing rather than vacuous:

| Injected fault | Result |
| --- | --- |
| `revive_retained` skipped in `invalidate_dbcs` | `retained` 2, expected 1 — the test depends on park-then-revive ordering |
| `SignalKey::dbc` drops `bus_id` | the two buses collapse into one 400-point series (expected 200) — the test depends on the key carrying the bus |

Conclusion: grooming note 1 stands as written. No blocker.

Tests: `cargo test -p cannet-gui` 709 passed / 0 failed / 6 ignored.

### 2026-08-19 — phase 1: ADR-0031 render-tier gate

Two release runs on the real rig, `ev-zonal` (the baseline project —
and one that **scopes** both its DBCs, `pack.dbc` → `pack` and
`zonal.dbc` → `zonal`, so these runs exercise the new scoped path and
the tightened fingerprint rather than the unscoped fast path).

Build `pnpm --dir apps/gui tauri build --no-bundle`; run
`target/release/cannet-gui --project <abs ev-zonal.cannet_prj>
--app-data-dir <isolated, seeded with the operator .window-state.json>
--connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`. Both runs connected
(`ids_measured` 173, rx/tx non-zero — the dongles were free), so
neither is the empty-capture failure mode.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>`: **passed, 31 metrics gated, both runs.**
No baseline was promoted or edited.

| metric | baseline | run 1 | run 2 | worst | limit |
| --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 0.000 | 0.000 | 0.000 | 10.000 |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 |
| lag_ms_max | 10.500 | 3.600 | 1.600 | 3.600 | 41.000 |
| jank_fraction | 0.000 | 0.000 | 0.000 | 0.000 | 0.050 |
| flush_ms_mean | 5.211 | 4.601 | 4.547 | 4.601 | 25.000 |
| flush_ms_max | 23.772 | 14.180 | 13.236 | 14.180 | 72.544 |
| tx_late_ms_mean | 7.600 | 6.676 | 5.471 | 6.676 | 18.000 |
| tx_late_ms_max | 65.695 | 31.975 | 21.357 | 31.975 | 156.391 |
| jsheap_mb_peak | 70.300 | 65.900 | 66.700 | 66.700 | 204.600 |
| jsheap_mb_drift_per_min | 9.547 | 3.935 | 1.750 | 3.935 | 24.094 |
| renderer_mb_peak | 299.363 | 309.453 | 305.051 | 309.453 | 662.727 |
| renderer_mb_drift_per_min | 40.168 | 35.734 | 40.847 | 40.847 | 85.336 |
| host_mb_peak | 59.227 | 67.387 | 59.742 | 67.387 | 182.453 |
| tree_mb_peak | 714.051 | 722.906 | 714.859 | 722.906 | 1492.102 |
| tree_mb_drift_per_min | 67.120 | 66.097 | 76.902 | 76.902 | 139.240 |
| rx_gap_p95_ratio_worst | 1.199 | 1.302 | 1.172 | 1.302 | 2.898 |
| rx_gap_short_frac_worst | 0.008 | 0.012 | 0.004 | 0.012 | 0.046 |
| rx_fps_retention | 0.998 | 0.996 | 0.998 | 0.996 | ≥0.800 |
| tx_fps_retention | 1.001 | 1.001 | 1.002 | 1.001 | ≥0.800 |

Rates: rx 1589.1 / 1605.9 fps, tx 1598.6 / 1610.6 fps against the
1608 ± 15 % band.

Reading it: the metrics the decode hot loop actually moves —
`flush_ms` and `tx_late_ms`, mean and max — are **below** baseline on
both runs (means 4.57 ms and 6.07 ms vs 5.21 and 7.60), so the
per-frame `dbc_applies` selection costs nothing measurable. It is
memoised until a frame's bus turns over, and frames of one message
arrive on one bus, so the common cost is one list rebuild per chunk.
The rows above baseline are all memory tiers (`host_mb_peak` +13.8 %
worst-to-worst, `tree_mb_drift_per_min` +14.6 %) and `rx_gap`
(+8.6 %), each far inside its limit and each varying more between my
own two runs than against baseline — run-to-run noise, not a signal.

Reports were written outside the repo: the owner deleted the historical
`docs/performance-measurements/frontend/*.json` set in `292f3051`, so
this phase records the numbers here rather than re-adding files there.

### 2026-08-19 — phase 2, slice 1: `list_value_tables` resolves per bus (host)

Branch `task-81-phase-2-bus-scoped-value-tables`, from
`task-81-phase-1-bus-scoped-decode`.

- `list_value_tables` gains `bus_id: Option<String>`, split into the
  `#[tauri::command]` and a testable `list_value_tables_inner` —
  matching `describe_message`/`decode_frame`/`encode_frame`'s existing
  `_inner` split in `dbc_commands.rs`. The DBC-backed branch resolves
  only through databases `filter::dbc_applies` admits for the bus,
  first-match-wins within that admitted set; the file-backed branch is
  unaffected (no DBC bears on a file-backed series). `bus_id: None`
  ("the bus is unknown", not "on no bus" — grooming note 2) keeps the
  pre-scoping first-match-across-all-databases behaviour rather than
  `dbc_applies`'s literal (scoped-out) answer, mirroring phase 1's
  any-bus rule for the encoding fingerprint.
- `AppState::first_dbc` is left alone; the bus-scoped branch filters
  `state.databases()` directly, the same shape `resolve_effective_calc`
  uses for its own bus-scoped resolution.

Before/after value-table lookup (exit criterion), on a two-bus fixture
(`list_value_tables_inner_resolves_per_bus`): message 256 signal `A`
defined twice — a `p`-scoped DBC with `VAL_` table `{0: Park, 1:
Drive}`, a `c`-scoped DBC with `{0: Open, 1: Closed}`.

| Query | Before (no scoping) | After |
| --- | --- | --- |
| bus `p` | `[Park, Drive]` (p.dbc loads first) | `[Park, Drive]` (unchanged — p.dbc is also the one that applies) |
| bus `c` | `[Park, Drive]` — **wrong**, p.dbc answers regardless of bus | `[Open, Closed]` — c's own table |
| bus `None` | `[Park, Drive]` | `[Park, Drive]` (unchanged — null-bus keeps first-match-across-all, per the ruling) |

Red-first evidence: with `bus_id` plumbed through but the filter not
yet added, `list_value_tables_inner_resolves_per_bus` failed on the
bus-`c` query:

```text
assertion `left == right` failed
  left: ["Park", "Drive"]
 right: ["Open", "Closed"]
```

(`tests.rs:996`) — `p.dbc` answered because it loaded first, exactly
the seam grooming note 2 describes. Adding the
`filter::dbc_applies(&d.buses, bus_id)` filter turned it green.

Tests: `cargo test -p cannet-gui` 710 passed / 0 failed / 6 ignored.
Gate `cargo clippy --workspace --all-targets -- -D warnings` clean;
`cargo fmt --all` clean.

Commit `4515ca6e` "list_value_tables resolves per bus".

### 2026-08-19 — phase 2, slice 2: `busId` plumbed through the frontend

- `useValueTables` — the one fetch every enum-label consumer routes
  through (`PlotArea`, `PlotPanel`, `ColorMapPanel`'s target-signal
  readout, `RbsPanel`, `TransmitSignalsTable`) — sends `busId:
  s.busId` on its `list_value_tables` invoke.
- `ColorMapPanel`'s other call site, the direct `invoke` in
  `onPickSignal`, sends `busId: d.bus_id` from the catalog descriptor
  it already has in hand.
- Grepped `apps/gui/src` for `"list_value_tables"`: no other direct
  caller exists — every other panel reaches the command through
  `useValueTables`, so these two edits cover the whole frontend.

Red-first evidence: `useValueTables.test.ts`'s file-backed-vs-DBC-backed
assertion (updated to expect `busId`) and a new test sending two
signals with different `busId`s both failed before the hook sent the
field:

```text
Received:
  1st spy call:
  Array [ "list_value_tables", Object {
-   "busId": "powertrain",
    "extended": false,
    "fileBacked": false,
    "messageId": 100,
    "signalName": "Gear",
  } ]
```

Tests: `pnpm --dir apps/gui test` 2234 passed (165 files). `pnpm --dir
apps/gui build` clean (`tsc -b && vite build`).

Commit `66c91fc6` "Plumb busId through list_value_tables' frontend
callers".

### 2026-08-19 — phase 2: ADR-0031 render-tier gate

Two release runs on `ev-zonal`, same procedure as phase 1: fresh
`pnpm --dir apps/gui tauri build --no-bundle` (binary timestamped
after both commits above), the same operator-local seeded app-data dir
phase 1 left in place (outside the repo, reused as-is), same flags
(`--connect-on-start --perf-capture-secs 60 --perf-interact scrub
--expected-rx-fps 1608 --expected-tx-fps 1608`). Both runs connected
(`ids_measured` 173, rx/tx non-zero — the dongles were free): run 1 rx
1573.2 / tx 1609.8 fps, run 2 rx 1599.6 / tx 1608.4 fps, both inside
the ±15 % band — neither is the empty-capture failure mode.

`cargo run --release -p cannet-perf-measurement -- check
--frontend-report <report>` against the untouched
`docs/performance-measurements/baseline.json`:

| metric | baseline | run 1 | run 2 | worst | limit | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| longtask_ms_per_s_mean | 0.000 | 0.000 | 0.000 | 0.000 | 10.000 | ok |
| longtask_ms_per_s_p95 | 0.000 | 0.000 | 0.000 | 0.000 | 17.000 | ok |
| lag_ms_max | 10.500 | 13.000 | 22.100 | 22.100 | 41.000 | ok |
| jank_fraction | 0.000 | 0.000 | 0.000 | 0.000 | 0.050 | ok |
| flush_ms_mean | 5.211 | 4.986 | 4.417 | 4.986 | 25.000 | ok |
| flush_ms_max | 23.772 | 16.501 | 16.221 | 16.501 | 72.544 | ok |
| tx_late_ms_mean | 7.600 | 6.837 | 5.633 | 6.837 | 18.000 | ok |
| tx_late_ms_max | 65.695 | 60.133 | 22.847 | 60.133 | 156.391 | ok |
| jsheap_mb_peak | 70.300 | 69.200 | 70.500 | 70.500 | 204.600 | ok |
| jsheap_mb_drift_per_min | 9.547 | 2.557 | 8.903 | 8.903 | 24.094 | ok |
| renderer_mb_peak | 299.363 | 297.195 | 304.664 | 304.664 | 662.727 | ok |
| renderer_mb_drift_per_min | 40.168 | 40.433 | 45.624 | 45.624 | 85.336 | ok |
| host_mb_peak | 59.227 | 59.258 | 58.250 | 59.258 | 182.453 | ok |
| tree_mb_peak | 714.051 | 714.984 | 715.031 | 715.031 | 1492.102 | ok |
| tree_mb_drift_per_min | 67.120 | 72.259 | 75.747 | 75.747 | 139.240 | ok |
| rx_gap_p95_ratio_worst | 1.199 | 2.150 | 1.166 | 2.150 | 2.898 | ok |
| rx_gap_short_frac_worst | 0.008 | 0.097 | 0.004 | 0.097 | 0.046 | **REGRESSED** |
| rx_fps_retention | 0.998 | 0.993 | 0.997 | 0.993 | ≥0.800 | ok |
| tx_fps_retention | 1.001 | 1.002 | 1.000 | 1.000 | ≥0.800 | ok |

Run 1 alone: `check` exits non-zero on `rx_gap_short_frac_worst`
(0.097 vs limit 0.046). Run 2 alone: `check passed (27 metrics
gated)` — the `grpc` mode was skipped that run ("virtual-bus server
exited before binding," a harness-side teardown hiccup unrelated to
this phase's change, not one of run 2's 27 gated metrics). **Comparing
worst-to-worst, the gate fails**: `rx_gap_short_frac_worst` 0.097 >
limit 0.046. No baseline was promoted or edited; every other metric —
18 of 19 frontend rows, plus every tracebuffer/hardware-peak row —
passes on both runs.

Observation: both runs' worst offender is the same id, `zonal/0x10E`
(`PackCurrentHiRes`, `GenMsgCycleTime` 10 ms, pack-bus-scoped) — run 1
`worst_short_frac` 0.097, run 2 0.004, baseline 0.008. The two runs of
the identical binary disagree by ~24x on this one id.

Hypothesis: this is run-to-run rx-side jitter, not a regression this
phase's code introduced — `list_value_tables` is a UI enum-label
lookup command, never called on the frame-ingest path `rx_gap`
characterizes (CAN-frame inter-arrival timing at the sidecar, upstream
of any DBC or value-table lookup). Supporting data: `flush_ms` and
`tx_late_ms` (the metrics a decode-path change would move, per phase
1's own reading) sit at or below baseline on both runs, the same
pattern phase 1 found for its own scoping change.

This hypothesis is **not** confirmed by a falsifying experiment in this
phase — no third run and no controlled A/B against the pre-phase-2
binary were taken, so it stands as a hypothesis, not a conclusion.
Recorded as an open finding rather than waived or fixed; see
Blockers.

Tests/gate summary: host 710 passed / 0 failed / 6 ignored; frontend
2234 passed; render-tier gate **worst-to-worst FAILED** on
`rx_gap_short_frac_worst` (1 of 19 frontend metrics).

### 2026-08-19 — task 81 exit-criteria walk (phase 2, not a completion declaration)

Per the task's exit criteria, with phase 1 + phase 2 evidence. This is
a status check, not a completion call — that is the overseer's, with
the owner.

1. *"The pyramid decode consults the same `dbc_applies` scoping as
   every other decode consumer; a signal scoped to bus A is never
   decoded by a DBC scoped only to bus B; tested."* — **Met**, phase 1.
   Evidence: `signal_cache.rs::a_scoped_database_never_decodes_another_bus`
   and its siblings; phase 1 slice 1's before/after table (2026-08-19,
   above) showing the chassis series stops reading the powertrain
   DBC's value.
2. *"`list_value_tables` resolves per bus; lanes/labels on two
   differently-scoped buses read their own tables; tested."* —
   **Met**, phase 2. Evidence:
   `dbc_commands.rs::list_value_tables_inner_resolves_per_bus` (host)
   and `useValueTables.test.ts`'s `busId` assertions (frontend), this
   entry.
3. *"The behavior change is called out in the status log with a
   before/after decode comparison on a two-bus fixture."* — **Met**.
   Phase 1 slice 1 has the decode before/after; phase 2 slice 1 (above)
   has the value-table-lookup before/after on the same shape of
   fixture.

Outstanding, not an exit criterion but load-bearing for the overseer's
call: the ADR-0031 gate's worst-to-worst failure on
`rx_gap_short_frac_worst` (above) is unresolved — hypothesized as
unrelated environmental jitter, not confirmed.

### 2026-08-19 — `rx_gap_short_frac_worst` ungated (owner ruling, out of scope)

Not part of this task's exit criteria — an owner ruling on the open
finding above (the phase-2 ADR-0031 gate's worst-to-worst failure), and
the overseer control measurement that resolved it as environmental
(15 further captures, both branches, spread 0.0022-0.0967 with no code
regression present). The owner's disposition of that finding:
`rx_gap_short_frac_worst` **stops being a gate** — it cannot be resolved
on a desktop PC, or at least not on every desktop PC, so gating on it
wastes review time. It stays measured and reported.

Landed on branch `task-81-phase-2-bus-scoped-value-tables` (continuing
this task's branch, since the finding surfaced here, though the fix
itself is unrelated to bus-scoped decode):

- `Verdict` (`crates/cannet-perf-measurement/src/check.rs`) gains an
  `advisory: bool` field. `rx_gap_short_frac_worst`'s row in
  `check_frontend` (`frontend.rs`) sets it `true`; every other verdict
  in the crate sets it `false`. `main.rs`'s aggregate pass/fail and its
  "N metrics gated" count both filter `!v.advisory`; the printed table
  shows `advisory` in the result column instead of `ok`/`REGRESSED` for
  that row — still visible, never gating.
- `rx_gap_gates_catch_on_wire_bunching` (the failing-case test at
  `frontend.rs:955`, formerly ~932) now covers only
  `rx_gap_p95_ratio_worst`, which stays a real gate. A new test,
  `rx_gap_short_frac_worst_is_advisory_not_a_gate`, proves the metric is
  still computed and reported at the same baseline/current/limit values
  a gated row would carry (including that a breach still reads `pass:
  false` on the row itself), and that the breach does not fail the
  aggregate `check` a caller would compute by excluding advisory rows.
- ADR 0031 amended (dated status-header line plus a new "Amendment
  (2026-08-19)" section): records the control-measurement evidence,
  names which gate families are trustworthy on a desktop rig vs.
  advisory, and notes that a future `_worst`/`_peak` gate wants the
  median-across-reports treatment already used for `_mb_drift_per_min`,
  with a 3-run minimum.
- No baseline touched; no other metric's limit changed.

Tests: `cargo test -p cannet-perf-measurement` 48 passed / 0 failed (was
47; net +1 across the split test). `cargo test -p cannet-gui` 710 passed
/ 0 failed / 6 ignored (unchanged — no host code outside
`cannet-perf-measurement` touched). Gate
`cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo
fmt --all` clean.

### 2026-08-19 — `rx_gap_short_frac_worst` re-gated, superseding the advisory treatment (owner ruling)

Supersedes the entry above: the owner corrected the advisory framing —
*"it's not advisory as much as it is optimized and noisy. It should not
get worse."* `rx_gap_short_frac_worst` is a real gate again, with its
limit set by the ~28% regression it must catch rather than by
`baseline x factor` off the last run. Landed on branch
`task-86-phase-2-reglate-rx-gap-short-frac` (not this task's branch —
recorded here because this is where the finding and the ungating are
recorded):

- `ftol::RX_GAP_SHORT_FRAC_FLOOR` (`crates/cannet-perf-measurement/src/frontend.rs`)
  rises from 0.03 to 0.15, giving a limit of `baseline * FACTOR + floor`
  = 0.008 * 2 + 0.15 = ~0.166 at the 0.008 baseline: above the worst of
  the 15 healthy same-rig runs (0.097), below the ~28% cohort
  regression. `rx_gap_short_frac_worst`'s row sets `advisory: false`
  again.
- The `advisory` mechanism itself (`Verdict::advisory`,
  `main.rs`'s filtering) stays — it has no user now, but removing it
  would only mean re-inventing it if a metric ever genuinely needs it.
  Its doc comment no longer implies `rx_gap_short_frac_worst` is that
  user.
- `rx_gap_short_frac_worst_is_advisory_not_a_gate` becomes
  `rx_gap_short_frac_worst_gates_the_cohort_regression`: proves a ~28%
  reading fails the new limit and the observed 0.097 healthy-run worst
  passes it.
- ADR 0031's 2026-08-19 amendment rewritten in place (not a new
  amendment) to state the corrected rule: what the gate is for
  (regressions that stack into something felt, not sub-5 ms per-frame
  deltas), how the limit is set (by the regression magnitude, not
  `baseline x factor`), and the load-bearing anti-creep rule — a gate
  limit ratchets down only, and raising one needs an owner ruling
  recorded in the ADR.
- No baseline touched; no other metric's limit changed.

Tests: `cargo test -p cannet-perf-measurement` 48 passed / 0 failed
(unchanged count — a test rename, not a net addition). `cargo test -p
cannet-gui` 717 passed / 0 failed / 6 ignored (unchanged by this
change; the branch's higher count than the entry above reflects other
work already landed on this session's chain). Gate
`cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo
fmt --all` clean.

## Blockers / side effects

Phase 1 hit no blockers. Side effects worth the next phase's
attention:

- **A scoped project pays a one-time pyramid rebuild** on first launch
  after this change, for the signals whose candidate chain shrank (ADR
  0047's 2026-08-19 amendment). Their old pyramids park rather than
  being deleted, so the disk is reclaimed by the pool's byte bound
  rather than immediately. An unscoped project pays nothing.
- **`crates/cannet-perf-measurement` declares its example DBCs
  unscoped**, though `examples/ev-demo` scopes them (`pt`, `batt`).
  That is deliberate — the signal bench characterizes one signal's
  decimation and its baselines were measured with every database a
  candidate for every frame — but it means the *bench* no longer
  mirrors what the *GUI* does with that project. If a future task wants
  the bench to measure the scoped path, carrying `buses` onto the
  harness's own `LoadedDbc` is the change, and it invalidates the
  bench's existing numbers.
- **`list_value_tables` is still unscoped**, so a lane's labels can
  still come from a database that cannot decode the series. That is
  phase 2 and is unchanged by this phase.
  **Resolved by phase 2** (2026-08-19): `list_value_tables` now takes
  `bus_id` and resolves through `filter::dbc_applies`-admitted
  databases only, per the status log entries above.

Phase 2 hit one open finding, unresolved at hand-off:

- **ADR-0031 render-tier gate, worst-to-worst FAILED on
  `rx_gap_short_frac_worst`** (2026-08-19): run 1 measured 0.097 on id
  `zonal/0x10E` against a 0.046 limit (baseline 0.008); run 2 measured
  0.004 on the same id. Hypothesis recorded in the status log: this is
  rx-side jitter unrelated to `list_value_tables` (a UI enum-lookup
  command with no role in frame ingest, upstream of where `rx_gap` is
  measured), not a regression from this phase's code — supported by
  `flush_ms`/`tx_late_ms` sitting at or below baseline on both runs,
  but **not confirmed by a falsifying experiment** (no third run, no
  A/B against the pre-phase-2 binary). This is a finding for the
  overseer, not something this phase resolved — no baseline was
  promoted or edited, and the code was not changed to chase it. If the
  next investigation reruns the gate, `zonal/0x10E` /
  `PackCurrentHiRes` (pack bus, `GenMsgCycleTime` 10 ms) is where to
  look first.

  **Resolved — environmental, not attributable** (overseer control
  measurement, 2026-08-19). 11 further captures on the same rig, same
  session: 7 on the phase-2 binary (bit-identical to the one that
  failed) and 4 on a freshly-built phase-1 control. The spike did not
  reproduce on either branch; both branches' gates pass on the
  untouched baseline (phase-2 7 reports, 141 metrics gated, exit 0;
  phase-1 4 reports, 87 metrics gated, exit 0).

  The falsifying datum: ordering all 15 runs by `rx_fps`, the two
  lowest are the two runs with the highest `short_frac` — and one of
  them is a **phase-1** run (0.012 at 1589 fps), which a
  phase-2-attributable regression cannot produce. The elevated
  short-gap fraction tracks a depressed on-wire receive rate, and it
  occurs on both branches. Supporting: the 4-vs-4 same-session
  distributions are a perfect tie (Mann-Whitney U = 8 of 16; medians
  0.0045 vs 0.0047), and the argmax id shuffles across three ids
  (`0x10F` 8x, `0x10E` 3x, `0x100` 2x) rather than naming one hurt
  signal — the fingerprint of an extreme-value statistic over a
  near-flat field.

- **The gate's own limit for this metric is too tight** (finding about
  the harness, not about this task; for the owner to dispose of).
  `rx_gap_short_frac_worst`'s limit is `baseline x 2 + 0.03` = 0.046
  (`ftol::FACTOR` / `ftol::RX_GAP_SHORT_FRAC_FLOOR`,
  `crates/cannet-perf-measurement/src/frontend.rs`), while 15 healthy
  runs spread 0.0022-0.0967 (44x) with a mode near 0.004 — the 0.008
  baseline was itself captured on a slightly unlucky run. That is a
  ~7 % spurious breach rate per run, ~13 % per two-run phase gate.
  Options: raise the floor (costs sensitivity — 0.097 would need
  ~0.081), or gate it on the **median across the supplied reports**
  the way ADR 0031 already treats the `_mb_drift_per_min` family,
  which is the principled treatment for a statistic that is itself a
  max — though that wants a 3-run minimum to bite. `tree_mb_peak`
  shows the same shape (709-998 MB across 7 runs, well inside its
  limit), so the `_worst` / `_peak` families as a class are
  extreme-value statistics gated as if they were means.

  **Resolved — floor raised, owner ruling** (2026-08-19, see the status
  log entry above). `RX_GAP_SHORT_FRAC_FLOOR` moves to 0.15 (limit
  ~0.166 at the 0.008 baseline), set by the ~28% regression the gate
  must catch rather than by `baseline x factor` off the last run;
  `rx_gap_short_frac_worst` gates again. The median-across-reports
  option remains the documented path if a future `_worst`/`_peak`
  metric needs it (ADR 0031).
