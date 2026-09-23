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

- **Held cache directory: refuse immediately** (owner, 2026-09-23,
  on the phase-1 verdict). A second instance opening a project whose
  cache another cannet holds does not wait and does not fall back to
  the in-RAM store: it refuses the project open and says who holds it.
  Rejected: a bounded wait (hides the real state), the RAM fallback
  (opens without history and lets two instances edit one project).
- **The terminating instance leaves a visual cue that it is still
  working** (owner, same ruling). Today the window closes first and
  the host then disconnects, stops loggers, flushes the scratch and
  persists the pyramids in `RunEvent::ExitRequested` (`lib.rs`) —
  ~23 s for a 57 M-frame capture, invisible, which is exactly how the
  field relaunch overlapped it. Phase 3.
- **Hardening is its own task**: task 157 (`0157-scratch-growth-
  failures-are-errors.md`), needs grilling; 156 lands the lock and
  un-ignores the two reproducing tests.

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

1. **`task156-restore-crash-investigation`** — landed 2026-09-23
   (`a76bbcbe`, worktree `cannet-156`, base `task149-units-surfaces`
   pending restack behind task 155): two `#[ignore]`d tests reproduce
   the 1224 panic on both geometric callers; verdict: a second cannet
   process held the mappings.
2. **`task156-cache-lock`** (base phase 1) — an exclusive lock on the
   project cache directory, taken where the scratch is opened
   (`open_trace_store`; a no-sharing open on Windows, `flock(LOCK_EX |
   LOCK_NB)` on POSIX), held for the session and covering the raw
   store, by-id, pyramids and filter index under the same directory;
   a held directory **refuses the project open** with a message naming
   the holder (pid, and the project path); the two reproducing tests
   lose their `#[ignore]` by asserting the refusal instead of the
   truncate; a host test covers refuse-then-release-then-open. ADR
   0002 DS-7 gains the lock as part of the reopen contract; ADR 0042
   (cache keyed on the project) cites it. Opus.
3. **`task156-closing-cue`** (base phase 2) — the window stays up
   while the host finishes: the close request is intercepted
   (`WindowEvent::CloseRequested`, `prevent_close`), the frontend
   shows a closing state ("Closing — writing the capture cache…", with
   what is being done), the shutdown work in `ExitRequested` runs off
   the event loop and the app exits when it is done; a second close
   click during it does nothing. The same cue for the disconnect and
   logger-stop steps, which are bounded already. No new frontend
   state beyond the closing flag (CLAUDE.md § GUI architecture). Opus.

## Exit criteria

- A test reproduces the post-restore growth failure and names the
  mapping that held the segment (phase 1 status log). **Met
  2026-09-23.**
- With the lock, a second `TraceStore` (or process) opening a held
  project cache is refused, and the two phase-1 tests pass un-ignored
  by asserting the refusal.
- Opening a project whose cache another cannet instance holds refuses
  with a message naming the holder; releasing it lets the next open
  succeed (host test).
- Closing the window during a long shutdown flush keeps a visible
  closing state until the host exits; a relaunch during that window
  hits the lock's refusal, not a panic.
- The owner has ruled on hardening with the verdict in hand
  (**ruled 2026-09-23: task 157**), and the ruling is recorded here.

## Status log

- 2026-09-23 — opened from ungroomed item 13; grooming complete;
  hardening survey recorded; two phases cut.
