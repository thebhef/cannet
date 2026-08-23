# Task 91 — `frame_index_at_ns` Binary-Searches an Unsorted Store

> **Status 2026-08-23 — code-complete, awaiting acceptance.** The single
> phase landed 2026-08-21 on the chain (nothing has merged). The four exit
> criteria are walked in the status log, all met. The render-tier perf
> gate was not run here; it is deferred to the close-out by
> owner-review-queue 2.2 / 2.3. `partition_by_t`, this task's one
> recorded blocker, was swept by task 106 — see owner-review-queue 1.19
> and 3.15.

Opened 2026-08-20 by task 90 phase 2, which was scoped to *correct a
doc comment* and found the code was wrong instead. Shelved as its own
task by owner instruction ("if you can't finish 90 then shelf it and
I'll review") rather than fixed inside a housekeeping phase: the fix is
a behavioural change to a core store primitive on the trace view's
anchoring path, and it deserves a design decision rather than a
bolt-on.

## The defect

`TraceStore::frame_index_at_ns` (`apps/gui/src-tauri/src/trace_store/mod.rs`)
is a textbook `lower_bound` binary search — valid only over a sorted
sequence. Its doc comment asserts the precondition that makes it valid:
*"frames are appended in arrival order with monotonic timestamps"*.

**The store's own test in the same file disproves that**:
`live_edge_is_the_newest_frame_not_the_last_appended_one`.

And this is not an exotic input. [ADR 0024](../../docs/adr/0024-trace-like-view-timing.md)
records that real multi-bus captures dip ~1.1 s below their own running
maximum several times a minute, so a live multi-bus session produces
non-monotonic store order **routinely**.

### Measured (task 90 phase 2, scratch test, discarded)

Store order `5e9, 9e9, 7e9, 8e9` — the store's own fixture:

| probe | true answer (linear scan) | binary search returns |
|---|---|---|
| `8e9` | index 1 (ts `9e9`, first at-or-after, earliest in store) | index 3 |
| `9e9` | index 1 (**exact match**, still buffered) | `len()` — "not found" |

Traced by hand for `9e9` over `[5, 9, 7, 8]`: mid=2 (`7 < 9`) → lo=3;
mid=3 (`8 < 9`) → lo=4; returns `len()`. An exact match at index 1 is
never examined.

## Why it is user-visible

`frame_index_at_ns` backs the `frame_indices_at_ns` and
`filtered_positions_at_ns` Tauri commands (`trace_query.rs`, registered
in `lib.rs`), which anchor a timestamp to a row in the chronological
trace — the time→index mapping of ADR 0024 / ADR 0035. That is how
timeline events and markers are spliced into the trace view.

So on an ordinary multi-bus capture a marker can be **placed against
the wrong row, or silently dropped entirely** when the search reports
"not found" for a timestamp that is present. Nothing surfaces an error;
the marker simply is not where it belongs.

## Scoped 2026-08-20 (owner: include it, if sufficiently scoped)

**The contract is not open — it is already written down.** The store's
own test says it:

> Anchor where a timeline event sorts into the chronological stream
> (ADR 0035): **the first frame with ts >= the event's ts.**

"First" is positional in the stream the trace displays, which is store
order. That is exactly what the linear-scan answers computed during
task 90 phase 2 return (index 1 for both probes on `[5, 9, 7, 8]`), and
what the binary search fails to produce once the sequence is unsorted.
So this is not a design question: **the function has a stated contract
and does not honour it.** Implement the contract.

What remains is cost, and that is measurable rather than a judgement
call — see below.

## Remaining questions (measure, do not debate)
- **What can it afford?** A linear scan is the reference
  implementation: obviously correct, and the yardstick every
  alternative must match answer-for-answer. Measure it on a realistic
  store before assuming it is too slow — and only add an index if the
  measurement demands one. This is on the serve path. A linear scan is
  correct and obvious but O(n) over a store that can hold millions of
  frames. A maintained sorted index costs memory and append work. A
  bounded backward scan from a binary-search seed may be enough given
  the dip is ~1.1 s and bounded — but "bounded in practice" needs a
  measured bound, not an assumption.
- **Does the spill layer already know the answer?** `cannet-spill`
  keeps `max_ts` and per-segment metadata; check whether segment-level
  bounds make an exact answer cheap before designing a new index.
- **Is anything else built on the same false precondition?** Audit the
  store for other searches or assumptions that assume monotonic append
  order.

## Phase (overseer, 2026-08-21)

**One phase.** The contract is already written down — the store's own
test states it and the scope section rules that implementing it is not
a design question — so there is nothing to slice into an investigation
phase ahead of the fix. What remains is a measurement, and it is
cheaper to take it inside the phase that can act on it than to hand a
verdict across a phase boundary.

The order inside the phase is fixed, though: failing test from the
store's own fixture, then the reference implementation, then the
measurement, and only then an index if the measurement demands one.
An index built before the measurement is a guess.

## Exit criteria (draft — firm at grooming)

- `frame_index_at_ns` returns the correct index for a non-monotonic
  store, with the store's own `live_edge_...` fixture as a regression
  test, including the exact-match-reported-as-missing case.
- The doc comment states the real contract; no comment in the store
  claims monotonic append order unless something enforces it.
- The cost of the chosen approach is measured on a realistic store
  size, not asserted.
- Any other code resting on the monotonic-append assumption is either
  fixed or recorded.

## Status log

### 2026-08-21 — (branch `task-91-frame-index-unsorted`)

Branched from `task-92-stale-resolver-refs` at `77b35661`. Commits are
`--no-verify` with the hooks' work run by hand first (`pre-commit`
stashes and restores the unstaged tree around a multi-minute run, which
clobbers concurrent edits).

