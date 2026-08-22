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

### 2026-08-22 — phase 2: the unresolvable series is visible and repairable

**Verified rather than assumed.** A busless DBC-backed reference already
fell into `ViewSignalStatus::NotDecoded` without a special case:
`describe_on_bus` filters through `filter::dbc_applies`, which answers
`false` for a `None` bus, so nothing defines the signal and `serving` is
`None`. `needs_attention()` counts `NotDecoded`, and the launcher badge
reads that count live with the panel closed
(`viewSignalsAttention.ts`). No code was needed for the status; the
existing test `a_reference_bound_to_no_bus_is_not_decoded` now also
asserts the badge counts it.

**What was missing was the repair, and that is what landed.** The
picker on such a row was *disabled and empty* — `describe_on_bus` on a
`None` bus returns nothing, so there were no candidates. Shipping
phase 1 with that surface would have been the silent emptying in a
different costume: a row that says "Not Decoded" and offers nothing to
do about it.

- `ViewSignalCandidate` gains `bus_id` and `bus_name`. Every candidate
  of an ordinary row carries the row's own bus; a reference that names
  **none** takes its candidates from every bus the loaded databases are
  assigned to, and those are its re-point offers.
- `build_rows` now describes each row on the buses it needs and fills
  the `(bus, message)` memo in a first pass, so the second pass reads it
  by reference — no message descriptor is copied per row.
- `SignalRemap` splits `busId` into `fromBusId` / `toBusId`. This is the
  one remap that moves a bus, and every store the operation reaches
  moves with it: a plot area's series and its `primarySignalKey`, the
  signals view's selection keys and section assignments, a colormap's
  target, and the project's per-signal colour override. A bus re-point
  writes **no** transmit frame — the frame sits on the bus it transmits
  to, which is not the reference being repaired — and `remapSignal`'s
  no-op guard now compares whole identities, so a re-point that only
  moves the bus is a real change while a choice that moves neither is
  still nothing.
- The panel's `<option>` value carries the bus, so a candidate on
  another bus is a distinguishable choice; the choice is an ambiguity
  pick only when it names the row's own signal **on the row's own bus**.
  Cross-bus options are labelled `Bus · database: signal`.
- A row nothing serves now shows a `— not decoded —` placeholder rather
  than letting the browser display the first offer as if it were in
  force. This also affects the pre-existing renamed-signal rows, which
  had the same wart.
- Doc corrections in the same commit: `view_signals`'s module docs (the
  taxonomy's §1 and the list of repairs the panel offers),
  `ViewSignalRef::bus_id`, `ViewSignalsPanel`'s header, `signalRemap`'s
  module doc, and `plotPanelConfig.ts`'s `SignalRef.busId`, which said a
  busless series was "kept so plots that pre-date per-bus signal binding
  still sample" — false as of phase 1.

**Mutation evidence.**

- Making `buses_for` return only the row's own bus for a busless
  reference fails `a_reference_bound_to_no_bus_is_offered_the_buses_that_decode`.
- Making it return every bus for *every* reference fails
  `an_ordinary_row_offers_only_its_own_bus`.
- Dropping the `candidate.busId === row.busId` half of the panel's
  ambiguity-pick condition fails
  `re-points every stored reference onto the bus that was chosen` — a
  re-point would silently degrade into a database pick that leaves the
  reference where it was.

