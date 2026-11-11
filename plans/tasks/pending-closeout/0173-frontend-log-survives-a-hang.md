# Task 173 — A Frontend Log Which Survives a Hang

> **Opened 2026-11-11** from the owner's log review of a hang on the
> LL16 bench PC. Groomed and implemented 2026-11-11 (rulings under Open
> questions); awaiting the Windows experiment and the cost measurement.

## Why

cannet on the LL16 bench PC hangs after running for several days. The
window is resized often over RDP, and another application on the same
PC commands the DUT through the same bus. The 2026-11-11 hang was
diagnosed as far as the logs allow, which is not far enough: they say
the window stopped answering and do not say which side stopped.

## The session

LL16 bench PC, Kvaser (SN 14092, ch 0) through the python-can sidecar,
project `ct_single_module.cannet_prj`, 0.9.0-integration. The rolling
host log held 2026-11-11 06:11 → 15:04 PST. At the hang: 112 M frames,
27.3 h buffer, 205 live plots.

| When (PST) | What |
| --- | --- |
| all day | `jsheap_mb` cycles ~250 ↔ 900+ every ~60 s; `renderer` 3–4.5 GB; `ui_last_ms` peaks ~1.0–1.1 s. |
| 11:39:00 | Last UI heartbeat. |
| 11:39:20 | `frontend unresponsive: no UI heartbeat for 13432 ms`. `gpu` steps 344 → 436 MB in the same 20 s sample. |
| 11:39–11:44 | `ui_last_ms` climbs to 314019 and never recovers. `renderer` swings 2.9 ↔ 4.8 GB. Ingest (`read_fps` ~1135, `queued=0`), sidecar (`errors=0/s`, `echoes_dropped=0`), host `rss_mb` (~7320) and free memory (≥ 7.6 GB of 32 GB) are all normal. |
| 11:44:22 | Log stops. No panic record, no shutdown lines. |
| 11:44:35 | New process (owner relaunch). |

Owner's description of the window: still resizable, not clickable,
white overlay.

## What the logs cannot say

The heartbeat is `report_js_heap`, a synchronous command dispatched on
the host's webview IPC thread (`command_surface.rs`). Its absence means
either the renderer stopped sending or that host thread stopped
turning. Two hypotheses, neither confirmed:

- **Host window/IPC thread blocked.** A white overlay on a window which
  resizes but takes no clicks is what Windows shows for a window whose
  owning thread has stopped pumping messages. Rests on the owner's
  description only.
- **Renderer main thread spinning.** The `renderer` swings during the
  hang; the `gpu` step at the last heartbeat is consistent with a
  resize starting a relayout which does not terminate. Circumstantial.

The frontend records almost nothing which would settle it. A normal
launch sends one number a second (the JS heap). The counters, timer lag
and long-task measures in `diag.ts` are `--diag` only and go to the
devtools console. There is no `window.onerror` or `unhandledrejection`
handler, so an uncaught JS exception never reaches `cannet.log`. The
host logs no resize, scale-factor or session event. Task 171 hit the
same wall ("no persisted frontend log").

## Scope

1. **Uncaught frontend failures reach the host log.** `window.onerror`
   and `unhandledrejection` are forwarded over the existing IPC path
   and written to `cannet.log` at `warn`, rate-limited. Timer lag and
   long-task time are forwarded only when over a threshold; the
   per-render counters stay `--diag`.
2. **A worker-side recorder which does not depend on the host.** A Web
   Worker with its own timer receives a ping from the main thread and
   appends to a bounded ring in origin-private storage. It records:
   - main-thread stall start and end (pings stopped / resumed);
   - whether the host is acknowledging the heartbeat;
   - `invoke` calls which have not returned, by command name and start
     time;
   - the suspect events in item 3.

   The ring is handed to the host at launch and periodically while
   healthy, and written to `frontend.log` beside `cannet.log`. During a
   hang the file on disk is stale until the next launch; that is
   accepted, since every hang so far has ended in a kill and relaunch.
