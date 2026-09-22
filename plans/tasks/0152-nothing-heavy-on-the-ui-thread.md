# Task 152 — Nothing Heavy on the UI Thread

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
- **The host has 111 synchronous commands and 16 async ones**
  (`#[tauri::command]` over `apps/gui/src-tauri/src/*.rs`). Most are
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

## Rulings

- **Heavy work leaves the UI thread** (owner, 2026-09-22). Overseer's
  reading: a command that touches the filesystem beyond a single
  small file, walks a directory, or waits on a long-held lock is
  `async` and runs its work off the IPC thread (`spawn_blocking` or
  the host's existing worker pattern); the frontend shows the busy
  state it already has for those rows.
- **A guard against regression** (owner, 2026-09-22): a host test
  lists every synchronous command and asserts it is on an allow-list
  of pure state reads, so a new filesystem command cannot land
  synchronous unnoticed. The audit's table becomes the check.

## Open questions

(none — ruled 2026-09-22.)

## Phases

1. **Audit.** Every command classified (sync/async × what it does);
   every frontend `await` that blocks input reviewed; the
   `ui_last_ms` creep explained; findings and the fix list in the
   task file, with the freeze reproduced by a test that times the
   heartbeat across a cache delete of a generated multi-GB directory.
2. **Fix.** The listed commands moved off the IPC thread, the busy
   states confirmed, the regression guard (§ Rulings) in place,
   ADR 0002 amended if DS-8's wording changes.

## Exit criteria

1. Deleting or clearing a project cache of several GB never stops the
   UI heartbeat: the `frontend unresponsive` warning does not fire
   during it, asserted by a test over a generated directory.
2. No synchronous command walks or removes a directory, reads an
   unbounded file, or waits on a long-held lock; the audit table in
   the task file records every command's classification.
3. The `ui_last_ms` creep is explained, and fixed if it is the
   frontend's or the host's doing.
4. The regression guard is in place: the sync-command allow-list test
   fails on a synchronous command it does not name.
5. Tests cover 1, 2 and 4; ADR 0002 and README match the behaviour.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened; survey and rulings above.
