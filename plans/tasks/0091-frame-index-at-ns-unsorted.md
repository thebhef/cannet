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
