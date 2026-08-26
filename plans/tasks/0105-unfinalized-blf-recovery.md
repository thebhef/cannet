# Task 105 — A BLF Whose Writer Never Finalized

> **Status 2026-08-23 — code-complete, awaiting acceptance.** Opened
> 2026-08-20, groomed 2026-08-21; **all three phases landed 2026-08-21**
> on the chain (nothing has merged). **The exit criteria below were never
> walked** — the three phase entries supply the evidence in prose, but no
> per-criterion verdict was written (owner-review-queue 3.45). Findings
> still owed a verdict: owner-review-queue 3.9, 3.10, **3.58**.

Recorded from an owner report; the investigation below is what the
overseer established before grooming, not a settled diagnosis.

## The report

A BLF produced by a process that crashed cannot be opened. From another
agent's note on the file in question:

> `BLFWriter` writes the 144-byte file header with placeholder zeros at
> open and only fills in object count, file size, uncompressed size and
> stop timestamp in `stop()`. Killing the runner skips that, so Vector
> tools see a zero object count and call the file corrupt. Frame data
> is fine: the writer flushes a compressed `LOG_CONTAINER` every
> 128 kB, so everything except the last ≤128 kB in memory is on disk.

So the data is almost entirely intact and the header is a stub. **Loss
is bounded at ≤128 kB** — the tail still in the writer's buffer.

## What was checked before grooming

### The stated cause does not apply to our reader

`FileStatistics::parse` (`crates/cannet-blf/src/format/header.rs`)
rejects exactly three things:

- fewer than 144 bytes (`Truncated`),
- a first four bytes that aren't `LOGG` (`BadSignature`),
- `statistics_size` under 144 (`StatisticsSizeTooSmall`).

**A zero `object_count`, `file_size`, `uncompressed_file_size` or stop
timestamp all parse without complaint**, and `object_count` appears
nowhere in `reader.rs` or `scan.rs` — the walk is not bounded by it. So
"zero object count" is what *Vector tools* reject on; it is not by
itself what stops us, and the real cause is still unidentified.

### Two candidates, both testable

1. **`statistics_size` is also a placeholder.** If `BLFWriter` stamps 0
   there at open, `parse` returns `StatisticsSizeTooSmall(0)` and the
   file is refused before a single object is read. This would match the
   report exactly and is the first thing to check.
2. **The truncated tail aborts the whole read.** The last
   `LOG_CONTAINER` is partial, so the walk hits
   `BlfReadError::UnexpectedEof` ("the file ended mid-object"). That is
   a hard error, and `scan_blf_channels` turns any error into a failed
   import — so ~100 % of a recoverable file is discarded because of its
   final fragment.

Both may be true; they fail at different points and need different
fixes. **Do not fix either before an experiment identifies which one
the reported file actually hits.**

### Our own writer is safe — but not completely

`BlfCaptureWriter` (`crates/cannet-blf/src/lib.rs`) writes to
`<dest>.part` and only `fs::rename`s into place in `finish()`; its
`Drop` removes the partial so "the destination is observably
untouched". A clean crash therefore leaves no broken file at the
destination.

**But `Drop` does not run on a hard kill or power loss**, which leaves a
`<dest>.part` in exactly this state: real containers, stub header. So
cannet can produce one of these too, and today cannot read it back —
which puts this in the same family as task 90 item 1, where the finding
that mattered was that *cannet writes files it then truncates*.

## Likely shape of the work

- Identify the actual rejection point with an experiment on the
  reported file (or a fixture built by killing a writer mid-run).
- Read a stub-header BLF by walking containers to EOF and deriving the
  counts from what is actually there, rather than trusting the header.
- Stop at the truncated tail **and keep everything before it**, rather
  than failing the whole file — the same rule task 90 item 1 applied to
  `WindowedSource`.
- Say so plainly when it happens: one system-log line naming how much
  was recovered and that the tail was incomplete. Silent partial
  recovery would be worse than the current refusal.
