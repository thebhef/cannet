# Task 170 — Startup Restore Feedback

Owner feedback 2026-10-21, from real use: on launch the window sits
with empty plot and trace views and no feedback until the prior
capture has loaded enough to populate them.

Never on the roadmap: groomed straight into pending-closeout on the
owner's order ("new task, groom now for immediate implementation").

## What the code does today

Opening a project (`App.tsx::applyProject`) loads the DBC set, the
elements and the layout, then calls `restore_scratch_capture`
**without awaiting it**. The views mount at count 0 and stay there
until the command returns. Nothing is emitted while it runs.

Where the time goes, from the owner's own log over a 110.8 M-frame
capture (two launches, 2026-10-21):

| Phase | Cost | Files |
| --- | --- | --- |
| reload: by-id index (`ByIdIndex::reopen`) | 2.8–3.0 s | 2452 |
| reload: frame metadata (`DiskRawStore::reopen_timed`) | 1.4–1.6 s | 1691 |
| reload: payload / ring / derived / anchor | ~0.2 s | 212 |
| signal pyramids (`SignalCacheStore::restore` → `SampleSeq::reopen_many`) | 7.4–9.1 s | 129 pyramids, 2.9 GB |
| **total with nothing on screen** | **11.8–14.0 s** | |

Every expensive phase maps its files through one function,
`open_segments` (`crates/cannet-spill/src/seg.rs`, 16 threads), and
each knows its file count before mapping the first one. The only
feedback that exists today starts *after* the command returns, and
only when pyramids were rejected (the **Rebuilding signal caches…**
chip, `App.tsx`). A clean restore shows nothing.

Reusable machinery: `load-progress` + `ProgressPacer` (100 ms, the
live-update cadence) in `capture.rs`; `closing-progress` step reports
emitted from the host's own thread (`closing.rs`); `ProgressReport`
and `loadProgressReadout` in `statusLine.ts`; `LoadProgressChip`.

## Grooming notes

- 2026-10-21 Q1 (where the feedback shows): **A — status-line chip
  only.** "Restoring prior capture…" with a determinate bar and a
  `n / N files` readout in the status-notice slot beside the load
  chip. Views stay empty until the count lands; no per-view notice.
- Chip lifetime: from the **first** `restore-progress` event to the
  command's return. The host emits each phase's first report unpaced
  (files 0 of N), so a project with nothing to restore emits nothing
  and shows no chip — no flicker on an ordinary open.
- Determinate per phase, like the closing overlay: each phase's total
  is known from the manifest before it maps a file. Three phases:
  `capture_index`, `capture_frames` (metadata, then payload once its
  count is known — the total may grow once), `signal_caches`.
- The measurement is a per-file callback from `open_segments` (called
  on the mapping threads, so `Sync`); the host pacer sits behind it.
  No polling thread, no second counter.
- Store reads queue behind the reload's lock, so the chip is fed by
  the event alone, never by a command.
- Branch `fix-startup-restore-feedback` beneath `doc-closeout-2`
  (parent `fix-plot-y-scale`), squashed to one commit after each
  phase, as task 169 was.
- Integrated timing is the owner's check on their own project: the
  host already logs `restored N frames … in X ms`, before/after. The
  phase's own cost check is in-process at the spill boundary.

## Phases

### Phase 1 — host: `restore-progress` event (Rust)

- `open_segments` gains a progress seam: a caller-supplied
  `&(dyn Fn(usize) + Sync)` (or equivalent) invoked once per file
  mapped with the running count; the existing signature stays for
  callers that do not report. Thread it through `ByIdIndex::reopen`,
  `DiskRawStore::reopen_timed` (metadata and payload) and
  `SampleSeq::reopen_many` / `reopen_set`.
- `capture.rs`: `RESTORE_PROGRESS = "restore-progress"`, record
  `{ phase, files_opened, total_files }` with `phase` one of
  `capture_index` | `capture_frames` | `signal_caches`.
  `restore_scratch_capture_blocking` emits each phase's first report
  unpaced at 0 of N, then paced by `ProgressPacer`, then a final
  N of N at the phase's end.
- Tests: spill — the callback sees every file exactly once and ends
  at the path count, across the threaded and single-file paths; host —
  a reload over a generated disk scratch reports the three phases in
  order with the right totals, through whatever seam the closing
  sequence's tests use (if none fits, test the report builder in
  isolation). Reload wall clock with and without the seam, same
  scratch, in-process: the difference is noise or the seam is wrong.
- Docs: rustdoc on the seam and the record; README mention lands with
  phase 2.
- Lanes: Rust only (fmt, clippy, test for `cannet-spill` and
  `cannet-gui`); frontend lanes unreachable, declared.