- 2026-09-23 (phase 1, `task156-restore-crash-investigation`) —
  **verdict: a second cannet process held the mapping.** The mapping
  that still held segment *i* was not a stale in-process instance. It
  belonged to the *previous* cannet process, which was still alive and
  still holding every segment file in the same project cache directory
  while the new process restored that directory and grew a chain in it.

  Observation → hypothesis → experiment → data → conclusion:

  - **Observation.** `create_segment` opens with `truncate(true)`, so a
    duplicate mapping is only fatal when the path *exists* at that
    moment. On Windows `remove_file` of a mapped file succeeds
    (POSIX-semantics delete unlinks the name and leaves the mapping on
    the now-orphaned file), so every wipe path in the host is harmless;
    only a path that both exists and is mapped raises 1224. Measured
    directly: with a live mapping, `CREATE_ALWAYS` fails 1224, `set_len`
    to a *smaller* size fails 1224, `set_len` to a larger size succeeds,
    and after the unmap everything succeeds.
  - **Hypothesis 1 (in-process).** Some host path keeps a second live
    store or cache over one directory — the pre-swap raw store, a second
    boot instance, a leaked `SignalCache`.
  - **Experiment 1.** Instrumented `seg.rs` with a process-wide registry
    of live mappings keyed by path (incremented after a successful map,
    decremented in `Segment::drop`) and ran the whole `cannet-gui` and
    `cannet-spill` suites (1339 + 70 tests) with a panic on
    `create_segment` whenever the path was already mapped **and**
    existed.
  - **Data.** Zero hits. The only duplicate mappings anywhere were
    transient ones inside tests that deliberately keep a "prior session"
    store alive beside a "this session" one
    (`signal_cache::tests::a_math_pyramid_is_not_persisted` and
    siblings), and each resolved the moment the older value was dropped.
    Production has exactly one `TraceStore::new_disk` and one
    `SignalCacheStore::new` (`lib.rs:442`, `lib.rs:763`), and every swap
    path — `TraceStore::reroot`, `SignalCacheStore::reroot`,
    `SignalCacheStore::restore`, `invalidate_dbcs` — drops the old value
    before or as the new one lands. Hypothesis 1 **refuted**.
  - **Hypothesis 2 (second process).** A mapping belongs to the file,
    not to the process. Two cannet processes with the same project open
    share one `cache/<project hash>` scratch (ADR 0042), and there is no
    instance guard anywhere in the host.
  - **Experiment 2.** Read the owner's own log,
    `%LOCALAPPDATA%/dev.cannet.app/logs/cannet.log`, around the panic.
  - **Data.** The crashing process started at **17:47:01.954**
    (`crash: rolling log + crash records`, then `opened project
    ct_string.cannet_prj` 17:47:02.555, `startup: interactive`
    17:47:04.117, `restored 57529481 frames ... in 4470 ms`
    17:47:08.583, panic **17:47:09.095**). The *previous* process — the
    one that had just imported that BLF (`Done: 57,529,481 frames`,
    17:46:21) and saved the project (17:46:53) — was still emitting its
    20 s health tick at **17:47:15.902**, six seconds *after* the panic,
    reading `rss_mb=520 tree_mb=522 webview_mb=0[browser=0 renderer=0
    gpu=0 other=0] ui_last_ms=23119`: its webview was gone and its UI
    had been unresponsive since ~17:46:52, but the host process was
    alive and still holding its mappings. It stopped ticking between
    17:47:15 and the next start at 17:47:31. The two processes therefore
    overlapped by at least 14 s, and the second one restored and wrote
    into the first one's scratch. Hypothesis 2 **confirmed**.
  - **Conclusion.** The old process's window had been closed but its
    host had not finished exiting (the shutdown path syncs every segment
    of a ~3 GB scratch); the user relaunched into the same project, the
    new process reopened the same scratch, and its first serve grew a
    geometric chain into a segment file the old process still mapped.

  **Why growth and not the reopen.** Reopening the same files twice is
  legal — `open_segment` never truncates. The collision needs the two
  chains to be at *different* lengths, which is exactly what the
  manifest guarantees: the old process had grown into segment *i* after
  its last flush, so that file exists and is mapped while the manifest
  the new process reopens from still describes a chain one segment
  short. The new chain's next push therefore calls
  `create_segment(path(i))` on a live mapping. The overseer's "persisted
  watermark behind the on-disk segment files" lead is real — it is the
  *enabling* condition — but it is only harmful because a second mapping
  is alive.

  The `pyramids=[live=174 ... revived=62]` lead turned out to be a red
  herring: that health line belongs to a session hours earlier. The
  crashing process's own restore line reads `162 reopened, 0 revived, 0
  rebuilt; reused 432 MB, re-decoding 0 MB` — a clean restore, no
  parking and no revival involved.

  **Reproducing tests.** Both fail today, both are `#[ignore]`d on this
  branch because phase 2 is what makes them pass, both run in ~10 ms
  against the public API, no hardware:

  - `sample_seq::tests::a_reopen_never_truncates_a_segment_another_mapping_still_holds`
    — 65 pushes (segment 0 full, segment 1 created and mapped), reopen
    from the pre-growth length 64, one push. Panics at
    `seg_chain.rs:76:14` with the field's exact message: `cannet-spill:
    segment I/O failed: Os { code: 1224, ... "The requested operation
    cannot be performed on a file with a user-mapped section open." }`.
  - `disk::tests::a_reopened_store_never_truncates_a_segment_another_store_still_holds`
    — the same shape through `DiskRawStore`: 64 frames of id 7, flush
    (the manifest records the one-segment by-id chain), one more frame
    (segment 1 created and mapped), `reopen`, append. Same panic, same
    line — this is the by-id family the field scratch shows.

  Both are written to fail on **every** CI OS, not only Windows: the
  Windows arm is the panic (taken with `catch_unwind` so it reads as an
  assertion), and the POSIX arm is the assertion that the held chain's
  samples survive — on Linux `set_len` on a mapped file succeeds and
  silently zeroes the other chain's segment under it, which is the
  *worse* of the two outcomes.

  **Fix proposal for phase 2** — two parts, in this order:

  1. **An exclusive lock on the project cache directory** (the root
     cause). The scratch is keyed on the project, not on the process, so
     a second instance must not be able to open one that is still held.
     A lock file in the cache dir, opened with no sharing on Windows /
     `flock(LOCK_EX | LOCK_NB)` on POSIX and held for the session, is
     the whole mechanism; `open_trace_store` takes it and, when it
     cannot, the session falls back to the in-RAM store with a
     system-log line naming what happened — the fallback path
     `lib.rs:442` already has. The same lock covers the pyramid scratch
     and the filter index, which live under that directory. **Design
     question for the owner:** on a held directory, fall back to RAM
     (the app runs, that project's history is not there), or refuse to
     open the project and say why?
  2. **The hardening** — a segment I/O failure surfaced as an error
     rather than a panic. It does not fix this bug (with the lock in
     place the case cannot arise), but it is the seatbelt for every
     other way `create_segment` can fail — a full scratch volume, a
     removed drive, a scanner holding a handle — each of which today
     takes the whole session down through the poisoned-`databases`
     cascade rather than costing one view.

  **Hardening cost, re-checked against the survey.** The survey is
  correct on every count it made:

  | Item | Survey | Measured |
  |---|---|---|
  | Panic sites on the growth path | 2 | 2 — `seg_chain.rs:76` (`geometric_push_grow`), `seg_chain.rs:101` (`grow_fixed`) |
  | Grow call sites | 5 | 5 — `byid.rs:278`, `sample_seq.rs:273`, `disk.rs:562` and `:574`, `filter_index.rs:135` |
  | Spill APIs turning fallible | 4 | 4 — `RawStore::append` (`lib.rs:92`, today `-> usize`), by-id `push` (crate-private, reached only through `DiskRawStore::append`), `SampleSeq::push` (public), the filter index's grow site behind `extend` / `extend_membership` (two public fns, one site) |
  | Host consumers | 3 | 3 — `TraceStore::append` (today `Option<u64>`; `session.rs:978` is the one caller that reads it), `SignalCache::push_sample` (6 call sites in `signal_cache.rs`), the filter index writer |
  | Other non-test `expect`s in cannet-spill | 3 | 3 invariant checks (`disk.rs:588`, `:768`, `:813`) **plus one the survey missed** — `seg.rs:134`, the `open_segments` worker-join re-panic. Not on the growth path and not I/O, but it is a fourth panic in non-test code |

  The 117 `lock().expect("... poisoned")` sites stay out of scope, as
  the survey says: the cascade is a consequence of the panic, not a
  separate defect.

## Blockers / side effects

- 2026-09-23 (phase 1) — **nothing stops a second cannet instance from
  opening a project another instance still holds.** That is this task's
  root cause, but its blast radius is wider than the segment files: the
  two processes also share one rolling log (`cannet.log` carries both
  sessions' lines interleaved, which is why the health counters appear
  to jump), one pyramid manifest, and one `signals/` directory whose
  wipe paths delete files the other process is mapping. Whatever phase 2
  does about the lock, the log interleaving stays until something
  separates the two.
- 2026-09-23 (phase 1) — **on Linux and macOS the same defect corrupts
  silently.** There `set_len` on a mapped file succeeds, so the second
  process zeroes the first's segment under its live mapping instead of
  failing. The Windows panic is the *benign* arm of this bug.
- 2026-09-23 (phase 1) — **the closing process holds its mappings for
  seconds after its window is gone.** In the field log the old process
  kept ticking for ~23 s after its UI went unresponsive, with its
  webview already at zero. Anything that only watches for the window to
  close (including the user) will see the app as "closed" while the
  scratch is still held. Worth a look in phase 2: whether the shutdown
  sync of a multi-GB scratch can release mappings earlier.
- 2026-09-23 (phase 1) — **two reproducing tests are `#[ignore]`d** on
  `task156-restore-crash-investigation`; they fail by design until phase
  2 lands. CI runs `cargo test --workspace` without `--include-ignored`,
  so they are inert until the attribute comes off.
- 2026-09-23 (phase 1) — **the machine's C: drive is full** (931 GB
  total, ~5 GB free; `Docker` 252 GB and `Packages` 183 GB under
  `%LOCALAPPDATA%` dominate, and `.../repo/cannet/target` is 46 GB).
  Linking `cannet-gui`'s test binary failed with `os error 112` until
  the phase worktree's own `target/` was cleaned and rebuilt with
  `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`. Nothing
  outside the phase worktree was deleted. Any phase needing a release
  host build will hit this first.
- 2026-09-23 — **phase 1 reviewed and accepted** (overseer): one
  commit, two `#[ignore]`d reproducing tests, comment-references grep
  clean; verdict is the previous process's mappings. Owner rulings on
  the verdict recorded above (refuse immediately; a closing cue; the
  hardening becomes task 157). Phases 2 and 3 cut; phase 2 launched.
