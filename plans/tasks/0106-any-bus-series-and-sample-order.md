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
