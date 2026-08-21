# Task 90 — Follow-Ups from the 86 / 27 / 87 Cycle

Opened by owner ruling 2026-08-19. The findings tasks 86, 27 and 87
recorded under their `## Blockers / side effects` headings and left
undispositioned, collected as one task; task 88 phase 1 then added
another. Each is independently shippable; they share nothing but their
origin, so they can land in any order.

A fifth finding — the Tauri mock-app test harness failing to load on
Windows — was **moved to [`plans/backlog.md`](../backlog.md) by owner
ruling 2026-08-19**: the testability gap it represents is expected to
dissolve when the host-side model is lifted into its own Tauri-free
crate, so chasing the mock runtime now would be work aimed at the wrong
layer.

All four remaining items are small.

## Item 1 — `WindowedSource` truncates an out-of-order import

**This is read-path data loss and it is the reason this task exists.**
Recorded in [task 87](0087-blf-writer-timestamp-fidelity.md)'s
blockers, from its experiment 8.

`cannet_core::WindowedSource` stops the walk at the *first* frame past
`end_ns` and never calls the inner source again, documented as
"matching a file's arrival-ordered timestamps". Measured on
`examples/time-origins/wall-clock-out-of-order.blf`: importing with
`end_ns = start + 1000 ms` keeps 31 of 121 frames and silently drops
the file's two **earliest** frames (+120 ms, +300 ms) even though both
are inside the requested window.

It is pre-existing and unrelated to task 87's writer clamp — task 87
established that a dip staying above the writer's anchor already
survives into our own files today (its experiment 2), so cannet writes
files that cannet then truncates on import.

**Decided (owner ruling 2026-08-19): read to EOF and skip
out-of-range frames.** A time range returns every frame in that range,
always. The two shapes task 87 named, and why the other was rejected:

- *Walk to EOF and filter* — correct for every input, at the cost of
  reading the whole file when the user asked for a window. Note that
  real multi-bus captures dip ~1.1 s below their own maximum several
  times a minute (ADR 0024), so the early-exit optimisation is already
  wrong on ordinary data, not just on adversarial data.
- *State the truncation in the import dialog* — cheap, and consistent
  with the task 88 ruling that a stated choice is not something to warn
  about. But nothing in the dialog tells the user their file is
  out-of-order, so the "choice" would not be an informed one.

**Measured before deciding (overseer, 2026-08-19).** Two facts settle
the cost argument:

- **The whole file is already read once, before the dialog appears.**
  `cannet_blf::scan_blf` walks to EOF — `capture.rs`'s own comment calls
  the census "exact" and "the one sanctioned extra walk". So walking to
  EOF on the import pass is not a new full-file read in the workflow; it
  is a second pass over a file the OS page cache has just seen.
- **The dialog's range is already correct for an out-of-order file.**
  `scan.rs` accumulates `first`/`last` as `.min()` / `.max()`, not in
  file order. (Task 86 item 2 recorded the file-order assumption as
  load-bearing; that is now stale — it was fixed.)

Together those make the dialog option worse than it first looked: the
range fields show the user a correct window, the user picks inside it in
good faith, and the import then silently drops frames that are inside
the window they were shown. The "stated choice" framing does not apply,
because nothing states it.

The fix itself is two lines in `WindowedSource::next_frame`
(`cannet-core/src/io.rs:125-128`): when a frame is past `end_ns`,
`continue` instead of setting `done` and returning `None`.

No "source declares itself monotonic" fast path (also ruled out): that
is speculative configurability and a second code path to keep honest,
and the census already dominates the cost. Add one only if a
measurement asks for it.

## Item 2 — Two crates ship an example named `gen_time_origin_fixtures`

`crates/cannet-blf/examples/` and `crates/cannet-mdf/examples/`, both
from commit `65207a54`. Cargo links both to
`target/debug/examples/gen_time_origin_fixtures.exe`, so a parallel
`cargo test --workspace` races on that output and fails with
`LNK1104: cannot open file` — observed twice during task 87 phase 2,
naming a different crate each time.

Rename one or both so the output paths do not collide, and check
nothing invokes them by the old name (the fixtures they generate live
under `examples/time-origins/`). `cargo test --workspace --lib --tests`
skips examples and is green, which is why this has been survivable and
also why it is easy to miss.

## Item 3 — `TraceStore::frame_index_at_ns`'s doc comment contradicts its own test

The comment claims "frames are appended in arrival order with monotonic
timestamps". The store's own test in the same file,
`live_edge_is_the_newest_frame_not_the_last_appended_one`, shows they
are not. Recorded from task 87 phase 1's question 3.

