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

## Root causes (confirmed 2026-08-13, phase 1)

Both observations are root-caused, and they turn out to be
**independent of each other**. The experiments and their raw data are
in the Status log below.

### (A) The Ctrl-C hang — a closed wait cycle around the sidecar's stdin

The shutdown path itself is fine and finishes in milliseconds. The
process then hangs in **tokio runtime teardown**, in a cycle that
cannot break on its own:

1. `main`'s async body returns, so `#[tokio::main]` **drops the
   runtime**. Dropping a runtime blocks until every *running*
   blocking-pool task returns, with no timeout.
2. The one running blocking task is `SidecarSupervisor::run`,
   dispatched through `CliSidecarHost::spawn_blocking` →
   `Handle::spawn_blocking`. It polls `child.try_wait()` every 250 ms
   and returns only once the sidecar child has exited.
3. The sidecar child exits only on **stdin EOF** (its lifetime
   contract). The write end of that pipe is the `ChildStdin` inside
   the `Child` that the wait loop itself owns (`child_arc`, plus the
   clone in `SupervisorInner::active`). `child.stdin` is never taken
   and never dropped.

So teardown waits for the wait loop, the wait loop waits for the
child, and the child waits for an EOF only that wait loop's own
`Child` can produce. Nothing in the cycle involves hardware, a
client, or PCAN — E1 reproduced the hang with **no client ever
connected and no channel ever opened**. The owner's second Ctrl-C did
not "force our exit": it made the console host terminate the process
(`STATUS_CONTROL_C_EXIT`), because our code never reaches an exit at
all.

Falsified alternatives:

- *The mDNS goodbye stalls* — E3 (mDNS on, the owner's exact flags)
  printed the "goodbye done" probe immediately, then hung.
- *A PCAN-wedged sidecar swallows the EOF* — E1 hung with no session
  ever opened; and E5 shows the sidecar exits on a real EOF in ~1 s
  through the full dev launch chain (`shutting down
  (reason=stdin-eof)`, `exit code 0`).
- *Drop-order: a supervisor `Arc` clone captured by the proxy service
  closure outlives the select* — immaterial. The `Child` is owned by
  the blocking task's own stack frame, so no amount of `Arc` dropping
  closes that pipe while the wait loop runs.

### (B) The `PCAN Channel has not been initialized` warn — a benign close race

`_SharedInterface._close_locked` (`servers/cannet-python-can/
cannet_python_can/server/shared_interface.py`) sets `self._channel =
None` and calls `ch.close()` while `_rx_pump` is blocked inside
`ch.recv(timeout_s=0.25)` on the channel object it fetched *before*
the close. PCAN-Basic fails that in-flight read with
`PCAN_ERROR_INITIALIZE`; `_rx_pump` logs `rx for … failed: …` at
WARNING, then sees `_stop` and breaks out of its loop. One line, once
per close.

It is **not** a symptom of the abrupt client loss and **not** a wedge:
E4 produced the identical line on an abrupt kill *and* on a nominal
disconnect, and the interface reopened cleanly for the very next
session both times. It is a cosmetic defect of the close sequence —
see the verdict for where it goes.

## Phases (groomed 2026-08-13)

1. **Investigation** — *done 2026-08-13; see "Root causes", "Verdict"
   and the Status log.* Reproduce both observations (GUI hard-close
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
4. **Logging parity + secrets sweep** — *done 2026-08-13; see the
   Status log.* Server gets the GUI's
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

## Verdict — what phases 2 and 3 should actually do

Written 2026-08-13 at the end of phase 1, from the confirmed root
causes above. Phase 2's scope shrinks (the server already tolerates a
dropped session); phase 3's grows a little (the fix is a real
supervisor `stop()`, not just a timer).

### Phase 2 — session robustness

1. **The GUI does not perform a nominal disconnect on exit. Add
   one.** `disconnect_remote_server` is invoked from the explicit
   Disconnect action (`apps/gui/src/App.tsx`) and from the
   session-reset path, but the window's `onCloseRequested` handler
   never calls it, and the host's `RunEvent::ExitRequested` arm
   (`apps/gui/src-tauri/src/lib.rs`) only flushes the trace store and
   the pyramids. Quitting the GUI is therefore *exactly* the abrupt
   case the owner hit. Fix on the close path, before `win.destroy()`.
2. **The server and sidecar already tolerate a dropped session** — E4
   demonstrated it end to end on real PCAN hardware: the relay ends
   both directions, the sidecar's request pump sees the stream end,
   `cleanup()` unsubscribes, the channel closes, and the next session
   subscribes to the same channel and runs. Land a regression test
   for it rather than a change.
