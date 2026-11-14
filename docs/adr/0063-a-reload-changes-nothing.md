# ADR 0063 — A reload changes nothing

Status: accepted (2026-11-14)

## Context

The frontend is a view over a host-side model (`CLAUDE.md` § GUI
architecture), so in principle it can be torn down and rebuilt at any
time — and sometimes it has to be: a WebView2 renderer or GPU restart
leaves a black window whose only recovery is a reload. In practice a
reload booted as if the process were new. It re-opened the project file,
which stops every rest-of-bus element and logger and reloads the
transmit pool with its periodics stopped; it re-pushed the DBC set and
the virtual buses; it asked for the prior capture to be restored, which
swaps the session buffer out from under a live pump; it reset every
view's trace window; and it reverted unsaved project edits to the file.
A user who reloaded a connected window found every view stopped and
their edits gone.

## Decision

**The frontend may be reloaded at any time without changing host or
project state.**

1. **The host holds what the session is.** Beside the session buffer it
   already held, the host holds, in memory and for the session only:
   - each element's **trace window** (`trace_windows.rs`) — the run
     controls are host commands and the frontend mirrors the map;
   - the **working project** (`working_project.rs`) — the project as
     the user has it, saved or not, with its dirty flag, pushed by the
     frontend on each edit (debounced, 300 ms);
   - what each connected session's connect answered and was asked to
     apply, the file an import is reading, and every other fact the
     frontend used to build up from the answers to its own commands.

   None of it is written to disk. A relaunch still opens the project
   file and restores a prior capture as stopped (ADR 0002 DS-7).
2. **A boot asks first.** `session_status` answers whether a project is
   held, its file, its working document and dirty flag, the session
   buffer's picture, the connected sessions, the loaded DBC set, whether
   a pyramid rebuild is owed, and an import in flight. If the host holds
   a project — connected or not, saved or not, dirty or not — the boot
   **rejoins** it: it applies the working document and mirrors the
   trace windows, and reads everything else back from that answer and
   from the mirrors that hydrate themselves on mount. It opens nothing,
   pushes no DBC set, replays no virtual bus, restores no capture,
   pushes no logger set, and clears nothing. The frontend compares
   nothing: the host says what it holds. Only a process launch, which
   holds nothing, takes the fresh path, and the fresh path is unchanged.
   User-initiated Open project, New project and the disk-watch Reload
   (ADR 0053) are fresh opens.
3. **Host state wins.** Once the host holds the project, the project
   file is read only on a fresh open. The working document's layout is
   fresher than the working layout in `.cannet/state.json` (ADR 0032),
   so a rejoin applies the document's.
4. **Nothing pushed from mount-time defaults.** A frontend that has not
   yet heard the boot's answer holds only defaults — no elements, no
   buses, no loggers. Pushes that would overwrite host state with them
   (the trace-window id set, the logger set, the RBS bus names) wait
   for the boot, and a rejoin's first set is the one the host already
   has, so it is not sent.
5. **The restore never swaps a live store.** `restore_scratch_capture`
   refuses to replace the session buffer while a bus is connected or an
   import pump runs, and answers from the live store instead.
6. **The automation scenario runs once per process.** `diag_autostart`
   hands the launch's self-driving config (ADR 0031) to the first boot
   only; a reloaded frontend rejoins the session rather than opening and
   connecting again. `--reload-after-secs` (with `--reload-prepare`)
   reloads the window from the host and logs the session's state before
   and after, the regression harness for this rule.

### What a reload loses

- **Undo history** (ADR 0058's stacks) and **view-local state** —
  scroll positions, expanded rows, column drags not yet in the layout,
  focus history. They start fresh, as on a fresh open.
- **Nothing of a project edit, on a reload the app's own page sees
  coming.** An edit schedules the push; a reload inside the 300 ms
  debounce is covered by the page's `pagehide` handler, which sends the
  pending push at once. That send is an un-awaited `invoke` during
  teardown, and on WebView2 it reaches the host: the reload harness's
  probe — the same un-awaited `invoke` from a `pagehide` listener —
  logged on the host within 40 ms of the host issuing the reload in
  each run it was tried. A renderer that dies without running `pagehide` (a crash rather
  than a reload) gets no flush, and there the debounce is the bound:
  up to 300 ms of edits.
- **Transient progress chips** for work that keeps running on the host:
  a capture export's progress (its completion still shows) and a prior
  capture's restore progress. A pending "project changed on disk"
  notice is not raised again.

## Consequences

- Every boot-path or frontend-state change is judged against this rule:
  a fact the frontend builds up from events or from its own commands'
  answers is a fact a reload loses, unless the host holds it and the
  rejoin reads it back. New session state belongs on the host, with a
  read the rejoin uses.
- A mount-time push of frontend defaults to the host is a defect: it
  must wait for the boot's answer.
- The window can be reloaded as a recovery step at any time, including
  mid-capture, without the user re-establishing anything.
