# Task 152 — Nothing Heavy in the Foreground

Renamed 2026-09-22 from "Nothing Heavy on the UI Thread": the scope is
every shape of foreground work (§ Three shapes), not the IPC thread
alone.

Opened by owner instruction 2026-09-22 from an observed freeze.
**Executes now, on the current stack.** Grooming in progress.

## Why

From the owner, 2026-09-22: "I deleted a cache and my UI checked out
for several seconds. That should be happening on a background
thread. We should audit for other places where we're doing work on
the UI thread or waiting for work on the UI thread."

## Findings (2026-09-22 survey)

- **The freeze is in the log.** `cannet.log`, 2026-09-22
  16:49:10.821Z: `WARN health: frontend unresponsive: no UI heartbeat
  for 6304 ms (host is still running; the window or its renderer is
  wedged)` (`crash.rs`), followed at 16:49:16.178Z by `INFO project:
  removed the data cache for <a project directory>`. The heartbeat
  stopped for the whole of the delete.
- **`delete_project_cache` is a synchronous Tauri command**
  (`project_registry.rs`, `pub fn`, not `async fn`), as are
  `clear_project_cache`, `clear_all_project_caches` and
  `list_project_caches` (the directory-size walk ADR 0002 DS-8
  calls expensive). A synchronous command runs on the webview's IPC
  thread, so a directory removal or walk of any size stalls every
  frontend interaction until it returns.
- **The host has 114 synchronous commands and 34 async ones**
  (`#[tauri::command]` over `apps/gui/src-tauri/src/**/*.rs`, recounted
  2026-09-22; the survey's 111/16 missed the `rbs/` and `trace_store/`
  modules). Most are
  state reads that should be synchronous; the audit is to find the
  ones that are not — filesystem walks and removals, file reads of
  unbounded size, waits on a lock a long-running job holds, network
  calls — and any frontend `await` on the UI thread that amounts to
  the same thing.
- **A second observation from the same log**, for the audit to
  explain or rule out: between 2026-09-22 00:00:19Z and 00:03:59Z the
  health line's `ui_last_ms` climbed monotonically 583 → 941 ms,
  ~16 ms per 20 s tick, on a long capture. A UI heartbeat interval
  that grows without bound is either a frontend accumulating work per
  tick or a host serve getting slower; either is in this task's remit.

- **A second case, same day, that the sync/async test would pass**
  (owner report on the logger, 2026-09-22; diagnosis in 0137 § Status
  log, 2026-09-22). `list_logger_files` is already `async` and already
  runs on the blocking pool, and it still took the machine down: its
  body scans every unlisted `.blf` in full (7.2 s for 492 MB, 24.8 s
  for 1.2 GB, local NVMe, release), the file gridview re-issues it
  every 250 ms while a logger writes, `useHostMirror` neither skips a
  tick with a fetch in flight nor drops a late response, and the cache
  fills only after a scan — so every poll during a scan starts another
  full read of the same file. Nothing was on the IPC thread. The work
  was *foreground-driven*: its volume was set by a view's cadence, and
  its result reachable only through the request that paid for it.

## Three shapes of foreground work (2026-09-22)

The audit classifies against all three, not the first alone:

| shape | where it runs | symptom | example | rule it breaks |
| --- | --- | --- | --- | --- |
| **A. on the IPC thread** | synchronous command body | heartbeat stops; every interaction stalls | `delete_project_cache` | none written; ADR 0002 DS-8 calls the walk expensive and stops there |
| **B. foreground-driven derivation** | async command, blocking pool | machine saturates, view never converges, reopened panel empty | `list_logger_files` + the 250 ms poll | ADR 0049 — a serve is bounded, derivation is not the serve — written for the signal cache only |
| **C. on the renderer thread** | frontend JS | heartbeat interval creeps; input lag | `ui_last_ms` 583 → 941 ms; a poller with no in-flight guard | CLAUDE.md § GUI architecture (view-local, paged), no ADR |