3. **Silence the close-race warn (B).** Either suppress the `rx for …
   failed` warning when `_stop` is already set (a close the reader was
   told about), or have `_close_locked` join the rx thread before
   closing the channel. It is small enough to fix inside 67; if it is
   split out, it is a cosmetic-logging task, not a robustness one.
4. The "sidecar exits gracefully on stdin-EOF even with a wedged or
   active channel" item is **already true** as written — E5 confirms
   the EOF path works through the real launch chain. What is missing
   is the EOF, not the handling of it, which is phase 3's business.

### Phase 3 — bounded shutdown

1. **The fix that matters is an explicit sidecar stop, not a timer
   around the current behaviour.** After the Ctrl-C select,
   `run_proxy` must call a new `SidecarSupervisor::stop()` that
   (a) sets `suppress_restart`, (b) **takes and drops the child's
   `ChildStdin`** so the sidecar actually sees EOF, (c) waits up to
   5 s for the child to exit, (d) kills the process tree on expiry.
   The runtime may only be dropped after that returns.
2. **`Child::stdin` has to become reachable.** Today it is never
   taken, so there is nothing for `stop()` to drop; stash the
   `ChildStdin` alongside `active` in `SupervisorInner`.
3. **Kill the tree, not the child.** The dev chain is
   `cannet-server → uv → uv → cannet-python-can.exe → python →
   python`. E5 shows that killing the direct `uv` did take the whole
   tree down — but only because uv forwards stdin, so the
   grandchildren saw EOF. That is uv's behaviour, not a guarantee, so
   the backstop should be a Windows job object / `taskkill /T`-style
   tree kill. (Same argument applies to the existing
   `SidecarSupervisor::restart`, which calls `Child::kill()` on the
   direct child only.)
4. **Own the second Ctrl-C.** Race a second `ctrl_c()` against the 5 s
   wait and `std::process::exit` on it, so the hard exit is our code
   and our exit code rather than the console host's
   `0xc000013a`.
5. **Never let runtime teardown be the thing that waits.** With
   `stop()` in place the blocking wait loop is already finished, but
   the shutdown should still end with an explicit
   `Runtime::shutdown_timeout` — which `#[tokio::main]` cannot
   express, so `main` builds its runtime by hand.
6. The GUI host does **not** have this bug: it ends in
   `std::process::exit`, so the OS closes the pipe. It is worth
   noticing that its sidecar is cleaned up only *because* the process
   dies — a shared `stop()` would make that deliberate rather than
   incidental.

## Status log

### 2026-08-13 — phase 1, investigation

Method: observation → hypothesis → experiment → data → conclusion.
All experiments run on the owner's machine against the real PCAN
hardware (two PEAK PCAN-USB FD channels), debug build of
`cannet-server` at `a2f88ed`, sidecar via the dev `uv` path.