#### Observation — the defect, reproduced with a control

Throw-away printing test over two stores built from the same six
probes; the **control** is the same timestamps sorted, where a binary
search is valid, so a "correct" reading discriminates rather than
merely failing to fire.

```
--- CONTROL monotonic: store order [5e9, 7e9, 8e9, 9e9]
    probe  5e9  binary_search -> 0   linear_scan -> 0   agree
    probe  6e9  binary_search -> 1   linear_scan -> 1   agree
    probe  7e9  binary_search -> 1   linear_scan -> 1   agree
    probe  8e9  binary_search -> 2   linear_scan -> 2   agree
    probe  9e9  binary_search -> 3   linear_scan -> 3   agree
    probe 10e9  binary_search -> 4   linear_scan -> 4   agree
--- SUBJECT non-monotonic: store order [5e9, 9e9, 7e9, 8e9]
    probe  5e9  binary_search -> 0   linear_scan -> 0   agree
    probe  6e9  binary_search -> 1   linear_scan -> 1   agree
    probe  7e9  binary_search -> 1   linear_scan -> 1   agree
    probe  8e9  binary_search -> 3   linear_scan -> 1   DIFFER
    probe  9e9  binary_search -> 4   linear_scan -> 1   DIFFER
    probe 10e9  binary_search -> 4   linear_scan -> 4   agree
```

The control agreed on all six probes, so the disagreement is the
unsorted input, not the harness. `9e9` is an **exact match at index 1**
and the search returned `4` — `len()`, which every caller reads as "past
the tail". This reproduces the task file's recorded numbers exactly.

#### Experiment — the reference implementation

