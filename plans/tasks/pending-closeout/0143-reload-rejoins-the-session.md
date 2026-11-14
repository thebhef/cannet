# 0143 — A Webview Reload Rejoins the Running Session

> **Opened 2026-09-15** by owner ruling, from the six-day ll16 capture
> report: the window went black mid-capture (a WebView2 renderer/GPU
> restart under an RDP session event — 11.9 GB free, so not memory),
> and the only recovery is a reload, which today disturbs the capture.
> **Groomed 2026-11-14** after the owner reloaded a connected window and
> every view with run controls came back stopped, with no way to widen
> a trace view back to the whole buffer. The rule the owner stated:
> reloading the frontend window has no impact on the state.
> The precise WebView2 `ProcessFailed` hook is **backlogged**, not in
> scope (owner ruling: the user can command a reload if they need to).

## Context

The frontend is a view over a host-side model (`CLAUDE.md` § GUI
architecture), so in principle it can be torn down and rebuilt at any
time. In practice a reload boots as if the host were fresh:

- `open_project` re-roots the session (a no-op on the same directory)
  but **stops every RBS element, stops every logger, and reloads the
  transmit pool with periodics stopped**.
- The frontend re-pushes the DBC set and `replay_local_virtual_buses`.
- `restore_scratch_capture` → `TraceStore::try_reload` **swaps the raw
  store wholesale**, gated on the project identity only. Only *Connect*
  waits for a reload in flight (`restorePendingRef`); an already-live
  pump appends into a store that is about to be replaced.
- **Every element's trace window resets.** The window (`start`, `end`,
  `isPaused` — `trace.ts`) lives only in the frontend element registry;
  `applyProject` sets each to a stopped empty window and the restore
  then sets each to a stopped whole-buffer window.
- **Unsaved project edits revert to the file.** Elements, buses,
  interface bindings, the DBC list and signal colours live only in the
  frontend until Save; the working layout is in `.cannet/state.json`
  but `applyProject` overwrites it with the file's layout.

Evidence, `ll16_6d_crash.log` 2026-09-15 21:02–21:08: renderer memory
collapses 2.2 → 1.0 GB and the GPU process restarts (black screen); the
reload logs `opened project` at 21:03:14; the pump keeps running (fps
~1000, `trace_len` monotone) but no `restored … frames` line ever
appears before the owner restarts the app at 21:08.

## Rulings (owner, 2026-11-14)

1. **The host holds the trace windows.** A session-scoped map, element
   id → trace window, beside the session buffer it indexes. The
   frontend registry mirrors it; Start / Stop / Pause / Resume / Clear /
   All Data are host commands. Not persisted — a relaunch still
   restores a capture as stopped. This is state only: the paging path
   (`useTrace`'s window arithmetic, `fetch_trace_range`, the plot's
   visible-window resample) does not change, and nothing is written per
   frame.
2. **The host holds the working project.** The frontend pushes the
   working project document to the host on each edit (debounced), as it
   already does the layout. In memory only, session-scoped. A rejoin
   reads it back, dirty flag included, instead of the file. Undo
   history is not carried across a reload.
3. **A boot rejoins whenever the host already holds a project**,
   connected or not, saved or not. The fresh path runs only when the
   host holds nothing — a process launch. The frontend compares
   nothing: the host says what it holds. (Settles the former design
   questions 1 and 2: host state wins for everything once the host
   holds the project; the file is read only on a fresh open.)
4. **The host-issued reload (phase 5) is not in the 2026-11-14 run.**
   A manual reload gets used for a while first.

## Scope

### Phase 1 — All Data in every trace-style view

`TraceControls` shows All Data for every consumer: `onAllData` becomes
required and the trace panel and the signals panel pass
`trace.allData`. The plot's behaviour is unchanged.

### Phase 2 — the host holds the trace windows

- Host: the session-scoped window map and its arithmetic (today's pure
  functions in `trace.ts`: fresh, cleared, restored, clear-keeping-
  state, all-data, stop, pause, resume, re-anchor). Commands for each
  run control, a read of the whole map, and a change event.
- The moments that set every window today move with it: connect / open
  a BLF / Clear start every window from 0; a restored capture sets
  every window to the stopped whole buffer; a new element takes
  running-from-0 when a session buffer exists, else stopped-empty; a
  buffer that shrank re-anchors. Opening or closing a project empties
  the map.
