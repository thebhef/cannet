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

## Audit (2026-09-22, overseer — phase 1 deliverable)

**Method.** Every `#[tauri::command]` under `apps/gui/src-tauri/src`
(113 synchronous, 33 `async`, by a grep over the attribute and the
`fn` line), each body read together with the helpers it delegates to;
every frontend `setInterval` (6) and `pollWhile` consumer (3); the
health log of 2026-09-22 for the `ui_last_ms` creep. A row is an
offender when its per-call work is unbounded (scales with a directory,
a capture or a file), waits on a thread or the network, or spawns a
process, on a thread the UI depends on.

### Shape A — synchronous commands that do more than read state

The IPC thread runs these; the heartbeat (`report_js_heap`, itself a
synchronous command) queues behind them, which is what the log shows.

| # | command | what it does that is not a state read | driven by | bound | fix |
| --- | --- | --- | --- | --- | --- |
| A1 | `delete_project_cache` | `remove_dir_all` of another project's cache | gesture | the cache (GBs) — **the observed 6.3 s** | `async` + `off_async_workers`; row busy state |
| A2 | `clear_project_cache` | `clear_cache` removes a cache's contents; for the open project, A5 | gesture | the cache | same |
| A3 | `clear_all_project_caches` | `remove_dir_all` per registered cache, then A5 | gesture | every cache | same |
| A4 | `list_project_caches` | `dir_footprint` walks every registered cache directory (ADR 0002 DS-8 "expensive") | settings view shown, `project-dir-changed`, Refresh | caches × files | shape B: rows return at once, size pending, one background walk per row announces |
| A5 | `clear_trace_store` | `start_session` + `restamp_scratch_for_capture` → `signal_caches.clear()` → `wipe_dir` removes every pyramid file | gesture; A2/A3 | pyramid count | `async` off-thread; or drop in memory, unlink in a background job |
| A6 | `open_project` | reads + parses the file; `reroot_session` (flushes and reopens the raw store, `signal_caches.reroot` re-reads the cache dir, notes reroot); `logger::stop_all` **joins every writer thread** (each finishes its file first — on a cloud-synced folder that is the freeze); `apply_cache_caps` re-reads settings files | gesture | writer flush + store reopen | `async` off-thread with the join off the IPC thread; the frontend already waits on the result |
| A7 | `close_project` | `reroot_session` + `logger::stop_all` (join) | gesture | same | same |
| A8 | `save_project_as` | `save_project` + `create_at` + `carry_workspace_scope` + `reroot_session(Carry::Contents)`: flushes the raw store and moves the capture into the new directory — a rename on one volume, a **copy of the whole capture across volumes** | gesture | the capture | `async` off-thread, busy state on the status bar |
| A9 | `set_loggers` | `reconcile`: `stop_one` joins the threads of loggers being stopped; `start_one` creates files (cloud folder: sync client) | gesture (logger panel edits, project open) | writer flush | `async` off-thread |
| A10 | `add_dbc` | `read_to_string` + `Database::parse` of the whole DBC + `invalidate_derived_caches` (A13) | gesture, and the DBC watcher's reload | DBC size (MBs: ~100 ms) | `async` off-thread |
| A11 | `set_settings` | writes the settings file; `apply_cache_caps` re-reads settings and applies the scratch cap to the live store; `apply_unit_change` invalidates derived caches (A13) | gesture | A13 | `async` off-thread |
| A12 | `attach_local_bus_bridge`, `replay_local_virtual_buses` | `connect_and_subscribe` spawns the session thread and **blocks on `ready_rx.recv()`** until the remote handshake completes or fails | gesture; project open replay | the client's connect deadline | `async` (as `connect_remote_server` already is) |
| A13 | `clear_dbcs`, `remove_dbc`, `set_dbc_buses`, `set_signal_unit`, `set_signal_dbc_pick`, `define_/update_/delete_math_signal` | `invalidate_derived_caches` → `signal_caches.invalidate_dbcs` drops the affected pyramids and unlinks their files (`wipe_prefix`) | gesture | cached pyramid count | one change: invalidation drops in memory and hands the unlinking to a background job; the commands then stay synchronous |
| A14 | `transmit_frame_once` | `SessionTx::transmit` → `blocking_send` on the session's outbound channel: **waits while the queue is full** (a slow server) | gesture | queue drain | `try_send`, and a `Failed { queue full }` wire status |
| A15 | `restart_sidecar` | `kill_child_tree` + process spawn | gesture | tens of ms | `async` off-thread (cheap) |
| A16 | `reveal_in_file_manager` | `Command::spawn` | gesture | tens of ms | `async` off-thread (cheap) |