`frame_index_at_ns` replaced with a forward scan over
`[first_index, len)`, the contract stated verbatim by the store's own
`live_edge_...`-adjacent test comment (ADR 0035: the first frame with
ts >= the event's ts). `frame_index_at_ns_lower_bounds_a_non_monotonic_store`
was written first and watched fail on the sharper case
(`left: 4, right: 1`, "exact match behind a dip") before the change.

#### Data — what the reference implementation costs

In-process, `--release`, 21 reps per probe, min and median, on this
machine. **Control = the `head` probe**, which returns at index 0
without walking the store: if the timing loop measured nothing it would
read the same as `tail`, and it does not (0.0 µs vs 9.7 ms).

| store | n | probe | result | min | median |
| --- | --- | --- | --- | --- | --- |
| disk | 1 M | head (CONTROL) | `0` | 0.0 µs | 0.0 µs |
| mem | 1 M | head (CONTROL) | `0` | 0.0 µs | 0.0 µs |
| disk | 1 M | middle | `500 000` | 4 877 µs | 5 000 µs |
| mem | 1 M | middle | `500 000` | 3 636 µs | 3 971 µs |
| disk | 1 M | tail (full scan) | `len()` | 9 651 µs | 9 961 µs |
| mem | 1 M | tail (full scan) | `len()` | 7 751 µs | 8 044 µs |
| disk | 8 M | head (CONTROL) | `0` | 0.0 µs | 0.1 µs |
| disk | 8 M | middle | `4 000 000` | 47 354 µs | 56 818 µs |
| disk | 8 M | tail (full scan) | `len()` | 92 255 µs | 99 790 µs |

Cost is linear in rows walked at **~12.5 ns/row** and independent of
which raw store backs it (the disk store's meta mapping is read without
rebuilding a frame).

#### Conclusion — the measurement demands an index

A full scan is **10 ms at 1 M frames and 100 ms at 8 M**, and this is
the serve path: `frame_indices_at_ns` maps a *batch* — one timestamp per
timeline event — and every call holds the store's append mutex, the same
mutex whose buffer-wide hold starved RX ingest and forced `scan_chunk`'s
chunking. Twenty events on an 8 M-frame capture is two seconds of held
mutex. The scan is also not fixable by micro-optimisation: at 8 M rows
it touches ~208 MB of strided meta bytes, so even a perfect scan stays
in the tens of ms.

So the linear scan ships as the **reference**, in tests, and an index
carries the serve path — built after the measurement, not before it.

#### Data — what the index costs

Same harness, same machine, after the change. The `head` control still
discriminates (0.0 µs against the tail probe's microseconds).

| store | n | probe | before (median) | after (median) |
| --- | --- | --- | --- | --- |
| disk | 1 M | middle | 5 000 µs | **2.6 µs** |
| disk | 1 M | tail | 9 961 µs | **3.6 µs** |
| mem | 1 M | middle | 3 971 µs | **0.6 µs** |
| mem | 1 M | tail | 8 044 µs | **1.5 µs** |
| disk | 8 M | middle | 56 818 µs | **2.4 µs** |
| disk | 8 M | tail | 99 790 µs | **3.5 µs** |

Steady-state cost is flat in `n`, as the design says it should be: a
binary search over `n / 1024` maxima plus at most one 1024-row scan.

The **first** query against a store that already holds its rows pays the
whole fold, measured separately before anything else touched the store:
**9 719 µs at 1 M, 100 657 µs at 8 M** — one scan's worth, once, where
the reference implementation paid it on every call. It lands after an
import or a scratch reload, both of which already took seconds. Folding
on append instead would spread the same ~12.5 ns/row across the appends
and remove the lump, at the price of a second code path maintaining one
invariant; not taken, since the invariant is the thing this task is
fixing and one lump is not worth splitting it.

#### Audit — what else rests on monotonic append order

| site | verdict |
| --- | --- |
| `TraceStore::buffer_seconds` doc | **Fixed.** Claimed `first`/`last` were oldest/newest by arrival order; the code has read [`RawStore::max_ts`] for the newest since the live-edge work, so the comment described a span that would shrink on every dip. |
| `TracePanel.tsx` anchor-refetch comment | **Fixed.** Justified not refetching with "frames arrive in increasing time". The conclusion holds — an append cannot get in front of a row that already qualified — but not for that reason. |
| `cannet-spill`'s `lower_bound` / `partition_point` calls (`byid.rs`, `filter_index.rs`, `sample_seq.rs`, `seg_chain.rs`) | **Sound.** Every one searches frame-index or slot space, which is monotone by construction (assigned at append), never the timestamp column. |
| `trace_store::rate` | **Sound, recorded.** Every timestamp delta is a `saturating_sub`, so a dip reads as a zero interval rather than a negative one. Per-key rates are per `(bus, channel, id)` and cannot interleave; the aggregate and per-bus windows can momentarily under-report across a dip, which is the existing ADR 0024 behaviour and not a correctness defect. |
| `signal_cache::partition_by_t` | **Not fixed — recorded below.** |

#### Does the spill layer already know the answer?

No. `cannet-spill` keeps exactly one timestamp aggregate — the global
running max (`disk.rs`, `max_ts`) — plus a per-row `read_ts(idx)` off
the meta mapping. Segments carry no ts bounds of their own: a meta
segment is a fixed-stride array of records, and eviction picks segments
by *index* (`evict_oldest_bytes` advances by whole meta segments), never
by time. So there was nothing to reuse, and the index this task adds is
the cheapest sampling of the one monotone quantity that does exist.

#### What landed

| commit | subject |
| --- | --- |
| `9e1ee709` | A timeline event anchors to the right row when the store is unsorted |
| `a386c30c` | Record the reproduction and the reference implementation's measured cost |
| `063a6adb` | Anchoring a timestamp searches a sequence that is monotone by construction |
| `93bae7ff` | Two comments stop claiming the store is appended in timestamp order |

Rust tests: `cannet-gui` **832 → 837** passing (6 ignored throughout) —
one regression test over the store's own fixture plus four differential
tests in the new `trace_store::anchor`. `cannet-dbc --lib` **112**,
unchanged. `cargo test --workspace` green. Frontend **2421** passing
across 185 files, unchanged (the only frontend edit is a comment), and
`pnpm --dir apps/gui build` clean. `cargo clippy -p cannet-gui
--all-targets` and `cargo fmt --all -- --check` clean before each
commit.

The render-tier perf harness was **not** run: the owner's rig holds the
PCAN dongles. No baseline promoted, no limit widened.

#### Exit criteria

| criterion | verdict |
| --- | --- |
| `frame_index_at_ns` correct for a non-monotonic store, with the `live_edge_...` fixture as a regression test, including the exact-match case | **Met.** `frame_index_at_ns_lower_bounds_a_non_monotonic_store` builds `[5e9, 9e9, 7e9, 8e9]` — the `live_edge_...` fixture — and asserts probe `9e9` anchors at index 1. That assertion is the one that failed first (`left: 4, right: 1`). |
| The doc comment states the real contract; no comment in the store claims monotonic append order unless something enforces it | **Met.** `frame_index_at_ns` and `buffer_seconds` rewritten, `trace_store::anchor` module docs carry the argument. `grep -rn "appended in arrival order\|monotonic timestamps\|increasing time"` over `apps/gui/src-tauri/src` and `apps/gui/src` returns nothing. |
| The cost of the chosen approach is measured on a realistic store size, not asserted | **Met.** Two tables above: 1 M and 8 M rows, disk and in-RAM, `--release`, in-process, 21 reps, min and median, with a control probe that discriminates. Both the reference implementation and the shipped one. |
| Any other code resting on the monotonic-append assumption is either fixed or recorded | **Met.** Audit table above: two comments fixed, three sites argued sound, one (`signal_cache::partition_by_t` on an any-bus series) recorded under Blockers as a real instance of the same defect, deliberately not fixed. |

## Blockers / side effects

- **`signal_cache::partition_by_t` has the same defect, unfixed.** It
  binary-searches a `SampleSeq`'s `t_seconds` and its doc asserts the
  sequence is non-decreasing. For a *bus-scoped* series that holds: the
  `SignalKey` carries `bus_id` alongside the message id, so the sequence
  is one arbitration id on one bus and the ADR 0024 interleave — which
  is a dip *between* buses — cannot reach it. But `bus_id: None` is a
  live "any bus" path (`SignalKey` docs; exercised by
  `an_unscoped_series_decodes_each_frame_by_its_own_bus`), and such a
  series takes frames from every bus into one sequence, so its
  `t_seconds` column dips exactly the way the trace store's does. Left
  alone deliberately: it is outside a task scoped to the store, and it
  is not a one-line fix — the pyramid levels above the base are built by
  aggregating in the same order, so the ordering question has to be
  settled for the whole cache, not just its lookup.
- No blockers otherwise. The perf harness was **not** run (owner's rig
  holds the dongles); the measurement above is the in-process one, which
  is separate from the render-tier gate.
