# Task 106 — The Any-Bus Series, and the Sample Order It Breaks

Opened by the overseer 2026-08-21, out of [task 91](0091-frame-index-at-ns-unsorted.md)'s
audit. Task 91 fixed the trace store's time→index anchor, which
binary-searched a column that is not sorted. The audit then found the
same false precondition one layer up, in the signal cache — and found
that it is reachable only through a legacy shape that
[task 88 phase 2](0088-bus-assignment-governs-decode.md) already
flagged as needing a migration decision.

**Both halves are the same question, so they are one task.**

## The two halves

### 1. The migration decision task 88 phase 2 deferred

A DBC-backed series naming **no bus** (`bus_id: None`) still decodes
samples its fingerprint cannot see. `signal_fingerprint::dbc_encoding`
was made to stop keeping a candidate chain for such a series, and does
— it has no definition at all. The **decode** path was not changed and
did not: `signal_cache::scan_chunk`'s per-target bus filter still
treats a `None` target bus as "take every frame", and each frame is
then decoded by the databases assigned to *its* bus.

So a legacy any-bus series produces samples that no DBC edit can
invalidate — under-invalidation, where the old rule over-invalidated.

Nothing in the app creates such a series any more: the descriptor
universe emits no `bus_id: None` row, the Database panel's drag fans
out over assignments, and the transmit and RBS panels name their row's
bus. It is reachable only from a project saved before per-bus signal
binding, which opens with its databases unassigned and decoding nothing
until the user assigns them.

Phase 2 named the faithful fix and declined to take it: **rule that a
DBC-backed series naming no bus resolves nothing**, and `scan_chunk`'s
`None` target arm goes with it. Not taken there because it would
silently empty every legacy plot series — the kind of redesign that
phase was told to surface rather than make.

Two `signal_cache` tests pin the current behaviour by name:
`an_unscoped_series_decodes_each_frame_by_its_own_bus` and
`bus_id_scoping_keeps_per_bus_series_independent`'s last assertion.

### 2. `partition_by_t` binary-searches a sequence that can dip

`signal_cache::partition_by_t` is a `lower_bound` over a `SampleSeq`'s
`t_seconds`, and its doc asserts the order is non-decreasing:

> Smallest live slot `k` in `[first_slot, level.len())` whose
> `t_seconds` is `>= target` — the partition point of the
> (non-decreasing) `t_seconds` order…

**Bus-scoped series are safe.** `SignalKey` carries `bus_id`, and the
dip [ADR 0024](../../docs/adr/0024-trace-like-view-timing.md) measured
is *between* buses — interleaved deliveries from separate adapters. One
bus's frames arrive in order, so a per-bus series' samples do too.

**An any-bus series is not.** It mixes buses into one sequence, so its
`t_seconds` dips exactly the way the raw trace store's timestamps do,
and the search walks past an exact match the same way task 91's did.
Same defect class, same user-visible shape: a plot window anchored to
the wrong sample, or a sample reported missing that is present.

## Why one task, and why the order matters

**Settling half 1 may dissolve half 2 entirely.** If a DBC-backed
series naming no bus resolves nothing, no mixed-bus `SampleSeq` can
exist, and `partition_by_t`'s stated precondition becomes true rather
than merely asserted — no index, no scan, nothing to build.

So the order is: **decide half 1 first.** Building task 91's
prefix-maximum index into the signal cache before taking that decision
risks paying for machinery the decision deletes.

And if the decision goes the other way — legacy any-bus series keep
decoding — then half 2 is not a one-liner, because **the pyramid levels
above the base aggregate in the same order**. The ordering question has
to be settled for the whole cache, not just for the base level's
search. Task 91's `TsAnchorIndex` is the reference for what that costs:
sampled prefix maxima, 8 bytes per 1024 rows, folded as a delta.

## Open questions for grooming

- **What does a legacy project do on open?** Emptying a plot series
  silently is the outcome phase 2 refused. Is there a migration that
  binds an any-bus series to a bus — the project's only bus, where
  there is exactly one — rather than dropping it? How many buses does
  a pre-binding project typically have?
- **Is the exposure reachable in practice at all?** It needs a project
  saved before per-bus signal binding, opened, *and* its databases
  assigned. If no such project exists outside a test, the honest answer
  may be to delete the path rather than fix it — which is the shape the
  owner has ruled for before: an ill-conceived path gets removed, not
  migrated.
- **Does anything else read `t_seconds` assuming order?** Task 91
  audited the trace store and `cannet-spill`; the signal cache above
  it was out of that task's scope and has not had the same sweep.

## Exit criteria (draft — firm at grooming)

- The any-bus series' decode behaviour is **ruled on and implemented**,
  not left asserted in two places that disagree; the two tests pinning
  today's behaviour are turned around or kept deliberately, with the
  reason recorded.
- No binary search in the signal cache rests on an order nothing
  enforces. Either the precondition is made true, or the search is
  replaced by one that holds without it, checked answer-for-answer
  against a forward scan over dipping fixtures — the standard task 91
  set.