A live-capture condition, not one the BLF writer creates. The fix is to
correct the comment to what the function actually guarantees —
**verify the binary search's behaviour against non-monotonic input
first**, because if the code depends on the claim being true this stops
being a comment fix.

## Item 4 — `cannet-spill`'s manifest version is written but never checked

Found by task 88 phase 1 and verified by the overseer 2026-08-19.

`disk.rs` defines `MANIFEST_VERSION: u32 = 3` and stamps it into every
manifest it writes, and the constant's own doc comment states that "a
manifest from before the current layout fails to parse and the caller
wipes the (ephemeral) scratch". `Store::reopen_timed` deserializes the
manifest and **never compares `manifest.version` to
`MANIFEST_VERSION`** — so that claim holds only by accident, when an
older layout happens to be missing a field serde requires. Bumping the
constant does not reject an old scratch.

Consequence that surfaced it: task 88 makes a frame's bus required on
the append path, but reopen maps segments directly and bypasses
`append`, so a scratch written by a pre-rule build can still restore
bus-less frames. They render with an empty bus id rather than
crashing. Task 88's exit criterion is scoped to the append path for
exactly this reason.

**Decided (owner ruling 2026-08-19): check it, and reject on
mismatch.** Compare `manifest.version` to `MANIFEST_VERSION` and return
`Ok(None)`; the caller already treats that as a clean miss and skips the
restore (`trace_store/flush.rs`, `let Ok(Some(..)) = reopen_timed(..)
else { return None }`), so no new machinery is needed and the
constant's doc comment becomes true.

**The version policy, stated so the check does not become a nuisance**
(owner, same ruling): *additive and compatible changes do not rev the
version* — as has always been the case. The constant moves only when an
old scratch genuinely cannot be read by the new code, so the check
rejects exactly the manifests that would otherwise be misread. Write
this into the constant's doc comment alongside the check.

**Alternative home:** [task 61](0061-ingest-perf-round-2.md) owns the
spill record's `bus_id` and will be editing this file anyway — fold it
there if 61 lands first.

## Phases (2026-08-19)

Two, because item 1 is a behavioural fix with a regression test and the
rest is housekeeping. They are independent and can land in either
order.

1. **A time-range import returns everything in the range.**
   `WindowedSource` reads to EOF and skips out-of-range frames;
   `examples/time-origins/wall-clock-out-of-order.blf` becomes the
   regression test (measured: 31 of 121 frames kept, including the loss
   of the file's two earliest frames). Check the MDF import path takes
   the same wrapper, and re-measure the import benchmark, since this
   trades an early exit for a full second pass.
2. **The three housekeeping items**: rename one of the colliding
   `gen_time_origin_fixtures` examples, correct
   `frame_index_at_ns`'s doc comment (verifying the binary search
   against non-monotonic input first — if the code depends on the claim,
   this stops being a comment fix), and add the manifest version check
   with its policy comment.

## Exit criteria (2026-08-19)

- An import window over an out-of-order file keeps every frame inside
  the window; the `wall-clock-out-of-order.blf` case is a regression
  test.
- `cargo test --workspace` (parallel, examples included) is green.
- `frame_index_at_ns`'s documentation states what the function
  guarantees, verified against non-monotonic input rather than assumed.
- A scratch whose manifest version does not match is rejected, or the
  constant's doc comment says what the code actually does.

## Status log

### 2026-08-20 — Phase 1: `WindowedSource` reads to EOF (branch `task-90-phase-1-window-reads-to-eof`)

Branched from `task-88-phase-6-shared-colour-chip` (`52f33652`). One
commit, `3e0b8b7a` — "A time-range import reads to EOF instead of
stopping at the first out-of-range frame":

- `crates/cannet-core/src/io.rs` — `WindowedSource::next_frame`: a
  frame past `end_ns` is now `continue`d instead of setting `done` and
  returning `None`. Struct doc comment rewritten to state the new
  contract (reads to EOF, filters rather than truncates) instead of
  the old "stop after" semantics.
- `crates/cannet-blf/tests/ordering.rs` — new regression test,
  `a_windowed_import_over_the_out_of_order_fixture_keeps_every_frame_in_range`,
  against the committed `examples/time-origins/wall-clock-out-of-order.blf`
  fixture (121 objects, its two earliest events arriving last).