**Observation 1.** Owner's repro: Ctrl-C printed `hardware proxy:
shutting down` and the process then sat for minutes; a second Ctrl-C
produced `STATUS_CONTROL_C_EXIT`. A
`rx for pcan:PCAN_USBBUS2(…) failed: A PCAN Channel has not been
initialized yet or the initialization process has failed` warning
appeared around the time the GUI was closed.

**Hypothesis A1.** *The server hangs because the sidecar never exits,
because it never receives stdin EOF — and that is independent of any
PCAN state.* Falsifiable: if a PCAN wedge were required, a run with no
client and no open channel would shut down cleanly.

**E1 — Ctrl-C with no client, `--no-mdns --sidecar-restart-budget 0`.**
`hardware proxy: shutting down` printed immediately. Server still
running 30 s later; the whole sidecar tree (uv → uv →
cannet-python-can.exe → python → python) still present and unchanged;
**no `shutdown reason=stdin-eof` banner from the sidecar**. Killing the
sidecar tree → **server exited 0.33 s later**. Conclusion: A1
supported, and the PCAN-wedge explanation is falsified — the hang
needs no client, no session and no hardware channel.

**E2 — does the sidecar honour stdin EOF at all?**
`uv run --extra dev pytest tests/test_stdin_shutdown.py -q` → 2
passed in 2.56 s. Conclusion: the sidecar exits promptly on a real
EOF; the failure is that the EOF is never delivered.

**Hypothesis A2.** *The wait is in tokio runtime teardown, after
`main`'s body — not in the mDNS goodbye and not in the select.*
Experiment: temporary `eprintln!` probes after the select, after the
mDNS shutdown, and as the last statement of `main`.

**E3 — the owner's exact invocation (`--bind 0.0.0.0:50051 --tls`,
mDNS on), with probes.** stderr, in order and all within one second of
the Ctrl-C: `hardware proxy: shutting down` → `probe: select
resolved; awaiting the mDNS goodbye` → `probe: mDNS goodbye done;
run_proxy returning` → `probe: main body finished; runtime teardown
starts now`. Then **40 s with no exit** and the sidecar tree intact.
Killing the sidecar tree → **server exited 0.30 s later**. Conclusion:
A2 confirmed. The mDNS hypothesis is falsified; the hang is strictly
inside runtime teardown, waiting on the blocking wait loop, which
waits on the child, which waits on the stdin the wait loop holds.
Root cause (A) as written above. Probes removed afterwards.

**Observation 2 / Hypothesis B1.** *The `PCAN Channel has not been
initialized` warn is a close-time race in `_rx_pump`, not a wedge, and
not specific to an abrupt client loss.* Falsifiable two ways: it
should also appear on a **nominal** disconnect, and the interface
should reopen cleanly straight afterwards.

**E4 — real PCAN session, client killed abruptly, then a second
session (`--sidecar-log-level debug`).** Sequence in the server log:
`Session opened` → `Subscribe pcan:PCAN_USBBUS1(h:0x51, ch:0, uid:0)`
→ `opened` → *(client hard-killed)* → `Session closing; releasing
['pcan:PCAN_USBBUS1(…)']` → `closing pcan:PCAN_USBBUS1(…)` → `[warn]
rx for pcan:PCAN_USBBUS1(…) failed: A PCAN Channel has not been
initialized yet or the initialization process has failed`. The second
client then subscribed to the same channel, got `Subscribe … -> ok`,
disconnected **nominally**, and produced the *same* close +
`rx … failed` warn pair. Conclusion: B1 confirmed on both counts — the
warn is a spurious close-race line, the session is recoverable, and
observation 2 is unrelated to observation 1.

**E5 — killing only the direct child.** With the sidecar ready,
`Stop-Process` on the direct `uv` child alone: the entire descendant
tree was gone within 3 s and the sidecar logged `shutting down
(reason=stdin-eof)` / `exit code 0`. Conclusion: uv forwards stdin, so
its death propagates EOF; the graceful path works through the whole
real launch chain when the pipe actually closes.

Commits: see the branch `task67a-shutdown-investigation`. No product
code changed in phase 1 — the temporary probes in
`crates/cannet-server/src/main.rs` and the temporary
`cannet-client` example used to drive a real session were removed
before committing.

### 2026-08-13 — phase 2, session robustness

Branch `task67b-session-robustness`, off `task67a-shutdown-investigation`
(`bc26cae`). Three commits, one per leg of the phase-1 verdict.

**Leg 1 — the GUI hangs up on exit** (`768f7a3`).

*Layer choice: the host's `RunEvent::ExitRequested` arm, not the
window's `onCloseRequested` handler.* The frontend handler is reached
only on a window close and returns early when nothing is dirty; the host
arm is on every exit route (window close, `AppHandle::exit`, the ADR
0031 perf harness) and does not depend on a webview that may already be
gone. The verdict's "fix on the close path, before `win.destroy()`"
therefore landed one layer down.

*Second design point: signalling was not enough.* Dropping a
`SessionHandle` only sends a oneshot; the worker learns of it on its
next poll, and `run` reaches `std::process::exit` far sooner than that,
so a disconnect-and-exit would have been indistinguishable from the
process dying mid-session — the very case being fixed. So
`cannet_client::SessionHandle` grew `shutdown_timeout(Duration)`, which
signals and then waits for the worker to finish (a channel whose sender
lives in the worker thread's closure, so its drop is the "worker and its
runtime are gone" edge), returning whether it made the budget.
`session::disconnect_on_exit` spends **500 ms** across all sessions on a
single deadline — enough for a healthy loopback/LAN close, short enough
that an unreachable server cannot make quitting feel stuck. No
connection-state event is emitted; the webview it would notify is on its
way out.

TDD: `shutdown_timeout_returns_only_once_the_session_is_torn_down` in
`crates/cannet-client/tests/end_to_end.rs` (red — no such method —
before the implementation). It asserts the receive half is *already* at
end-of-stream when `shutdown_timeout` returns, which is what separates
"the disconnect completed" from "the disconnect was signalled". The
Tauri arm itself is two lines with no unit-test seam.

README's remote-session section now says quitting disconnects.

**Leg 2 — dropped-session regression test** (`ae7b380`).

Harness: `crates/cannet-server/tests/proxy.rs`, the existing
fake-upstream pattern (single-owner `LoopingBlfReplay` behind
`ProxyServerImpl`), plus a new `spawn_severable_tunnel` — a bare TCP
relay in front of the proxy that drops both sockets on command. That is
what makes it a *death* rather than the nominal hang-up the neighbouring
`a_client_hanging_up_drops_its_upstream_session` already covers: no
`GOAWAY`, no `END_STREAM`, and the client end is left intact and held
past the assertions so nothing on it can send a close. The single-owner
upstream is the witness — a leaked session would answer the next one
`BUSY` forever.

The behaviour was already correct (E4), so the test passed on first run.
Falsified deliberately to prove it is not vacuous: with `cut.send(())`
commented out, it fails with "the killed client's session was never
released". No hardware, no Python; runs in ~2 s.

**Leg 3 — the close-race warn is gone** (`a860fa3`).

Fix shape: **suppress at the reader**, not join-before-close.
`_close_locked` runs under `_lock` and `_rx_pump` takes the same lock in
`_current_channel`, so joining the rx thread from the close would
deadlock — the code does not support the verdict's second option
cleanly. Since `_close_locked` sets `_stop` *before* closing the
channel, a read that fails with `_stop` already set is by construction
one we asked for: it now goes to the debug sink and ends the loop. A
read that fails with `_stop` clear still warns.

TDD: two tests in `tests/test_shared_interface.py`. The first drives the
real race — a fake channel that fails an in-flight `recv` once closed,
the way PCAN-Basic does, with an `in_recv` event so the close lands
while the reader is provably inside a read — and asserts no WARNING
record survives it (red before the fix, with the owner's exact message).
The second pins the other half: a read that fails outside a close still
warns.

Test counts, all green after the last commit:

| layer | command | result |
| --- | --- | --- |
| client | `cargo test -p cannet-client --test end_to_end` | 8 passed |
| host | `cargo test -p cannet-gui` | 569 passed, 6 ignored |
| server | `cargo test -p cannet-server` | 94 passed, 2 ignored |
| sidecar | `uv run --extra dev pytest` | 105 passed |

`cargo clippy --all-targets` clean on `cannet-client`, `cannet-gui`,
`cannet-server`; `ruff check`, `ruff format --check` and `mypy` clean on
the sidecar. No frontend file was touched, so the pnpm suites were not
in scope.

### 2026-08-13 — phase 3, bounded shutdown

Branch `task67c-bounded-shutdown`, off `task67b-session-robustness`
(`383472a`). Three commits: the supervisor's `stop()` + tree kill, the
server's shutdown sequence, and the log-line correction found by the
manual verification.

**The API** (`crates/cannet-sidecar`). `SidecarSupervisor::stop(host,
grace) -> StopOutcome` — suppress restarts, drop the `ChildStdin`, poll
for the exit every 25 ms up to `grace`, kill the process tree on expiry.
The pipe is reachable at all because `install_child` (factored out of
`run`) now **takes stdin out of the `Child`** and stashes it in
`SupervisorInner`; left where it was, it belonged to the wait loop that
was itself waiting for the child to exit, which is root cause (A) in one
sentence. The wait loop clears the slot with `active`, and `restart`
drops it before killing, so a merely-slow sidecar still gets its EOF.

**Tree-kill design** (`process_tree.rs`, new). A pair: Unix children are
spawned as their own **process-group leader** via the safe, stable
`CommandExt::process_group(0)`, and the kill is `kill -KILL -<pgid>`;
Windows needs no preparation and uses `taskkill /PID <pid> /T /F`, which
walks the parent links Windows already records. **Why not job objects /
`killpg`:** both are `unsafe` FFI, which the workspace forbids outside
`crates/cannet-spill`, and a job object additionally has to be created
and assigned at spawn. Shelling out keeps `cannet-sidecar`
dependency-free (recorded `rejected` in
`plans/technology-inventory.md`). Cost, accepted: an external binary
(`taskkill`, `kill`) has to exist, so a failure falls back to killing the
direct child; and on Unix the sidecar no longer receives the terminal's
Ctrl-C, which makes our own stop the only thing that ends it — the same
path every other OS already took. The same primitive replaced
`restart`'s only-direct-child `Child::kill()` (the latent defect from
phase 2's list).

**The server** (`crates/cannet-server/src/main.rs`). `shut_down()` runs
`stop()` (5 s grace, on `spawn_blocking` — it polls a child) and the
mDNS goodbye **concurrently**, so the goodbye's ~1 s is spent inside the
grace period rather than after it, and races both against a second
`ctrl_c()` that `std::process::exit(130)`s — our exit and our code
instead of the console host's `STATUS_CONTROL_C_EXIT`. `main` builds the
runtime by hand (`#[tokio::main]` can only *drop* it) and ends in
`shutdown_timeout(1 s)`: with `stop()` in place the blocking wait loop is
already finished, so that bound is a guarantee, not the mechanism.