- Consider offering to rewrite a correct header (a repair), and whether
  `<dest>.part` files should be offered for recovery on startup.

## Grooming resolutions (2026-08-21)

- **Read-only. We never write to the file.** Owner ruling: recover what
  is there and leave the bytes untouched. No header repair, no repaired
  copy. The user's other tools will still reject the file; that is
  their vendor's problem to solve, and it is not worth the risk class
  of writing into a capture we did not create and whose format we would
  be asserting we understand completely.
- **Recover loudly, but do not ask.** One system-log line naming how
  much was recovered and that the tail was incomplete — no modal, no
  prompt. This is the pattern task 88 phases 4 and 7 established for
  consequential-but-not-interactive events. Silent partial recovery
  would be worse than today's refusal, because the counts and
  timestamps the app then shows are derived from an incomplete file;
  a modal is heavier than the situation deserves.
- **Stop at the truncated tail and keep everything before it.** Not a
  new decision — the rule task 90 item 1 applied to `WindowedSource`,
  where the finding that mattered was that cannet must not discard
  recoverable data on a read path.
- **Check the MDF path rather than assuming.** `scan_mdf_channels` is
  described in the code as the "same one-pass-over" sibling of
  `scan_blf_channels`, so whether it has the same failure is cheap to
  establish and dishonest to guess.
- **`<dest>.part` discovery is out of scope**, and becomes its own task
  once this one establishes such a file is readable at all. Surfacing a
  crashed session's leftovers is startup crash-recovery: a different
  feature, a different moment, its own UX.

## Phases

