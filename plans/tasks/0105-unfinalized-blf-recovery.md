# Task 105 — A BLF Whose Writer Never Finalized

**Status: opened 2026-08-20; groomed 2026-08-21.** Recorded from an owner
report; the investigation below is what the overseer established before
grooming, not a settled diagnosis.

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