**TDD.** The stand-in sidecar is the cannet-sidecar test binary
re-executed at a `fake_sidecar_process` entry point (no Python, no `uv`,
no shell, and it exists on every OS by construction): one mode honours
EOF, one ignores it and spawns a grandchild that inherits the shared
stdout pipe — so "the whole tree is gone" is observable as that pipe
reaching EOF. Written red (no `stop`, no `StopOutcome`), then made
green. Deliberately falsified afterwards: with `kill_tree` swapped back
for `Child::kill()`, `stop_kills_the_whole_tree_once_the_grace_expires`
and `a_manual_restart_kills_the_previous_tree_not_just_its_root` both
fail ("the grandchild still holds the shared pipe open"). The graceful
test asserts the child exited **0**, which a killed one cannot.

| layer | command | result |
| --- | --- | --- |
| sidecar crate | `cargo test -p cannet-sidecar` | 39 passed |
| server | `cargo test -p cannet-server` | 94 passed, 2 ignored |

`cargo clippy --workspace --all-targets -- -D warnings` clean (the
pre-commit gate ran it on every commit).

**Manual verification**, this machine, real PCAN hardware (2 PEAK
PCAN-USB FD), debug build, sidecar via the dev `uv` chain — 6 processes
under the server: `uv → uv → cannet-python-can.exe → python → python`
(plus a conhost). Ctrl-C was delivered as a real `CTRL_C_EVENT` by a
harness in its own console that calls `SetConsoleCtrlHandler(NULL,
FALSE)` **before** spawning the server (the phase-1 blocker: the agent's
shell tree inherits an ignore-Ctrl+C state) and re-sets it for itself
before firing, so it survives to measure.

