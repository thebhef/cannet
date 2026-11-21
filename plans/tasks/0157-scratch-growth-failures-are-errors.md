# Task 157 — A Scratch That Cannot Grow Is an Error, Not a Panic

Opened 2026-09-23 by owner ruling while walking task 156's verdict.
Grilled 2026-10-02; two phases. Queued behind the current stack's landing.

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

## Open questions

(none — grilled 2026-10-02, see § Rulings)

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

1. **No panic on the growth path.** cannet-spill's two growth sites
   (`geometric_push_grow`, `grow_fixed`) return `io::Result`; the four
   spill APIs and the three host consumers propagate it
   (`TraceStore::append` → `io::Result<Option<u64>>`); `seg.rs:134`'s
   worker-join `expect` becomes an error too. A failure emits the
   diagnostic ruled above (store, segment path and index, chain length
   and capacity, OS error, lock state) as an error-level system message,
   and the capture stops — phase 1's behaviour until phase 2 lands.
   cannet-spill gains a test-only fault hook on segment creation/growth
   (the deterministic way to inject ENOSPC-class failures; no quotas, no
   real full volumes). Tests: each store's growth failure surfaces as an
   error, the message carries every field, no mutex is poisoned.
2. **Shed and retry.** A raw-store growth failure runs the DS-8 eviction
   for one leading segment and retries, repeating while a segment
   remains; the truncation marker advances; a warning-level message
   names the dropped span and the cause. Derived stores shed in step or
   drop-and-rebuild. Nothing left to shed, or a retry failing after a
   shed → the capture stops with phase 1's error message. README's
   session-buffer passage: the buffer is a ring, growth failure drops
   the oldest, loggers are the durable capture. ADR 0002 DS-8 amended
   (growth failure is a second trigger for the ring). Tests through the
   fault hook: a failure mid-capture keeps the capture running with the
   marker advanced; a single-segment store stops with the error; a
   persistent failure stops after one shed.

Both phases Opus; the spill crate's five chains are the design-heavy
part.

## Exit criteria

1. No panic site remains on cannet-spill's growth path; an injected
   growth failure in any store surfaces as an error and poisons no
   mutex — tests through the fault hook.
2. A growth failure that stops the capture logs the store, segment path
   and index, chain length and capacity, OS error and lock state as an
   error-level system message — host test on an injected failure.
3. A growth failure with history to shed keeps the capture running:
   the oldest segment goes, the truncation marker advances, a
   warning-level message names the dropped span and cause — tests.
4. Nothing left to shed, or a retry failing after a shed, stops the
   capture with criterion 2's message — tests.
5. ADR 0002 DS-8 names growth failure as a ring trigger; README's
   session-buffer passage says the ring drops the oldest and names the
   logger as the durable capture.

## Status log

- 2026-09-23 — opened by owner ruling ("lock only in 156; hardening as
  its own task"); cost carried over from task 156's survey and its
  phase-1 re-check.
- 2026-10-02 — owner order on task 156's acceptance: diagnostic logging
  for growth failures is this task's (§ Rulings, exit criterion drafted).
- 2026-10-02 — grilled (Q1–Q3 in § Rulings); two phases cut; exit
  criteria set.
