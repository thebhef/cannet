# Task 57 — Perf Follow-Ups from the 54–56 Slice

Five perf items surfaced by the 54/55/49/56 implementation slice's
status logs and by the 2026-08-08 sidecar-logging investigation
(root-caused and fixed on `fix-sidecar-pcan-debug-throughput`; see
task 55's "Perf regression follow-up" note). Grouped here as one
task; owner directed follow-up on all five (2026-08-08).

## Items

### 1. Per-area scoping of the plot panel's derived configs

Any `areas` edit re-mints every derived-axis config
(`derivedAreaConfigs` in `PlotPanel.tsx`) and the handlers memoised
on it, so collapse, solo, hide/show, and plain-click primary
promotion re-render the whole `PlotArea` stack. Measured by 55.C's
probe: 4 renders on a 2-area panel where 1–2 suffice; recorded
three times (55.C item 4, 49.A, 55.D). Scope the mapping per
logical area so an edit to one area re-renders only its own derived
axes. The standing memo guards ("re-renders no plot area when only
panel-local state changes"; the ctrl-click selection slice guard)
must stay green, and the fix should convert the probe methodology
into real render-count regression tests.

**Grooming map (2026-08-08, code read):** the mint chain is
`areas → effectiveAreas (PlotPanel.tsx:1255) → derivedAreaConfigs
(:1592) → areaHandlers (:1766) / selectedKeysByAxis (:1663) /
weights / collapsed flags / plottedSignals`; `derivedAreaConfigs`
mints a fresh `derivedArea` object per axis (:1630-1637) and
`PlotArea` is default-shallow `memo`, so the `area` prop alone
defeats the memo panel-wide on any `areas` change. Scoping must
preserve `d.area` identity (and `signals` identity — unified mode
already passes by reference, the solo mask at :1625 allocates) for
untouched areas, and keep `areaHandlers`' existing ref-mirror
discipline (:1355-1369, :1450-1466). The relevant guard tests are
enumerated in `PlotPanel.dom.test.tsx` (:3602, :4217, :4082,
:3857, :1561, :1604, :3546, :3371, :626, :4135) — extend, don't
weaken.

### 2. Collapsed areas keep resampling — DROPPED (owner, 2026-08-08)

A collapsed area with a live uPlot keeps fetching on window ticks
(recorded by 55.C). **Dropped by owner ruling**: stopping the fetch
trades expand-time responsiveness for saved background work — the
same trade already rejected for hidden/solo-masked series, whose
kept-warm fetch is what makes unhide and solo-clear instant cache
repaints. The continued fetch while collapsed is the deliberate
cost of an instant expand; not a defect.

### 3. `signalSetKey` conflates membership with order

`signals.map(signalRefKey).join("|")` is order-sensitive, so
sort-area (56.C) and drag-reorder drop the decimation cache and
cold-refetch when only series order changed (recorded by 56.C).
Split the key: membership changes fetch; order-only changes remap
the existing series (uPlot rebuild is acceptable; the refetch is
not). Natural to fold into item 1's refactor if it touches the same
seam.

**Grooming map (2026-08-08, code read):** the order-sensitive
string exists in TWO places that must stay in agreement —
`signalSetKey` (`PlotArea.tsx:957`, first dep of the construction
effect :2440, and the `builtSignalSetRef` compare :2365-2371 whose
`else` branch is the repaint-from-cache path) and the decimation
cache `descriptor` minted independently inside `resample` (:1316;
cache drop rule `useDecimatedRange.ts:160-179`). A reorder today
costs uPlot destroy+rebuild, `resetRange()` cold whole-window
fetch, and a `useFirstSampleWait` "building…" flash. No series-
remap helper exists (`addSeries`/`delSeries` unused); the
`series[i]`↔`signals[i]` index assumption is hard-coded at five
sites (:1044, :1345, :1381, :2616, lane targets :1740). Scope
ruling: the uPlot rebuild on reorder is acceptable — the split
only has to make membership (sorted key) drive the cache
descriptor and `builtSignalSetRef` so the rebuild repaints from
cache instead of refetching; a full remap path is NOT required.

### 4. Capture-restore startup cost

Restoring a 4.07M-frame prior capture took ~21 s before connect
(2026-08-07 run logs; a 195k restore took ~10 s). **Owner ruling
(2026-08-08): this is a user-facing launch cost for anyone with a
large cache — not a harness concern — and the goal is a real
improvement for those users.** Investigation first all the same:
profile where the time goes in the host restore path and let the
data pick the fix (faster restore, non-blocking/background restore
with the GUI live, or both). Scientific method — no fix without the
profile naming the cost.

**Grooming map (2026-08-08, code read):** the restore command
(`restore_scratch_capture`, `capture.rs:530-565` →
`TraceStore::try_reload`, `flush.rs:398-446`) is mmap-reopen, NOT
a per-frame load: O(segment files) + a 4096-frame ring refill —
estimated ~250 mmaps for 4M frames, which a code-read says should
NOT cost 21 s. The 21 s is unattributed; nothing on this path is
instrumented (no spans, no benches — `cannet-perf-measurement`'s
tracebuffer mode never exercises `reopen`). The profile must
split: reopen sub-phases (manifest / meta mmaps / by-id mmaps /
ring refill, with file counts), the flusher's two whole-directory
walks + possible eviction landing on the first tick, and the
identity/derived/notes reads. Blocking shape: restore is awaited
inside `applyProject` (`App.tsx:1316-1334, 2177`), the splash
covers the GUI until it settles, `--connect-on-start` waits behind
it (pinned by `App.bootOpenOnce.dom.test.tsx:198-220`), and
`try_reload` holds the store mutex throughout. Separately: the
signal pyramid and filter index are wiped on restore and rebuilt
lazily on FIRST USE — `SignalCache::catch_up` materializes every
matching frame as an owned Vec before decoding
(`disk.rs:753-769`), per-frame `to_vec` + intern clone, under the
store lock; the real cache on this machine has an id with 17.5M
postings, i.e. an unbounded sub-GB allocation spike on first plot
over restored history. Found in passing (not a startup cost, needs
dispositioning): `try_reload` restores `per_key` but never resets
`mux_index_from`/`latest_mux` (`flush.rs:411-444` vs
`reset_derived` :461-476) — mux queries over restored history take
the bounded backward-scan fallback; the one piece of derived state
restore leaves inconsistent.

**Scope ruling (owner, 2026-08-08): all three layers.** (a) Profile
and speed up the synchronous restore where profitable; (b) if raw
speedup is bounded, restructuring to a background restore (GUI
live, history appearing when ready) is in scope; (c) the first-use
rebuild over restored history is in scope too — chunked/streaming
decode instead of materialize-then-decode, removing the hidden
O(capture) first-plot stall and capping the allocation spike. To a
large-cache user, "launch" ends when the first plot draws.

### 5. Perf-harness connect robustness

The first capture launched after a fresh `tauri build` silently
failed to connect twice on 2026-08-08 (sidecar up, dongles
enumerated, project open, no `connected to` line for 100 s, no
error logged; suspected AV scan of the just-frozen sidecar binary
delaying startup). The capture then runs empty and writes an
fps-0 / `rx_gap: null` report that looks like data. Make the
capture path fail loudly or retry: `--connect-on-start` under
`--perf-capture-secs` should retry the connect (bounded) and, if
the capture window ends without a connection, exit non-zero
without writing a report (or write it clearly marked failed).

**Grooming map (2026-08-08, code read):** the automation is
frontend-orchestrated (`App.tsx:1520-1592`, config from
`diag.rs:651`). The silence is a *silent skip*, not a hang:
`waitUntil` polls readiness (bindings non-empty + sidecar address)
for `AUTOMATION_READY_TIMEOUT_MS` = 30 s, then the `!ready` branch
skips `handleConnect` with zero logging (`App.tsx:1548-1550`),
warm-up (4.8 s) + settle (2 s) + 60 s capture run anyway ≈ the
observed ~97 s. The 1 Hz reporter pushes samples unconditionally,
so `diag.rs:567` writes a normal-shaped report for a never-
connected run, and `App.tsx:1583` destroys the window in `finally`
— exit code is always 0 (no host command exists for a nonzero
exit). No retry exists on the connect itself (the sidecar restart
budget covers crashes only). Natural seams recorded: log the
`!ready` branch, bounded `handleConnect` retry, assert
connectedness before `beginDiagCapture`, failure marker or
suppressed write at `diag.rs:567`, new host command for exit code.

**Failure contract (owner ruling, 2026-08-08): no report + exit
non-zero.** A never-connected capture writes nothing — absence is
the one failure signal no consumer can misread — and the process
exits non-zero (new host command; the frontend cannot set an exit
code today). The failure detail goes to the system log /
`cannet.log` (the `!ready` branch logs loudly). Marked-failed
reports rejected: every consumer would need to learn the marker,
and an unaware one reads fps-0 "data" — today's trap.

**Flake follow-through (owner, 2026-08-08):** landing the signal
is step one, not the finish. Once a never-connected run fails
loudly (logged cause + non-zero exit), use the first real
occurrence's data to root-cause the underlying first-run-after-
a-fresh-build startup flakiness (readiness timing out at 30 s —
suspected AV scan of the just-frozen sidecar, unproven) and fix
that cause; the bounded in-run connect retry may already cure it,
but the claim needs the signal's evidence, not an assumption.

## Exit criteria

- An `areas` edit (collapse, solo, hide, selection, primary) re-
  renders only the affected logical area's `PlotArea` instances,
  pinned by render-count tests; both standing memo guards green.
- Order-only `signals` changes (sort-area, drag-reorder) do not
  refetch; membership changes still do (tested).
- The restore-time work has a status-log conclusion with profile
  data, and lands a measured improvement to the large-cache launch
  experience (before/after at the 4M-frame scale).
- An unconnected perf capture can no longer produce a
  passing-shaped report: bounded connect retry, and a clearly
  failed outcome otherwise (tested at whatever seam the capture
  path allows).
- ADR-0031 gate green (multi-run) after the render-path work and
  at completion; docs updated where behavior changed.

## Status log

**2026-08-08 — Phase 57.A, item 5 (perf-harness connect robustness),
branch `task57a-capture-fail-loudly`.**

Landed the failure contract for a `--perf-capture-secs` run under
`--connect-on-start` that never connects: no report, non-zero exit.

- `f8f37de` — planning docs commit (this file + the roadmap edit),
  content unmodified.
- `5236470` — `fix(gui): fail a never-connected perf capture loudly
  instead of writing an empty report`.
  - Logs the `!ready` branch (binding count, sidecar readiness) to the
    system log / `cannet.log` instead of silently skipping connect —
    applies to any `--connect-on-start` run, not just a capture.
  - Bounded connect retry, scoped to `captureSecs != null` only (a
    plain `--connect-on-start` still connects once, unretried — there's
    no capture window whose absence needs a report suppressed): 3
    attempts, each given 3 s to land a "running" session before
    retrying, 1 s between attempts. Chosen bound + rationale: these
    numbers only delay *when* the capture window opens (worst case
    ~11 s added before `beginDiagCapture`), never its length (the
    `captureSecs` sleep is unchanged) — "retry over the pre-capture
    window" from the grooming map, read literally.
  - Connectedness is asserted before the capture window opens (at the
    top of the `captureSecs != null` block, i.e. before the interact
    warm-up and settle sleep too, which is strictly earlier than
    "before `beginDiagCapture`"). A failed run never calls
    `beginDiagCapture`/`endDiagCapture` — the host never arms, so no
    report is written; a marked-failed report was ruled out, so this is
    the whole suppression mechanism, not a Rust-side guard.
  - New host command `exit_process(code)` (`diag.rs`, wraps
    `AppHandle::exit`) — the frontend's only way to set a process exit
    code. The failure path calls it with `code: 1` and returns before
    the `finally` block's normal `destroy()` (added a `failed` flag so
    the two exit paths don't race).
  - Tests: `apps/gui/src/App.perfCaptureConnect.dom.test.tsx` (3 new
    dom tests — never-ready capture, retries-exhausted capture, and a
    plain connect-on-start's `!ready` log without retry/exit), fake
    timers with `performance` added to `toFake` (vitest's default
    doesn't fake `performance`, and the automation code's `waitUntil`
    bounds itself with `performance.now()` — without this the poll
    loops never see elapsed time pass and hang). `App.bootOpenOnce.
    dom.test.tsx` re-run unchanged and green (the pinned splash/boot
    ordering, non-capture connect-only path, is untouched).
  - Test counts: JS 137 files / 1651 tests (was 1648) all green
    (`pnpm --dir apps/gui test`); Rust 495 passed / 0 failed / 2 ignored
    (`cargo test -p cannet-gui`); `cargo clippy -p cannet-gui
    --all-targets` clean; `pnpm --dir apps/gui build` clean.
  - Docs: README § Self-driving performance runs and ADR 0031's
    Consequences both updated with the retry/no-report/exit-non-zero
    contract, in the same commit.

**Conflict with the setup brief, recorded per the "no silent
redesign" rule:** the task brief asked for "Rust tests for the
report-suppression and exit-code command." Report suppression turned
out to need no new Rust logic — the frontend simply never calls
`diag_capture_start`/`diag_capture_finish` on a failed connect, so the
pre-existing `diag_capture_finish` empty-samples guard (already
untested, unrelated to this change) is never exercised by this path.
`exit_process` is a one-line `AppHandle::exit` wrapper; calling it in a
test would attempt to exit the test process, and the crate has no
`tauri::test` harness (`State`'s inner field is private outside
`tauri::state`, so a command taking `State<'_, T>` can't be
constructed standalone either) — adding one is a new-dependency
decision out of this phase's scope. Closest faithful reading: both
behaviors are tested at the frontend orchestration seam instead (dom
tests assert `exit_process` is called with `code: 1` and the diag
commands are never called), which is where the decision is actually
made and is exactly the "whatever seam the capture path allows"
language in the exit criteria.

**Flake follow-through (owner ruling): pending, not attempted.** The
underlying first-run-after-a-fresh-build 30 s readiness timeout
(suspected AV scan of the just-frozen sidecar) has not recurred since
2026-08-08 and was not reproduced or root-caused in this phase, per the
ruling — root-causing happens on the signal's first real occurrence
(now that a never-connected run fails loudly instead of silently),
likely during this task's later perf-gate runs.

**2026-08-08 — Phase 57.D, item 5 (the failure contract's exit code, and
the readiness flake's root cause), branch
`task57d-capture-exit-and-flake`.**

Commits: `a508f54` (exit code), `b559507` (readiness flake), `a3018b2`
(rustfmt of the former).

Test counts: Rust 498 passed / 0 failed / 2 ignored (`cargo test -p
cannet-gui`, was 496); JS 139 files / 1666 tests (was 138 / 1664), all
green. `tsc --noEmit`, `cargo clippy -p cannet-gui --all-targets` and
`cargo fmt --check` clean.

### A. `exit_process(1)` reached the OS as 0

**Observation** (57.C, twice). A `--connect-on-start
--perf-capture-secs 60` run hit the readiness timeout, logged the cause,
wrote no report — and the launching shell saw `0`. The dom tests assert
`exit_process` is *invoked*, so the loss is below the frontend.

**H1 — the runtime drops the requested code.** Experiment: read the
pinned sources. Data: `AppHandle::exit(code)` → `request_exit(code)` →
`Message::RequestExit(code)`; the wry handler emits `RunEvent::
ExitRequested { code: Some(code) }` and, on the next line, sets
`*control_flow = ControlFlow::Exit` — which tao defines as
`ExitWithCode(0)` (`tao-0.35.2/src/event_loop.rs:177`). The code is
dropped one statement after it is delivered, and `App::run` exits with
whatever the loop returned. **Confirmed by construction**; the two rival
hypotheses in the brief (a `finally`/teardown race, an `ExitRequested`
handler overriding the code) need no separate test — this one accounts
for the observation on its own, and the host's handler never touched the
code because it never read it.

**Reproduction, before.** Release build; an isolated scratchpad copy of
`examples/ev-zonal` with both `interface_bindings[].server` repointed at
`127.0.0.1:9` (nothing listens there, so connect can never land a
session — the originals were not touched); launched
`--connect-on-start --perf-capture-secs 5`. Data: 3 connect attempts
logged, **no report**, `echo $?` → **0**.

**Fix.** `run()` takes `App::run_return` instead of `App::run`, keeps
the code off `RunEvent::ExitRequested`, and exits the process itself:
`final_exit_code(requested, event_loop_code) = requested
.unwrap_or(event_loop_code)`, unit-tested both ways. This is not a
change of shutdown shape — tao's own `run` *is* `run_return` followed by
`process::exit(code)`; the only difference is who supplies the code.

**Verification, after.** Same reproduction, rebuilt: 3 attempts, no
report, **exit 1**. Success path unaffected: a real 5 s capture against
the ev-zonal copy connected, wrote its report, **exit 0**.

### B. The readiness flake — the sidecar was never slow

**Observation.** Both 57.C failures logged `connect preconditions not
ready after 30000ms (bindings=2, sidecar=not ready)`.

**H2 (the standing suspicion) — the frozen sidecar's first start after a
fresh build is pushed past 30 s by the filter-stack/AV toll 57.C
measured (~14 ms per newly written file).** Experiment: measure
`sidecar started (pid …)` → `listening on …` in `cannet.log`, for the
two failures and for this session's first launch after a fresh `tauri
build` (which rewrites the whole frozen tree). Data: the **failing runs
took 1.27 s and 1.21 s**; this session, first-after-a-fresh-build
**2.42 s and 2.51 s** (two fresh builds), later launches **1.04–2.41 s**
across eleven. **Refuted** — and
refuted twice over, because in both failures the sidecar's `listening`
banner is in the log **~31 s before** the timeout fired.

**H3 — the host's published status never moved to ready.** Experiment:
look for the side effect only `set_phase(Ready, addr)` produces — it
starts the `WatchInterfaces` subscription against the bound address.
Data: the sidecar's own log shows `WatchInterfaces stream opened` **9 ms
after** the banner in the failing run (15:08:23,152 → 15:08:23,161
local). **Refuted** — the host held `ready` + the address the whole
time; only the frontend's copy was stale.

**H4 — the transition was published into the gap between the frontend's
snapshot and its listener registration.** `useSidecarStatus` awaited
`get_sidecar_status`, *then* awaited `listen(...)`; an event emitted in
between reaches nobody, and a healthy sidecar never transitions again,
so the miss is permanent. Experiments: (a) a dom test that publishes the
transition while the registration promise is still pending — the hook
stays `starting` forever (red before the fix, green after); (b) the
timing correlation across the session's 13 launches — the two failures
are the **two smallest** banner→frontend-boot gaps (**172 ms** and
**258 ms**), while every run that connected had the banner land either
≥406 ms before the frontend booted (so its snapshot already read ready)
or after its listener was live. **Confirmed.**

**Fix.** Re-read the status once the listener is attached — the same
post-listener refetch `useHostMirror` already standardises, and what
`sidecar.rs`'s `STATUS_EVENT` rustdoc already claimed subscribers do.

**No readiness-policy change, deliberately.** `AUTOMATION_READY_TIMEOUT_
MS` stays 30 s: the measurement says a cold sidecar needs ~2.5 s, so
30 s remains the right "genuinely dead" bound, and the candidate shapes
in the brief (a liveness-keyed wait, a longer capture-run timeout, a
build-step warm touch) would each have papered over a lost event rather
than fixed it — none would have helped, since no amount of waiting
recovers an event that was already delivered to nobody.

**Verification.** Six consecutive `--connect-on-start
--perf-capture-secs 5` runs on the rebuilt binary, the first of them the
first launch after a fresh `tauri build` (the flake's stated trigger
condition): 6/6 connected, 6/6 wrote a report, 6/6 exited 0.

## Blockers / side effects

Phase 57.E:

- **The splash's 5 s floor caps what a background restore can show.**
  `useSplashVisible` holds the splash for `max(SPLASH_MIN_MS = 5000,
  boot settled)`. Boot-minus-restore measures ~3.2–3.9 s on this
  machine, so a restore has to exceed ~1–1.8 s before the earlier
  `bootSettled` moves the splash at all. The 4M-frame case measured here
  (1.2–1.5 s) sits right at that line: the splash lift went 7.13 s →
  5.00 s in the measured pair, but part of that is the floor, not the
  change. Anything bigger (the 90.5M-frame capture in this machine's
  real cache) is pure saving. The floor is a deliberate product decision
  (disclaimer dwell) and was not touched.
- **The restore still holds the trace-store lock across the reopen.**
  `try_reload` takes `lock_inner()` first and calls
  `DiskRawStore::reopen_timed` under it, so store-reading commands queue
  behind the reopen even now that the command itself is off the main
  thread. Left as is deliberately: during that window the store those
  commands would read is the *new session's empty one*, so the queueing
  costs the user nothing they could otherwise see. Reopening off-lock
  and swapping under it is the obvious next step if that changes; it
  needs a re-validation of `scratch_dir`/identity after re-taking the
  lock, which is why it wasn't done as a drive-by.
- **`restore_scratch_capture` lost its `State<'_, AppState>`
  parameter.** An async Tauri command can't borrow managed state across
  a `'static` future, so it takes `AppHandle` and calls `app.state()` —
  the shape `fetch_trace_range` and the other async commands already
  use. No caller changes (the frontend passes no arguments).
- **The `async` change has no automated test.** The crate still has no
  `tauri::test` harness (57.A recorded why), and "runs off the main
  thread" is a property of Tauri's dispatch, not of code this crate can
  call. Its sibling `scan_blf_channels` is in the same position. The
  evidence is the measurement in the status log — the one-variable
  before/after where `async` moved the interactive marker from 8 ms
  after the restore to 1493 ms before it.
- **The synthetic capture reproduces the filter-stack toll only
  sometimes.** Same tool, same 4M frames, same directory: one launch
  reopened 1620 by-id files in 58 ms (0.036 ms/file, the already-scanned
  floor) and the next three in 1106–1399 ms (0.68–0.86 ms/file, close to
  57.C's 1.1 ms/file). Every number quoted for this phase is from a
  toll-paying run; the fast one is noted so a future reader doesn't
  average them.
- **Scratch left behind, not cleanable from here** (same as 57.C). The
  measurement used a scratchpad copy of `examples/ev-zonal` and the
  cache directory the app auto-located for it
  (`…/dev.cannet.app/cache/dccb012f226c5b06896e319dd8c5c3f0`, ~184 MB of
  synthetic capture) plus an auto-located project dir under
  `…/dev.cannet.app/projects/a2d9e64e…`. Both were created by the app
  for that copy; the user's real project caches were never written to.
  `rm -rf` is not permitted from this session.
- **A measurement run was discarded for concurrent-process
  interference, one was kept after review.** The 23:54 run was flagged
  mid-phase as possibly user-touched; its intervals had all closed ~4 s
  in and the app then sat idle, so it was sound — but the before figure
  was re-taken from an untouched launch anyway (23:56) and only that one
  is quoted. The 00:05 run *was* discarded on its own evidence: a
  concurrently running instance (the owner's own build) had rewritten
  the cache directory, so it restored 4592 frames instead of 4M.

Phase 57.D:

- **The stuck status had an interactive face too.** The same lost event
  left the Connection panel's "Local sidecar" row reading `starting…`
  for the life of a session whose sidecar was up — `useSidecarStatus` is
  shared by `App` and `ProjectPanel`. Fixed for both by the same change;
  worth knowing that the perf harness only made a user-visible bug
  legible.
- **Two sibling hooks have the same shape and were left alone.**
  `useConnectionStates` (`connectionStates.ts`) and the interface-cache
  effect in `ConnectionManagement.tsx` both snapshot before they
  `listen`, so both can lose a transition the same way. Neither is on
  the readiness path this phase was chartered to fix, and both recover
  on any later event (bus state and interface lists move repeatedly,
  unlike a sidecar that binds once), so they are a latent-but-quieter
  instance of the same bug rather than this one.
- **`run()` is now `-> !`.** It ends in `std::process::exit`, so it can
  no longer return to `main`. No caller changes; noted because the
  signature is public.
- Rebuilding the release host with a bare `cargo build --release -p
  cannet-gui` produces a binary with **no frontend at all** (it points
  at the Vite dev server without the `custom-protocol` feature the tauri
  CLI passes) — it boots, spawns the sidecar, and then sits there
  silently, which looks exactly like a hang. README § *Self-driving
  performance runs* already says so; recorded here because it costs a
  confusing 20 minutes if you skip it, and because
  `--features tauri/custom-protocol` is a working shortcut when the
  frontend bundle is already built.

Phase 57.A:

- The `!ready` log line fires for *any* `--connect-on-start` run, not
  only a perf capture (item 1 of the grooming map is written that
  generally). Side effect, not a scope creep: a plain connect-on-start
  launch that times out now leaves a system-log line where it used to
  leave silence, with no other behavior change (still no retry, still
  no exit) — verified by a dedicated test.
- Added a second, stricter "is a session up" boolean
  (`remoteConnectedRef`, `kind === "running"` only) alongside the
  existing `remoteConnected` (`"running" || "connecting"`, used
  elsewhere for the status line). The retry-confirmation loop needs the
  strict version — a "connecting" session is exactly the state a retry
  must not mistake for success — so this is a second derived value, not
  a reuse of the existing one.
- No changes to items 1-4 (per-area plot scoping, dropped item,
  `signalSetKey`, capture-restore cost) or the ADR-0031 gate re-run —
  out of this phase's scope (item 5 only).

Phase 57.B (items 1 and 3):

- `useValueTables` is shared (plot, colormap, transmit, RBS panels), so
  the sorted fetch key changes all of them: a caller that reorders the
  same signals no longer refetches. The hook's result has always been a
  map keyed by signal, so no caller can observe a difference beyond the
  saved round-trips and the map's identity holding still.
- `patternResolutionsByArea` no longer carries an entry for an area
  without patterns (it used to hold a fresh empty array). The two
  readers both cope — the render falls back to the shared
  `EMPTY_RESOLUTIONS`, the bus-rename warning effect iterates what is
  there — but a future reader must not assume one entry per area.
- `scopedCatalog` / `resolveColor` now key on the filter / colormap
  *elements* rather than on `registry.entries`. That relies on
  `applyElementPatch` replacing the element object it patches (it does,
  and its no-op short-circuit returns the array unchanged); an element
  mutated **in place** would no longer reach these memos.
- While solo is active, an `areas` edit still re-derives every axis in
  the panel: the mask's visible set is rebuilt from the areas on every
  edit, and a non-matching area's rows all read hidden, so the mask is
  panel-wide by construction. Unchanged from before this phase, and
  stated in the code where the dependency is taken.
- Reordering an area's rows still destroys and rebuilds its uPlot
  instance — the scope ruling's accepted half of the trade, now pinned
  by a test so a future reader doesn't take it for an oversight.

Phase 57.C (item 4, first half):

- **`try_reload` changed shape**: `bool` → `Option<String>` (the reload's
  cost breakdown, ready to log). Six test call sites moved to
  `.is_some()` / `.is_none()`; the restore command is the only production
  caller.
- **The restore's INFO line changed text**, from `restored N frames from
  prior capture` to `... in {ms} ms`. Nothing parses it, but it is the
  line a user sees in System Messages, so it is a visible change.
- **`open_segments` is the crate's first threading.** It is
  `std::thread::scope` over contiguous chunks of a path list with no
  shared state and no dependency added, which is the smallest shape that
  buys the 13x — but `cannet-spill` was single-threaded before this and a
  reviewer should know that changed.
- **The ADR-0031 gate was not re-run.** This phase touched only the host
  restore path, which no render-tier measurement exercises (the harness
  starts a *fresh* capture, so it never reopens one), and the gate is the
  orchestrator's to run. The two post-57.B reports are committed at
  `35312a2`.
- **Item 5's flake reproduced, twice, with its cause named.** Two of six
  perf captures run in this phase failed with `ERROR automation: perf
  automation: connect preconditions not ready after 30000ms (bindings=2,
  sidecar=not ready)` — so it is **sidecar readiness**, not bindings,
  that times out, which is evidence for item 5's flake follow-through
  (the AV-scan-of-the-frozen-sidecar suspicion is consistent with this
  phase's finding that a first open after a write costs ~14 ms/file, but
  that link is unproven). Both runs correctly wrote **no report**.
  However, **the process still exited 0** in both cases (`echo $?` from
  the launching shell), so the "exit non-zero" half of the 57.A failure
  contract did not come through in a real run — the dom tests assert
  `exit_process` is *called*, not that the code reaches the OS. Recorded
  for the owner; verifying it is item 5's, not this phase's.
- **Scratch left behind, not cleanable from here.** The profiling used an
  isolated copy of `examples/ev-zonal` under the session scratchpad and
  its own cache directory (`.../dev.cannet.app/cache/96e8f5695237
  5e0eabc0ddece4f37234`, created by the app for that copy — the user's
  real project caches were never written to). `rm -rf` is not permitted
  from this session, so both are left in place; the scratchpad copy of a
  216k-frame capture (~16 MB) is there too.

**2026-08-08 — follow-up: the outer `catch` was still a quiet-exit-0
hole.** Review found that an exception during the capture window
(`handleConnect` rejecting instead of just failing to land a session,
or `beginDiagCapture` throwing) skipped the retry/assert logic
entirely — `failed` stayed `false`, the outer `catch` only
`console.error`d, and `finally` fell through to `getCurrentWindow().
destroy()`: exit 0, no report, the exact quiet success the failure
contract exists to prevent, just reached via a rejection instead of a
readiness timeout.

Fix: on a capture run (`captureSecs != null`), the `catch` block now
also logs the cause via `logAutomation("error", ...)`, sets `failed =
true`, and calls `exit_process(1)` — the same failure path as the
retry-exhausted and never-ready branches, reusing the `finally` block's
existing `!failed` guard against `destroy()`. A non-capture run is
unaffected: `console.error` only, app stays open. There's no code
after `endDiagCapture` inside the `try`, so any capture-run exception
means the report is absent or unfinished — exit non-zero is always the
right call, not just for the two branches already covered.

TDD: added a failing test first
(`App.perfCaptureConnect.dom.test.tsx`, "an exception during the
capture window (connected, but beginDiagCapture throws) fails the run")
— connect succeeds on the first attempt (so the retry logic never sets
`failed`), then `diag_capture_start` is made to throw, exercising the
outer `catch` in isolation from the retry/assert paths. Confirmed red
(`exitCalls` empty) against the pre-fix code, then green after the fix.

- Test counts: JS 137 files / 1652 tests (was 1651) all green
  (`pnpm --dir apps/gui test`); `tsc --noEmit` clean. No Rust files
  touched by this follow-up.

**2026-08-08 — Phase 57.B, item 1 (per-area scoping of the plot panel's
derived configs), branch `task57b-render-path-scoping`.**

- `7f4ff46` — `perf(gui): scope the plot panel's derived area configs per
  logical area`.
- Sequencing: item 1 first, item 3 second (they touch adjacent seams but
  not the same lines — item 1 is `PlotPanel`'s derivation chain, item 3
  is `PlotArea`'s cache/rebuild keys). One render-count test written for
  item 1 turned out to need item 3's work to pass, and moved to that
  slice (below).
- New `keyedMemo.ts`: `createKeyedMemo` / `useKeyedMemo` (a per-key memo
  whose entry survives while that key's own dependency list does,
  `Object.is` per entry, keys not asked for in a pass retire) and
  `useStableMembers` (holds a freshly-filtered list's identity while its
  members are the same objects in the same order). 4 unit tests.
- Scoped per logical area: `effectiveAreas` (via a new single-area
  `applyAreaSelection` in `signalSelection.ts`, with the plural now
  mapping over it), `derivedAreaConfigs` (its body lifted to a
  module-level pure `deriveAreaConfigs`), `manualKeysByArea`,
  `patternResolutionsByArea` (pattern-free areas are now simply absent,
  falling back to the shared `EMPTY_RESOLUTIONS` instead of a fresh
  empty array), and `areaHandlers`. `selectSignal` now reads the
  selection order through a ref — it was the one handler that closed
  over a value rebuilt on every areas edit, which alone re-minted every
  axis's bundle. `placeSignal`'s internal-move path leaves untouched
  areas at their existing identity.
- **Discovered prerequisite, recorded because it was not in the grooming
  map:** the scoping is undone one render later without it. The element
  registry replaces its whole `entries` array whenever *any* element is
  patched — including this panel persisting its own `areas` — and
  `scopedCatalog` / `resolveColor` were keyed on that array, so the
  persist round-trip re-minted the `catalog`, `ecuLookup`, `valueFormats`
  and `resolveColor` props of every area. Both now key on the filter /
  colormap *elements* (`useStableMembers`), which `applyElementPatch`
  leaves alone when the edit was elsewhere. This is very likely the bulk
  of 55.C's "4 renders on a 2-area panel": 1 for the edit + one per area
  for the persist.
- Measured, `render.PlotArea` deltas on a stopped 3-area panel (2 rows
  each, no canvas so the areas' own resample machinery is inert and the
  count is pure prop fan-out) — **before → after**: collapse `6 → 1`,
  hide a row `3 → 1`, promote a row to primary `3 → 1`, panel re-render
  after the edit's persist `3 → 0`.
- Tests: new `describe("PlotPanel per-area render scoping")` in
  `PlotPanel.dom.test.tsx` (4 render-count regression tests, the 55.C
  probe methodology made permanent) plus `keyedMemo.test.ts` (4). Both
  standing memo guards re-run and green; the ctrl-click selection-slice
  guard's comment updated where it claimed a plain click "legitimately
  re-renders the stack" — it no longer does.
- The new tests' settle loop waits past `FIRST_SAMPLE_INDICATOR_MS`
  before measuring: with no canvas nothing ever settles the first-sample
  gate, so each area's "building…" timer fires ~300 ms after mount and
  otherwise lands inside the measurement window.
- Test counts: JS 138 files / 1660 tests (was 1652) all green
  (`pnpm --dir apps/gui test`); `tsc --noEmit` clean. No Rust touched.

**2026-08-08 — Phase 57.B, item 3 (`signalSetKey`: membership vs
order), same branch.**

- `ea75ae6` — `perf(gui): key a plot area's sampled data on membership,
  not order`.
- The split, as groomed: `signalSetKey` (ordered) still keys the uPlot
  construction effect — the destroy+rebuild on reorder stays, per the
  scope ruling, and no series-remap path was built. A new
  `signalMembershipKey` (the same keys, sorted) keys everything about
  the *data*: the decimation cache `descriptor` inside `resample`, the
  `builtSignalSetRef` compare (so a reorder takes the
  repaint-from-cache else-branch instead of `resetRange()`), and
  `useFirstSampleWait` (so no "building…" flash). The two copies of the
  descriptor string the grooming map warned about are now one
  expression, read from both places.
- Two order dependencies had to move with it, or the split would have
  been wrong rather than merely ineffective:
  - `hostExtentsRef` held the `signal_min_max` sidecar's answer as an
    array parallel to the signals *at fetch time*, read positionally
    (`hostExtents?.[i]`). Keeping it across a reorder-driven repaint
    would have normalised each series against its neighbour's all-time
    range. It is a `Map` keyed by signal key now, like the decimation
    cache beside it.
  - `useValueTables` keyed its fetch on the ordered key, so a reorder
    refetched every table and replaced the result map — which
    `PlotPanel` turns into `enumKeys`, a dependency of every area's axis
    derivation. One area's reorder re-derived the whole panel. Its key
    is sorted now (the result was always keyed by signal, so order
    cannot change the answer); pinned by a new unit test, confirmed red
    against the unsorted key first.
- Tests: new `describe("PlotPanel signal set: membership vs order")` in
  `PlotPanel.dom.test.tsx` — order-only change repaints from cache (no
  new `sample_signals`, no "building…", same drawn point count, and the
  expected fresh uPlot instance), membership change still fetches, and
  the reorder render-scoping test deferred from item 1 (the other area
  does not re-render). Plus one `useValueTables.test.ts` case.
- Test counts: JS 138 files / 1664 tests (was 1660) all green
  (`pnpm --dir apps/gui test`); `tsc --noEmit` clean. No Rust touched.
- Docs: `DecimatedRequest.descriptor`'s rustdoc-equivalent comment now
  states the membership rule (and why order must stay out of it) in the
  same commit as the code.
- Two review tidy-ups after the fact, no behavior change: `1b55f3a`
  (the membership key written down among `resample`'s dependencies —
  it is derived from `signals`, which was already listed) and `497f30b`
  (the scoped-catalog doc comment put back on the scoped catalog after
  the filter-element hoist landed between them).

**Phase 57.B closing state.** Items 1 and 3 meet their exit criteria
(`areas` edits scoped by render-count test; order-only changes repaint
from cache, membership changes fetch, both tested). Items 4
(capture-restore startup cost) and the ADR-0031 gate re-run are
untouched — the gate is the orchestrator's to run after this phase.

**2026-08-08 — Phase 57.C, item 4 first half (profile the capture-restore
startup cost and land the synchronous wins), branch
`task57c-restore-profile`.**

Commits: `35312a2` (the two post-57.B gate reports, content unmodified),
`9c4af47` (instrumentation), `ae9622a` (mux fix), `fd857b1` (the
synchronous win), `92b99ac` (instrumentation into `cannet.log`).

Test counts: Rust 496 passed / 0 failed / 2 ignored (`cargo test -p
cannet-gui`, was 495) and 57 passed / 0 failed / 1 ignored (`cargo test
-p cannet-spill`, was 56); `cargo clippy -p cannet-gui -p cannet-spill
--all-targets` clean. No frontend files touched.

### Attribution: observation → hypothesis → experiment → data → conclusion

**Observation.** From `cannet.log`, 18 restores logged 2026-08-08. The
gap from the last line before the restore (`rbs: loaded RBS config`) to
`restored N frames`: 9.5–10.4 s for ~190–216k frames, 15.25 s for 1.07M,
20.68 s for 4.07M — and **0.09 s / 0.11 s** for exactly two of them.

**H1 — the reopen's `O(segments)` mmaps are the cost.** Experiment: a
standalone binary calling `DiskRawStore::reopen_timed` on copies of real
captures, with a `FILE_FLAG_NO_BUFFERING` sweep to purge the OS page
cache. Data: a 216k-frame / 766-file capture reopened in **64–92 ms**
warm and **67–70 ms** page-cache-cold; a 90.5M-frame / 3.9 GB /
3040-file capture in **247 ms** warm and **323 ms** cold. **Refuted** as
stated — mapping a segment is ~0.1 ms, and neither the page cache nor
capture size explains 10 s.

**H2 — the gap is outside the command** (the frontend's
`api.fromJSON(layout)`, the flusher's directory walks, an eviction on the
first tick). Experiment: instrument the command end to end (`9c4af47`)
and launch the release build against an isolated copy of the ev-zonal
project with its own capture. Data: a 10.29 s log gap, of which
`restore_scratch_capture` reported **10290 ms**. **Refuted** — the whole
gap is inside the command, and the phase split named it:

| phase | ms | work |
| --- | --- | --- |
| identity read | 0 | 1 file |
| manifest read | 0 | 1 file |
| **by-id mmaps** | **10231** | **761 files, 179 ids** |
| meta mmaps | 45 | 4 files |
| payload mmaps | 11 | 1 file |
| ring refill | 1 | 4096 frames |
| derived read | 1 | 358 keys |
| notes restore | 0 | — |
| **command total** | **10290** | 201 337 frames |

**H3 — something about the `cannet-gui` process** (its address space, the
store mutex, Tauri's dispatch). Experiment: run the standalone probe on
*the very same directory* immediately afterwards. Data: **59–75 ms**.
**Refuted.**

**H4 — it is the first open of a *just-written* file.** Experiment: a
fresh 20 s capture, then the standalone probe first. Data: by-id
**8018 ms / 559 files = 14.3 ms/file**; the same directory again
immediately: **42 ms**. Splitting open from map on another fresh
capture: read-only `open` (no mmap) **14.2 ms/file**, read-write `open`
**14.9 ms/file** — so it is the *open*, not the mapping, not the access
mode, and not the bytes (those 559 files hold ~1.3 MB in total).
**Confirmed.**

**Conclusion.** The restore cost is `files × ~14 ms`, paid once per
segment file on the first open after it was written, and ~0.1 ms
thereafter. The mechanism is the Windows filesystem filter stack —
real-time antivirus scanning each newly written file (`Get-MpComputer
Status`: `RealTimeProtectionEnabled=True`, `AMRunningMode=Normal`;
exclusions not readable without admin). Three independent facts agree:
the only two fast restores in the log are the two relaunches where **no
capture ran in between**, so the files had already been opened since
their last write; a byte-identical *copy* of an already-scanned capture
shows no toll at all (76 ms for 3040 files); and two of this session's
captures failed to connect, wrote nothing, and the following restore was
correspondingly fast. The by-id index is one geometric chain per id, so a
179-id capture pays the toll hundreds of times for ~1 MB of postings —
which is why the cost tracks file count, not frame count.

### The synchronous win (`fd857b1`)

Waiting parallelises. Measured on one freshly-written capture, serial vs
16-way over the same file set: **14.30 ms/file → 1.08 ms/file (13x)**.
`seg::open_segments` maps a path list on a fixed 16-thread scoped pool
and returns the mappings in order (a unit test pins the ordering and the
error propagation); the by-id reopen pools *every* id's paths into one
pass, so a capture with few deep chains parallelises as well as one with
many shallow ones, and the raw meta and payload families use it too. The
thread count is a constant, not `available_parallelism`, because the work
is external wait rather than CPU — the rationale and the measurement are
in the constant's rustdoc.

**Before → after, same project, same shape** (release build, fresh
capture then `--project` launch, 201k frames / 179 ids / 761 by-id
files):

| | before | after |
| --- | --- | --- |
| by-id mmaps | 10231 ms (13.4 ms/file) | 844–1037 ms (1.1–1.4 ms/file) |
| meta + payload | 56 ms | 23–24 ms |
| command total | 10290 ms | **877 / 1062 ms** |
| `cannet.log` launch gap | 10.29 s | **0.88 s** |

An already-scanned capture (relaunch with no capture in between) now
restores in **23 ms**, logged.

### Instrumentation (a deliverable, `9c4af47` + `92b99ac`)

`DiskRawStore::reopen_timed` returns a `ReopenStats` splitting manifest /
by-id / meta / payload / ring, each with the file count that makes its
duration readable; `reopen` delegates and drops it, so no other caller
changed. `try_reload` returns the formatted breakdown (it used to return
`bool`), the restore command puts the **total on the INFO line the user
already sees** (`restored N frames from prior capture in 877 ms`) and the
phase split behind it at debug. Both land in `cannet.log`, which carries
the system log only — the first cut used `tracing::info!` and was
invisible there, which is why `92b99ac` exists.

### Mux disposition (`ae9622a`) — a bug, worse than the grooming map said

The grooming map expected mux queries over restored history to fall back
to the bounded backward scan. They did not: at launch the DBC set
installs the mux extractor while the store is still **empty**, so
`mux_index_from` is 0; `try_reload` then swaps in N frames that never
passed through the extractor and leaves the mark at 0, which
`latest_mux_in_window` reads as "coverage proves absence" — returning
**nothing**, with no scan attempted. Every mux group blank over the whole
restored history. Regression test written first and confirmed returning
`None`; the fix re-roots the index at the new tip exactly as
`set_mux_extractor` does. Small and surgical, so landed rather than
deferred.

### Verdict for 57.D

- **What a large restore costs now.** The remaining cost is
  `files × ~1.1 ms`. Measured: 761 files → 0.88–1.06 s. Projected from
  that per-file constant: the observed 4.07M-frame case (~1555 files)
  goes 20.7 s → **~1.7 s**; the 90.5M-frame capture in this machine's
  real cache (3040 files) goes ~43 s → **~3.4 s**. These two are
  projections, not measurements: a large capture could not be re-measured
  with the toll present, because copying one preserves already-scanned
  content and reopens in 76 ms.
- **Further raw speedup is bounded, and why.** What is left is external
  wait we can overlap but not remove. 16-way already recovers ~92% of it;
  the floor without the toll is ~0.08 ms/file (the 23 ms already-scanned
  restore), so the residual ~1 ms/file *is* the toll. The only structural
  lever left is **mapping fewer files** — defer a by-id chain to its first
  query, or coarsen the geometry (`BASE_ENTRIES` is 64, i.e. a 512-byte
  first segment, so ~10 tiny files per id before the cap). Neither was
  attempted here: neither is named by the profile as necessary once the
  cost is ~1 s, and both change the on-disk shape.
- **Where the first-use rebuild cost lives — the bigger number.**
  `SignalCache::catch_up` asks `matching_frames_indexed` for **every**
  matching frame as an owned `Vec` before decoding a single sample, under
  the store lock. Measured on a real capture: **0.30 µs/frame** and
  **116 B/frame** resident (working-set delta over 1.25M held frames; the
  struct alone is 72 B, the rest is the per-frame payload `Vec` and
  `bus_id` `String` allocations). The id with 17.5M postings in this
  machine's real cache therefore costs **≈5.3 s and ≈2.0 GB** in the
  materialization alone, before any decoding — five times the restore it
  follows, and unbounded in capture length rather than in file count.
  That is where 57.D's chunked/streaming decode has to bite; a background
  restore would hide the ~1–3 s reopen, but it would not touch this.

**2026-08-08 — Phase 57.E, item 4 second half (the first-use rebuild and
the background restore), branch `task57e-restore-experience`.**

Commits: `125c052` (chunked catch-up), `10695fc` (rebuild benchmark),
`db2c2dc` (interactive marker), `2c736ec` (background restore),
`e504233` (restore off the main thread).

Test counts: Rust 500 passed / 0 failed / 3 ignored (`cargo test -p
cannet-gui`, was 498/2 — two new tests, one new `#[ignore]`d benchmark)
and 57 passed / 1 ignored (`cannet-spill`, untouched); JS 139 files /
1669 tests (was 1667), all green. `cargo clippy -p cannet-gui -p
cannet-spill --all-targets`, `cargo fmt --check` and `tsc --noEmit`
clean.

### A. First-use chunked decode (`125c052`, `10695fc`)

`SignalCache::catch_up` asked `matching_frames_indexed` for **every**
matching frame in the unread range as one owned `Vec` before decoding a
sample. On the first use of a signal over restored history the unread
range is the whole capture, so that allocation is `O(capture)` — 57.C
measured 116 B and 0.30 µs per materialized frame, i.e. ≈2.0 GB for the
17.5M-posting id in this machine's real cache.

It now walks the range in `CATCH_UP_CHUNK_FRAMES` = 16384-frame chunks,
fetching one chunk's matches and decoding them before asking for the
next — the same shape `FilterIndex::extend` already uses for its build
(`BUILD_CHUNK`). The materialized set and the trace-store lock hold are
both bounded by the chunk; decoding still runs off that lock, between
fetches. Chunking costs one extra by-id range lookup per chunk
(`O(log occurrences)`), 244 of them over a 4M-frame span.

**Measured** (release, new `#[ignore]`d `bench_first_use_rebuild`: a
4M-frame single-id capture in a temp scratch, first `slice` timed while
a sampler thread tracks the process working set). The chunk size is the
only variable — a chunk larger than the capture *is* the old whole-range
fetch:

| | whole-range fetch | 16384-frame chunks |
| --- | --- | --- |
| rebuild wall clock | 1.98 s | 1.93 s |
| working-set delta | **+389 MB** (97 B/frame) | **+85 MB** (21 B/frame) |

Reproduced twice each. The decode time is unchanged and inherent
(`O(matches)`); what goes away is the allocation. The residual 85 MB is
the store's mapped meta/payload/pyramid pages the scan touches — kernel
page cache, pageable, and there in both columns.

TDD: an equivalence pin first (a capture spanning several chunks decodes
to exactly the same samples, and a later catch-up resumes at the tip),
written and confirmed **green against the pre-change code** so it pins
behaviour rather than describing the rewrite; then a bounded-chunk test
through a fetch seam (`catch_up_chunked`) asserting no chunk exceeds the
cap, that the chunks tile the range with no gap or overlap, and that
every match still decodes once — red (didn't compile) before the change.

### B. Background restore (`2c736ec`, `e504233`, marker `db2c2dc`)

Two changes, because the first alone was inert:

1. **The frontend no longer awaits the restore.** `applyProject` starts
   it and keeps its promise in `restorePendingRef`; the boot settles and
   the splash's hold drops without it. **Connect** waits instead —
   `handleConnect` awaits the pending restore immediately before its
   first store-touching statement, because `try_reload` swaps the raw
   store wholesale and a clear or an append racing it acts on a store
   about to be discarded. The automation connect goes through the same
   function, so a perf capture still never starts over a half-restored
   buffer, with no automation-specific code.
2. **`restore_scratch_capture` is `async`.** A sync `#[tauri::command]`
   runs on the main thread, which is why the frontend change on its own
   changed nothing: **observation** — with the restore no longer awaited,
   the "startup: interactive" marker still landed 8 ms *after* the
   restore. **Hypothesis** — the sync command blocks the main thread and
   everything behind it. **Experiment** — flip that one word and re-run
   the same launch. **Data** — the marker moved to 1493 ms *before* the
   restore, restore duration unchanged (1445 → 1493 ms). Confirmed. The
   crate's own `scan_blf_channels` / `fetch_trace_range` rustdoc had
   already written this rule down.

**Measured** (release build, an isolated scratchpad copy of
`examples/ev-zonal`, a synthesized 4M-frame / 180-id / 1620-by-id-file
prior capture rewritten before every launch so the reopen pays the
filter-stack toll 57.C attributed):

| | before | after |
| --- | --- | --- |
| restore itself | 1195 ms | 1493 / 1294 ms |
| RBS-loaded → interactive | **1268 ms** | **7 / 27 ms** |
| history lands | at interactive | interactive + ~1.4 s |
| launch → interactive | 7.13 s | 3.23 s |
| splash lifts (5 s floor) | 7.13 s | 5.00 s |

The RBS-loaded → interactive row is the attributable one: the last log
line before the restore to the interactive marker, unaffected by the
±1.5 s run-to-run spread in webview/sidecar startup that makes the raw
launch→interactive numbers flatter than they look. Read it as: the
restore no longer sits between the app and the user, and the same work
finishes ~1.4 s later, in the background.

**Launch → first plot**, the owner's bar, is the sum of the two halves
and only one of them was ever on the critical path: interactive (3.2 s)
+ history landing (~1.4 s) + the first-use rebuild for the plotted
signals. The rebuild is what A measured — 1.93 s for a *fully dense* 4M
id, far less for a real 180-id capture where a signal owns ~22k of the
4M frames — and it is the half that no longer risks a multi-GB spike.

**Instrumentation, a deliverable** (`db2c2dc`): the boot writes one INFO
line as it drops the splash's hold (`startup: interactive N ms after the
frontend loaded`). With the restore's existing line it brackets a launch
in `cannet.log`, which is what made the ordering above measurable at
all; before it there was nothing marking when the app became usable.

**Boot-order pins.** `App.bootOpenOnce.dom.test.tsx`'s
"automation connects only after the project has fully applied" is
unchanged in intent but now drives the delay through the DBC load
(`dbcDelayMs`) rather than the restore, and a **new, stricter** pin
states the deliberate order this phase introduces: connect lands after
the restore *resolves*, not merely after it was invoked (the mock pushes
a marker when it resolves). A third new test pins the other half — the
app logs itself interactive while the restore is still pending. The
first was red before the change.

**Docs in the same commits:** ADR 0002 DS-7 gained a paragraph on the
reload not gating the app (and on connect being what waits), the
README's splash paragraph no longer promises "up with its data",
`useSplashVisible`'s contract says what actually holds the splash, and
`signal_cache`'s module docs state the chunked scan's residency and
lock-hold bounds.