| run | invocation | to exit | code | tree left |
| --- | --- | --- | --- | --- |
| healthy | `--bind 127.0.0.1:50051` | **0.46–0.51 s** | 0 | 0 of 6 |
| owner's flags | `--bind 0.0.0.0:50051 --tls` | **0.41 s** | 0 | 0 of 6 |
| second Ctrl-C at 0.12 s | `--bind 127.0.0.1:50051` | **0.13 s** | **130** | 0 of 6 |
| wedged sidecar | tree suspended (`NtSuspendProcess`) so the EOF cannot be acted on | **5.87 s** | 0 | 0 of 6 |

The healthy runs take the graceful path — `shutting down
(reason=stdin-eof)` → `exited on stdin EOF` → `exited cleanly`, no kill
— which is the exit criterion's "the graceful stdin-EOF path, not the
kill, is what fires when the sidecar is healthy". The wedged run is the
backstop: `did not exit within 5s; killing its process tree` →
`killed the sidecar process tree`, and all six suspended processes gone.
Against the same build before this phase, every one of these hung
indefinitely.

**One line changed by what that verification showed.** The backstop's
kill made the wait loop report `[error] sidecar (pid N) exited with exit
code: 1` plus the whole invocation summary — which reads as a sidecar
that failed to launch, on a shutdown we performed. A non-zero exit with
`suppress_restart` set (only `stop` sets it) is now an info-level
`exited with … after being stopped`; the warn line about the kill
already carries the news. Verified by re-running the wedged scenario.

### 2026-08-13 — phase 4, logging parity + secrets sweep

Branch `task67d-logging-parity`, off `task67c-bounded-shutdown`
(`c6aed62`). Four commits.