- Any doc comment asserting non-decreasing sample order either
  describes something enforced, or is corrected.
- If an index is built, its cost is measured on a realistic cache, not
  asserted.

## Grooming (overseer, 2026-08-22)

### What the codebase answered

- **`bus_id: None` is not only the legacy path.** `SignalKey` uses it
  for *file-backed* series too (`SignalKey::file` — `slot` is the source
  file's signal-channel-group index, `file_backed: true`). Those are
  "filled once from an imported signal channel group, never from
  frames", so their `t_seconds` follows the source group's own order and
  cannot dip between buses. **The legacy DBC any-bus series is
  therefore the only sequence in the cache that can mix buses**, which
  confirms the task's premise: settle half 1 and half 2 dissolves.
- **A no-bus series already has somewhere to land.**
  `view_signals::ViewSignalStatus::NotDecoded` is the most severe of the
  five states, `needs_attention()` counts it, and the signal-mapping
  launcher badge reads that count live with the panel closed
  (`viewSignalsAttention.ts`). A series naming no bus has no assigned
  databases by construction, so it falls into that state without a
  special case — and the panel is the surface built to repair exactly
  this.
- **The frontend type is already `busId: string | null`** on
  `ViewSignalRef`, and `null` is legitimate there for `fileBacked`
  series. So the fix is not "make the field non-nullable"; it is "a
  DBC-backed target with no bus resolves nothing", enforced where DBC
  keys are built rather than in the shared struct.

### Recommended ruling — half 1

**A DBC-backed series naming no bus resolves nothing. It is neither
migrated nor deleted: it is kept, reported `NotDecoded`, and repaired
by the user in the signal mapping panel.**

This is the faithful fix task 88 phase 2 named and declined, plus the
one thing phase 2 was missing — a place for the user to see what
happened. The three reasons:

1. **It makes the precondition true rather than asserted.** No mixed-bus
   `SampleSeq` can exist, so `partition_by_t`'s doc comment becomes a
   description instead of a hope, and no prefix-maximum index has to be
   built into the cache or its pyramid levels. Half 2 costs nothing.
2. **Nothing is lost silently.** The outcome phase 2 refused was an
   *empty plot with no explanation*. A `NotDecoded` row with an
   attention badge is the opposite of silent, and it is machinery that
   already ships.
3. **A migration would be guesswork.** Binding an any-bus series to
   "the project's only bus" is only unambiguous when there is exactly
   one, and a pre-per-bus-binding project **already opens with its
   databases unassigned and decodes nothing** until the user assigns
   them. The user is doing repair work on such a project regardless;
   inventing a one-bus special case buys a narrow slice of that repair
   at the cost of a permanent legacy read path — which is the shape the
   owner has ruled against before.

The two tests pinning today's behaviour
(`an_unscoped_series_decodes_each_frame_by_its_own_bus` and
`bus_id_scoping_keeps_per_bus_series_independent`'s last assertion) are
**turned around**, with the reason recorded in the test.

*If the owner rules the other way* — legacy any-bus series keep
decoding — half 2 becomes real work: task 91's `TsAnchorIndex` shape
applied to the base level *and* every pyramid level above it, since
those aggregate in the same order. That is the branch this grooming is
asking about, and it roughly triples the task.

### Phases (under the recommended ruling)

| # | Phase | Model | What lands |
|---|---|---|---|
| 1 | A DBC target with no bus resolves nothing | Opus | `signal_fingerprint`'s already-taken position extended to the decode path: `scan_chunk`'s `None`-target arm removed for DBC-backed targets, DBC key construction refusing a busless target, the two pinning tests turned around with their reasons. `partition_by_t`'s doc comment rewritten to describe what is now enforced — separately noting that file-backed `None` is a different thing and stays. |
| 2 | The unresolvable series is visible and repairable | Opus | A busless DBC-backed reference reports `NotDecoded` in the signal mapping panel and counts toward the attention badge, with the panel's source picker able to re-point it at a bus. Verified against a fixture project carrying a busless series. |
| 3 | The order sweep | Sonnet | The audit half 1 does not cover: every other reader of `t_seconds` (and of the pyramid levels) that assumes non-decreasing order — corrected where the assumption is false, documented where it is now enforced. Task 91 swept the trace store and `cannet-spill`; the signal cache above them never had the same pass. |

Phase 3 stays whichever way half 1 is ruled — it is the "does anything
else read `t_seconds` assuming order?" question, and the answer is not
contingent on the ruling.

### Wall clock

Nothing here needs an hours-long run. The exit criterion "if an index
is built, its cost is measured on a realistic cache" only binds under
the *rejected* branch; under the recommended ruling no index is built.

## Status log

### 2026-08-22 — phases 1 and 2 folded into one branch

**Fold, and why.** Phases 1 and 2 land as one branch
(`task-106-any-bus-series`, from `a2c5ed59`), because shipping the rule
without the surface that reports it *is* the silent emptying
[task 88 phase 2](0088-bus-assignment-governs-decode.md) refused to do.
Two commits, each green.

**The ruling being implemented is the overseer's recommendation and the
owner has not confirmed it.** It is implemented as written, unsoftened
and unhedged: *a DBC-backed series naming no bus resolves nothing; it is
kept, reported `NotDecoded`, and repaired by the user in the signal
mapping panel.* The rejected branch's machinery (a prefix-maximum
`t_seconds` index in the cache and its pyramid levels) is **not** built.
If the owner reverses the ruling, this branch's two commits are the
whole of the diff to revert.

### 2026-08-22 — phase 1: a DBC target with no bus resolves nothing

**Landed** (commit recorded below):

- `SignalKey::dbc` takes `bus_id: String`, not `Option<String>`. The
  any-bus series is now unrepresentable rather than merely unused.
  `SignalKey::bus_id` stays `Option<String>` — `SignalKey::file` still
  uses `None`, as task 88's exit-criteria grooming ruled.
- `scan_chunk`'s per-target bus filter lost its `None`-target arm.
  `GroupTarget::bus_id` is `&str`, so there is no arm left to take: the
  invariant is discharged once, in `plan_batch`, where the DBC-backed
  key's bus is read.
- `CacheQuery::key` and `PersistedSignal::key` return `Option<SignalKey>`.
  A busless DBC-backed query answers empty through `slice_many`,
  `min_max_many` and `time_span`, index-parallel with the batch.
- `SignalCacheStore::restore` **drops** a DBC-backed manifest row that
  names no bus, with its files — not restored, not parked, not counted
  as owed a rebuild. Nothing can ever fill it, and parking it would hold
  disk against a definition that can never return. The retention pool
  read out of a manifest is filtered the same way.
- `partition_by_t`'s doc comment now *describes* the order instead of
  asserting it, and says why it holds: a DBC-backed series is scoped to
  one bus and one bus's frames arrive in order (the dip ADR 0024
  measures is *between* buses); a file-backed series follows its source
  channel group's own order; every pyramid level folds the level below
  in slot order.