3. **The suspect events are logged.** `resize`, `devicePixelRatio`
   change and `visibilitychange` go into the ring from the frontend.
   The host logs window resize and scale-factor change to `cannet.log`
   at `debug`, coalesced per burst. (Windows) RDP session
   connect/disconnect is deferred — see Q6.

Reading a hang afterwards: worker saw pings stop → renderer; pings
continued while the host saw no heartbeat → host IPC thread, with the
outstanding `invoke` names as the first suspects.

### Not in scope

- Fixing the hang. This task makes the next one diagnosable.
- A live channel which bypasses IPC (a localhost endpoint the worker
  posts to). It is the only way to get a file which grows during a
  hang; it adds a port, a token and a CSP exception. Can be added
  behind the same worker later.
- WebView2 `ProcessFailed` / DevTools-protocol capture. Windows-only,
  and scope 2 covers the renderer case on every platform.
- A host main-thread probe (`main_last_ms`) and host-side tracking of
  the in-flight synchronous command. Scope 2 answers both by inference
  for frontend-initiated commands. The remaining gap is a host thread
  stuck in something the frontend did not ask for; a process dump of
  `cannet.exe` covers that until it happens twice.
- Seen in the same log: every `saved project` is followed within
  ~200 ms by `project-watch: project file removed on disk` (4 of 4
  saves). Groom separately.

## Open questions

Defaults taken at implementation, 2026-11-11. Not owner rulings;
any of them can be reopened:

- **Q1 (scope 2)** — **OPFS with a `FileSystemSyncAccessHandle`** in a
  dedicated worker, flushed after each append. No IndexedDB fallback:
  without Worker or OPFS the recorder is off and `cannet.log` says so
  once.
- **Q2 (scope 2)** — **macOS: yes** for the host-blocked case (Status,
  2026-11-11). **Windows/WebView2: unverified.** Still the gate on the
  design; if it fails there, the live channel moves into scope.
- **Q3 (scope 2)** — the OPFS store is capped at 256 KB, dropping the
  oldest whole records (with a note) when handover is failing.
  `frontend.log` sits beside `cannet.log` and rolls the same way
  (`log_rotation_bytes`, one generation), through the shared
  `cannet-log` writer.
- **Q4 (scope 2)** — **no offset machinery.** Every record carries the
  webview's wall-clock UTC time in `cannet.log`'s own timestamp format;
  the two files line up by eye.
- **Q5 (scope 1)** — timer lag ≥ 1000 ms from the existing 1 Hz
  reporter is forwarded at `warn` (not while the window is hidden,
  where the browser throttles timers). The long-task observer stays
  `--diag`. Forwards are rate-limited to 5 per kind per minute.
- **Q6 (scope 3)** — **RDP session detection deferred** (Windows-only
  API). A resize burst plus `visibilitychange` is what this change logs.
- **Q7** — yes: `technology-inventory.md` has Web Worker + OPFS as
  `adopted`, with IndexedDB, a localhost side channel and
  `tauri-plugin-log` `rejected`.

## Phases (proposed, ungroomed)

1. **The storage experiment.** Q1 and Q2 on Windows/WebView2 and
   macOS. Nothing else starts until a ring written before a kill is
   read back after it.
2. **Uncaught failures (frontend + host).** Scope 1. Test first: a
   thrown error and a rejected promise in the frontend each produce
   one `warn` line; a burst is rate-limited.
3. **The worker recorder and `frontend.log`.** Scope 2. Tests: a
   blocked main thread produces a stall record with start and end; an
   `invoke` which never returns is listed by name; a ring left by a
   prior launch is written to `frontend.log` on the next.
4. **Suspect events.** Scope 3, both sides.

## Exit criteria

- [ ] An uncaught frontend exception and an unhandled rejection each
      appear in `cannet.log`. *Tested up to the IPC call
      (`frontendFailures.test.ts`); the host side is the existing
      `gui_emit_system_log` path. Not yet seen in a live `cannet.log`.*