- Frontend: the registry's `trace` slot becomes a mirror of the host
  map (the shared `useHostMirror`); `useTrace`'s controls invoke the
  host. Stop and Pause freeze at the host's count.

### Phase 3 — the host holds the working project

- Host: the working project document and its dirty flag, set by a
  debounced push from the frontend on every project edit, read by one
  command. Emptied by open / close / new project; Save clears dirty.
- Frontend: push on edit. No boot change yet.

### Phase 4 — rejoin

- Host: a `session_status` command — whether a project is held, its
  path (none for an unsaved project), its working document and dirty
  flag. `restore_scratch_capture` refuses to swap the store while a
  bus is connected and answers from the live store instead.
- Frontend: the boot asks `session_status` first. If the host holds a
  project the boot **rejoins**: no `open_project`, no DBC push, no
  virtual-bus replay, no `restore_scratch_capture`, no logger push. It
  applies the working document (elements, buses, bindings, colours,
  dirty) and the working layout from `.cannet/state.json`, mirrors the
  trace windows, and reads the rest back through the commands that
  already exist — `list_dbc_content`, `get_connection_states`,
  `list_transmit_frames`, `get_logger_statuses`, `fetch_notes`,
  `list_math_signals`, `rbs_view`, the trace count / session origin.
- An ADR stating the rule: the frontend may be reloaded at any time
  without changing host or project state; what a reload does lose
  (undo history, view-local state such as scroll position) is listed.

### Phase 5 — the host reloads a wedged window (not started)

- The health recorder (`crash.rs`) already detects a heartbeat stall
  (`UI_HEARTBEAT_STALL_MS`, 5 s, warn once per episode). Past a much
  longer bound — 60 s proposed — it asks the main window's webview to
  reload, **once per episode**, and says so on the system log.
- The reload takes the phase-4 rejoin path.
- Open: the bound, and whether it gets a setting (`settings.json`,
  ADR 0034) or is always on.

### Out of scope

- WebView2 `ProcessFailed` (backlog: needs a direct `webview2-com`
  dependency and `unsafe` COM calls the workspace forbids outside
  `cannet-spill`'s fenced site).
- Any change to what a *fresh* boot does.
- Undo history across a reload.

## Exit criteria

- [x] The trace panel and the signals panel show All Data; pressing it
      on a stopped view shows the whole session buffer (DOM tests).
- [ ] Trace windows are host state: run controls round-trip through
      the host, the frontend holds only a mirror, and the window
      arithmetic has host tests. No `trace.ts` arithmetic remains that
      the host also has.
- [ ] A reload leaves the session connected, every logger writing,
      periodic transmits and RBS elements running, the trace count
      continuous, and every element's trace window as it was — running
      stays running, paused stays paused, stopped stays stopped. DOM
      tests for the rejoin branch of the boot; host test for
      `session_status`.
- [ ] A reload with unsaved edits keeps them and stays dirty; a reload
      while disconnected keeps the capture and the trace windows.
- [ ] `restore_scratch_capture` never swaps the store while a bus is
      connected (host test).
- [ ] Checked on CAN hardware: connected, a logger writing, a periodic
      transmit running, one view paused and one stopped — reload, and
      nothing changes.
- [ ] A perf reading at the phase-4 tip, recorded.
- [ ] The ADR is written; README's behaviour notes match what ships.
- [ ] *(phase 5)* A stalled heartbeat past the bound triggers exactly
      one reload per episode, logged; the verdict is a pure, tested
      function beside `ui_liveness`; `crash.rs` module docs match.

## Status log

- **2026-11-14, phase 1 (branch `task143-all-data`).** `TraceControls`
  `onAllData` is required and the chip always renders; the trace panel
  and signals panel pass `trace.allData`; the plot's handler (which
  also fits its x axis) is unchanged. The chip's tooltip no longer
  mentions the x axis (it is plot-only); `PlotToolbar.dom.test.tsx`
  updated. DOM tests: `TracePanel.dom.test.tsx` (Clear, Stop, All Data
  -> `{0, count, stopped}`) and `SignalsPanel.dom.test.tsx` (stopped
  40..60 -> `{0, count, stopped}`). Running-from-0 and paused cases
  stay covered by the pure `trace.test.ts`. No perf run: no data or
  render hot path changed.
