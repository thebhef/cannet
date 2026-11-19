# Task 175 — The Host Outlives a Dead Renderer

> **Opened 2026-11-18** from the same TR03 session as task 174.
> Implemented the same day; defaults under Open questions.

## Why

When the WebView2 renderer process dies, cannet cannot recover and
cannot be closed. The host keeps capturing and logs `frontend
unresponsive`, but:

- nothing reloads the page, so the window stays dead until the owner
  finds a way to reload it by hand;
- the close button does nothing: the frontend registered a
  close-requested listener, so Tauri holds every close for it
  (`manager/window.rs`), and a dead renderer never answers;
- meanwhile the WebView2 *browser* process grows at ~2 MB/s (11-17: 0
  → 15 GB in two hours) until it is itself killed out of memory,
  starving the machine on the way. The cause of that growth is not
  confirmed; host events emitted into a page with no renderer is the
  leading suspect.

## The sessions

Crashpad dumps under `%LOCALAPPDATA%\dev.cannet.app\EBWebView`, all
`0xE0000008` (out of memory):

| When (PST) | Process | Then |
| --- | --- | --- |
| 11-12 20:58 | renderer | browser grows, killed 22:46 |
| 11-17 17:27 | renderer | browser grows, killed 19:23; owner killed the host |
| 11-18 11:46, 11:46, 11:54, 12:08 | renderer | each reload rejoins and dies again within ~20 s (task 174's cause) |

The health line already shows the signature: `renderer=0` with a
climbing `ui_last_ms` and a climbing `browser=`.

## Scope

1. **Detect a dead renderer.** The UI heartbeat has been silent for
   10 s **and** the host's own `WebView` process family holds a browser
   process but no renderer. A silent heartbeat alone is not enough: a
   renderer in a long GC pause or a busy main thread is alive and
   must not be reloaded.
2. **Reload it.** The host reloads the main webview, which rejoins the
   running session (ADR 0063). Logged at `warn`.
3. **Don't crash-loop.** At most 3 automatic reloads in 10 minutes,
   and none within 30 s of the last (the reloaded page needs time to
   send its first heartbeat). Past the cap the host logs once and
   stops trying until the heartbeat comes back.
4. **Close works without a frontend.** A close request while the
   heartbeat has been silent for 10 s — renderer dead or hung — runs
   the host's shutdown sequence directly (capture, loggers, caches;
   ADR 0002 DS-7), as `begin_close` would.

### Not in scope

- Stopping host events to a page with no renderer. The browser-process
  growth goes away with the reload; past the reload cap it would not.
  Needs confirming first.
- A dead **browser** process. Reload cannot recover it (the webview's
  controller is gone); the close fallback still applies.
- macOS. Its `WebKit` processes are not the host's descendants, so the
  family check answers "unknown" and nothing is reloaded. The close
  fallback is heartbeat-only and does apply.
- WebView2's own `ProcessFailed` event. It would need `webview2-com`
  as a direct dependency and is Windows-only; the process-family check
  reuses what the health recorder already reads.

## Open questions

Defaults taken at implementation, 2026-11-18. Not owner rulings:

- **Q1** — 10 s of silence before either action. The 11-18 log shows
  ~2 s main-thread stalls several times an hour on a heavily loaded
  frontend; nothing healthy has been seen past 3 s.
- **Q2** — reload cap 3 per 10 min, 30 s grace.
- **Q3** — a close with no frontend skips the unsaved-changes prompt
  and autosave-on-exit: the project's unsaved edits are lost, as they
  are today when the process is killed — the only exit there was. The
  capture is written, which a kill does not do.

## Exit criteria

- [x] A stale heartbeat with a renderer present, or with the family
      unknown, reloads nothing. *`renderer_watch.rs` tests.*
- [x] A stale heartbeat with no renderer reloads; the fourth death in
      10 min does not, and is logged once. *`renderer_watch.rs` tests.*
- [x] The family walk counts renderer processes. *`crash.rs` tests.*
- [x] A close with the heartbeat silent ≥ 10 s starts the shutdown
      sequence; one with a live frontend still goes to it.
      *`renderer_watch.rs` tests for the predicate; the run-loop arm in
      `lib.rs`.*
- [ ] Windows, live: killing the renderer process of a running cannet
      reloads the window into the same session; closing a window whose
      renderer is dead exits cleanly with the capture written.
- [x] Docs: README (what the host does when the window dies); rustdoc.