**Suites.** `cargo test -p cannet-gui` 893 passed / 6 ignored (891 after
phase 1, plus this phase's two `view_signals` tests);
`cargo test --workspace` green; clippy clean but for the known
`cannet-dbc` warning; `cargo fmt --all -- --check` clean. Frontend
before: 2615 passed / 199 files; after: 2624 passed / 199 files.
`npx tsc --noEmit` and `npx vite build` clean.

### 2026-08-22 — phase 3: the order sweep

**Branch** `task-106-phase-3-order-sweep` from `2158b9c7`. One commit,
doc-only: `4d0e4c8b`, "Order-dependent signal cache reads name why the
order holds."

**Verifying phase 1's premise, not inheriting it.** Phase 1's note
claimed both fills behind `partition_by_t` are ordered (one bus's
frames; one signal channel group) but flagged that as unverified beyond
the signal cache itself. Checked directly: `SignalKey::dbc` no longer
admits a busless target ([`scan_chunk`]'s per-frame bus filter has no
`None` arm), so a DBC-backed pyramid can only ever receive one bus's
frames — confirmed by re-reading `scan_chunk` line by line, not assumed
from the earlier commit message. A file-backed pyramid receives exactly
one MDF signal channel group's `(timestamps_ns, values)` pair per fill
(`fill_file_backed`, one call per group per signal in
`fill_file_backed_signals`), with the incumbent series replaced rather
than appended to on a re-fill — so there is no second call that could
splice a different source's samples into the same pyramid either.

**Sweep inventory.** Every reader of `t_seconds` / a pyramid level found
via `grep -rn "t_seconds"` across `apps/gui/src-tauri/src` plus every
frontend consumer reachable from a signal-cache-shaped payload
(`SampledPoints` / `SignalsSample` / `RawSeries`):

| site | outcome |
| --- | --- |
| `signal_cache::partition_by_t` (the `lower_bound` every level is searched by) | **Already enforced, doc already names why** (phase 1). Re-verified rather than trusted: re-read `scan_chunk`'s bus filter and `fill_file_backed`'s call sites myself (previous paragraph) instead of citing phase 1's say-so. |
| `window_count`, `window_slice`, `evict_below`, `level_points` | **Sound — inherit `partition_by_t`'s invariant**, no fresh assumption of their own. Each already carries (or references) the "non-decreasing" note; left alone. |
| `SignalCache::extrapolated_spans` (`served.first()`/`.last()`/`.windows(2)`) | **Sound.** `served` is `window()`/`window_categorical()`'s output, which is `partition_by_t`-sliced and order-preserving decimation — provably ascending, not a fresh assumption on raw input. Already has an extensive doc comment; left alone rather than padding it further. |
| `signal_sampler::decimate_min_max`, `reduce_transitions` | **Sound.** Both are called only on pyramid-derived slices (`signal_cache.rs:508,568,586`), never on raw trace-store frames despite the module doc's "roughly time-ordered" phrasing being written with the trace store in mind. Bucketing is by index, not by a `t_seconds` search, so an actual dip would degrade approximation quality, not correctness — and after phase 1 the input is exactly ordered anyway. Left alone: the "roughly" hedge is stale flavour text, not a wrong precondition. |
| `SignalCache::latest`, `::rate`, `::time_span`, `::all_samples` | **Fixed.** Each takes level 0's first/last live slot as the series' oldest/newest sample directly (no search), which is exactly the "min/max shortcut" pattern the sweep was told to look for. None said why that was sound. Doc comments now point at `partition_by_t`'s rationale. |
| `SignalCacheStore::time_span` (the multi-key batch aggregator) | **Sound, not touched.** Folds `lo.min(first)` / `hi.max(last)` across each query's own `time_span()` — an explicit min/max fold, correct regardless of any relationship between queries' own spans. |
| `SignalCache::push_sample`, `::extent`, `min_max_many` | **Sound.** Value-range tracking (`lo`/`hi`) is widen-only and never reads `t_seconds` at all. |
| `SignalCacheStore::fill_file_backed`'s doc | **Fixed.** Asserted the incoming order was trustworthy ("the order the reader yields them in") without saying why a reader's order should be trusted. Now states the structural reason: one channel group is one continuously-sampled source, so there is no second stream that could race it the way two CAN adapters do — the same shape of argument `partition_by_t` already makes for the DBC-backed case, made explicit here too. |
| `cannet_spill::SampleSeq`'s own `partition_point` calls (`evict_below`, the private fold helper) | **Sound — different axis.** Both search `cum_cap`, a cumulative-capacity array over segment index, monotone by construction; neither touches `t_seconds`. Same verdict shape as task 91's audit of `cannet-spill`. |
| `cannet-mdf::signals::signal_groups` / `FileSignal::timestamps_ns` ("ascending" doc, no sort call) | **Investigated, not fixed — a boundary call, recorded below.** This is the "reader" `fill_file_backed`'s doc refers to, and it really does just trust on-disk record order with nothing enforcing it. Argued sound (one channel, one source, no interleave mechanism analogous to the bus dip — see the blocker entry) but it is a data-source crate the signal cache reads *from*, not the signal cache or a layer above it, so fixing or further hardening it is outside this phase's stated boundary. |
| `capture.rs::write_mdf_capture`'s frame-timestamp fold | **Sound, not touched.** Folds `start_time_ns.min(frame.timestamp_ns)` over every frame — an explicit min, not a first/last shortcut, so it needs no pyramid ordering at all. |
| `capture.rs::write_mdf_capture`'s signal loop (`points.first()`) | **Sound — correct use of an already-fixed contract.** Relies on `all_samples()`'s now-documented "in time order" guarantee; no fresh assumption of its own, left alone. |
| `signal_fingerprint.rs` | **Nothing found.** No `t_seconds`, no search, no first/last shortcut anywhere in the module. |
| `signal_snapshot.rs`, `view_signals.rs`, `sampling.rs`, `ipc.rs`, `emitters.rs` | **Nothing found.** Each surfaces host-computed fields (`latest`, `rate`, `time_seconds`, `from_seconds`/`last_seconds`) rather than re-deriving anything from a raw sample sequence. |
| `plotData.ts::RawSeries.t` (and `mergeSeries`'s forward sample-and-hold walk over it) | **Fixed.** The interface doc asserted "strictly-increasing" with no reason given. `RawSeries.t` is always one signal-cache key's slice (`PlotArea.tsx`'s `seriesRel` is built straight from `snapshot.byKey`), so it inherits the same per-key guarantee `partition_by_t` establishes host-side. Doc now says so. |
| `plotData.ts::sampleColumns`, `::splitExtrapolatedRows` | **Sound, not touched.** Both already state their ascending-`t`/ascending-`xs` assumption in their own doc comments; they consume the now-justified `RawSeries.t`, not a fresh unverified input. |
| `plotData.ts::lastAtOrBefore`, `::firstAtOrAfter` | **Sound.** Both binary-search `xs`, which `mergeSeries` builds via `[...xsSet].sort((a, b) => a - b)` a few lines above every call — sorted by construction at the call site, not by assumption. |
| `PlotArea.tsx::cacheTRangeFor` (`s.t[0]` / `s.t[s.t.length - 1]`) | **Sound, not touched.** A diagnostic readout already labelled "leftmost and rightmost"; correct consumer of the now-documented `RawSeries.t` contract. |
| `PlotArea.tsx`'s `xs[0]` / `xs[xs.length - 1]` merge-window fallback | **Sound.** `xs` is `mergeSeries`'s own sorted output, not raw input — no assumption, a guarantee it just built. |
| `eventMerge.ts::buildEventMerge` (binary searches over `anchorsAbs`) | **Checked, left alone — different layer.** `anchorsAbs` comes from the host's `frame_indices_at_ns` (the trace-store anchor task 91 already fixed), not from the signal cache, so it is outside this phase's boundary. Its doc's claim ("anchors non-decreasing because events are time-sorted") is true even over a store that dips: for any threshold `x`, the *first* store index with `ts(idx) >= x` is provably non-decreasing as `x` rises, because the set of qualifying indices can only shrink as the threshold rises, and an index that drops out of it can never let a smaller index back in for a larger threshold. Recorded so the "does anything else read `t_seconds` assuming order" question is answered for this site too, without touching trace-store territory task 91 already swept. |

**No defect found above the signal cache itself.** Every site either
inherits a proven invariant, folds explicitly rather than shortcuts, or
was already sound before this branch. The only changes landing are the
five doc comments above (four in `signal_cache.rs`, one in
`plotData.ts`) — no behavioural change, so no new regression test:
there is nothing new to guard, and mutation-testing a doc comment has
no code to break. `partition_by_t`'s own differential coverage (the
task-91-pattern dipping fixtures) already guards the one enforcement
point everything else here depends on.

**No index was built.** The measurement-before-index exit criterion
does not bind: nothing found needed one.

**Suites.** Before: `cargo test -p cannet-gui` 893 passed / 6 ignored
(unchanged from phase 2's count); `cargo test --workspace` green.
After: identical counts — doc-only change. `cargo clippy --workspace
--all-targets` clean but for the known `cannet-dbc` warning; `cargo fmt
--all -- --check` clean. Frontend: 2624 passed / 199 files before and
after (unchanged); `npx tsc --noEmit` and `npx vite build` clean.
`git grep -Ein "task [0-9]|plans/" -- apps/ crates/` empty.

## Blockers / side effects

- **The ruling is unconfirmed by the owner.** Recorded here rather than
  worked around: both commits implement the overseer's recommendation
  verbatim.
- **Phase 3's premise, from evidence rather than assumption.** Phase 1
  makes `partition_by_t`'s precondition true for the signal cache's own
  sequences, and the reason generalises: `SampleSeq` sample order is set
  by whatever fills it, and after phase 1 both fills are ordered (one
  bus's frames; one signal channel group). So phase 3's sweep of *other*
  `t_seconds` readers is about readers of these same now-ordered
  sequences, not about a second source of dips. Not verified beyond the
  signal cache — that is phase 3's job.
- **A pre-existing wart the placeholder fixed as a side effect.** A row
  with candidates but nothing serving it (a renamed signal, not just a
  busless reference) rendered its `<select>` with `value=""` against a
  list of real options, so the browser displayed the first offer as
  selected. Phase 2 could not leave it, because a busless row is exactly
  that shape; the fix applies to the renamed-signal rows too.
- **`examples/ev-zonal/dbc/pack.dbc` and `apps/gui/src-tauri/Cargo.toml`**
  carry line-ending-only working-tree modifications that pre-date this
  branch. Left untouched, unstaged, as instructed.
- **`cannet-mdf::FileSignal::timestamps_ns` is documented "ascending" with
  nothing enforcing it — a real instance of the same defect class, one
  layer below the signal cache.** `signal_groups` (`crates/cannet-mdf/src/signals.rs`)
  walks a channel group's records via `file.next_record` and pushes them
  in on-disk order with no sort and no check. Argued sound rather than
  fixed: a signal channel group is one continuously-sampled channel from
  one source, so — unlike a CAN bus, where two independent adapters feed
  one interleaved queue — there is no second stream whose deliveries
  could race it and produce a dip. But that is an argument about the
  *mechanism*, not a proof about every MDF file an external tool might
  produce, and it is not this phase's to fix: `cannet-mdf` is a data
  source the signal cache reads *from*, not the signal cache or anything
  above it. Left as a finding rather than silently dropped or quietly
  fixed out of scope.
- **`eventMerge.ts` was checked and found sound, but is a different
  layer's territory.** It binary-searches `anchorsAbs`, which comes from
  the trace store's `frame_indices_at_ns` (task 91's fix), not from the
  signal cache. Confirmed correct by a short argument (recorded in the
  sweep inventory above) rather than left unexamined, but not touched:
  fixing or re-documenting trace-store-side code is outside this task's
  "signal cache and above" boundary.