- **2026-11-14, phase 2 (branch `task143-host-trace-windows`).** Trace
  windows are host state: `apps/gui/src-tauri/src/trace_windows.rs`
  (`TraceWindow` + the ported arithmetic, a `TraceWindows` map on
  `AppState`, commands `get_trace_windows` / `trace_window_control` /
  `sync_trace_windows`, event `trace-windows-changed` carrying the
  map). Frontend mirrors through `useHostMirror` (`traceWindows.ts`);
  `ElementRegistry.updateTrace` → `controlTrace`; `trace.ts` keeps only
  the read side. Paging untouched.
  - Element lifecycle is one command, not ensure + remove: the
    registry hands the host its whole id set whenever the set changes
    (`sync_trace_windows`) — new ids get the new-element window, kept
    ids keep theirs, missing ids are dropped. Covers create, ensure,
    duplicate, remove, undo/redo and project apply with one call site.
  - Run controls are not optimistic: the view shows the host's answer
    (no DOM test showed a lag problem; the round trip is in-memory).
  - The "every window" moments and where each lives now:

    | Moment (old frontend site) | Now |
    |---|---|
    | Connect / open BLF or MDF / Clear / New (`startAllElements` via `useSessionReset`) | `clear_trace_store` command: `start_all` |
    | Buffer shrank (`reanchorToSession` effect on `count`) | `clear_trace_store_now` (every clear, incl. the project-cache Clear) and a restore that reloaded nothing: `reanchor_all` |
    | Restore (`restoredTrace(restored.count)`) | `restore_scratch_capture`: `restore_all(count)` when count > 0 |
    | Import ended (`stopTrace(e.trace, count)` on `log-finished`) | `run_pump` clean end when `replay_origin`, and MDF's no-messages branch: `stop_all(store len)` |
    | Project apply (`clearedTrace(countRef.current)`) | `open_project`: `replace_for_open` (file's element ids, cleared at the store count) |
    | Close / New project | `close_project`: map emptied |
    | New element (`newElementTrace` in create / ensure / duplicate / restore) | `sync_trace_windows`: `new_element(session started or len > 0)` |

  - Tests: 19 host (`trace_windows::tests`, `project::tests::element_ids…`;
    the arithmetic port was written with the module, then a mutation
    — clear dropping paused-ness — was confirmed caught before
    reverting). DOM: `traceWindows.dom.test.tsx` (new, written and
    seen failing first), TracePanel run controls / All Data (rewritten,
    seen failing against the old `useTrace`), SignalsPanel / PlotPanel
    All Data, App import-end / Clear / mirror / id sync, mid-session
    create, DBC re-anchor. `registryTestKit` records controls and
    takes the host's answer (`setTrace`).
  - Deviation: New project. Before, `startElements: false` left the
    seeded views as `newElementTrace` made them — stopped with no prior
    session, running otherwise — and the result raced the
    fire-and-forget clear. Now the clear always starts every window, so
    the seeded views run from 0 after New in every case (the clear
    starts a session, which is the new-element rule's own condition).
    Queued for a yes/no.
  - README: the "new trace starts empty and stopped regardless of the
    buffer" note was already wrong (mid-session views run from 0 since
    an earlier change); corrected. `docs/CONTEXT.md` gains **Trace
    window**.
  - Perf (ADR 0031, release, ev-zonal 60 s, scrub; reports
    `docs/performance-measurements/frontend/2026-11-14-7e7d9983-run{1,2,3}.json`):
    ids_measured 174 / 174 / 174; rx 1605.9 / 1605.1 / 1605.8 f/s;
    lag_ms max 22.0 / 20.1 / 4.1; longtask max 0 / 78 / 0 ms/s;
    tx_late_ms max 5.97 / 77.6 / 8.46; flush_ms max 7.07 / 20.17 /
    11.64; host_mb max 71.6 / 63.5 / 63.1; webview_renderer_mb max
    356.2 / 362.4 / 353.6; jsheap max 101.7 / 97.1 / 99.4;
    `memo.elementRegistryValue` 0.83/s in all three (no per-frame
    registry churn).
- **2026-11-14, phase 3 (branch `task143-working-project`).** The host
  holds the working project: `apps/gui/src-tauri/src/working_project.rs`
  (`WorkingDocument`, a `WorkingProject` store on `AppState`, commands
  `set_working_project` / `get_working_project`, both synchronous
  memory swaps on the allow-list). No boot change.
  - What the document carries — the frontend-owned half of the save
    payload, in the form Save writes it (DBC / `.cannet_rbs` paths
    relative to the project file where the file stores them so):
    `layout`, `elements`, `buses`, `interface_bindings`, `dbcs` (with
    bus scoping), `local_virtual_buses`, `signal_colors`. Plus `dirty`.
    `schema_version` and the dead `remote_address` arrive in the push
    and are dropped.
  - What stays in host registries (single source, not copied): the
    transmit pool, math signals, signal DBC picks, signal units — what
    `save_project` already snapshots from the registries. Bus names
    already reach the host on every bus edit; RBS and loggers are their
    own host state. Phase 4 reads them through the existing commands.
  - The path is not stored: `get_working_project` reads it from the
    disk watch's record (`watched_project`, set on open and every save,
    forgotten on close). The record's text — what ADR 0053's "changed on
    disk" compares against — is untouched by a push.
  - Lifecycle: `open_project` seeds the document from the parsed file,
    clean; `close_project` (New) resets to "held, no document, clean";
    a push replaces document + dirty (and marks a never-opened session
    held); `save_project` / `save_project_as` clear dirty. Before any of
    these (process launch) nothing is held — the bit phase 4's
    `session_status` needs.
  - Frontend: `workingProject.ts` — one debounced (300 ms),
    de-duplicating pusher, made once in `App`. It reads `gatherProject`
    (the function Save uses) at send time. Triggers: one effect keyed
    on `gatherProject`, `projectPath`, `dirty` and `bootSettled`, and
    the dock's layout-change listener (the layout is not React state).
    `gatherProject` now depends on an element list whose identity
    changes only when an element object does, so a trace-window mirror
    update or a live count tick schedules nothing. Gated on
    `bootSettled`: nothing is sent while the boot is still applying the
    project. `pagehide` flushes a pending push.
  - Tests: host 6 (`working_project::tests`: fresh holds nothing, open
    seeds clean, close resets, push replaces, save clears dirty, the
    frontend payload deserializes to exactly the seven fields; a
    `saved()` no-op mutation was confirmed caught). Frontend:
    `workingProject.test.ts` (7, pusher), `App.workingProject.dom.test.tsx`
    (5: no push before the boot settles, an edit pushes once with
    dirty, mirror update / count tick / unchanged document push
    nothing, `pagehide` flushes, New pushes after the close). Removing
    the boot gate or the `pagehide` listener was confirmed to fail them.
  - Dropped during the phase: a "resend after open / close" hook. New
    seeds fresh element ids, so its document never equals the last
    push and the ordinary trigger already sends it; no test could tell
    the hook was there.
  - Perf (ADR 0031, release, ev-zonal 60 s; reports
    `docs/performance-measurements/frontend/2026-11-14-73271efc-run{1,2,3}.json`
    with scrub, `-idle-run4.json` with no interaction; `73271efc` is the
    pre-squash build, same code): ids_measured 174 in all four; rx
    1605.4 / 1609.0 / 1607.0 / 1612.0 f/s; lag_ms max 29.5 / 4.6 / 3.2
    / 3.1; longtask max 0 in all; tx_late_ms max 13.3 / 7.7 / 24.4;
    flush_ms max 12.1 / 10.6 / 10.9; host_mb max 63.0 / 63.2 / 64.2 /
    63.1; webview_renderer_mb max 343.6 / 410.7 / 357.8 / 445.0; jsheap
    max 97.9 / 123.9 / 105.7. `workingProject.push` 0.83/s in the scrub
    runs — equal to `dockview.layoutChange` and `registry.update`, i.e.
    one push per scrub gesture edit (plot pan / zoom / follow write the
    element and layout) — and **0 in the no-interaction run**: no push
    during a steady live capture. Run 1 (first in a fresh
    `--app-data-dir`) has `winw` 0 and scroll_jank_px 81 863; runs 2–3
    have `winw` 0.8 and 289 / 241, in phase 2's band — the same split
    earlier reports show between `winw` 0 and non-zero runs.