**The factoring choice: share, via a new `crates/cannet-log`**
(`d09f300`). What `crash.rs`'s writer actually depends on is `std::fs`
and `chrono` — no Tauri anywhere — so the "minimal server-side
implementation" fallback was not needed. What the two hosts *cannot*
share is the policy around it: the GUI reads its rotation cap from a
live settings file and its panic hook must bypass the write lock
without deadlocking, while the server's cap is a constant. So the crate
is deliberately **stateless** — the caller owns the directory, the file
name, the cap and any lock — and holds only what must not drift:
`append_block` (create dir → rotate past cap → append → flush) and
`iso8601_from_ms` / `unix_ms`. It is not `cannet-core` (zero-dependency
CAN-model charter; `chrono` has no business there) and not
`cannet-sidecar` (supervision charter, where a log writer is a misfit a
future reader trips over). `cannet-gui` handed its direct `chrono`
dependency over to the new crate, whose only dependency it is. **No new
external dependency:** `tracing-appender` was considered and recorded
`rejected` in `plans/technology-inventory.md` — its rotation is
time-based behind a background writer thread, which is neither the size
cap nor the flush-per-write that make an instant death still leave
evidence.

**Where the logs land.** The server's directory is the one it already
owns — `identity::default_identity_dir()`, i.e.
`dirs::data_local_dir()/cannet-server` — beside the certificate and the
token:

| OS | file |
| --- | --- |
| Windows | `%LOCALAPPDATA%\cannet-server\cannet-server.log` |
| Linux | `$XDG_DATA_HOME/cannet-server/cannet-server.log` (default `~/.local/share/…`) |
| macOS | `~/Library/Application Support/cannet-server/cannet-server.log` |

Semantics are the GUI's, as fixed defaults: flushed per write,
size-rotated at 5 MB to a single `.1` generation, debug floor on the
file. Both sinks carry `<rfc3339> <LEVEL> <source>: <message>`; sources
are `hardware proxy`, `sidecar:python-can`, `cannet-server` (fatal
startup), `replay` and `vbus`. **No `--log-dir` and no level flag** —
the only verbosity knob is the pre-existing `--sidecar-log-level`.
Every `eprintln!` in the crate is gone; each line's wording survives
minus the prefixes the tags now carry (a literal `warning:`, `[info]`,
`error:`).

**Sidecar logfile wired** (`5716b72`). `LaunchConfig::log_file` is now
`sidecar_log_file(logging::dir())` — `sidecar-python-can.log` in the
same directory, resolved per spawn so a restart after the directory
becomes writable starts writing. An uncreatable directory is a warning
and no `--log-file`, matching the GUI.

**The token ruling, as built.** The banner is `logging::console_only`,
which is `eprintln!` and touches no file. The log gets
`logging::token_configured_note()` instead — a function that **takes no
argument**, so no later edit can interpolate a secret into it. The
certificate fingerprint went the other way: public by design
(ADR 0041), so it is now an ordinary logged line rather than a
console-only one.

#### Secrets sweep — sink × secret

Sinks: **S-err** server stderr, **S-log** `cannet-server.log`, **G-log**
GUI `cannet.log` (and its panic hook), **SC-log** the sidecar's
`sidecar-python-can.log`, **Err** an error string returned to a caller
(tonic `Status` / Tauri `Err`).