Two things the audit did **not** measure and phase 2 verifies before
its allow-list is final: whether `set_scratch_cap` (A11) evicts spill
segments synchronously, and how many files `invalidate_dbcs` (A13)
unlinks on a typical project.

### Shape A — synchronous commands that are state reads (the allow-list)

Bounded by state already in memory, or one small JSON file under the
config directory, or a DBC-sized computation. These stay synchronous;
the regression guard names exactly this set.

| group | commands |
| --- | --- |
| snapshots | `get_bus_health`, `get_connection_states`, `get_server_prompts`, `addresses_needing_trust`, `get_discovered_servers`, `get_server_list`, `get_interfaces`, `get_logger_statuses`, `get_sidecar_status`, `capture_extent`, `signal_pyramids_rebuilding`, `fetch_system_log` (ring ≤ 4096), `fetch_notes`, `list_transmit_frames`, `fetch_field_validity`, `list_local_bus_bridges`, `list_view_signals`, `list_signal_units`, `active_project_is_auto_located`, `app_version`, `diag_enabled`, `diag_autostart` |
| DBC-sized compute | `list_signals`, `list_dbc_content`, `list_dbc_collisions`, `list_value_tables`, `list_file_backed_content`, `describe_message`, `decode_frame`, `encode_frame`, `list_math_signals`, `evaluate_signal_generators`, `validate_signal_generator`, `list_units`, `list_unit_picker`, `list_unit_mappings`, `check_unit_definition`, `resolve_display_units`, `get_setting_descriptors`, `preview_export_template`, `rbs_crc_algorithms` |
| in-memory mutations that emit | `cancel_import`, `cancel_export`, `set_live_tail_rows`, `clear_system_log`, `gui_emit_system_log`, `add_note` … `clear_notes` (11; the notes store writes its small file), `set_transmit_frame`, `remove_transmit_frame`, `reorder_transmit_frames`, `clear_transmit_frames`, `start_periodic_transmit`, `stop_periodic_transmit`, `set_view_signals`, `remove_view_signals`, `clear_view_signals`, `create_local_virtual_bus`, `drop_local_virtual_bus`, `detach_local_bus_bridge`, `disconnect_remote_server` (drops the handle; the worker disconnects itself, no join), `watch_interfaces`, `unwatch_interfaces`, `diag_capture_start`, `diag_push`, `exit_process` |
| one small config-dir file | `get_settings`, `get_settings_overrides`, `get_state`, `set_state`, `get_export_state`, `set_export_state`, `save_project` (the project file itself), `accept_server_fingerprint`, `accept_server_insecure`, `set_server_token`, `forget_server`, `add_server_to_path`, `third_party_licenses`, `diag_capture_finish` |
| the heartbeat | `report_js_heap` — **must** stay synchronous: its arrival on the IPC thread is the liveness evidence |

### `async` commands — where their bodies run

ADR 0048's rule: a body whose duration scales with the capture goes
through `off_async_workers` (the blocking pool); a `#[tauri::command]
async fn` that never awaits otherwise runs on the async runtime's
worker that polls it, and a pool of those is the size of the core
count.

| where | commands | verdict |
| --- | --- | --- |
| blocking pool (`off_async_workers`) | `sample_signals`, `signal_min_max`, `scan_blf_channels`, `scan_mdf_channels`, `list_logger_files`, `connect_remote_server` | right place; `list_logger_files` is shape B by *volume* (below), not placement |
| awaits real I/O | `refresh_interfaces`, `add_server` | fine |
| runtime worker, spawns the job and returns | `open_log`, `import_mdf` (pump thread), `save_capture` (export job) | fine, provided the pre-spawn work stays bounded (phase 2 checks the census is inside the thread) |
| runtime worker, sync body, bounded | `rbs_*` (13: in-memory state, `rbs_load`/`rbs_save` one small file), `rbs_view`, `rbs_signal_rows`, `fetch_trace_range`, `fetch_by_id_page`, `fetch_signal_page`, `frame_indices_at_ns` | fine: a page or an element's size |
| runtime worker, sync body, **capture-scaled** | `fetch_filtered_trace`, `filtered_positions_at_ns` — a predicate change rebuilds the filter index over the whole capture **under the `filter_index` mutex**, so every other filtered page fetch parks a runtime worker on that lock; `restore_scratch_capture` — reopens the store and restores pyramids, once per open | **B1**: the rebuild through `off_async_workers`, the lock taken for the swap only; `restore_scratch_capture` through `off_async_workers` |

### Shape B — foreground-driven derivation

