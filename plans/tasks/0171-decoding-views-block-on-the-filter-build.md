# Task 171 — Decoding Views Must Not Block on the Filter Build

> **Opened 2026-10-26** from the owner's log review of a four-day live
> session. Not groomed; questions below. Not started.

## Why

> I had cannet sitting attached to the bus for a few days, and I
> noticed the signal panel seemed to stop getting updates on one
> particular message. I tried to disconnect/reconnect and cannet is
> now sitting unresponsive. — owner, 2026-10-26

The owner changed the firmware versions on a string controller (a
CANopen SDO download from this PC) and watched the signals panel for
`String1Versions` (0x18FF4411). The new values hit the wire. The panel
kept showing the old ones for the rest of the session. Disconnect did
nothing; the window then went black for four and a half minutes.

Nothing was lost on the wire and nothing crashed. **Every decoding
fetch in the host was parked on one mutex, held by a filter-index
build over the whole capture, and the build had been started by the
error frames the owner's own firmware download produced.** The
frontend waited on the fetch with no timeout and painted its last
completed page.

## The session

TR03 rig, Kvaser Leaf v3 (SN 20833) through the python-can sidecar,
project `ct_string.cannet_prj`, 2026-10-22 11:46 → 2026-10-26 11:40
PDT. 451,052,676 frames at ~1300/s; eight Kvaser 32-bit timer wraps,
all corrected by the task 155 unwrap (that task's owed live soak —
`buffer_s` tracked wall-clock for the whole 95.9 h). The rolling host
log (5 MB) held only the last ~9 h.

Timeline, local PDT, from `cannet.log` health lines, the sidecar log
and the logger's BLFs:

| When | What |
| --- | --- |
| 11:33:04 | cannet begins transmitting 96 frames/s. Nothing logs who started it or what. |
| 11:34–11:38 | CANopen SDO requests on 0x601 at ~2100/s from this PC through the same Leaf (another handle; 473,592 frames). The Kvaser reports them as `LOCAL_TXACK` echoes, so the sidecar counts them and cannet rows them as `Tx`. Bus load ~4000/s. |
| 11:36:41 | The controller resets under the download: the session's **first error frames**. `String1Versions` payload changes (versions zeroed, then hw rev `FF FF` → `01 00` by 11:37:29). |
| 11:36:50 | **Filter-index build over the whole capture starts.** Scratch `other` grows 3.4 GB in 3 min (435 × 8 MiB index segments); host working set 0.6 → 11.6 GB (the mmap'd frame store walked end to end); system free memory ~190 MB on a 32 GB machine. |
| 11:36:50 → | The signals panel's page fetch never returns. Panel shows the pre-change values. |
| 11:40:10 | Index dropped and a second full build starts. |
| 11:40:30 | Owner clicks Disconnect. The build keeps running. |
| 11:40:50–11:45:19 | `frontend unresponsive: no UI heartbeat` — the renderer was paged out (its working set fell from ~6 GB to ~600 MB). |
| 11:45:19 | Owner connects again. New session clears the store and the index; everything frees; the UI comes back on its own. |

The 13 hours before 11:36 show `String1Versions` with a constant
payload, which is what the message is. That period explains nothing
about the hang and is recorded only so nobody re-scans it.

## The mechanism (in code, verified 2026-10-26)

1. **The trigger is automatic.** `TracePanel.tsx` collapses error
   frames by default: `collapsing = collapseErrorFrames &&
   anyBusHasErrors(health)` (`collapseErrorFrames` defaults to `true`,
   lines 96–97; the test at line 301). The moment bus health reports
   an error frame, every chronological trace view switches to the
   filtered path with `withoutErrorFrames` (`sinkPredicate.ts:144`),
   predicate `{ error_frame: false }`. The owner typed nothing in the
   filter.
2. **That predicate cannot be narrowed by id.** `filter.rs`
   `resolve_candidates` narrows an `error_frame` leaf to no ids (its
   own test says so: "an error frame leaf narrows no ids and forces
   the per-frame test"), so `all_ids_tested` (`trace_query.rs:1423`)
   makes the candidate set the whole capture and
   `FilterIndex::extend` walks all 451 M frames, `BUILD_CHUNK` at a
   time.
3. **The walk holds the DBC mutex.** Task 152 (B1) moved the rebuild
   off the `filter_index` lock: `ensure_active_filter_index`
   (`trace_query.rs:1155`) builds under `filter_index_build` and
   takes `filter_index` only to swap. But `extend_active_index`
   (`trace_query.rs:1192`) takes `state.databases()` at line 1194 and
   holds it across `refresh_filter_index` at line 1238 — the entire
   walk — because the `keep` closure decodes through the model it
   borrows from the guard.
4. **Every decoding fetch needs that mutex.** `fetch_signal_page_inner`
   takes `state.databases()` (lines 645, 657) to snapshot the DBC set
   before decoding a page; so do the by-id and trace-row decoders
   (lines 44, 119, 521, 532, 1079). `AppState::databases` is a std
   `Mutex<Vec<LoadedDbc>>` (`app_state.rs:70`): one holder, everyone
   else waits, no timeout. From 11:36:50 the signals panel's fetch
   sat behind the build.
5. **The frontend waits forever.** `useWindowedQuery.ts` keeps one
   request in flight, supersedes any pending one, and has no timeout
   or abort. `useSignalView` keeps the view's last page, so the panel
   paints old values and looks "not updating". No pending state
   reaches the panel.
6. **Nothing cancels the build.** Disconnect and Clear do not touch
   `filter_index_build`; the swap discards a stale result when
   `session_start_ns` moved, but only after the walk finishes. A second
   build started at 11:40:10 before the first was useful.
7. **The health line could not see it.** The UI heartbeat
   (`report_js_heap`, `lib.rs:264`) is a sync command that takes no
   lock, so `ui_last_ms` stayed healthy while every view was blocked.
   The 11:40:50 "frontend unresponsive" was the renderer being paged
   out under the 11.6 GB host, not the lock. There is no host line for
   a filter build starting or finishing, none for a command waiting on
   a lock, and no persisted frontend log (`diag.ts` is `--diag` and
   console only).

Nothing in this chain needs a log the repo does not keep; the logging
items below are so the *next* one is a one-line grep instead of a
day.

## Scope

1. **The DBC mutex is never held across capture-scaled work.**
   `extend_active_index` snapshots what it needs from the databases
   (the resolved candidates and the decode model, which `decode_model`
   already builds as a value) and releases the guard before the walk.
   Audit the other `state.databases()` holders for the same shape
   (`sample_signals`, `restore_scratch_capture`'s pyramid restore, the
   by-id scans). Rule: the guard protects the vector, not the work.
2. **A filter build is cancellable and is cancelled.** A cancel flag
   checked once per `BUILD_CHUNK`; raised by Clear, Disconnect, a new
   session, and a predicate change that supersedes the one being
   built. A cancelled build installs nothing. The second build at
   11:40:10 should have been the first one being cancelled.
3. **The default error-frame collapse does not walk the capture.**
   Collapsing error frames is a class test the store can answer
   without decoding — the same way the by-id index answers an id. Two
   shapes to grill: an error-frame posting list maintained on append
   (so `{ error_frame: false }` narrows to "everything except these
   rows", `O(errors)`), or the chronological view skipping error rows
   at serve time with the count from bus health. Either way the
   predicate stops being the one non-narrowable leaf a default setting
   can arm on a 450 M-frame capture.
4. **The host says what it is waiting on.** One WARN when a command
   waits more than 1 s to acquire a named lock (command, lock, wait);
   one INFO pair at filter-build start and finish (predicate summary,
   frames walked, segments, elapsed, cancelled or installed). With
   these two lines, the 2026-10-26 log reads as the mechanism above
   in one grep.

### Not in scope (seen in the same logs; groom separately or drop)

- The renderer's working set cycled 5.6–9.1 GB all day (JS heap
  1.0–2.9 GB sawtooth, ~30 MB/s churn, floor flat) and drove free
  memory under 1 GB at every peak. One panel: closing a panel in the
  next session dropped the heap to ~200 MB. Nothing names which.
- The sidecar process emitted nothing 11:29:14–11:31:28 (read 0
  frames; ~2 min of bus traffic lost, five ECU counter checks failed)
  with ~700 MB free just before — paged out. The sidecar's stats line
  carries no working-set or system-memory figure.
- New session, 12:18:49–12:20:06: the bus went silent, sends were
  refused, and the sidecar reopened the channel **248 times at ~300 ms
  intervals** with no backoff (`shared_interface.py` "refused sends
  with its transmit queue full and received nothing for N s; reopened
  the channel"); the host logged ~7000 transmit-queue-full warnings.
  Recovered unaided.
- A transmit starting (11:33:04, 96 frames/s) leaves no log line
  saying which frame, which source, or who.
- Another handle's frames on the same Kvaser channel arrive as
  `LOCAL_TXACK` echoes and are rowed as `Tx` — the ADR 0061 PEAK caveat
  applies to Kvaser too and is not written down.
- The 5 MB rolling log holds ~9 h of a four-day session because the
  2 s rx/tx stats lines fill it.
- Task 143 (a stalled heartbeat reloads the window) would have
  reloaded into the same held lock; it is unaffected by, and does not
  fix, this.

## Open questions

- **Q1 (scope 3)** — posting list vs. serve-time skip? The posting
  list keeps the filtered path uniform (one index, one page fetch);
  the serve-time skip keeps the chronological path and never builds
  an index for a default. Which row count does the trace's scrollbar
  show while error frames are collapsed?
- **Q2 (scope 1)** — a per-call snapshot of the decode model is an
  allocation per page fetch on today's code too (lines 645/657 clone
  the set); is the model already `Arc`-shaped enough to share, or does
  `databases` become `RwLock<Arc<…>>` with the swap on reload?
- **Q3 (scope 4)** — does the lock-wait WARN live in a wrapper on
  `AppState`'s accessors (every holder, free) or only on the
  capture-scaled ones (fewer false positives from a slow
  `delete_project_cache`)? Task 152's audit table is the list.
- **Q4** — does the rule ("a serve never waits on capture-scaled
  work; derivation is bounded, cancellable and announced") land in
  the ADR task 152 proposed, or as its own? Task 152 is in
  pending-closeout; whichever lands first carries it.

## Phases (proposed, ungroomed)

1. **The regression test, then the lock scope (host).** Write the
   test first: start a full-capture filter build on a store large
   enough to take seconds, issue `fetch_signal_page` from another
   thread, assert it returns within the live-update cadence while the
   build is still running. Watch it fail on today's code. Then
   scope 1. Perf reading: filtered-page fetch cost unchanged.
2. **Cancellation (host).** Scope 2 and the tests for it: Clear,
   Disconnect and a superseding predicate each stop a build within one
   chunk and install nothing; a cancelled build frees its scratch
   segments.
3. **Error frames without a capture walk (host + trace).** Scope 3
   after Q1 is ruled; the trace panel's collapse toggle keeps its
   behaviour and loses its cost.
4. **Logging (host).** Scope 4; one test per line. Exercise against a
   synthetic replay of the 2026-10-26 shape (generated BLF, error
   frames arriving late) and confirm the two lines tell the story.

## Exit criteria

- [ ] A signal page fetch returns while a whole-capture filter build
      is in progress (regression test, host).
- [ ] No `state.databases()` guard is held across any capture-scaled
      loop (audited; the accessors' call sites listed in the status
      log).
- [ ] Clear, Disconnect and a superseding predicate cancel a running
      build within one chunk; nothing is installed from a cancelled
      build; its scratch is released.
- [ ] The default error-frame collapse on a capture of ≥ 100 M frames
      costs no whole-capture walk when the first error frame arrives.
- [ ] A command waiting > 1 s on a lock logs one WARN naming both; a
      filter build logs start and finish with predicate, frames,
      elapsed and outcome.
- [ ] Replay of the 2026-10-26 shape (long capture, late first error
      frame, a payload change on one message): the signals panel
      shows the change within the live-update cadence; the trace
      collapses error frames; the host working set does not grow by
      the capture's size.
- [ ] Docs: the rule in an ADR (Q4); CONTEXT.md if a term is added;
      the task 152 audit table updated for the moved holders.

## Status

(none yet)