- `crates/cannet-blf/src/lib.rs` — the existing
  `windowed_source_filters_a_blf_import_range_...` test updated: it
  pinned the old truncation ("only the pre-start marker was walked
  past"), which the ruling makes false. Renamed to
  `..._reads_to_eof_and_sees_every_marker`, extended with a frame that
  dips back in range after a past-end frame, and now asserts both
  markers are seen and the dip is kept.
- `apps/gui/src-tauri/src/capture.rs` — `open_log`'s doc comment
  updated to match (markers ride the whole walk, not a prefix bounded
  by `end_ns`).

**Red first.** Changed `windowed_source_stops_at_the_first_frame_past_end_and_never_resumes`
(io.rs) in place to assert the new contract before touching the
implementation:

```
let source = WindowedSource::new(vec_source(&[1, 2, 5, 2]), None, Some(3));
assert_eq!(drain(source), vec![1, 2, 2]);
```

Ran under the old implementation and observed it fail exactly as
predicted:

```
thread 'io::tests::windowed_source_reads_to_eof_and_keeps_a_frame_that_falls_back_in_range' panicked:
assertion `left == right` failed
  left: [1, 2]
 right: [1, 2, 2]
```

Applied the two-line fix; the same test then passed, and the whole
`cannet-core` suite (41 tests) stayed green.

**The measured case, pinned.** Before writing the fixture-level test,
dumped `wall-clock-out-of-order.blf`'s offsets under a scratch test
(discarded, not committed) to get exact numbers rather than guess
them: 121 frames total, 31 with offset ≤ 1000 ms before the old
early-exit point (index 31 is the first > 1000 ms), plus the file's
two earliest frames (+120 ms, +300 ms) arriving as its last two
objects — 33 in range total. That is the number the new test pins.

**Test counts.** `cargo test --workspace --lib --tests`:
**1454 → 1455** passed (0 failed throughout; 9 ignored — includes
`bench_blf_import`), across 35 binaries. `cargo test -p cannet-gui`:
**759 passed / 0 failed / 6 ignored**, unchanged (this phase touches
no `cannet-gui` test file). `cargo clippy --workspace --all-targets`
and `cargo fmt --all -- --check` both clean.

**MDF import shares the same `WindowedSource`, no separate
implementation.** `apps/gui/src-tauri/src/capture.rs`: `open_log`
(BLF) wraps its source at line 155 —
`cannet_core::WindowedSource::new(source, start_ns, end_ns)` — and
`import_mdf` wraps its `MdfCanFrameSource` at line 1035 with the
identical call. `crates/cannet-mdf/src/` has no windowing logic of
its own — grepping the crate for anything window-related returns
nothing. The one `io.rs` fix covers both import paths; no second
implementation exists to fix or record.

**`bench_blf_import` re-measured, release, `--ignored --nocapture`.**
This benchmark does not exercise `WindowedSource` at all (no phase
sets `start_ns`/`end_ns`; every phase walks the whole file
unconditionally), so it is not a direct measurement of this change —
recorded per the phase brief's instruction to verify rather than
assert. Two runs, machine-noise-sized differences, no regression in
either direction:

| phase | before | after |
| --- | --- | --- |
| census | 0.36 s | 0.31 s |
| markers* | 0.45 s | 0.39 s |
| decode | 0.72 s | 0.54 s |
| convert | 0.81 s | 0.69 s |
| full/mem | 2.20 s | 1.62 s |
| full | 7.38 s | 3.83 s |
| full+obs | 5.85 s | 3.87 s |

**`bench_blf_import` re-verified a second time** (foreground, release,
`--ignored --nocapture`, commit `ce24de28` — this branch, correct
checkout confirmed): census 0.40 s, markers* 0.52 s, decode 0.73 s,
convert 0.93 s, full/mem 2.30 s, full 7.44 s, full+obs 7.06 s — within
machine noise of both prior runs above, no regression.

**ADR-0031 render-tier gate.** Release build
(`pnpm --dir apps/gui tauri build --no-bundle`), four 60 s
`--perf-interact scrub` runs against `examples/ev-zonal`
(`docs/performance-measurements/frontend/2026-08-20-ce24de28-p1-run{1..4}.json`,
not committed — review artifacts). `cannet-perf-measurement check`
against the promoted baseline with all four `--frontend-report`s and
`--expected-rx-fps 1608 --expected-tx-fps 1608`:

```
check passed (87 metrics gated)
```

Every host mode (`tracebuffer`, `grpc`, `hardware-peak`) and every
frontend metric across all four runs is `ok`. No baseline promoted, no
limit widened. The two metrics flagged as known-jittery came in inside
their noted bands: `lag_ms_max` worst 26.3 ms (band 1.1–29.4, limit
41), `rx_gap_short_frac_worst` worst 0.005 (band 0.003–0.0105, limit
0.166). `tree_mb_peak` worst 767.7 MB against baseline 714.1 / limit
1492.1 — no repeat of task 88 phase 6's unreproduced 8233 MB spike.