| # | site | derivation | driver | single-flight | fix |
| --- | --- | --- | --- | --- | --- |
| B0 | `list_logger_files` | `scan_blf` of every unlisted `.blf` (7.2 s / 492 MB) | the file grid's 250 ms poll while writing | no — every poll during a scan starts another | phase 3 reference case (§ Rulings) |
| B1 | `fetch_filtered_trace` index rebuild | O(capture) on predicate change | every filtered view's first page | yes (mutex) — but the waiters hold runtime workers | above |
| B2 | `list_project_caches` (A4) | directory walk per cache | settings view show / event | no | above |
| B3 | `rbsAttention` mirror | `rbs_signal_rows` for **every** RBS element per `rbs-changed` event | every RBS mutation, `"*"` on every DBC mutation | no | bounded by element count; acceptable, noted |

### Shape C — the renderer thread and its pollers

| site | cadence | in-flight guard | stale drop | verdict |
| --- | --- | --- | --- | --- |
| `useHostMirror` (`LoggerFileGrid` while writing, `RbsPanel` while running, `TransmitPanel` while running; event-driven elsewhere) | `view_refresh_interval_ms` = 250 | **none** | **none** | phase 3: one request in flight, newest response wins |
| `useWindowedQuery` (trace, filtered trace, by-id, signals, view signals) | 250 | `fetching` + `pending` coalesce | descriptor check | the reference implementation; untouched |
| `DatabasePanel` value column | 500, gated by a `trace-grew` dirty flag | none | none (a `live` flag only) | phase 3: same guard as the mirror (small) |
| `App` rebuild-progress poll | 1000 while the chip is up | none, `stopped` flag | — | cheap; untouched |
| `diag.ts` heartbeat | 1000 | — | — | must stay |
| `perfInteract.ts` | harness only | — | — | out of scope |