- [ ] A main-thread stall of ≥ 5 s is in `frontend.log` after the next
      launch with its start, its end (or "ended by kill"), the
      outstanding `invoke` names and whether the host was
      acknowledging the heartbeat. *Unit-tested (`hangRecorder.test.ts`:
      start, end, pending names, ack state, kill → "never seen" close,
      handover). A live renderer stall has not been induced.*
- [ ] The same holds when the app is killed from Task Manager during
      the stall (Windows), and force-quit (macOS). *macOS: SIGKILL
      during an induced host-blocked episode. The record survived and
      was closed at the next launch. Not done for a renderer stall.
      Not done on Windows.*
- [ ] A hang with the host IPC thread blocked and one with the
      renderer main thread blocked read differently in `frontend.log`
      (one test each, induced). *One unit test each, with simulated
      pings. Live: host-blocked induced on macOS (SIGSTOP of the host);
      renderer-blocked not induced live.*
- [ ] Window resize, scale-factor change and visibility change are
      logged; RDP session change per Q6. *Implemented and unit-tested
      on both sides; RDP deferred (Q6). Not observed in a live run.*
- [ ] The recorder's steady-state cost is measured at ~200 plots and
      recorded here. *Not measured.*
- [x] Docs: README (where the logs are and what `frontend.log` holds);
      `crash.rs` rustdoc on what the heartbeat does and does not prove;
      `technology-inventory.md` per Q7.

## Status

- **2026-11-11: implemented, uncommitted.** All three scope items
  landed in one change; the phases above were not landed separately.
  - *Scope 1.* `frontendFailures.ts` forwards `error` /
    `unhandledrejection` events and the reporter's ≥ 1 s timer lag
    (`diag.ts`) to `cannet.log` at `warn`, source `frontend`, through
    the existing `gui_emit_system_log` command.
  - *Scope 2.* `hangRecorder.ts` (store + state machine, pure),
    `hangRecorder.worker.ts` (OPFS + timer binding),
    `hangRecorderClient.ts` (main-thread pings, events, handover). The
    host command `append_frontend_log` (async, blocking pool) calls
    `crash::persist_frontend_records`, which writes `frontend.log`.
    Outstanding invokes come from a new choke point, `ipc.ts`: all 52
    product files that imported `invoke` from `@tauri-apps/api/core`
    now import it from `./ipc`, and a test forbids the direct import.
    Tauri's own `__TAURI_INTERNALS__.invoke` is non-writable, so it
    could not be wrapped in place. Not covered: invokes made inside
    `@tauri-apps/api` helpers (`listen`, the dialog plugin).
    Cadences: ping 500 ms, worker tick 500 ms, stall at 2 s, ack loss
    at 3 s, pending commands named past 1 s, handover every 30 s.
  - *Scope 3.* The frontend writes `resize` (coalesced in the worker),
    `dpr` and `visibility` records. On the host, `window_events.rs`
    writes one `debug` line per resize/scale burst (500 ms quiet).
  - **macOS experiment (Q2): WKWebView, debug build against the Vite
    dev server.** At launch, `start` reached `frontend.log` within
    seconds, so OPFS sync handles work there. The host was
    `SIGSTOP`ped at 23:47:45.49Z. The worker recorded `ack-lost … 3463
    ms … pending >1s: report_js_heap x4` at 23:47:49.481Z. The host was
    `SIGKILL`ed at 23:47:53Z. The relaunch wrote both that record and
    `ack-resumed: never seen — the process ended …` to `frontend.log`.
    So on macOS, a record flushed during a host-side hang survives a
    kill. Not tried: a renderer-side stall (blocking the main thread
    needs devtools), and anything on Windows/WebView2.
  - Known limits:
    - A freeze of the whole renderer process, worker included, leaves
      no records. The host's own `frontend unresponsive` warning is
      then the only trail.
    - A hidden window opens no stall, because the browser throttles its
      timers.
    - A second cannet sharing the same webview profile cannot take the
      store's sync handle, so it runs with the recorder off.
    - Records drained just before a cap-trim may be written to
      `frontend.log` twice.
  - Open: Q2 on Windows; the ~200-plot cost measurement.
