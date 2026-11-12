# Task 172 — The Logger Reads Only What It Shows

Owner feedback 2026-11-11, from real use: a logger pointed at a
SharePoint (OneDrive-synced) folder on a low-disk machine downloads
files the owner had offloaded, **even with the logger panel hidden**.
Low disk and a cloud-synced log folder are a typical setup, so the
behaviour also needs a switch to turn it off.

Never on the roadmap: groomed straight into pending-closeout on the
owner's order ("new task, implement now").

## What the code did

| # | Observation | Effect on a cloud folder |
| --- | --- | --- |
| 1 | Dockview keeps a background-tab panel mounted; `LoggerFileGrid` had no visibility gate. | A hidden panel listed on mount, on `loggers-changed`, on every scan event, and every poll tick while writing. |
| 2 | Every listing queues a background scan of each uncached `.blf` (`log_files::file_node`). | Every offloaded file got a scan queued. |
| 3 | The "header-only" `scan_blf` walks every object: a whole-file read. | Each scan downloads the whole file. |
| 4 | The host scan queue had no cancel. | Queued downloads ran on after the panel hid or closed. |
| 5 | `LogFileCache` is in memory only. | A restart re-reads, so re-downloads, every file. |

Directory listing and `stat` do not hydrate a placeholder; only the
scan reads file content.

## Decisions (owner, 2026-11-11)

- New setting `logger_scan_file_headers`, **default on** (today's
  behaviour), user-overridable, Settings › Logging, `Behaviour` kind
  (visible without developer settings).
- Hiding the panel **cancels queued and in-flight scans**, not just
  new listings.
- Item 5 (persisting the cache across restarts) is out of scope: with
  scans off nothing is read at all, which is the case that matters.

## Shape

- Host: `ScanFn` takes a cancel flag and returns `None` when cancelled
  (production: `scan_blf_cancellable`). `LogFileCache::cancel_scans`
  clears the queue and pending set, raises the current generation's
  flag and installs a fresh one. New sync command
  `cancel_logger_file_scans` (allow-listed: in-memory) calls it and
  emits `logger-files-scanned` so any other visible grid re-lists.
- Host: with the setting off, an uncached file lists with
  `scan_skipped: true` and no scan is queued; cached headers still
  show.
- Frontend: `useHostMirror` gains `enabled`; `LoggerPanel` tracks
  `api.isVisible` (the `DatabasePanel` precedent) and passes it as the
  grid's `onScreen`. The grid's scan-event listener is gated the same
  way, and it calls `cancel_logger_file_scans` when it hides, unmounts,
  is re-aimed at another folder, or the setting turns off. Skipped
  cells render `—` with a hint.

## Exit criteria

1. A hidden logger panel issues no `list_logger_files` and registers
   no scan listener; showing it lists. — `LoggerFileGrid.dom` "a hidden
   grid neither lists nor listens…", `LoggerPanel.dom` "lists the
   folder only while the panel is on screen". **Met.**
2. Hiding, unmounting, re-aiming, or switching the setting off cancels
   host scans. — `LoggerFileGrid.dom` two "cancels the host's header
   scans…" tests. **Met.**
3. Cancel stops the running scan, drops queued ones, caches and
   announces nothing, and leaves the files re-queueable. —
   `log_files::cancel_stops_the_running_scan_and_drops_the_queued_ones`
   (verified to fail with the queue clear removed). **Met.**
4. With the setting off a listing queues no scan and marks files
   skipped; a cached header still lists. — the two
   `log_files::with_header_scans_off_*` tests (the first verified to
   fail with the gate removed); `LoggerFileGrid.dom` "shows the trace
   columns as skipped…". **Met.**
5. README describes the on-screen-only rule and the setting. **Met.**
6. Owner's check on the real machine: a OneDrive-synced logger folder
   with files offloaded — (a) panel in a background tab: no download
   activity; (b) setting off, panel shown: no download activity, `—`
   in start/end/duration/messages. **Not yet run.**

## Status log

- 2026-11-11 — Landed as one commit on `logger-reads-only-what-it-shows`
  beneath `doc-closeout-2`. Host suite 1467 pass, clippy and fmt
  clean; frontend 3989 pass, build clean.
