# 0143 — A Webview Reload Rejoins the Running Session

> **Opened 2026-09-15** by owner ruling, from the six-day ll16 capture
> report: the window went black mid-capture (a WebView2 renderer/GPU
> restart under an RDP session event — 11.9 GB free, so not memory),
> and the only recovery is a reload, which today disturbs the capture.
> Two parts, in order: make a reload safe, then let the host issue one
> when the renderer stops heartbeating. The precise WebView2
> `ProcessFailed` hook is **backlogged**, not in scope (owner ruling:
> the user can command a reload if they need to).

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

Evidence, `ll16_6d_crash.log` 2026-09-15 21:02–21:08: renderer memory
collapses 2.2 → 1.0 GB and the GPU process restarts (black screen); the
reload logs `opened project` at 21:03:14; the pump keeps running (fps
~1000, `trace_len` monotone) but no `restored … frames` line ever
appears before the owner restarts the app at 21:08.

## Scope

### Phase 1 — rejoin

A boot that finds the host already holding the project it would open
takes a **rejoin** path instead of the fresh-host path.

- Host: a `session_status` command — the active project (id + path)
  and whether a live session exists (any connected bus / running pump).
  Belt and braces on the host too: `restore_scratch_capture` refuses
  to swap the store under a live session and answers from the live
  store instead.
- Frontend: on boot, if `session_status` names the project the boot
  would open, skip `open_project`, the DBC push, the virtual-bus
  replay, `restore_scratch_capture` and the logger push; read the
  state back through the commands that already exist —
  `list_dbc_content`, `get_connection_states`, `list_transmit_frames`,
  `get_logger_statuses`, `fetch_notes`, `list_math_signals`,
  `rbs_view`, the trace count / session origin (status snapshot) —
  and apply the project file for layout and buses as today.
- Everything the fresh path does that is *not* host state (layout,
  undo history reset, dock) still happens.

### Phase 2 — the host reloads a wedged window

- The health recorder (`crash.rs`) already detects a heartbeat stall
  (`UI_HEARTBEAT_STALL_MS`, 5 s, warn once per episode). Past a much
  longer bound — 60 s proposed — it asks the main window's webview to
  reload, **once per episode**, and says so on the system log. With the
  anchor index persisted and `frame_indices_at_ns` off the main thread
  (landed 2026-09-15), a stall is the renderer, not the host; the
  threshold still has to clear ordinary long JS tasks.
- The reload takes the phase-1 rejoin path, so a live capture is
  undisturbed.

### Out of scope

- WebView2 `ProcessFailed` (backlog: needs a direct `webview2-com`
  dependency and `unsafe` COM calls the workspace forbids outside
  `cannet-spill`'s fenced site).
- Any change to what a *fresh* boot does.

## Design questions

1. **What decides "the host already holds this project"** — project id
   equality alone, or id + path? (Id alone matches the DS-7 identity
   gate; path catches a Save As that moved it.)
2. **Should the rejoin path re-apply the project file at all**, or is
   host state the only truth once a session is live? Layout and buses
   come from the file today; the DBC set and transmit pool would come
   from the host. Any field that exists in both needs a ruling on
   which wins.
3. **Watchdog threshold and opt-out.** 60 s once per episode is the
   proposal; whether it needs a setting (`settings.json`, ADR 0034)
   or is always on.
4. **An ADR** stating the rule — the frontend may be reloaded at any
   time without disturbing the host session — since it governs every
   future boot-path change, not just this one.

## Exit criteria

- [ ] A reload during a live capture leaves the session connected,
      every logger writing, periodic transmits and RBS elements
      running, and the trace count continuous. DOM tests for the
      rejoin branch of the boot; host test for `session_status`.
- [ ] `restore_scratch_capture` never swaps the store under a live
      session (host test).
- [ ] A stalled heartbeat past the bound triggers exactly one reload
      per episode, logged; the verdict is a pure, tested function
      beside `ui_liveness`.
- [ ] The ADR from design question 4 is written; README's behaviour
      notes and `crash.rs` module docs match what ships.

## Status log

_(none yet)_