| # | Secret | Sink | Where | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Server token (`--token` / `CANNET_TOKEN` / generated) | S-err | `main.rs` startup banner | **by design** — the operator reads it off the console; `console_only`, never the log layer |
| 2 | Server token | S-log | `main.rs` | **absent** — the file gets `token_configured_note()`, which takes no argument |
| 3 | Server token | SC-log | `launch.rs` `apply_settings` | **absent** — the sidecar is passed only `--log-level`, `--log-file`, `CANNET_DRIVER_MODULE` |
| 4 | Server token | Err | `auth.rs` `TokenError` | **absent** — carries a `PathBuf` + `io::Error`, never file contents |
| 5 | Server token | any | `auth.rs` `AccessToken` | **unprintable** — no `Debug`, no `Display`; `as_str` is the only renderer |
| 6 | Presented credential (auth failure) | S-err / S-log / Err | `auth.rs` `token_gate` | **absent** — all four rejection causes return one constant `unauthenticated()`; nothing echoed, so it is not an oracle either |
| 7 | TLS private key | any | `identity.rs` `ServerIdentity` | **unprintable** — no `Debug` derive |
| 8 | TLS private key | Err | `identity.rs` `IdentityError` | **absent** — variants hold paths and `io::Error`; a bad PEM is the unit `NoCertificate`, not the text. `Generate(rcgen::Error)` is interpolated, but rcgen's error enum is categorical and holds no key bytes |
| 9 | GUI trust-store token | G-log | `server_trust.rs` `TrustEntry` | **redacted** — hand-written `Debug`, regression-tested |
| 10 | GUI trust-store token | frontend / IPC | `server_trust.rs` `TrustedServer` | **absent** — exposes `has_token: bool` |
| 11 | GUI trust-store token | G-log | `server_trust.rs` `read_servers` | **absent** — whole-document `parse_or_default`; the per-key `read_scoped` path quotes a refused *value* into a logged complaint, so this document deliberately forgoes it (now recorded in its rustdoc) |
| 12 | GUI trust-store token | G-log | `connect_flow.rs` `Attempt` | **fixed** — derived `Debug` printed it in full; now redacted (`239f7d3`) |
| 13 | GUI trust-store token | G-log | `interfaces.rs`, `session.rs`, `connection_state.rs` | **absent** — every line interpolates `{error}` / `{msg}` / a classifier string, never the attempt |
| 14 | GUI trust-store token | frontend event | `connect_flow.rs` `TrustPrompt` / `TokenRefused` | **absent** — fingerprints and transport detail; `TokenRefused` is a unit variant |
| 15 | Client token | any | `cannet-client` `ConnectConfig` / `Trust` | **fixed** — a *public* type whose derived `Debug` printed it; now redacted (`239f7d3`) |
| 16 | Client token | Err / G-log | `cannet-client` `ConnectionError` | **absent** — no variant carries it; `InvalidToken` refuses to echo the bad value |
| 17 | Client token | downstream | `proxy.rs` | **absent** — the credential is deliberately not relayed; a fresh `Request` is built per upstream call |
| 18 | Server token (`--token`) | S-err | `main.rs` `ProxyArgs` / `Cli` | **fixed** — derived `Debug` held it; removed outright (`239f7d3`) |
| 19 | Any secret | SC-log | `cannet_python_can` CLI, `helpers.py`, `service.py` | **absent** — the sidecar's whole CLI is `--bind` / `--log-level` / `--log-file` / `--version`; its only `os.environ` read is `CANNET_DRIVER_MODULE`; loopback `add_insecure_port`, so there is no TLS material and no auth metadata to log |
| 20 | Any secret | G-log | `sidecar.rs` `log_sidecar_output` | **absent** — it forwards every child stderr line, but the child holds no secret (19) |
| 21 | Any secret | G-log panic hook | `crash.rs` | **absent** — the hook writes the panic payload; nothing in the repo panics on a secret-bearing value |

No sink was found writing a credential today, so **no red-first
regression of an actual leak was possible**. Three types did hold a
plaintext token behind a *derived* `Debug` — one `{:?}` from a leak, in
each case beside code that already logs — and those were fixed under
red-first tests (rows 12, 15, 18): both redacting impls printed the
token in full before the change, and the removed derives are
compile-time. The pattern is the one `AccessToken`, `ServerIdentity`
and `TrustEntry` already followed — the guarantee lives at the type,
not in every call site's memory.

**Empirical confirmation**, this machine, real PCAN hardware (2 PEAK
PCAN-USB FD), debug build, sidecar via the dev `uv` chain. Two runs
against a fresh `cannet-server.log`, one plaintext and one `--tls`:

| check | result |
| --- | --- |
| logfile + sidecar logfile created in the identity dir | yes, both |
| token value present on the console | yes — the ruling |
| token value present in `cannet-server.log` | **no** |
| token value present in `sidecar-python-can.log` | **no** |
| `PRIVATE KEY` in either logfile | **no** |
| fingerprint present in `cannet-server.log` | yes — public by design |

| layer | command | result |
| --- | --- | --- |
| shared log crate | `cargo test -p cannet-log` | 6 passed |
| sidecar crate | `cargo test -p cannet-sidecar` | 39 passed |
| server | `cargo test -p cannet-server` | 100 passed, 2 ignored |
| client | `cargo test -p cannet-client` | 29 passed |
| host | `cargo test -p cannet-gui` | 568 passed, 6 ignored |

`cargo clippy --workspace --all-targets -- -D warnings` clean (the
pre-commit gate ran it on every commit). No frontend file was touched,
so the pnpm suites were not in scope; no Python file was touched, so
the sidecar suite was not either.

## Blockers / side effects

- **Console Ctrl-C is disabled by inheritance in the agent's shell
  tree.** Every process launched from it inherits an "ignore Ctrl+C"
  console state, so `GenerateConsoleCtrlEvent(CTRL_C_EVENT, …)`
  returns success and does nothing. The experiment harness had to call
  `SetConsoleCtrlHandler(NULL, FALSE)` before launching the server.
  Not a product defect — recorded so the next investigator does not
  spend the time again.