Shape B is the one this repo keeps re-implementing: the signal cache
had it (ADRs 0048 / 0049 fixed it there), the logger listing has it
now. The rule that closes it is the same each time — **a request
answers with what exists, bounded in wall time; derivation runs as a
background job, single-flight per key, and announces itself; the
pending state is the row's own.** ADR 0049 already says this for one
cache; the proposal below generalises it.

## Rulings

- **Heavy work leaves the UI thread** (owner, 2026-09-22). Overseer's
  reading: a command that touches the filesystem beyond a single
  small file, walks a directory, or waits on a long-held lock is
  `async` and runs its work off the IPC thread (`spawn_blocking` or
  the host's existing worker pattern); the frontend shows the busy
  state it already has for those rows.
- **All three shapes are in scope** (owner, 2026-09-22): the audit and
  the fixes cover A, B and C; the logger listing is shape B's reference
  case and `useHostMirror` shape C's; the standalone 137 listing-fix
  branch proposed earlier that day is dropped in favour of phase 3
  here. The logger's *idle* gap (no filesystem watch while nothing
  writes) stays a 137 fix branch, sequenced after this task's listing
  fix. Task renamed accordingly.
- **A guard against regression** (owner, 2026-09-22): a host test
  lists every synchronous command and asserts it is on an allow-list
  of pure state reads, so a new filesystem command cannot land
  synchronous unnoticed. The audit's table becomes the check.

- **The rule lives in ADR 0049** (owner, 2026-09-22): amended with the
  general statement (any command, any derivation — not the signal cache
  alone) and the shape-A guard; no new ADR.

## Open questions

(none — ruled 2026-09-22.)

## Phases (groomed 2026-09-22)

1. **Audit.** Every command classified — sync/async × what it touches
   (filesystem, lock, network) × whether its per-call work is bounded
   by the page it serves or scales with disk / capture × who drives it
   (a gesture, a poll, a re-render) × single-flight or not. Every
   frontend poll site (`pollWhile` ×3, `setInterval` ×6) reviewed the
   same way. The `ui_last_ms` creep explained. The freeze reproduced by
   a test that times the heartbeat across a cache delete of a generated
   multi-GB directory. Output: the table and the fix list in this file.
2. **Shape A.** The listed synchronous commands moved off the IPC
   thread through the host's existing `off_async_workers`; the busy
   states confirmed; the sync-command allow-list test in place; ADR
   0002 DS-8 amended if its wording changes.
3. **Shape B + C, reference case.** `list_logger_files` returns stat
   data at once; start / end / duration / count read from the cache or
   show pending; one background scan per file, single-flight, announces
   completion by event and the grid refetches. `useHostMirror` gains an
   in-flight guard and drops out-of-order responses (shared layer:
   RBS and Transmit pollers benefit too). ADR 0049 amended with the
   general rule. Any further shape-B/C sites the audit listed follow
   here or get their own branch, by size.

## Exit criteria (groomed 2026-09-22)

1. Deleting or clearing a project cache of several GB never stops the
   UI heartbeat: the `frontend unresponsive` warning does not fire
   during it, asserted by a test over a generated directory.
2. No synchronous command walks or removes a directory, reads an
   unbounded file, or waits on a long-held lock; the audit table in
   this file records every command's classification against all three
   shapes.
3. No command's per-call work scales with the folder or capture it
   serves unless the response is a page of it: `list_logger_files`
   returns before any scan finishes, and N unscanned files under any
   number of overlapping listings cost N scans — both asserted by test.
4. `useHostMirror`: a fetch slower than the poll interval yields one
   request in flight at a time, and the newest response wins — asserted
   by test.
5. The `ui_last_ms` creep is explained, and fixed if it is the
   frontend's or the host's doing.
6. The regression guard is in place: the sync-command allow-list test
   fails on a synchronous command it does not name.
7. ADR 0049 carries the general rule and the shape-A guard; ADR 0002
   and README match the behaviour.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened; survey and rulings above.
- 2026-09-22 — the logger listing (0137) diagnosed as a second freeze
  the sync/async test would pass; shapes B and C, phases 2–3 and exit
  criteria 3, 4, 7 proposed; owner accepted all three shapes the same
  day and the task was renamed.
- 2026-09-22 — owner ruled the rule lives in ADR 0049, amended; no
  open questions.
