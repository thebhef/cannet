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
