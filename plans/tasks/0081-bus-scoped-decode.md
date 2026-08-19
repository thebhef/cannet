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