- The two tests that pinned the old behaviour are turned around, each
  carrying a comment saying what the old rule was and why it changed:
  `an_unscoped_series_decodes_each_frame_by_its_own_bus` is now
  `a_series_naming_no_bus_decodes_nothing`, and
  `bus_id_scoping_keeps_per_bus_series_independent`'s last assertion now
  reads `assert!(any.is_empty())`.
- New: `a_persisted_row_naming_no_bus_is_dropped_rather_than_restored`.
- Stale doc comments corrected in the same commit:
  `filter::dbc_applies`, `ipc::SignalQuery::bus_id`,
  `SignalCacheStore::slice`, `scan_chunk`'s bus-scoping note and
  `SignalKey`'s own rustdoc.
- ~46 incidental test queries that passed `bus_id: None` because it was
  the shortest thing that decoded now name the bus their fixture frames
  actually carry. Three tests over `mixed_capture` (which spreads frames
  across `bus0`/`p`/`c`) gained the assignment set that fixture always
  implied; `one_group_fetches_each_chunk_once_for_all_its_signals` now
  asserts a per-bus split of its frames instead of an any-bus total.

**Does a file-backed target reach `scan_chunk`?** No — checked, not
assumed. `group_keys` filters `!key.file_backed` before any group is
formed, so a file-backed key never becomes a `GroupTarget`;
`ensure_caches` also mints no cache for one. Its samples arrive only
through `fill_file_backed`. So the `&str` bus on `GroupTarget` costs
file-backed series nothing.

**Mutation evidence.**

- *Observation.* `a_series_naming_no_bus_decodes_nothing` and
  `bus_id_scoping_keeps_per_bus_series_independent` were written in
  their new form first and both failed against the unchanged code
  (`888 passed; 2 failed`), then passed after `scan_chunk` changed.
- *Experiment on the restore guard.* Replacing
  `if row.bus_id.is_none()` with `if false && row.bus_id.is_none()`
  made `a_persisted_row_naming_no_bus_is_dropped_rather_than_restored`
  fail with `left: (1, 1, 0) / right: (1, 0, 0)`.
- *Conclusion.* Without the guard the busless row is judged against the
  no-definition fingerprint, fails, and is **parked** — disk held
  indefinitely for a series nothing can revive. The guard is what drops
  it; the test discriminates.

**Suites.** Before: `cargo test -p cannet-gui` 890 passed / 6 ignored;
`cargo test --workspace` green. After: 891 passed / 6 ignored (the one
new test); workspace green. `cargo clippy --workspace --all-targets`
clean but for the known `redundant_closure` in `cannet-dbc/src/tests.rs`;
`cargo fmt --all -- --check` clean;
`git grep -Ein "task [0-9]|plans/" -- apps/ crates/` empty.
