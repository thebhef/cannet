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

## Blockers / side effects

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