1. **Identify the rejection point.** Build a fixture by killing a
   writer mid-run (or use the owner's file), and determine which of the
   two candidates above actually stops us. Record observation →
   hypothesis → experiment → data → conclusion in the status log. No
   fix before this lands.
2. **Read a stub-header capture**: derive the counts from the walk
   rather than the header, stop cleanly at a partial tail, keep
   everything before it, and log what was recovered.
3. **The MDF path**, fixed the same way or recorded with the reason it
   does not apply.

## Exit criteria

- A capture whose writer never finalized opens, and every frame before
  the truncated tail is present; tested against a fixture built by
  abandoning a writer mid-run.
- The file is byte-identical after being opened; tested.
- One system-log line states how much was recovered and that the tail
  was incomplete.
- The root cause is stated with the experiment's data that confirmed
  it — not with the reported symptom, which grooming already showed
  does not apply to our reader.
- The MDF path is fixed or its exemption is recorded with a reason.

## Status log

### 2026-08-21 — Phase 1: identify the rejection point (branch `task-105-unfinalized-blf`)

Branched from `task-100-calc-fields-dbc-config` (`3e0b8b7a`).

**The framing above does not survive contact with the code.** Neither
of the two groomed candidates is what stops us, and the file we were
told "cannot be opened" opens.

**Observation.** A throwaway integration test (`tests/scratch_probe.rs`,
deleted after the run) built three files from one 20 000-frame source
and walked each with `BlfReader` and with `scan_blf`:

| file | header parse | `object_count` | `scan_blf` |
| --- | --- | --- | --- |
| control — finalised by `BlfCaptureWriter::finish` | ok | 20 000 | `Ok`, 20 000 frames, start `1.7e18` |
| A — our writer hard-killed (`mem::forget`, no `Drop`) | ok | 0 | `Ok`, **18 728 frames**, start **0** |
| B — A with 1 / 17 / 4 096 trailing bytes removed | ok | 0 | `Err("BLF ended mid-object")`, **0 frames** |

**Hypothesis 1 (groomed candidate 1): `statistics_size` is also a
placeholder, so `parse` returns `StatisticsSizeTooSmall(0)`.**
*Refuted.* `BlfFileWriter::create` stamps `statistics_size: 144` into
its placeholder, and python-can's `BLFWriter._write_header` — the
writer that produced the reported file — stamps `b"LOGG"` and
`FILE_HEADER_SIZE` at open too. Both stub headers parse; row A above
is the data.

**Hypothesis 2: a zero `object_count` stops us.** *Refuted.* Row A
recovered 18 728 frames from a file whose header says it holds none.
`object_count` is written by `BlfFileWriter::finish` and read by
`FileStatistics::parse`, and appears nowhere else on the read path
(`git grep object_count crates/cannet-blf/src` — writer.rs and
header.rs only). The walk is bounded by EOF, not by the count. A zero
count is what *Vector* tools reject on; it is not what stops us.

**Hypothesis 3 (groomed candidate 2): the truncated tail aborts the
whole read.** *Confirmed.* Row B: removing a single trailing byte
turns `scan_blf` from `Ok(18 728 frames)` into
`Err(BlfReadError::UnexpectedEof)`. `scan_blf_channels` maps any
scan error to a failed import, so **one lost byte discards 16 387
recoverable frames** — the whole file minus its last container. The
loss is not bounded at ≤128 kB as the report assumed; it is total.
The rejection point is `BlfReader::pull_one_container`, where a short
`read_exact` of a top-level record's body becomes
`BlfReadError::UnexpectedEof`.

**A third defect the experiment turned up, not in the report.** Row A
opens, but with `start_unix_nanos == 0`: a stub header carries the
all-zero SYSTEMTIME sentinel, so every frame is dated from 1970 and
the capture silently loses its wall clock. This is unrecoverable by
construction — per-event timestamps are unsigned offsets *from* that
anchor, so the absolute time is not in the file at all — and a
zero-start BLF is already a legitimate shape
(`examples/time-origins/relative-zero.blf`). The only honest response
is to say so, which is what the recovery log line now does.

**Does cannet produce such a file?** Yes for the stub header, no for
the torn tail. `BlfCaptureWriter` streams to `<dest>.part` and
`Drop` removes it, so a clean crash leaves nothing at `<dest>` —
confirmed in row A, where `dest exists = false`. A hard kill skips
`Drop` and leaves `<dest>.part` with a stub header and 107 770 bytes
of complete containers. It is *not* torn: `BlfFileWriter` writes each
`LOG_CONTAINER` with one unbuffered `File::write_all`, so a killed
process cannot split one. A torn tail needs a buffered writer
(python-can opens its file through Python's `BufferedWriter`) or
power loss, which is why row B has to be built by truncation.

**Conclusion.** Two things to fix, one to report: the walk must end
cleanly at a trailing fragment and keep everything before it
(hypothesis 3); the stub header must not be treated as authoritative
for counts (it never was); and the lost wall clock must be named in
the log rather than passed off as a 1970 capture. **Ruled 2026-08-26**
(owner-review-queue 3.9, now
[task 122](0122-a-file-keeps-what-you-wrote.md) § 2): the anchor will
be persisted to the header the moment it is known instead of only at
`finish()`, so future `.part` files carry a real start and recovery
honours it with no heuristic. Files already on disk stay undated —
the absolute time was never written.

### 2026-08-21 — Phase 2: read a stub-header capture (branch `task-105-unfinalized-blf`)

`b364e5a1` — "A capture whose writer never finalized is read for what
it holds", `8f82d222` — "A recovered BLF import says in one line what
it recovered".

The walk now ends at a trailing fragment the way it ends at a clean end
of file. `read_exact_or_eof` became `read_up_to`, which reports how many
bytes it got instead of erroring, and both places that ran out of file
mid-record — a short top-level record on disk, and an inflated container
stream that ends mid-object — keep everything before the fragment and
stop. `BlfReadError::UnexpectedEof` had no remaining construction site
and was removed.

Two things fell out of writing it:

- **Clipping only a record's inter-object padding costs nothing.** The
  old code read `object_size + padding` with one `read_exact`, so losing
  a padding byte failed the file as hard as losing a whole record. The
  padding carries no data, so the record is now decoded and no fragment
  is reported. This is why the tests assert the biconditional — a
  fragment is reported *exactly when* one cost us frames — rather than
  "any truncation reports a fragment", which is false and was the first
  version's failing assertion.
- **The tolerance had to be scoped.** `damage_that_is_not_a_trailing_fragment_is_still_an_error`
  corrupts a record signature in the middle of the file and holds that
  it is still an error. It passed before the change and after it, which
  is what makes "the damaged file opens" a discrimination rather than a
  reader that accepts anything.

Counts come from the walk, as they always did — the reader has never
read `object_count`. `FileStatistics::is_unfinalized` (on `file_size ==
0`, since an empty *finalised* BLF also reports zero objects) names the
placeholder header, and `BlfScan` carries it beside the fragment size.

Byte-identity is proved by digest, not by an assertion that no write was
attempted: `recovering_a_damaged_capture_leaves_its_bytes_untouched`
FNV-1a-hashes the file, runs three full passes over it (two decoding
walks and a scan), re-hashes, and compares — then checks the directory
for companion files, so a `.recovered` copy would fail it too.

The one system-log line is `capture::recovered_capture_warning`, a pure
function over the scan so it is testable without an `AppHandle` (the
shape `dropped_file_backed_warning` established). It names the frame and
channel counts, the fragment size when there is one, and the lost wall
clock, and says the file was not modified. `scan_blf_channels` emits it;
`open_log`'s existing line stopped reporting the placeholder header's
zeros as the file's own numbers.

**Tests:** `crates/cannet-blf/tests/unfinalized.rs` (5),
`an_empty_finalised_header_is_not_mistaken_for_a_placeholder`,
`a_recovered_capture_says_what_it_recovered`,
`an_intact_capture_is_scanned_without_a_recovery_warning`.

### 2026-08-21 — Phase 3: the MDF path (branch `task-105-unfinalized-blf`)

**Exempt: the MDF reader already does what phase 2 added to the BLF
reader.** Not a guess — a throwaway probe (deleted) truncated the
committed `unsorted_unfinalized_classic.mf4`, whose records run to the
end of the file the way an unfinalized MDF's do:

| bytes removed | frames of 55 | error |
| --- | --- | --- |
| 0 | 55 | none |
| 1 | 54 | none |
| 8 | 54 | none |
| 32 | 53 | none |
| 64 | 52 | none |

`next_in_chunk` returns `EndOfChunk` when a record would run past the
buffer, and `data_chunk` clamps an unfinalized block's end to the file's
own length, so a partial trailing record costs itself and nothing else.
`frames.rs::a_partial_trailing_record_costs_only_itself` pins it.

Truncating a *finalised* MF4 is a hard error instead, because a
finalised file's block graph sits after its data — removing a byte from
the end removes metadata, not records. That is the same class as BLF's
mid-file damage and is correctly loud.

## Blockers / side effects

- **An abandoned MDF `.part` opens as a silently empty capture.** Same
  probe: killing `MdfCaptureWriter` mid-run leaves a 572 kB `.part` that
  `MdfCanFrameSource::open` accepts and walks to **zero frames**, with
  `is_unfinalized()` reporting `false`. The file holds `##HD` ×1 and
  `##DT` ×1 but `##DG` / `##CG` / `##CN` ×0 — the writer emits the
  channel-group description at `finish()`, so the records that are on
  disk have nothing describing their shape and no walk can recover them.
  The ID block also still reads `MDF     ` rather than `UnFinMF `.
  Fixing it means changing what the writer emits at open (stamp
  `UnFinMF`, write the group description before the data), which is a
  writer change, not a reader one, and only becomes reachable through
  the UI once `<dest>.part` discovery exists — explicitly out of scope
  here. Recorded rather than fixed; the silent zero is the part worth
  fixing first if it is picked up.
- **A recovered capture's wall clock cannot be restored.** Named in the
  log line, not repaired: BLF per-event timestamps are unsigned offsets
  from a `measurement_start_time` the writer never wrote, so the
  absolute time is not in the file. A zero start is a shape the app
  already supports (`examples/time-origins/relative-zero.blf`).
