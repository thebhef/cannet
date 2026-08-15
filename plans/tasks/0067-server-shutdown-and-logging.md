# Task 67 — Server Shutdown Hang and Logging Parity

Owner feedback from live use of the Task 41/42 server (2026-08-13).
Two legs: a shutdown defect (investigation-first) and logging parity
with the GUI host.

## Owner feedback (verbatim intent)

Ctrl+C on `cannet-server` didn't exit cleanly:

- start server (`--bind 0.0.0.0:50051 --tls`), connect with
  cannet-gui, run the RBS example project
- close the GUI (no explicit disconnect first — unclear if
  consequential); a sidecar warning appeared around then
- Ctrl+C → server stuck at `hardware proxy: shutting down` for
  several minutes
- second Ctrl+C → forced exit (`0xc000013a`, STATUS_CONTROL_C_EXIT)

```
[warn] sidecar:python-can: cannet_python_can.server.shared_interface rx for pcan:PCAN_USBBUS2(h:0x52, ch:0, uid:1) failed: A PCAN Channel has not been initialized yet or the initialization process has failed
hardware proxy: shutting down
error: process didn't exit successfully: `target\debug\cannet-server.exe --bind '0.0.0.0:50051' --tls` (exit code: 0xc000013a, STATUS_CONTROL_C_EXIT)
```

And: the owner assumed `cannet-server` logs like `cannet-gui`; if
not, it should follow the same pattern.

Added 2026-08-13: "We should make sure all of our sensitive logs
don't contain tokens/keys etc." — a secrets-in-logs sweep across
**all** log sinks (GUI `cannet.log`, server stderr + new logfile,
sidecar debug logfile), not just the server's new file.

## What the code says today (orchestrator read, 2026-08-13)

- **Logging is not the same pattern.** The GUI host has a rolling,
  flushed-per-write `cannet.log` with rotation and a min-level
  setting (`apps/gui/src-tauri/src/crash.rs`, `system_log.rs`,
  tracing subscriber). `cannet-server` uses bare `eprintln!` to
  stderr everywhere — no file, no timestamps, no rotation. The
  sidecar's own always-debug logfile hook
  (`cannet-sidecar::launch::LaunchConfig::log_file`) is passed
  `None` by the server (`main.rs`), where the GUI passes a path.
- **Shutdown path** (`crates/cannet-server/src/main.rs`, Ctrl-C
  select): the select exits promptly, prints
  `hardware proxy: shutting down`, awaits the mDNS goodbye (~1 s,
  bounded), and returns. There is **no explicit sidecar stop with a
  bounded wait**. Sidecar lifetime is stdin-EOF; the supervisor's
  reader tasks run via `spawn_blocking`, and tokio runtime teardown
  waits **indefinitely** for blocking-pool tasks.

## Hypothesis (unconfirmed — investigation phase must falsify or
confirm before any fix)

The sidecar did not exit on stdin EOF — plausibly a thread stuck in
a PCAN read/error loop after the client vanished mid-session (the
`PCAN Channel has not been initialized` warning marks that state) —
so the blocking readers never returned EOF and runtime teardown
hung. Alternative hypotheses to rule out: stdin never actually
closed (drop-order of the supervisor Arc — a clone captured by the
proxy service closure may outlive the select); the mDNS shutdown
await itself stalling.

## Phases (groomed 2026-08-13)

1. **Investigation** — reproduce both observations (GUI hard-close
   mid-session → channel-wedge warn; then Ctrl-C → hang),
   instrument to locate the wait (which task/thread survives; does
   the sidecar process outlive the stdin drop?) and the wedge
   mechanism, record observation → hypothesis → experiment → data →
   conclusion in this file.
2. **Session robustness** — per the verdict: the server tolerates
   dropped sessions (client killed/disappeared/crashed without
   nominal disconnect) and remains recoverable, ready to serve the
   next session; the GUI performs a nominal disconnect on exit
   (check first, implement if missing); the sidecar exits
   gracefully on stdin-EOF even with a wedged/active channel.
3. **Bounded shutdown** — explicit shutdown sequence: stop sidecar
   (stdin-EOF, the expected graceful path) → wait **5 s** → kill
   the process tree on expiry. Second Ctrl-C during the window
   hard-exits immediately by design, not by console-host force.
4. **Logging parity + secrets sweep** — server gets the GUI's
   pattern: rolling `cannet-server.log` in the identity dir
   (`<data-local-dir>/cannet-server`, XDG-honoring), same
   rotation/flush/level semantics, timestamps + level tags on both
   sinks, sidecar `log_file` hook wired; no `--log-dir` flag.
   Factor from the GUI host rather than copying (share where the
   code allows without dragging Tauri types into the server).
   Sweep all sinks for secret material per the exit criterion.

## Grooming needed before implementation

- ~~Shutdown grace period~~ — resolved 2026-08-13 (owner): **5
  seconds**, then kill the sidecar process tree; a second Ctrl-C
  during the window hard-exits immediately (our code, not the
  console host). The kill is a **backstop, not the expected path**
  — the sidecar terminating gracefully on stdin-EOF is the
  expectation, so a sidecar-side fix making EOF exit reliable even
  with a wedged PCAN channel is in scope, not deferred.
- ~~Log file location for the server~~ — resolved 2026-08-13
  (owner): same shape as the GUI, XDG-honoring location — the
  existing identity dir `<data-local-dir>/cannet-server`
  (`identity::default_identity_dir`), `cannet-server.log` with the
  GUI's rotation/flush/level semantics as fixed defaults. **No
  `--log-dir` flag.**
- ~~Whether the channel-wedge warn is in scope~~ — resolved
  2026-08-13 (owner): the investigation covers **both**
  observations (hang + `PCAN Channel has not been initialized`
  warn — same repro, plausibly one mechanism). 67's fix scope
  stays shutdown/session-robustness; if the wedge proves an
  independent defect, write it up and surface it for its own task.
  As part of the resolution, **check and implement if missing**:
  - the client (cannet-gui) performs a nominal disconnect when
    exiting;
  - the server tolerates dropped sessions (client killed,
    disappeared, or crashed without nominal disconnect) and
    remains recoverable — ready to serve the next session.
- ~~Secrets-in-logs: disposition of the startup token print~~ —
  resolved 2026-08-13 (owner): the print stays **console-only**,
  bypassing the log layer; no secret material ever reaches a disk
  sink. The logfile may record only that a token is configured.

## Exit criteria (groomed 2026-08-13)

- The reproduced hang **and** the channel-wedge warn have recorded
  root causes with confirming experiment data in this file (or the
  wedge is written up as an independent defect and surfaced for
  its own task).
- Ctrl-C exits the server within the bounded grace period in the
  repro scenario (client hard-closed mid-session), sidecar process
  verifiably gone; the graceful stdin-EOF path — not the kill —
  is what fires when the sidecar is healthy.
- After a client is killed mid-session without nominal disconnect,
  the server serves the next session normally (demonstrated by
  test or recorded manual repro).
- The GUI performs a nominal disconnect on exit (verified;
  implemented if it was missing).
- Server logs carry timestamps and level tags, and land in a
  rolling logfile following the GUI's pattern; the sidecar debug
  logfile hook is wired.
- No token, private key, or other credential material appears in
  any log sink (GUI `cannet.log`, server stderr/logfile, sidecar
  debug log) — verified by a recorded sweep of every place a
  secret is held (server `--token`/`CANNET_TOKEN`/generated token,
  TLS private key, GUI `servers.json` tokens, auth-failure paths).
- README's server section documents the log location.
