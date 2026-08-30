# 0122 — A File Keeps What You Wrote

> **Opened 2026-08-26** from the owner's walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 3A — findings
> **3.9, 3.15, 3.30, 3.59** plus one consistency ruling from the same
> conversation. All five are ruled; there are no open questions. One
> phase, one branch, each fix test-first.

Five small fixes in the capture-format layer. The common thread: a file
cannet writes or reads should carry exactly what the user put in it —
no colour quietly dropped, no wall clock lost to a kill, no future
build's keys discarded, no foreign file's disorder trusted into a wrong
plot.

## The five fixes

### 1. A black event survives BLF (3.59)

A `GLOBAL_MARKER` carries two colour fields, so black and uncoloured
are distinguishable as a pair — the loss is two guards of ours, not the
format (owner: *"BLF supports two colors for markers"*):

- `BlfCaptureWriter::append_marker` (`cannet-blf/src/lib.rs`) guards
  the fill branch on `color & 0x00FF_FFFF != 0`, so `#000000` skips it
  and is written byte-identical to an uncoloured marker.
- `marker_color` (`capture.rs`) resolves the fill/foreground pair
  correctly, then discards black on a closing `rgb != 0`.

After the fix a black event is written as white text on a black chip
(`foreground_color = 0xFFFFFF`, `background_color = 0x000000`) —
the same text-on-a-chip reading every other colour uses — and an
uncoloured event keeps the black-on-white build default. No schema
involvement (owner: *"the text block is for fields that don't exist in
the marker format"*).

Flip the pinning test
(`a_black_event_colour_reads_back_uncoloured_from_a_blf_marker_and_survives_in_mdf`):
black now comes back black from BLF too, and the test's rationale
comment ("the record has no third state") is corrected — it was false.
ADR 0057's loss-table row for colour loses its `#000000` exception in
the same commit.

### 2. The BLF anchor reaches disk before `finish` (3.9)

`BlfFileWriter::create` writes an all-zero placeholder header, and the
real `measurement_start_time` lives only in memory until `finish()`
seeks back and rewrites it — so a killed session's `<dest>.part` has no
anchor at all, and a recovered capture is dated from 1970.

Fix: persist the anchor **the moment it becomes known** — one
seek-write of the header when `set_start_if_unset` first latches a
value (for the GUI's path, `create_with_start`, that is at creation).
Once per capture, not per append. Recovery then honours the stated
start with no heuristic anywhere (owner: *"if there's a start
timestamp, honor it. I don't want to do heuristics"*). Old `.part`
files stay undated; nothing can help those.

Test: hard-drop a writer without `finish` after one append, read the
`.part` header, assert the anchor is the declared start rather than
the sentinel. Task 105's recovery log line — which names the lost wall
clock — is updated in the same change: for files this build writes,
the wall clock is no longer lost.

### 3. Foreign sample order is normalised at the boundary (3.15)

`cannet-mdf::signal_groups` builds `FileSignal::timestamps_ns` in file
order with nothing enforcing the documented "ascending". Every
consumer depends on it: the paged window lookup binary-searches, the
pyramid folds index-adjacent points into time-span envelopes, and
uPlot's own contract is ascending x. An unsorted foreign file draws a
silently mislabelled plot.

cannet cannot produce such a file; the import path exists precisely
for files other tools decoded, and MDF does not forbid a descending
master. `absolute_ns`'s clamp can also *manufacture* a descent from a
file with one pre-start sample late in record order.

Fix, in `signal_groups`: an `is_sorted` check per channel (one
comparison per sample, free on well-formed files) and a stable sort of
the `(timestamp, value)` pairs only when it fails. Sorting a signal
series loses nothing — unlike the trace, a series has no arrival
identity (ADR 0024's two timing models). Tests: a generated fixture
whose master descends, and one exercising the clamp case, both
asserting ascending output.

### 4. Unknown block keys round-trip (3.30)

The `cannet-event/1` grammar preserves unknown keys at the text layer,
but `Note` has no field to hold them — so opening and saving a file
written by a future build drops what this build does not understand,
against the groomed rule (owner ruling 2026-08-26: *"preserve them"*).

Fix: a passthrough field on `Note` (unrecognised key/value pairs, in
file order), populated by `event_text::decode`, written back verbatim
by `encode` after the known fields. `#[serde(default)]` so stored
sessions and the frontend twin are untouched — the frontend never
reads it. Task 107's exit criterion 23 ("partially met — true at the
text layer only") goes to met.

Test: decode a block carrying an unknown key, round-trip through
`Note`, assert the key survives in the emitted text.

### 5. `commented_event_type` rides the block on every carrier

Today it is in the `cannet-event/1` block for MDF `##EV`, in the native
record field for BLF `EVENT_COMMENT` (where `comment_text` deliberately
suppresses the block copy), and nowhere for `GLOBAL_MARKER`. Owner:
*"it's fine/more consistent for it to be in every string."* One line in
`comment_text`: stop suppressing the field. The native record field
stays written for foreign readers; the block becomes uniform for ours.
Extend an existing round-trip test to read the value from the block.

## Exit criteria

1. A `#000000` event round-trips through BLF as `#000000`, pinned by
   the flipped test; an uncoloured event still round-trips as
   uncoloured (the control), and ADR 0057's colour row carries no
   exception.
2. A `.part` left by a hard-killed `BlfCaptureWriter` carries the
   declared `measurement_start_time` in its header, pinned by a
   kill-then-read test; a finished file's header is byte-identical to
   before the change.
3. `signal_groups` returns ascending `timestamps_ns` for a fixture
   whose master channel descends and for one with a pre-start sample,
   pinned by tests; a well-formed file's output is unchanged.
4. A `cannet-event/1` block carrying an unknown key survives file →
   `Note` → file, pinned by a test; task 107's exit criterion 23 is
   updated to met.
5. An `EVENT_COMMENT`'s block carries `commented_event_type`, pinned by
   an extended round-trip test; the native field is still written.
6. The full local CI table is green, and ADR 0057 matches the shipped
   behaviour.

## Status log

- 2026-08-27: All five fixes implemented on `task-122-file-keeps` off
  `task-114-one-name` (98791283), each test-first (failing test watched
  red, then green). Full local CI run, all seven jobs green.

  **1. Black survives BLF.** `BlfCaptureWriter::append_marker`'s `color`
  is now `Option<u32>`: `Some(rgb)` fills `background_color` under a
  white `foreground_color` whatever the value, `None` leaves
  `build`'s black-on-white default. The old `color & 0x00FF_FFFF != 0`
  guard could not tell `#000000` from "uncoloured" because the argument
  could not either. `capture::color_to_rgb` returns `Option<u32>` to
  match, and `marker_color` reads any non-white fill as the colour —
  black included — falling back to the foreground only when the fill is
  white (which is still the neutral default and every pre-fill-convention
  marker cannet wrote). The pinning test is flipped and renamed
  (`a_black_event_colour_survives_a_blf_marker_and_an_mdf_event`), its
  false "the record has no third state" rationale replaced, and an
  uncoloured control note added beside the black one in both formats.
  `cannet-blf`'s own writer test gained a third marker asserting the
  `#000000` record shape.

  **2. The anchor reaches disk at latch.** `BlfFileWriter::create` and
  `set_start_if_unset` now share one `placeholder_header(start)` helper;
  the latch does a seek-write of it at offset 0 and seeks back, once per
  file. `set_start_if_unset` returns `io::Result<u64>` (11 call sites
  updated). `finish` is untouched, so a finished file's header is
  byte-identical to before. Pinned by
  `a_killed_writer_leaves_the_anchor_it_latched`, which `mem::forget`s a
  writer after one append and reads the anchor back out of the `.part`.
  `recovered_capture_warning`'s wall-clock clause is now reached only by
  a `.part` an older build left, so
  `a_recovered_capture_says_what_it_recovered` was rewritten: it asserts
  the kill *keeps* the wall clock and no longer says a word about it,
  then zeroes header bytes 40..56 to reconstruct an older build's
  undated `.part` and asserts the clause is still there for that.

  **3. Foreign sample order.** New `signals::sort_by_time`, called per
  channel at the end of `signal_groups`: `is_sorted` (one comparison per
  sample) and, only when that fails, a stable sort of the
  `(timestamp, value)` pairs. New `crates/cannet-mdf/tests/sample_order.rs`
  — a descending master, a pre-start sample late in record order, and an
  ascending control with a tie that pins both the no-op path and the
  sort's stability.

  **4. Unknown keys round-trip.** `Note::unknown_block_lines:
  Vec<String>` (`#[serde(default)]`), filled from `EventText::extra` by
  all three readers (`note_from_marker`, `note_from_comment`,
  `note_from_event`) and written back by `EventText::from_note` after
  the known keys. Pinned by
  `a_block_key_from_a_later_schema_version_survives_a_round_trip`, which
  puts two unknown keys — one before the subject lines, one after — into
  a marker, opens it, resaves it, and reads them back out of the file.

  **5. `commentedEventType` on every carrier.** Rather than the single
  line in `comment_text` the task names, the field moved into
  `EventText::from_note` itself, which is the one place that makes it
  uniform for *every* carrier (the overseer's framing) rather than for
  `EVENT_COMMENT` alone; `events_from_notes`'s now-redundant assignment
  was dropped. Behaviour for the marker carrier is unchanged in practice
  — a marker's note never carries the field — so the two readings differ
  only in where the rule lives. The `EVENT_COMMENT` round-trip test now
  reads the record's native `mCommentedEventType` *and* the block's copy
  off the file.

  Docs in the same commit: ADR 0057 (the colour row loses its `#000000`
  exception and gains the pair-of-fields reason; the schema-version row
  goes from "lost" to "kept (passthrough)"; a new paragraph in § 2 names
  `commentedEventType` as the one deliberate duplicate),
  `docs/blf-feature-support.md` § "What a cannet marker looks like", and
  rustdoc on `cannet-blf`'s crate root, `is_unfinalized` (both), `BlfScan`,
  `FileSignal::timestamps_ns`, `Note::color`, `Note::unknown_block_lines`
  and `recovered_capture_warning`.

  | CI job | Command | Result |
  | --- | --- | --- |
  | comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | no hits |
  | frontend | `pnpm --dir apps/gui test`; `pnpm --dir apps/gui build` | 3043 passed / 223 files; built |
  | python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `ruff format --check .`, `mypy`, `pytest` | 200 passed, no findings |
  | rust | `cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings` | 49 binaries ok; clean |
  | mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample`; `validate_export.py` | OK |
  | rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | clean |
  | sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | smoke ok |

- 2026-08-27: Exit criteria 1-6 met. Task 107's exit criterion 23 has no
  file left to update (the task file is retired); its closure is
  recorded on the `107` row of the acceptance checklist instead — see
  Blockers.

## Blockers / side effects

- **Task 107's exit criterion 23 could not be updated where it lives.**
  `plans/tasks/0107-*.md` was removed when the task landed (the roadmap
  lists only outstanding work), so there is no criterion 23 to mark met.
  Closest faithful reading: the `107` row of
  [`owner-review-queue.md`](../owner-review-queue.md) § Acceptance
  already names "unknown-key round-trip → task 122" as one of its two
  dispositioned criteria, and that row now says task 122 closed it.
- **The queue rows the task's provenance cites (3.9, 3.15, 3.30, 3.59)
  no longer exist.** Same reframe that tasks 115, 117 and 114 hit:
  `owner-review-queue.md` became an acceptance checklist on 2026-08-26.
  Followed their precedent — a `122` row in the `## Acceptance` list,
  closures in this status log.
- **`append_marker`'s signature changed** (`u32` → `Option<u32>`), as did
  `set_start_if_unset`'s return (`u64` → `io::Result<u64>`). Both are
  `cannet-blf` public API; every in-tree caller is updated, and there are
  no out-of-tree consumers.
- No perf capture taken (harness under repair) and no installer built —
  both per the overseer's standing constraints for this phase.