### Phase 2 — frontend: the chip (TypeScript)

- `types.ts`: `RestoreProgress` mirroring the record.
- `statusLine.ts`: `ProgressReport` gains the restore variant;
  `loadProgressReadout` renders `n / N files` with a phase word the
  closing overlay's step texts would use.
- `App.tsx`: listen for `restore-progress`; `restoreProgress` state
  set on the first event, cleared when `restore_scratch_capture`
  returns (either way). Render in `statusNotices` beside the load
  chip: `LoadProgressChip` + "Restoring prior capture…", same shape
  as the cache-rebuild chip (`index.css` reuse, no new tokens).
- Tests: `statusLine.test.ts` readout cases (zero total, growing
  total, final); an App dom test that the chip appears on the event
  and leaves when the command resolves, in the pattern of
  `App.traceOpenCancel.dom.test.tsx`.
- Docs: README, the relaunch/restore paragraph beside **Rebuilding
  signal caches…**: what the chip says and when it shows.
- Lanes: frontend (lint, typecheck, vitest, build); Rust unreachable,
  declared.

## Exit criteria

- [x] (code + dom tests; owner hands-on pending) A relaunch over a prior capture shows **Restoring prior
      capture…** with a determinate bar from the first mapped file to
      the command's return; an open with nothing to restore shows no
      chip.
- [x] The three phases report in order against their own file totals
      at the live-update cadence; the final report of each is N of N.
- [x] (in-process; owner log line pending) Reload cost unchanged within noise (in-process spill test;
      owner's `restored … in X ms` log line as the integrated check).
- [x] README describes the chip; rustdoc covers the seam and record.
- [x] One commit on `fix-startup-restore-feedback`, lanes green,
      `comment-references` grep clean.

## Status log

- 2026-10-21 groomed (Q1 → A); phases 1–2 defined; awaiting go.
- 2026-10-21 phase 1 landed on `fix-startup-restore-feedback` as
  bd57ed1b (one commit, nothing to squash; parent `fix-plot-y-scale`,
  `doc-closeout-2` restacked on top).
    - Spill: `open_segments(paths, on_file)` per-file callback;
      `DiskRawStore::reopen_reporting` (`ReopenPass`/`ReopenProgress`);
      `SampleSeq::reopen_many_reporting` and `reopen_file_count`.
    - Host: `try_reload_reporting`, `restore_reporting` (plans both
      pyramid sets before mapping either), `RESTORE_PROGRESS` with
      `RestoreProgress`/`RestoreReporter` (0 of N unpaced, 100 ms
      paced, N of N at the phase's end, nothing for empty phases).
    - Deviation accepted: `open_segments` changed signature (crate-
      private, no non-reporting caller remained); public wrappers kept.
    - Tests: each file reported once on threaded and single-file paths;
      reporter shape and pacing; end-to-end three-phase order against
      on-disk file counts.
    - Reload cost with/without the seam, 2088 files, debug, medians of
      15: 113.0 vs 109.4 ms and 102.5 vs 101.3 ms (noise).
    - Lanes green: fmt, clippy, test, doc for cannet-spill and
      cannet-gui; frontend declared unreachable. Review: clean;
      comment-references grep clean.
- 2026-10-21 phase 2 landed as 4bc98c4e (pre-squash c272d42c) on top of
  bd57ed1b.
    - `types.ts` `RestoreProgress`; `statusLine.ts` `ProgressReport`
      restore variant, readout "<capture index|capture frames|signal
      caches> n / N files", zero total -> null (indeterminate).
    - `App.tsx`: `restore-progress` listener + `restoreProgress` state,
      cleared in the restore closure's `finally` (invoke still not
      awaited); `restoreRunRef` ignores late reports and keeps an older
      restore from clearing a newer one's chip. Chip "Restoring prior
      capture…" beside the load chip, shares the `.cache-rebuild` rule.
    - Tests: 5 readout cases; `App.restoreProgress.dom.test.tsx` (4):
      appear/leave on resolve, leave on reject, late report ignored
      (fails with the guard removed), nothing to restore -> no chip.
    - README relaunch paragraph describes the chip.
    - Lanes: frontend test (254 files / 3984) + build green; no lint
      script exists in `apps/gui`; Rust/python lanes unreachable.
      Review: clean; comment-references grep clean.
- 2026-10-21 both phases squashed to one commit **fd32b6c6** on
  `fix-startup-restore-feedback` (pre-squash tips bd57ed1b, 4bc98c4e);
  `doc-closeout-2` restacked. Exit criteria walked above; the owner's
  hands-on check and log-line comparison are what remain. Queue § 4
  entry filed. No release build made (none ordered).
