# Task 156 — Restore From Cache Does Not Crash on a Mapped Segment

Opened 2026-09-23 from ungroomed user feedback (item 13).
**Executes now, downstack of `doc-closeout-2`** (owner ruling
2026-09-23): based on task 155's last branch, with `doc-closeout-2`
restacked on top.

## Why

Reopening a project after importing a BLF of tens of millions of
frames panicked on a tokio worker about half a second after
`restored N frames from prior capture`:

```
location: crates\cannet-spill\src\seg_chain.rs:76:14
message:  cannet-spill: segment I/O failed: Os { code: 1224, kind:
  Uncategorized, message: "The requested operation cannot be
  performed on a file with a user-mapped section open." }
```

followed by `databases mutex poisoned` on every other worker, which
took the session down. `seg_chain.rs:76` is `geometric_push_grow`'s
`create_segment(...).expect(...)`: growing a geometric chain (by-id
posting lists, `byid.rs`; sample sequences, `sample_seq.rs`) opens
the next segment's path with `truncate(true)` and `set_len`s it. OS
error 1224 means that path was **still mapped** by some live
`Segment` — Windows refuses to resize a file with an active section.
So a chain reopened from the cache (`reopen` rebuilds `cum_cap` from
the persisted `len`) decided segment *i* did not exist while a
mapping of segment *i* was alive somewhere: the same chain's stale
instance from before the store swap, a second store instance built
at boot, or a persisted watermark behind the on-disk segment files.
The panic ran under the `databases` lock, which points at the decode
/ sample-sequence path rather than the raw store.

Related: task 143 names "swaps the raw store under a live pump";
task 79 owns restore-then-import. ADR 0002 DS-7 is the reopen
contract.

## Rulings (owner, 2026-09-23)

- **Investigate, then fix the root cause.** Phase 1 reproduces it
  and names the mapping that still held the segment; phase 2 fixes
  that. Reproduce cheaply: at the cannet-spill / trace-store API
  level (reopen a chain from a persisted cache, then push until it
  grows), or by importing a generated BLF and reopening the project
  — never a multi-hour live run.
- **Hardening scope is decided by the verdict**, with the survey
  below as the cost input. The owner asked for the count of places
  the hardening (a segment I/O failure surfaced as an error rather
  than a panic) would touch before ruling on it.

## Hardening survey (overseer, 2026-09-23)

- Panic sites on the growth path: **2** — `seg_chain.rs:76`
  (`geometric_push_grow`) and `seg_chain.rs:101` (`grow_fixed`).
- Grow call sites: **5** — `byid.rs` `push`, `sample_seq.rs` push,
  `disk.rs` (two `grow_fixed` calls: meta and payload families),
  `filter_index.rs` (one).
- Spill APIs that would turn fallible: the raw store's append (behind
  the `RawStore` trait), by-id `push`, sample-sequence push, filter
  index push — **4**, plus the host consumers: `TraceStore::append`
  (today `Option<u64>` meaning "before session"), the signal cache's
  sample writes, the filter index writer.
- Not in the hardening's path: the **117** `lock().expect("…
  poisoned")` sites in the host. `app_state.rs` documents poisoning as
  intended policy (a panic under a held lock is unrecoverable); the
  cascade is a consequence of the panic, not a separate defect.
- Other `expect`s in cannet-spill's non-test code: `disk.rs:588`
  (bus interning cap), `:768` (payload cap), `:813` (clearing
  scratch). Invariant checks, not I/O on the growth path.

## Phases

1. **`task156-restore-crash-investigation`** (base: task 155's last
   branch; may run in a worktree while 155 is in flight and rebase
   after) — a failing test that reproduces OS error 1224 (Windows) or
   its equivalent double-mapping on Linux, the named culprit mapping,
   and the fix proposal with the hardening cost re-checked against
   the survey. Opus.
2. **`task156-restore-crash-fix`** (base phase 1) — the fix the
   verdict names, under the reproducing test; scope of any hardening
   per the owner's ruling on the verdict.

## Exit criteria

- A test reproduces the post-restore growth failure and names the
  mapping that held the segment (phase 1 status log).
- With the fix, reopening a project whose cache holds a large
  restored capture, then appending until a by-id and a sample chain
  grow, does not panic; the reproducing test passes.
- The owner has ruled on hardening with the verdict in hand, and the
  ruling is recorded here.

## Status log

- 2026-09-23 — opened from ungroomed item 13; grooming complete;
  hardening survey recorded; two phases cut.