- **The auto-restart budget confounds any "kill the sidecar"
  experiment**: the supervisor spawns a replacement that re-takes a
  fresh stdin pipe. Run with `--sidecar-restart-budget 0`.
- ~~**The server log has no timestamps**, so an experiment timeline
  cannot be correlated against it without external markers. This was a
  live cost during phase 1 and is first-hand motivation for phase 4.~~
  Fixed in phase 4: both sinks carry RFC-3339 timestamps.
- **Same close race, other caller (noticed in phase 2, left alone):**
  `_SharedInterface.reconfigure` also closes the old channel out from
  under an in-flight `recv`, but without setting `_stop` — it is a swap,
  not a shutdown — so a `ConfigureBus` on an open interface can still
  produce one `rx for … failed` WARNING. Phase 2's scope was the nominal
  *close*, and suppressing it at the reconfigure site needs a different
  signal than `_stop`. Cosmetic, same family as (B).
- ~~**Latent, out of scope here:** `SidecarSupervisor::restart` kills
  only the direct child.~~ Fixed in phase 3 with the same tree-kill
  primitive as the shutdown path, under its own test.
- **New in phase 3, Unix only:** a sidecar spawned as its own
  process-group leader no longer receives the terminal's Ctrl-C, so
  where a foreground SIGINT used to reach it directly, the host's
  `stop()` is now the only thing that ends it. Deliberate — it makes
  every OS take the same shutdown path — and noted here because it
  changes what a `kill -INT` on the server's group does.
- **New in phase 4, not a log leak but noticed by the sweep:**
  `CANNET_TOKEN` is inherited by the sidecar child. The child inherits
  the server's whole environment on purpose (so a driver-module
  override set for the server reaches it), and the sidecar never reads
  or dumps its environment — its only `os.environ` access is
  `CANNET_DRIVER_MODULE` — so nothing writes it anywhere. But the
  value does sit in the environment block of a process that is not the
  one enforcing it, readable via `/proc/<pid>/environ` by the same
  user on Linux. Clearing that one variable on the child would close
  it; out of scope here because it changes what the child is spawned
  with, not what any sink records.
- **Unverified on this machine:** the Unix half of the tree kill
  (`process_group(0)` + `kill -KILL -<pgid>`). The unit tests cover it
  and CI runs them on Linux; the manual runs recorded above are Windows
  (`taskkill /T /F`).

## Exit-criteria walk (2026-08-13, orchestrator)

1. **Root causes recorded with experiment data** — MET. Both in
   "Root causes": (A) the stdin wait cycle (E1/E3/E5), (B) the
   benign close race (E4), written up as independent; (B)'s
   `reconfigure` cousin recorded under Blockers / side effects.
2. **Ctrl-C exits within the grace period; graceful path when
   healthy** — MET. Phase 3 manual verification on real hardware:
   0.41–0.51 s graceful (`reason=stdin-eof`, no kill), including
   the owner's exact flags; suspended-tree backstop 5.87 s, tree
   0/6 remaining; second Ctrl-C 0.13 s exit 130.
3. **Dropped session → next session serves** — MET. Regression
   test in `crates/cannet-server/tests/proxy.rs` (severable
   tunnel, no GOAWAY/END_STREAM), deliberately falsified.
4. **GUI nominal disconnect on exit** — MET (was missing;
   implemented). Host-side `RunEvent::ExitRequested` →
   `session::disconnect_on_exit`, bounded 500 ms, red-first test on
   `SessionHandle::shutdown_timeout`.
5. **Server logs: timestamps + levels, rolling file, sidecar hook
   wired** — MET. `cannet-log` shared writer; `cannet-server.log`
   + `sidecar-python-can.log` in the identity dir; both sinks
   stamped; no new flags.
6. **No credential in any log sink, recorded sweep** — MET. 21-row
   sink × secret checklist in the phase 4 status log; empirical
   run: token on console only; three Debug-leak hardenings landed
   red-first (`Trust`, `Attempt`, `ProxyArgs`/`Cli`).
7. **README documents the log location** — MET. Per-OS table in
   the server section.

Perf gate (ADR 0031): release build at `1463663`, ev-zonal 60 s
scrub capture — **check passed, 31/31 metrics** vs the committed
baseline (report:
`docs/performance-measurements/frontend/2026-08-13-1463663-task67-closeout.json`,
uncommitted). Baseline untouched.
