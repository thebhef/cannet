# Task 91 — `frame_index_at_ns` Binary-Searches an Unsorted Store

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
