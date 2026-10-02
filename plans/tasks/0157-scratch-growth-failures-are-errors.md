# Task 157 — A Scratch That Cannot Grow Is an Error, Not a Panic

Opened 2026-09-23 by owner ruling while walking task 156's verdict.
**Needs grilling before implementation.** Queued behind task 156.

## Why

cannet-spill's segment growth panics on I/O failure
(`seg_chain.rs:76` `geometric_push_grow`, `:101` `grow_fixed`), and a
panic under a held lock poisons the host's `databases` mutex and takes
the whole session down (task 156's field log). Task 156 removes the
one cause seen in the field — two cannet processes on one project
cache — with an exclusive lock, and ruled the hardening a task of its
own: a full volume, a removed drive or a scanner's handle still reach
the same panic, and the machine the field capture ran on had ~5 GB
free on its system drive.

## Cost (task 156 § Hardening survey, re-checked by its phase 1)

- 2 panic sites on the growth path; 5 grow call sites (`byid.rs`,
  `sample_seq.rs`, `disk.rs` ×2, `filter_index.rs`).
- 4 spill APIs turn fallible: `RawStore::append`, by-id `push`,
  `SampleSeq::push`, the filter index's `extend` /
  `extend_membership`.
- 3 host consumers: `TraceStore::append` (its `Option<u64>` today
  means "before session"; `session.rs` is the only reader), the signal
  cache's `push_sample` (6 sites), the filter index writer.
- Out of scope: the host's 117 `lock().expect("… poisoned")` sites —
  poisoning is documented as intended policy in `app_state.rs`.
- One `expect` the survey missed, not on the growth path:
  `seg.rs:134`, the `open_segments` worker-join re-panic.

## Open questions (to grill)

1. What does a session do when the scratch cannot grow mid-capture:
   stop the capture with an error, keep running RAM-only from that
   point, or keep running with the raw store frozen at its last
   segment and the live edge only in RAM?
2. Does ADR 0002's accepted-failure stance (SIGBUS on external
   truncation of an ephemeral store) change, or does it stay for
   truncation and narrow only for growth?
3. Is `TraceStore::append`'s return a richer enum (`Appended(index)`
   / `BeforeSession` / `ScratchFailed(err)`) or an `io::Result` around
   the existing `Option`?

## Rulings

- **Growth failures are diagnosable from the log** (owner, 2026-10-02,
  on accepting task 156: "let's make sure we have logging to support
  diagnosis of further similar crashes"). Today cannet-spill emits no
  log line at all, and the field crash reached the rolling log only as
  the panic hook's location, message and backtrace. Whatever shape
  question 1 takes, the failure path reports the store the chain
  belongs to (raw, by-id, sample sequence, filter index), the segment
  path and index, the chain's length and capacity, the OS error, and
  whether this process holds the project-cache lock — as a system
  message at error level, so it reaches the panel and the rolling log.

## Phases

To cut at grooming.

## Exit criteria

To set at grooming; one is fixed by the ruling above:

- A growth failure logs the store, segment path and index, chain
  length and capacity, OS error and lock state as an error-level system
  message — host test on an injected failure.

## Status log

- 2026-09-23 — opened by owner ruling ("lock only in 156; hardening as
  its own task"); cost carried over from task 156's survey and its
  phase-1 re-check.
- 2026-10-02 — owner order on task 156's acceptance: diagnostic logging
  for growth failures is this task's (§ Rulings, exit criterion drafted).