Renderer-thread work proper: the settings view re-hydrates on every
show with `list_units` (2289 rows), `list_unit_picker` (~920) and
`list_project_caches` (A4); the units table and picker render every
row (task 151's remit). Nothing else on the renderer accumulates with
capture length (CLAUDE.md § GUI architecture holds).

### The `ui_last_ms` creep — explained, no defect

`ui_last_ms` is the age of the last heartbeat at the moment the health
sampler ticks. The sampler is `std::thread::sleep(20 s)` plus its own
sampling work, and the log shows its period as 20.033 s (00:00:19.020,
:39.055, :59.088 …); the heartbeat is a 1 Hz `setInterval`. Each tick
therefore lands 33 ms later in the heartbeat cycle: 583 → 617 → 649 …
974, then **8** at 00:04:39Z — a wrap, not a slowdown. Neither the
frontend nor the host got slower; exit criterion 5 is met by this
explanation. Phase 2 adds one sentence to `crash.rs`'s module docs so
the next reader does not open a task on it.

### Fix list, in order

1. **Phase 2 (shape A).** A1–A3, A5–A12, A15, A16 → `async` +
   `off_async_workers`; A13 → invalidation unlinks in a background
   job; A14 → `try_send`. The heartbeat test over a generated multi-GB
   cache directory (red first). The allow-list test over the table
   above. ADR 0002 DS-8 wording. `crash.rs` doc sentence.
2. **Phase 3 (shapes B and C).** B0 and `useHostMirror` per § Rulings;
   B1 (the index rebuild off the runtime workers, lock for the swap
   only; `restore_scratch_capture` likewise); B2 (cache sizes pending,
   background walk); the `DatabasePanel` guard. ADR 0049 amended with
   the general rule.

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

1. **Audit** — *done 2026-09-22 by the overseer, § Audit above*:
   every command classified against the three shapes, every poll
   site reviewed, the `ui_last_ms` creep explained, the fix list
   written. The freeze-reproducing heartbeat test moves to phase 2.
2. **Shape A.** § Audit's fix list item 1: A1–A16 as listed, the
   heartbeat test over a generated multi-GB cache directory (red
   first), the two unmeasured points verified, the sync-command
   allow-list test over § Audit's allow-list table, ADR 0002 DS-8
   amended if its wording changes, the `crash.rs` doc sentence.
3. **Shape B + C, reference case.** `list_logger_files` returns stat
   data at once; start / end / duration / count read from the cache or
   show pending; one background scan per file, single-flight, announces
   completion by event and the grid refetches. `useHostMirror` gains an
   in-flight guard and drops out-of-order responses (shared layer:
   RBS and Transmit pollers benefit too); § Audit's fix list item 2
   besides: B1 (the filter-index rebuild off the runtime workers,
   `restore_scratch_capture` likewise), B2 (cache sizes pending, one
   background walk), the `DatabasePanel` guard. ADR 0049 amended with
   the general rule.

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

- 2026-09-23 (phase 2) — **fourteen commands no longer serialize
  against each other.** The IPC thread used to be an implicit global
  lock over every synchronous command; moving a command to the blocking
  pool gives that up. Reviewed and judged safe as it stands: the
  frontend `await`s each of these in turn (the DBC load loop, which
  depends on load order, is an awaited `for`), and every body still
  takes the same `AppState` mutexes it did. The pre-existing
  cross-thread paths (the DBC watcher's reload, the pump threads) were
  already concurrent with all of them. It is a new shape to keep in
  mind when a *new* command is written, not a defect found.
- 2026-09-23 (phase 2) — `SessionTransmitter::transmit` (the blocking
  single-frame form) now has no caller in the workspace: the manual path
  uses `try_transmit` and the scheduler uses `transmit_batch`. Left in
  place — it is a library crate's public API and the python/GUI
  consumers of `cannet-client` are not all in this repo's tree.
- 2026-09-23 (phase 3) — **the perf reading for this branch measured an
  idle bus.** The ADR-0031 run
  (`docs/performance-measurements/frontend/2026-09-23-b4de94de-task152p3-run1.json`,
  parked in the overseer's scratchpad, not committed) came back `fps.rx = fps.tx = 0`,
  `rx_gap: null`, with `cannet.log` reporting `frame source ended
  cleanly (0 frames)` — the sidecar started, the GUI connected to
  `127.0.0.1:56872` and subscribed to both interfaces, and no frames
  arrived. No other `cannet-gui` or `cannet-server` process was running
  when the run started. Per the ADR-0031 rule a number measured off an
  idle bus is worse than no number, so this one is **not** a data point
  in the series and was not promoted or checked against the baseline. Not
  retried and nothing killed. The render-tier numbers it does carry are
  in the report for whatever they are worth (longtask 0 ms/s, `lag_ms`
  max 1.2 ms, `jank_fraction` 0, `jsheap_mb` peak 31.9,
  `mem.tree_mb` peak 575.3, `mem.host_mb` peak 47.2, `interact` 240
  gestures performed / 0 missing) — but they describe an app with no
  data flowing.
- 2026-09-23 (phase 3) — **a filtered fetch can now be answered `None`
  where it previously blocked.** If a Clear lands while a filter-index
  rebuild is running, the fresh index is discarded rather than installed
  and that one call serves an empty page; the next call rebuilds against
  the new session. Before, the rebuild held the lock, so the Clear's own
  `*state.filter_index() = None` waited for it. This is the intended
  trade (the lock is what phase 3 gives up) and the empty page is one
  fetch cadence long, but it is a new observable: a filtered view can
  blink empty for one tick immediately after a Clear.
- 2026-09-23 (phase 3) — **the logger file grid now refetches per
  announced scan.** A folder of many small unscanned files emits one
  `logger-files-scanned` per file, each one nudging the grid. The
  mirror's new single-flight guard is what bounds that to one refetch
  per round trip; the two landed together on purpose, and a future
  consumer of that event without a coalescing mirror would reintroduce
  the storm.

## Status log

- 2026-09-22 — opened; survey and rulings above.
- 2026-09-22 — the logger listing (0137) diagnosed as a second freeze
  the sync/async test would pass; shapes B and C, phases 2–3 and exit
  criteria 3, 4, 7 proposed; owner accepted all three shapes the same
  day and the task was renamed.
- 2026-09-22 — owner ruled the rule lives in ADR 0049, amended; no
  open questions.
- 2026-09-22 — phase 1 audit done by the overseer (§ Audit): 16
  shape-A offender rows, the allow-list, the async placement table,
  B0–B3, the poller table, the `ui_last_ms` creep explained as
  sampler/heartbeat aliasing. Phases 2 and 3 carry the fix list.
- 2026-09-23 — **phase 2 (shape A) landed** on `task152-shape-a`
  (1 squashed commit). § Audit's fix-list item 1, in full.

  **A1–A16, what each became** (the audit's table, ticked):

  | # | command(s) | now |
  | --- | --- | --- |
  | A1 | `delete_project_cache` | `async` + `off_async_workers` |
  | A2 | `clear_project_cache` | `async` + `off_async_workers` |
  | A3 | `clear_all_project_caches` | `async` + `off_async_workers` |
  | A4 | `list_project_caches` | **unchanged — phase 3's (shape B)**; named in the allow-list with that reason |
  | A5 | `clear_trace_store` | `async` + `off_async_workers`; body split out as `clear_trace_store_now(&app, &state)` for the exit path and A2/A3 |
  | A6 | `open_project` | `async` + `off_async_workers` |
  | A7 | `close_project` | `async` + `off_async_workers` |
  | A8 | `save_project_as` | `async` + `off_async_workers`; `save_project`'s body split out as `save_project_inner` (plain `save_project` stays synchronous — one small file) |
  | A9 | `set_loggers` | `async` + `off_async_workers` |
  | A10 | `add_dbc` | `async` + `off_async_workers` |
  | A11 | `set_settings` | `async` + `off_async_workers` |
  | A12 | `attach_local_bus_bridge`, `replay_local_virtual_buses` | `async` + `off_async_workers` |
  | A13 | `clear_dbcs`, `remove_dbc`, `set_dbc_buses`, `set_signal_unit`, `set_signal_dbc_pick`, `define_/update_/delete_math_signal` | **stay synchronous**; `invalidate_dbcs` is now in-memory only and `invalidate_derived_caches` requests `SignalCacheStore::sweep_unreferenced_in_background` |
  | A14 | `transmit_frame_once` | **stays synchronous**; `SessionTx::transmit` now uses a new `SessionTransmitter::try_transmit` (`try_send`), and a full queue comes back as `TransmitWireStatus::Failed { … outgoing queue is full … }` |
  | A15 | `restart_sidecar` | `async` + `off_async_workers` |
  | A16 | `reveal_in_file_manager` | `async` + `off_async_workers` |

  Command census after the phase: **146 commands, 99 synchronous, 47
  `async`** (was 113 / 33). No `#[allow(clippy::unused_async)]` was
  added: every converted command's body is inside `off_async_workers`,
  not merely inside an `async fn`.

  **A13's design.** `SignalCacheStore::invalidate_dbcs` now does the
  park / drop / revive / evict judgement and returns; the file work —
  which was a `wipe_prefix` (a `read_dir` of the whole pyramid root)
  per retired key *plus* a closing `wipe_dir_except` — collapses into
  one `sweep_unreferenced()`. The sweep recomputes its keep list under
  the lock from **live** state, never from the set the invalidation
  planned against (ADR 0048's "treat the plan as a hint"), so a series
  decoded again before the sweep runs keeps its files; a new pyramid's
  segment files are created truncating (`cannet_spill::seg::
  create_segment`), so nothing the sweep is late to take can be read as
  the new series' own. `park()`'s two "could not park" branches stop
  unlinking for the same reason — their files fall out of the keep list
  and the caller's sweep takes them (`restore`'s own closing wipe, or
  the background one). Single-flight: one sweeper thread, and requests
  that land while it runs are drained by it.

  **A14's design.** `try_transmit` is a new `cannet-client` method, not
  a change to `transmit_batch`: the scheduler thread keeps the waiting
  form (its whole job is to keep offering frames), and only the manual
  send — a command a view is waiting on — refuses. `TransmitRefused`
  distinguishes `Closed` from `QueueFull` so the two read differently
  to the user.

  **The two unmeasured points, measured.**
  1. **Does `set_scratch_cap` evict synchronously?** *No.*
     `TraceStore::set_scratch_cap` (`trace_store/scratch.rs`) takes the
     inner lock and stores the cap; eviction is the periodic flusher's
     `evict_below`. **But `apply_cache_caps`' other half does**:
     `SignalCacheStore::set_retention_cap` runs `evict_retained`, which
     `wipe_prefix`es each park it gives up — so lowering
     `pyramid_retention_bytes` unlinks inline. That is inside A11
     (`set_settings`), which is now `async` off the IPC thread, so it is
     covered; no further offender is left outside the fix list.
  2. **How many files does `invalidate_dbcs` unlink?** Measured off the
     new `signal_cache` test fixture: **6 files per cached signal** at
     200 samples — `…l0.0000`, `…l0.0001`, `…l0.0002`, `…l1.0000`,
     `…l2.0000`, `…l3.0000` (level-0 is a geometric segment chain, the
     higher levels one segment each). So the count is
     `Σ over retired signals (levels + level-0 segments)`, and the
     *pre-fix* cost was that many unlinks **plus one `read_dir` of the
     whole pyramid root per retired key** — i.e. quadratic in the
     retired set. A session with tens of plotted signals over a long
     capture is in the hundreds-to-low-thousands of files and as many
     directory walks. Not the six-second freeze on its own, which is why
     the audit ranked it below A1; comfortably enough to be felt on a
     DBC reload, and it is now one walk, off-thread.

  **Tests (red first, then green).**
  - `project_registry::tests::
    deleting_a_large_project_cache_never_stops_the_ui_heartbeat`
    (exit criterion 1). Fixture: **4,000 tiny files** across four
    subdirectories in a temp dir — *not* a multi-GB byte fixture,
    because the cost that froze the UI is the walk and the unlink
    count, not the bytes (a multi-GB cache made of a few large segment
    files removes faster than a megabyte-sized one made of tens of
    thousands of pyramid levels). Keeps the test in the fast default
    suite: **3.2 s**, against a 19 s host suite. The test thread stands
    in for the IPC thread and dispatches the removal the way Tauri
    dispatches an `async` command; the removal marks its own start and
    end, and the thread beats at 5 ms in between.
    **Red run:** with the removal called inline on that thread (what a
    synchronous command forces), **0 beats landed in 785 ms** of
    removal. **Green run:** the beats continue throughout, widest gap
    far below `UI_HEARTBEAT_STALL_MS`.
  - `command_surface::tests::
    every_synchronous_command_is_one_the_allow_list_names` (exit
    criterion 6), plus two guards on the list itself (no stale names;
    the scan still finds >100 commands). The check reads the crate's own
    sources — Tauri's sync/async choice is a *declaration*, so there is
    nothing to ask at run time. **Falsification run:** reverting
    `reveal_in_file_manager` to `pub fn` fails it by name.
  - `signal_cache::tests::
    a_dbc_change_unlinks_nothing_and_the_sweep_does_it_afterwards`,
    `…the_sweep_keeps_what_is_live_and_takes_only_the_rest`,
    `…the_background_sweep_drains_what_an_invalidation_left` (A13).
    The first was **red** against the first cut of the change (`park()`
    still unlinked when retention was disabled) and is what produced
    the file-count measurement above.
  - `cannet_client::tests::
    a_full_queue_refuses_a_manual_send_instead_of_waiting_for_room` and
    `…a_closed_session_refuses_a_manual_send_as_closed_not_as_full`
    (A14). The first pins the *contrast*: on the same full queue,
    `transmit` is still blocked after 100 ms where `try_transmit`
    answered at once.

  **Docs.** ADR 0002 DS-8 gains a paragraph: a derived family's orphaned
  files are now freed by a background sweep, so the measured footprint
  can briefly include files nothing refers to (the cap was never a hard
  ceiling — eviction runs on the flush tick). `crash.rs`'s
  `ui_heartbeat_age_ms` gains the § Audit explanation of the
  `ui_last_ms` creep, so the next reader does not open a task on it.
  Rustdoc on every command whose signature changed says why it is
  `async` and cites ADR 0048. **README unchanged**: it documents neither
  the per-send wire statuses nor the cache-delete latency, so nothing in
  it disagrees with the new behaviour.

  **Not in this phase, by design:** A4 / B2 (`list_project_caches` still
  walks a directory per registered cache, on the IPC thread) and every
  shape-B/C item. Exit criterion 2 is therefore **not yet met** — see
  the verdicts below.
- 2026-09-23 — **phase 3 (shapes B and C) landed** on
  `task152-listing-and-mirror` (1 squashed commit, `b4de94de`;
  pre-squash HEAD is the same commit — the phase was committed once).
  § Audit's fix-list item 2, in full.

  **B0 — `list_logger_files`, the reference case.** The listing now
  answers with the directory walk's own cost and nothing else. A file
  whose `(size, modified)` pair is not in `LogFileCache` lists with
  `scan_pending: true` and empty trace columns; the header scan is a
  background job. `LogFileCache` gained the scheduler: a `pending:
  HashSet<PathBuf>` (the single-flight set) and a `queued:
  VecDeque<ScanJob>` drained by **one** worker thread. A path enters
  `pending` once and leaves it only *after* its result is readable in
  `entries`, so a listing that races the hand-off either reads the meta
  or finds the scan still in flight — it can never miss both and queue a
  second one. One worker rather than one thread per file is deliberate:
  N concurrent multi-hundred-MB reads was half of what saturated the
  machine (0137's diagnosis). Each finished scan emits
  `LOG_FILES_SCANNED_EVENT` (`logger-files-scanned`) carrying the path.
  The file a logger is writing is still never queued — asserted.

  Frontend: `LogFileEntry.scanPending`; `LoggerFileGrid` renders start /
  end / duration / messages as `…` (`PENDING_CELL`, `.pending` at 0.55
  opacity, titled "Reading this file's header…") for a pending row, and
  listens for `logger-files-scanned` to refetch. `…` rather than blank
  or `0` because a file with no frames and a file nobody has read are
  different answers.

  **Shape C — `useHostMirror`.** One request in flight, newest answer
  wins, modelled on `useWindowedQuery`'s `fetching` + `pending`
  coalescing. A tick that finds a fetch out sets `stale` and returns;
  exactly one refetch runs from the in-flight fetch's `finally`. A
  `generation` counter decides "newest": it is bumped when a
  `fromPayload` event applies the whole state, and when the listener
  effect re-runs because the consumer re-aimed `fetch` — so a late
  answer for a superseded request or a previous target is dropped
  instead of overwriting fresher state. `refresh` is now stable (it
  reads `fetch` through a ref), so the listener effect keys on `fetch`
  explicitly. `LoggerFileGrid`, `RbsPanel` and `TransmitPanel` all get
  it for free.

  **B1 — the filter-index rebuild.** `ensure_active_filter_index` is now
  three phases: check under the index lock (and release it); if a
  rebuild is needed, take a new `AppState::filter_index_build` gate,
  re-check, build a fresh `ActiveFilterIndex` **into a local**, then take
  the index lock only for the swap; finally take the index lock and run
  the `O(delta)` incremental extend. The shared body is now
  `extend_active_index`. The build gate is what keeps two views asking
  for the same new predicate to one walk — the index mutex used to do
  that incidentally. The swap re-reads `session_start_ns()` under the
  lock and **discards** the fresh index if a Clear moved the capture
  mid-build (ADR 0048's "the plan is a hint"); the next call rebuilds. If
  what is installed is not current for the asked-for predicate, the
  function returns `None` and the caller serves an empty page, rather
  than serving from the wrong index.

  `fetch_filtered_trace`, `filtered_positions_at_ns` and
  `restore_scratch_capture` now run their bodies through
  `off_async_workers` instead of on the async-runtime worker polling
  them; all three lost their `#[allow(clippy::unused_async)]`.

  **B2 / A4 — `list_project_caches`.** New managed state
  `ProjectCacheSizes`: a `HashMap<PathBuf, u64>` of the last measured
  size plus a running/pending gate, the same shape as
  `SignalCacheStore`'s sweep. `ProjectCacheRow.bytes` is now
  `Option<u64>`; the command returns rows immediately with whatever is
  measured (`None` otherwise) and asks for one background walk of every
  registered cache, announced by `PROJECT_CACHES_MEASURED_EVENT`
  (`project-caches-measured`). Clear / Delete / Clear-all `forget()`
  the figures they invalidate, so a row reads pending rather than
  quoting a stale measurement. The command is `async` +
  `off_async_workers`, so **it is gone from
  `command_surface::SYNCHRONOUS_COMMANDS`** — the last entry that list
  carried with a debt written beside it. 98 names remain and
  `every_synchronous_command_is_one_the_allow_list_names` passes without
  it. Exit criterion 2 is now met in full.

  Frontend: `ProjectCacheRow.bytes: number | null`; the size cell shows
  `…` (dimmed, titled "Measuring this cache…"); `cacheSummary` reads
  `"N projects · measuring…"` while any row is pending rather than
  quoting a partial total; `canClear` keeps the offer while pending
  (Clear on an empty cache is a no-op, and a button that appears a
  second later is worse than one that does nothing);
  `ProjectCachesList` refetches on the event.

  **`DatabasePanel`'s value column.** A `fetching` flag in the poll
  effect; a tick that finds a request out returns *without* clearing the
  dirty flag, so the next tick after it lands asks once.

  **Tests (red first, then green).**

  | test | red evidence |
  | --- | --- |
  | `log_files::a_listing_returns_before_any_scan_finishes` | with `file_node` scanning inline (the pre-fix shape) the test **does not return at all** — killed at 90 s. Every scan is held on a condvar for the whole listing, so "waited for a scan" is a hang, not a slow pass. |
  | `log_files::n_unscanned_files_cost_n_scans_under_overlapping_listings` | dropping the `pending.insert` dedup: **6 scans of 5 files** by the time the assert ran (it would have reached 40 — 8 listings × 5 files). Green: exactly 5, and the next listing serves the headers. |
  | `log_files::a_finished_scan_announces_the_file_it_read`, `…a_scan_is_reused_when_size_and_modified_time_are_unchanged`, `…a_moved_size_or_modified_time_reads_as_uncached`, `…the_currently_writing_file_reports_its_live_status_instead_of_a_header_scan` (now also asserts 0 scans queued for the writing file) | — |
  | `useHostMirror` "keeps one request in flight when a fetch is slower than the poll interval" | **11 fetches** over ten 100 ms ticks before; 1 after, then exactly one coalesced refetch when it lands. |
  | `useHostMirror` "drops a response that lands after a newer snapshot" / "drops the answer to a fetch the consumer has since re-aimed" | both timed out at 5 s against the old hook. |
  | `tests::a_filter_index_rebuild_does_not_hold_the_index_lock_for_its_duration` | with the index lock taken before the build, a second caller **waited 21 459 µs of a 21 486 µs rebuild** (99.9 %). Green: worst wait < ¼ of the rebuild. Fixture 600 k frames, 2.2 s. |
  | `tests::two_views_asking_for_the_same_new_predicate_cost_one_rebuild` | four threads on one new predicate ⇒ `resolve_count == 1`. |
  | `project_registry::rows_list_with_their_sizes_pending_before_any_walk_has_run`, `…overlapping_listings_cost_one_walk_at_a_time` (8 requests ⇒ ≤ 2 measurements), `…clearing_a_cache_drops_its_measured_size_so_the_row_reads_pending` | — |
  | `LoggerFileGrid.dom` "shows the trace columns as pending…" and "re-asks for the listing when the host announces a finished scan" | — |

  The experiment that **refuted** its first hypothesis is worth
  recording: the first cut of the B1 test spun on `try_lock` and asserted
  it succeeded once during the rebuild. It passed against the
  *falsified* build too — the probe won the lock before the builder
  thread had taken it, so the test never observed the rebuild at all.
  The observable was changed to the *wait*: a blocking acquire in a
  loop, worst wait recorded, compared against the rebuild's own
  duration. That falsifies cleanly (21 459 / 21 486 µs).

  **One adjacent test was changed by the mirror's new behaviour.**
  `LoggerFileGrid.dom` "polls the listing only while writing" captured
  its idle baseline one render after mount; the post-listener refetch is
  now coalesced behind the mount fetch and lands a round trip later, so
  the baseline is taken after the snapshot pair settles. Same assertion,
  same intent.

  **Docs.** ADR 0049 amended (see below). README: the logger file list's
  pending columns and why they exist; the caches list's pending sizes.
  `docs/CONTEXT.md` unchanged — no new term; "pending" is used in its
  ordinary sense and the two events are named in the modules that emit
  them.

## Exit criteria verdicts (2026-09-23)

| # | criterion | verdict |
| --- | --- | --- |
| 1 | a multi-GB cache delete/clear never stops the heartbeat, asserted by test | **met** — `deleting_a_large_project_cache_never_stops_the_ui_heartbeat`; red at 0 beats / 785 ms before the fix. Fixture is 4,000 tiny files rather than multi-GB bytes, because the unlink count is the cost (reasoned above, stated in the test's own doc comment). |
| 2 | no synchronous command walks or removes a directory, reads an unbounded file, or waits on a long-held lock; the audit table records every classification | **met.** A4 was the last row outstanding. `list_project_caches` is `async` + `off_async_workers` and no longer appears in `SYNCHRONOUS_COMMANDS`; the guard passes over the remaining 98 names with no entry carrying a debt. |
| 3 | `list_logger_files` returns before any scan; N unscanned files cost N scans | **met** — `a_listing_returns_before_any_scan_finishes` (the pre-fix shape hangs rather than failing) and `n_unscanned_files_cost_n_scans_under_overlapping_listings` (8 overlapping listings of 5 files ⇒ 5 scans; without the dedup it was already at 6 when the assert ran). |
| 4 | `useHostMirror` single-flight + newest-wins | **met** — "keeps one request in flight when a fetch is slower than the poll interval" (11 → 1 fetches over ten ticks) and two newest-wins tests (a payload superseding an in-flight answer; a re-aimed `fetch` superseding the previous target's). |
| 5 | the `ui_last_ms` creep explained, and fixed if ours | **met** — § Audit's explanation (sampler/heartbeat aliasing, ending in a wrap) is now a doc paragraph on `crash.rs`'s `ui_heartbeat_age_ms`. Nothing to fix: neither side got slower. |
| 6 | the sync-command allow-list test fails on a command it does not name | **met** — `every_synchronous_command_is_one_the_allow_list_names`, falsified by reverting one command to `pub fn`. Two companion guards keep the list from rotting and the scan from silently finding nothing. |
| 7 | ADR 0049 carries the general rule and the shape-A guard; ADR 0002 and README match the behaviour | **met.** ADR 0049 gains a "same shape, three more times" context section and six general rules under § Decision (a command answers with what exists; a background job is single-flight per key and announces itself; a foreground poll never drives unbounded derivation; one request in flight per poller, newest wins; pending is neither empty nor zero; the guard is a test — `command_surface`'s allow-list, and why it must read the source). Status line amended. ADR 0002 DS-8 needed no further change: "sizes asked for, never polled" still holds — the walk is triggered by the listing, not a timer. README updated for both pending states. |

Task complete 2026-09-23: 7/7 met. Awaiting owner acceptance (review queue § 4).
