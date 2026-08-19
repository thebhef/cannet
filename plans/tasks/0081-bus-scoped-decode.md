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
