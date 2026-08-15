# Task 75 — Verification-Pass Findings on the Task-70 Chain

Owner's manual verification pass (2026-08-14, ~18:40 build carrying
the full task-70 chain) over the shipped fixes. Most items confirmed
fixed; this task captures what the pass surfaced. Groom, then work
through. (The two plot regressions from the same session — enum-lane
hover points, scroll-after-disconnect — are already captured in
task 72 §3–4.)

## Findings (owner, verbatim intent)

1. **MAJOR — scratch restore on boot is much slower, and the plot
   stops updating.** "Seems _muuuuch slower_ on at least a session's
   data that existed before task 70's work (not nearly as bad after
   closing/reopening project; maybe it's OK and we were rebuilding
   something?). In this mode, I was seeing quite a few hlines where
   there are more than one sample; maybe related? zooming in and out
   seems to be necessary to keep things actually updating. spamming
   'fit data' causes updates. Did not observe this
   unresponsiveness/lagginess during BLF streaming."
   Investigation-first, three entangled observations to separate:
   (a) restore wall-clock — the owner's own rebuild hypothesis
   (a one-time cache rebuild over pre-chain data would explain
   "not nearly as bad after close/reopen") is the first thing to
   confirm or refute; (b) plots not updating without interaction
   (zoom / fit-data forces a refresh — an update event not firing on
   the restore path, or the plot not re-fetching on data growth);
   (c) hlines where more than one sample exists — suspect
   interaction with the one-sample-hline rule: a series whose serve
   is still catching up transiently has one sample in-window and
   draws as an hline. (c) may be evidence for (b), not its own
   defect. Scientific method; no fix without the attributing
   experiment.
   **Orchestrator account (2026-08-14, from the code — supports the
   owner's rebuild hypothesis):** the pyramid scratch carries a
   `PyramidValidity` stamp (`pyramids.json`: capture id, DBC-set
   fingerprint, low-water mark) and ANY mismatch discards the
   persisted pyramids and cold-rebuilds by re-decoding raw frames —
   which `signal_cache.rs`'s own module doc budgets at minutes for a
   large session. The task-70 chain changed neither the persisted
   format nor the fingerprint computation (`app_state.rs::
   dbc_fingerprint`, `trace_store` — both untouched). The likely
   trigger is the phase-2 bleed fix itself, once: a pre-70 session
   wrote workspace-scoped state through the bleed's mis-routing, so
   the first post-fix boot can hydrate a DBC set (paths/order/
   mtimes) that no longer matches the manifest's recorded
   fingerprint → discard → one cold rebuild. After a re-import and
   reopen the manifest is rewritten under the fixed routing, and
   restores are seconds — exactly the owner's observation. The leg
   that stays OPEN regardless: during a rebuild/catch-up the plot
   only refreshed on user interaction (zoom / fit-data), where BLF
   streaming refreshes fine — establish whether the catch-up path
   emits (or fails to emit) the refresh signal streaming gets from
   `trace-grew`; the transient hlines are that stall made visible
   through the one-sample rule.
   **New observation (2026-08-14 ~22:27 local, log-attributed): a
   full hang on launch, same seam.** The owner launched onto an
   ~18.5-hour restored capture (57.7 M frames) and the UI hung until
   the process was killed (~17 min later); the relaunch restored the
   same session in 685 ms and was healthy. `cannet.log` for the hung
   launch (02:27:28 UTC): startup reached interactive in 2744 ms,
   restore completed in 642 ms (pyramids reused — no cold rebuild),
   **no errors or warnings after that**, and the host's health
   sampler ran normally to the kill (fps=0 — not connected —
   trace_len frozen, rss ~80–103 MB, one renderer spike 265→534 MB
   at 02:42 that recovered). No WebView2 crashpad dump. So the host
   was alive and the restore path fast; the hang was
   frontend/webview-side, after restore, with nothing logged. The
   investigation must find what the frontend does on first paint of
   a very large restored session that can wedge it (and why it is
   invisible to the log — a frontend-hang watchdog/log line may be a
   fix candidate). Distinct symptom from the slow-restore
   observation above (that one was a cold rebuild; this one reused
   pyramids) — same boot-restore seam, so it lives in this item's
   investigation.
   **Owner rulings (2026-08-14) on the legs:** the refresh behavior
   in that condition "should be understood and improved" —
   confirmed as this item's remaining work. The transient hlines
   "probably make sense given everything else going on" — accepted,
   no work here (task 72's extrapolation styling will make the
   state legible anyway). Overall verdict: the moment read as a 10x
   step backward but the rebuild account defuses it.
2. **Trace-open feedback, round 2** (phase-3 feedback verified
   better, three refinements):
   (a) the busy feedback disappears when data starts streaming into
   the plot panel — it should persist until the plot panel has all
   the data;
   (b) clicking the launcher while it presents feedback should
   CANCEL the import;
   (c) wording: "Scanning…" is disliked — "Loading trace" is
   clearer.
3. **Servers panel: mystery trusted row, un-forgettable.** Owner
   sees `trusted | not advertising | 127.0.0.1:65476` — an IP/port
   never entered by hand — and "I also can't forget it or change
   the token." Two legs: (a) where did the row come from —
   plausible lead: the ADR-0031 perf-gate runs on this machine
   (`--connect-on-start` against a spawned loopback server on an
   ephemeral port) writing a pin into the real per-user trust
   store; confirm, and decide whether harness connects should
   write pins at all; (b) forget / token-change failing on the row
   is a defect regardless of origin — fix test-first.
4. **Recents combobox too sticky** (pre-existing, owner: "should
   fix"): the list that appears when the button is clicked stays
   visible until the button is clicked again or something is
   selected — it should dismiss like other transient popups
   (click-outside).
5. **Recents in the command palette** — owner expected recent
   captures to be reachable via the palette and they are not.
   Establish the intended behavior (was it ever offered?); if the
   palette should list recent captures, add it. Otherwise record
   the verdict. (The empty-on-reload list itself was judged
   "probably working as spec'd" — the pre-fix merged list lives in
   whichever project's state the bleed last wrote; residue, not a
   defect.)

6. **Cold-rebuild feedback + offramp** (owner ruling, 2026-08-14):
   when a restore triggers the cold pyramid rebuild, the user gets
   (a) **feedback** that it is happening — today it is silent and
   reads as the app being broken ("seemed like we took a 10x step
   backward, in the moment") — and (b) an **offramp**: an
   affordance to discard the stale session data instead of paying
   the rebuild — "some way for them to say 'just delete that
   shit'." Grooming decides the surface (status chip like the
   trace-open feedback, with a discard action beside it) and what
   exactly discard drops (the pyramids alone rebuild anyway — the
   offramp presumably drops the whole restored capture).

## Process notes

- Item 1 is the priority and is investigation-first; its verdict may
  bear on whether the task-70 chain merges as-is (the owner's
  rebuild hypothesis, if confirmed as a one-time cost, likely
  defuses it).
- Item 2 is groomed refinement work on the phase-3 seam (guard ref +
  pending state + status chip); cancel needs a cancellation path
  through the scan command.
- Confirmed-fixed in the same pass, for the record: project-view
  alignment, disclosure sizing, chrono caret removal, dock-tab
  title, Ctrl+P "DBC", plot dropdowns, file-backed MDF signals,
  long-capture live edge. Palette aliasing confirmed reusable
  (`keywords` on commands and goto views, folded into the fuzzy
  match) — no architecture follow-up needed.

## Exit criteria (draft — firm at grooming)

- Item 1: all three observations attributed with data; the restore
  slowness either confirmed one-time (recorded, owner-accepted) or
  fixed; plots update during restore without user interaction;
  transient hlines explained by the attribution (and eliminated or
  ruled cosmetic by the owner).
- Item 2: busy feedback persists until the plot has the imported
  data; clicking the busy launcher cancels the import (tested);
  label reads "Loading trace…".
- Item 3: the mystery row's origin named with evidence; harness
  pins ruled on; forget and token-change work on every row state,
  regression-tested.
- Item 4: the recents popup dismisses on click-outside, tested.
- Item 5: verdict recorded; palette lists recents if ruled in,
  tested.
- Item 6: a cold rebuild announces itself while it runs, and offers
  a discard action that drops the stale session instead; both
  tested (the discard leaves a clean empty session, not a
  half-deleted scratch).

## Status log

### 2026-08-14 — item 1 leg (b): plots don't refresh during a rebuild

**Observation.** Owner, on a boot restore that cold-rebuilt the
pyramids: "zooming in and out seems to be necessary to keep things
actually updating. spamming 'fit data' causes updates. Did not observe
this unresponsiveness/lagginess during BLF streaming."

**Hypothesis.** The plot's re-request of a partial (ADR 0049) serve is
carried by the per-area self-paced resample loop, and that loop runs
only while the trace is _running_. A restored capture is stopped
(`trace.ts::restoredTrace` → `traceStatus` = `"stopped"` →
`PlotPanel.tsx:504 const live = trace.status === "running"` = `false`
→ `PlotArea.tsx` loop effect returns early), so on the restore path
nothing continues the prefixes a rebuilding cache serves. BLF
streaming is unaffected because the trace is running throughout.

**Experiment.** Two new component tests in `PlotPanel.dom.test.tsx`,
against the existing `mockSampleRebuild` fake host (one more point per
serve, `complete = false` until the last), with the panel's element
seeded as a **stopped** trace (`{start: 0, end: 60}`) — the shape
`restoredTrace` produces. No user interaction is performed. Falsifiable:
if anything continued the catch-up, the drawn point count would reach
the host's full answer.

- `paints each partial answer on a stopped trace too, with no user
  interaction` — 30 prefixes on offer.
- `stops re-sampling a stopped trace once the host reports it caught
  up` — 3 prefixes, then the round-trip count must go quiet.

**Data.** Before the fix: expected 30 drawn points, **received 2**.
The second test: expected 3, **received 2**. A stopped panel makes
exactly two real serves at mount (the construction effect's one-shot
plus its rAF follow-up) and then stops forever; the remaining 28
prefixes are never requested. The running-trace sibling test (`paints
each partial answer as the rebuild advances`) passes throughout, which
is the BLF-streaming half of the owner's report reproduced as the
control.

**Conclusion (attributed).** The defect is an ADR-0049 violation on the
stopped-trace path: the ADR's "the view re-requests; it does not poll"
is implemented only by a loop gated on `live`. A restored capture is
stopped by construction, so a cold pyramid rebuild under one leaves the
first prefix on screen until a gesture bumps `xEpoch` (pan/zoom, Fit
Data, goto-event) — exactly the owner's workaround.

This also explains observation (c), the transient hlines: a prefix
holds one sample in-window for a series the catch-up has not reached,
and the one-sample-hline rule draws it flat. They are the stall made
visible, not a separate defect — matching the owner's ruling that they
are accepted and need no work here.

**Fix.** `PlotArea.tsx` latches the host's completeness token into a
`catchingUp` state and the resample loop runs on `live || catchingUp`.
The latch clears on the token, so a frozen capture with nothing left to
decode still stops dead — pinned by the second test. Landed with the
tests. Frontend suite: 158 files / 2092 tests green; `pnpm build` clean.

### 2026-08-14 — item 1 leg: hang visibility (host-side watchdog)

**Observation.** The 22:27 hang left `cannet.log` with nothing to read:
startup interactive in 2744 ms, restore 642 ms with pyramids reused, no
errors or warnings afterwards, and health samples continuing at their
normal cadence right up to the kill ~17 minutes later.

**Why the log was silent.** Every field the health sample carries —
`trace_len`, `fps`, `rss_mb`/`tree_mb`/`webview_mb`, `sys_avail_mb`, the
scratch breakdown — is the **host describing itself**, and the host was
fine. The one number that originates in the renderer, `jsheap_mb`, is
pushed by the frontend's 1 Hz diag reporter through `report_js_heap`;
the host stored the value but not the _time it arrived_, so a frontend
that stopped pushing was indistinguishable from one pushing an unchanged
figure.

**Change (host-side).** `crash.rs` stamps every `report_js_heap` arrival
as a UI liveness heartbeat — the reporter runs on the renderer's main
thread, so a wedged one cannot issue it. The health sample gains
`ui_last_ms=<age>` (`?` when the frontend has never reported), and
`ui_liveness` turns the age into a once-per-episode verdict: a `warn`
line naming the stall when the beat has been missing for
`UI_HEARTBEAT_STALL_MS` (5 s, five beats), and an `info` line when it
returns. Both are above the level a bug report filters away; the sample
trail underneath keeps showing when the stall began.

One frontend line changes with it: the heartbeat now goes out even where
`performance.memory` is absent (WebKitGTK / WKWebView) — the heap number
is then `0`, which the host already reads as "no reading" and does not
store. Without that the watchdog would have been inert everywhere but
Windows. Pinned by `diag.heartbeat.test.ts`, which failed 0-of-3 beats
before the change.

Tests: `crash::tests::health_message_reports_how_stale_the_ui_heartbeat_is`
and `..::the_ui_stall_verdict_fires_once_per_episode_and_clears_on_recovery`
(both written failing first). Host suite 642 passed / 6 ignored, clippy
clean; frontend 159 files / 2093 tests.

**Note on scope.** This is a _visibility_ change, not an attribution. It
does not explain the 22:27 hang; it makes the next one legible from
`cannet.log` alone, and distinguishes "the host died" from "the window
stopped responding" without a debugger attached.

### 2026-08-14 — item 1 leg: the 22:27 launch hang — bounded non-reproduction

Not attributed. What follows is what the evidence **rules out**, with
the experiment behind each, so the next attempt starts narrower.

**Observation (from the task file's log account).** 57.7 M frames
(~18.5 h) restored in 642 ms with pyramids reused; startup interactive
at 2744 ms; no warning or error afterwards; health samples continuing at
their normal cadence until the kill ~17 min later; host rss 80–103 MB;
one renderer excursion 265 → 534 MB at 02:42 that recovered; no WebView2
crashpad dump.

**Ruled out — a host command holding the trace-store lock.** The obvious
suspect was the restore-widened window driving a non-chunked
`latest_in_window` pass: `useByIdView` / `useSignalView` send
`scanEnd = winEnd` (not the live tip) whenever the trace is _stopped_,
and a restored trace is stopped. Two data points kill it.
_(i)_ `TraceStore::latest_in_window_where` takes the fast O(keys) path
whenever `end == raw.len()`, and on a fresh restore `winEnd` **is** the
restored frame count, i.e. exactly `len` — the window scan is not
entered at all.
_(ii)_ Decisive regardless of _(i)_: `TraceStore::len`,
`buffer_seconds`, `frames_per_second` and `scratch_breakdown` all take
the same `lock_inner()` mutex that a window scan would hold for its
duration — and every one of them is read by the health sampler on each
tick. A host command sitting on that lock would have **stalled the
health samples**, and the log shows them arriving normally for the whole
17 minutes. The same argument clears `fetch_filtered_trace`, whose index
extend chunks its own locking.

**Ruled out — an O(capture) walk in the trace viewport.** The one
capture-length walk in `traceViewport.ts` (`expandedExtraHeight`) is
reachable only from `ByIdTable`, whose `count` is id space;
`TraceView` uses `expandedExtraHeightOf`, which costs one iteration per
_expanded row_. Likewise `gridviewSelection`'s O(count) `selectionOrder`
is overridden in `TraceView` to the render window.

**Ruled out — any _finite_ O(capture) pass on the UI thread.** Measured
on V8, at the observed 57.7 M: an accumulate-per-row loop takes
**107 ms**; pushing every index into an array takes **1017 ms** and
~460 MB; a `Set`-union-then-sort (the `mergeSeries` shape) over 2 M
takes **1199 ms**, so ~35–60 s extrapolated to 57.7 M — and at that size
it exhausts the heap rather than finishing. Nothing in that family
produces 17 minutes of unbroken unresponsiveness. A single pass would
have completed, and a fatal one would have left a crashpad dump; neither
happened.

**What the shape does say.** Seventeen minutes with no completion and no
death is a **non-terminating loop or a deadlock on the renderer's main
thread**, not slow work. The renderer's 265 → 534 MB excursion that
_recovered_ fits that too: a ~270 MB allocation churned and collected
repeatedly is a loop re-doing large work, where a single pass would show
one step and a plateau.

**Standing lead, unconfirmed.** The plot's x-sync ring — `applyXAll`
→ uPlot's `setScale` hook → `onUserXChange` → `applyXAll` — is the one
identified cycle on that thread. It is guarded twice (the
`xSyncRef.suppress` window and an equality check against the shared
window), and `PlotPanel.tsx` already carries a `plot.userXChange` DIAG
counter placed, in its own comment, to catch this ring "during the
freeze" — so the symptom has been suspected here before. A restore is
the case that puts every area through a full-span programmatic window
change at mount, which is when a missed suppression window would bite.

**Why it stops here.** Reproducing it needs the ring driven by _real_
uPlot: the jsdom double fires hooks only when a test explicitly asks it
to, so the cycle cannot close in the component suite, and a synthetic
capture at this scale plus an isolated-app-data GUI launch is a bigger
lift than the remaining budget. The watchdog above is what makes the
next occurrence cheap to attribute: `ui_last_ms` climbing while the host
stays healthy confirms the class in one log line, and `diag.ts`'s burst
path (`lag` / `longtask` / `plot.userXChange`) distinguishes a spinning
render loop from a thread blocked on IPC without attaching a profiler.

**Recommended next step (not done here):** rerun with the diag reporter
capturing and, on the next hang, read `plot.userXChange` and
`userx.setscale-hook` — a non-zero delta with no user input names the
ring directly.

### 2026-08-14 — item 2: trace-open feedback, round 2 (all three refinements)

Branch `task75-p2-trace-open-feedback`, off `task75-p1-restore-refresh`.

**(a) Persistence.** The census-phase busy signal (toolbar button +
status chip, from phase 3) always ended when the census resolved —
before the mapping dialog even opened, let alone before the pump that
actually loads the capture ran. `state.kind === "loading"` is the
frontend's existing completion fact for that pump: it's set once
`open_log`/`import_mdf` resolves (right after the host spawns the pump
thread) and only clears on the pump's own `log-finished` — the "existing
completion fact" the task pointed at, reused rather than inventing a new
event. The launcher/chip now go busy for this state too, as a second
sub-phase alongside the unchanged census one.

**(b) Click-to-cancel.** Host: `open_log`/`import_mdf` install a real
`Arc<AtomicBool>` into a new `AppState::import_cancel` slot before
spawning their pump (replacing the never-set placeholder `run_pump` was
always handed), and a new `cancel_import` command flips it — the same
cooperative shape `disconnect_remote_server` already uses via
`remote_sessions`'s per-session `stop` flag. Scoped to the pump phase
only, not the census: a census is one opaque `cannet_blf::scan_blf` /
`cannet_mdf` call with no per-iteration checkpoint to interrupt, so it
stays plain-disabled as phase 3 left it. Frontend: `handleImportTrace`
routes a click during `state.kind === "loading"` to `cancel_import`
instead of starting a second import. The pump's cancelled exit is
indistinguishable on the wire from a natural one (both emit
`log-finished: Ok`), so `importCancelledRef` — set the moment cancel is
requested — is what the `log-finished` listener checks to tell the two
apart; on a cancelled completion it resets to idle and re-runs
`resetSession()` (the same host clear a fresh open runs before
starting) instead of presenting the partial frames as "Done: N frames".

**(c) Wording.** Toolbar label "Scanning…" → "Loading trace…" (now
shared by both busy sub-phases); `statusLine.ts`'s two "Scanning
`<path>` …" resting lines → "Loading `<path>` …". Grepped the frontend
source for remaining "Scanning" text after the change — none left
outside internal variable/state names (`scanningBlfPath` etc., not
user-facing).

**Tests (written failing first).** Host:
`cancel_import_now_is_a_no_op_with_nothing_importing`,
`cancel_import_now_flips_the_registered_flag`, and
`a_cancelled_import_stops_the_pump_loop_early_leaving_the_frames_already_ingested`
— the last replicates `run_pump`'s per-frame loop body (the suite has
no `AppHandle` harness for calling `run_pump` itself) against a real
BLF and `TraceStore`, cancelling mid-file and asserting the frames kept
are exactly the ones ingested before the flag flipped. Frontend: new
`App.traceOpenCancel.dom.test.tsx` (persistence through a `trace-grew`
tick, and the full cancel round-trip: cancel invoked, no second import
started, `clear_trace_store` re-invoked, UI back to idle with no "Done:"
notice, a subsequent open works). Updated wording assertions in
`App.importTraceGuard.dom.test.tsx`, `App.blfScanNotice.dom.test.tsx`,
`App.mdfScanNotice.dom.test.tsx`, `statusLine.test.ts`. Also updated
`App.recentsScope.dom.test.tsx`'s `importCapture` helper to fire
`log-finished` after each import — with feedback now persisting past
the mapping-dialog step, that test's second import needs the first
one's completion signaled to get the launcher back to idle, exactly the
new behavior working as intended.

Commits: `983068d7` (host cancellation path), `d21f969c` (frontend
persistence + cancel + wording). Host: 645 passed / 6 ignored, clippy
clean. Frontend: 160 files / 2095 tests, `pnpm build` clean.

### 2026-08-14 — item 3 leg (a): the mystery row is the GUI's own sidecar

Branch `task75-p3-trust-row`, off `task75-p2-trace-open-feedback`.

**Observation (raw).** Owner's Servers panel carries
`trusted | not advertising | 127.0.0.1:65476`, an address never typed
in. Two leads were on file: an ADR-0031 perf-gate run writing a pin into
the real trust store, and the owner's own reading that 65476 smells like
a _client_-side ephemeral port — a peer address recorded as if it were a
server identity.

**Evidence read (read-only) from the owner's real state.**

- `%APPDATA%\dev.cannet.app\servers.json` holds **exactly one entry**,
  `10.10.10.50:50051` (a routable LAN server, pinned with a token). No
  loopback key of any kind. File mtime `2026-08-14 09:07:03 -0700`.
- `%LOCALAPPDATA%\dev.cannet.app\logs\cannet.log` contains 14 lines
  naming 65476. The first is
  `2026-08-15T01:45:35.215Z INFO sidecar:python-can: listening on
  127.0.0.1:65476`, eleven lines after
  `01:45:33.815 … starting sidecar via frozen binary`. The rest are
  `connection: connecting to / connected to / clock offset vs /
  disconnected from 127.0.0.1:65476` between 02:17:59Z and 02:24:26Z.
- The same log carries **104 distinct** `listening on 127.0.0.1:<port>`
  lines — one per launch, all in the Windows ephemeral range.
- Machine local time is UTC-7, so the launch that bound 65476 was
  **2026-08-14 18:45:33 local** — the ~18:40 build of the owner's
  verification pass.

**Hypothesis.** The row is the GUI's own python-can sidecar: it binds
`127.0.0.1:<OS-assigned port>`, a bus bound to local hardware dials it,
and the resulting session is what puts the address in the panel — with
nothing stored behind it.

**Experiment.** Read the three sources `server_list::build` merges and
test the one that can hold a loopback address with an empty store. New
unit test
`a_live_session_against_a_loopback_sidecar_mints_a_trusted_row_storing_nothing`
feeds `merge` a clock summary for `127.0.0.1:65476` and _nothing else_
— no discovery, no trust entry, no prompt — and asserts the whole row.
Falsifiable: if a session could not mint a row, or if such a row were
`new` rather than `trusted`, the assertion fails and the hypothesis
dies.

**Data.** The row comes out `address 127.0.0.1:65476`, `trust trusted`,
`name None` (which the panel renders as the literal string
"not advertising"), `online false`, `fingerprint None`,
`has_token false`, `insecure false`, `manual false` — character for
character what the owner is looking at. The mechanism is `merge`'s third
source: `for key in clocks.keys() { rows.entry(key).or_insert_with(||
offline_row(key, &TrustEntry::default())) }`, and `trust_state` returns
`Trusted` for it because `connect_flow::needs_trust` is false on a
loopback address (`plan` → `Attempt::Plaintext`, ADR 0041's local path).

**Conclusion (attributed).** The row is the app's own sidecar, held in
the list by a live capture session against it, storing nothing. It is
**transient**: `session.rs` unregisters the session when the pump exits
or the user disconnects, and `clock_status`'s 1 Hz poll republishes the
list the moment the summary map changes, so the row leaves with the
session and comes back — at a _different_ port — on the next local
capture.

**Both recorded leads are refuted, with the data that kills each.**

1. _Harness pin._ `servers.json` has no loopback entry at all, and its
   mtime (09:07 local) predates the 18:45 launch that bound 65476 by
   nine hours — nothing was written for it. Nor could it have been: the
   only writers are the trust dialog's commands and `add_server`'s
   `manual` flag, and a loopback connect reaches neither (no question is
   raised, and the harness never calls `add_server`). A
   `--connect-on-start` run mints the same _transient_ row an operator's
   click does, and persists nothing. **Harness connects do not write
   pins, and no code change is needed to keep it that way.**
2. _Client-side ephemeral port._ `sidecar:python-can: listening on
   127.0.0.1:65476` is the sidecar announcing its own **listen** socket
   (it binds port 0, hence the ephemeral range), and the host then dials
   that address. No socket's local end is being mistaken for a peer's.

**What the owner should do about their row: nothing.** There is nothing
stored to delete, and the address is dead the moment that session ended.
It reappears on every local-hardware capture, at whatever port the OS
hands the sidecar that launch.

**What is left as this item's defect** is leg (b): the panel offers no
action at all on a row like this, which is what made an ordinary
transient row read as an unremovable mystery.

### 2026-08-14 — item 3 leg (b): an action on every row

**Observation.** Owner: "I also can't forget it or change the token."
Both affordances are _absent_ on the row, not failing.

**Attribution (from `ServersPanel.tsx`, before the change).** Two
conditions, each gated on what the trust store happens to hold:

- `{row.fingerprint !== null && <button …>Token…</button>}`
- `{stored && <button …>Forget</button>}`, where
  `stored = fingerprint || hasToken || insecure || manual`.

A sidecar row holds none of them, so neither button is rendered. The
same gates cost more than the owner's row: a server with a **token
stored but no pin** (a real state — `server_list.rs`'s
`a_stored_token_on_its_own_is_not_trust` pins it) renders _Forget_ but
not _Token…_, so the credential in `servers.json` cannot be replaced or
cleared except by dropping everything.

**Change.** Both buttons render on every row. The store's contents now
decide only wording, never whether the action exists. Because a _Forget_
that drops nothing must not be a button that visibly does nothing, the
panel answers instead: `nothingStoredNote(row)` (in `serverList.ts`)
names what is keeping the row in the list — it is advertising, or a
session is connected to it and the row leaves when that session ends.
Those are the only two possibilities: a stored entry is never empty
(`update_server` removes an emptied one), so a row the store does not
hold came from one of the merge's other two sources.

**The security rule this leans on is the host's, and now has a test.**
Offering the token field on a row reached in the clear could look like
a way to put a credential on an unencrypted channel. It is not:
`connect_flow::plan` returns `Attempt::Plaintext` for a loopback address
and for an accepted-unprotected one _whatever the entry holds_, and
`Attempt::Plaintext` carries no token —
`a_token_stored_against_an_address_reached_in_the_clear_is_never_carried`
now pins that in the plan, which is where ADR 0041 §S7's rule belongs
rather than in which buttons a panel draws.

**Tests (the two that encoded the overruled assumption were rewritten,
and failed first — 4 failing / 2094 passing before the change).**

- `asks nothing about a server it reaches without asking, but still acts
  on it` (was `offers no trust actions …`) — _Trust…_ is still absent on
  a loopback row (there is no identity to accept), _Token…_ and _Forget_
  are not.
- `forgets a server` (was `forgets a server, and offers that only where
  something is stored`) — and asserts no note appears when something
  _was_ stored.
- `changes the token on a row that has one without a pin` — the trap
  above, clearing the token through the field.
- `says what keeps a row in the list when forgetting it stored nothing`
  — the owner's row exactly (`127.0.0.1:65476`, trusted, nothing
  advertising it, a clock from the live session): _Forget_ invokes
  `forget_server` and the panel says a session is connected to it.
- `says an advertising row is held by the network, not the store`.
- Three unit tests over `nothingStoredNote` in `serverList.test.ts`.

README's Servers-panel paragraph gains both facts in the same commit:
that every row carries both actions, and that a
`127.0.0.1:<high port>` row nobody typed in is the app's own sidecar.

Host: 647 passed / 6 ignored, clippy clean. Frontend: 160 files / 2101
tests, `pnpm build` clean.

### 2026-08-14 — item 3 leg (c): a performance run gets its own user scope

The owner's standing ruling, implemented even though leg (a) cleared the
harness of writing the pin it was suspected of: a measurement must not
write the operator's state at all.

**The seam.** Everything the app keeps per user goes through one
function — `persisted_json::config_dir` — and a grep over `apps/` and
`crates/` finds exactly one call to Tauri's `app_config_dir()`, inside
it. So one override covers the trust store, the project registry and
recents, both scoped settings files and user-scope UI state at once, and
no read path anywhere else learns that a run is under way. `--app-data-dir
<path>` sets it; `ConfigDirOverride` carries it as managed state,
registered on the builder so it is in place before `setup` resolves the
project directory.

Window geometry rides along by a narrower route: `tauri-plugin-window-
state` resolves its document as `app_config_dir().join(name)` and offers
no way to set the directory — but an absolute `name` replaces that join,
so `window_state_filename` hands it a full path under the override.
The launch creates the directory up front, because the plugin creates a
parent for the real location only.

**Explicitly not done — no special case in the trust logic.** "A
loopback connection doesn't pin" was rejected by the owner and stays
rejected: it would change what the product does to suit a test rig.
`connect_flow` is untouched by this phase.

**Deliberately not moved: the rolling log and crash records.** They are
the run's evidence, and ADR 0031's own troubleshooting instructions
(and every bug report) expect them in the usual place.

**Tests (written first).** `a_normal_launch_has_no_config_dir_override`
(no flag, an unrelated flag, argv[0] spelled like the flag, and the flag
with no value — the last must not point the session at an empty path),
`the_override_is_the_path_the_flag_names`, and
`the_window_state_document_follows_the_override_and_nothing_else` (which
failed first on Windows for the right reason: a `/tmp`-rooted path is
not _absolute_ there, so the plugin's join would not have been
replaced — the assertion now builds the path in the platform's own
spelling).

**What is verified, and what is not.** The parsing and the filename
mapping are unit-tested; that one override reaches every user-scope file
rests on the single-call-site grep above. A launch of the app with the
flag was **not** run: if the override failed, the run would write the
owner's real state, which this phase is forbidden to do — and the first
harness run after merge is the check, at zero risk (a flag that did
nothing would leave the isolated directory empty).

ADR 0031 gains the flag in its flag list and a consequence recording the
rule, the two things to run with (a fresh directory starts from default
settings; reuse one directory across runs being compared), and why the
log stays put. README's self-driving section puts `--app-data-dir` in
the example invocation and says to use it for every run.

Host: 650 passed / 6 ignored, workspace clippy clean.

### 2026-08-14 — item 4: the recents popup dismisses like every other one

Branch `task75-p4-recents`, off `task75-p3-trust-row`.

**The mechanism.** `App.tsx`'s Recent-captures toolbar dropdown was a
native `<details>`/`<summary>` pair — no React state, and no
outside-click behavior either: it closes only on a second click of the
summary or on picking an entry, unlike every other floating menu in the
app (context menus, the measurements picker), which dismiss on an
outside click or Escape through the shared `useDismissableMenu` hook.
Converted the dropdown to plain `open` state plus that hook rather than
inventing a bespoke handler — the task's own instruction to prefer the
shared mechanics over something new. The `<details>`/`<summary>` markup
becomes a `<div ref={…}>` with a `<button>` trigger and a
conditionally-rendered `<ul>`; CSS selectors and the four existing
tests that queried `details.recent-captures > summary` follow the
markup change (`.recent-captures > button`).

**Tests (written failing first).** New `describe("Recent captures —
dismissal (task 75 item 4)")` in `App.importTrace.dom.test.tsx`: closes
on an outside `mousedown` without opening anything (guards against a
click-through actually importing something), closes on Escape, and a
`mousedown` *inside* the menu does not dismiss it (the hook's own
`ref.current.contains` guard, exercised through the real toolbar
markup, not just the hook's own unit test). All three failed against
the unconverted `<details>` markup (no `.recent-captures-menu` visible
after "closing" was even meaningful to assert, since it never left the
DOM under `<details>`).

Frontend: 160 files / 2108 tests, `pnpm build` clean. Commit `87184399`.

### 2026-08-14 — item 5: recent captures reachable from the command palette

**Investigation answer (git history).** `git log --all -p -S"recentCaptures" -- apps/gui/src/commands.ts apps/gui/src/useCommands.tsx`
returns nothing — the recents list was never wired into the palette at
any point in history. Confirms the expected answer: this is new
behavior, landed only because the owner ruled it in.

**The wiring.** `useCommands.tsx` gains two new `UseCommandsOptions`
fields — `recentCaptures: readonly string[]` and `openRecentCapture:
(path: string) => void` — both passed straight through from `App.tsx`'s
existing `recentCaptures` state and `handleImportTrace`, the same state
and the same call the toolbar button already uses. No second source: a
`recentCaptureCommands` memo maps each path to `{ id:
"recent.open:<path>", path, label: "Open recent: <basename>" }`
(`basename` promoted from `windowTitle.ts`, which already had one for
the window-title capture label); the ids are registered into
`commandHandlersRef` as `() => openRecentCapture(path)` alongside the
static command handlers, and the same entries are folded into
`commandPaletteItems` with `hint: "Recent"` and `keywords: path` — the
full path, so a directory fragment finds the entry even though the
label shows only the filename, the same fold-into-fuzzy-match field a
renamed command or view already uses to stay reachable by an old name.
An empty `recentCaptures` list produces an empty memo, so the palette
gets no entries — no special-casing needed.

**Tests (written failing first).** New `describe("Recent captures —
command palette (task 75 item 5)")` in `App.importTrace.dom.test.tsx`:
each recent capture lists as its own command; filtering by a directory
fragment (`"old"` in `/old/legacy.blf`) finds it while a sibling entry
in a different directory does not — the case that specifically
exercises `keywords` rather than the visible label; selecting an entry
through the palette (type, Enter) drives the real `scan_blf_channels`
call with the recent path, the same as clicking the toolbar entry;
and an empty recents list contributes no "Open recent:" commands. A
pre-existing direct `useCommands(...)` call in
`SignalsPanel.gridview.dom.test.tsx`'s harness needed the two new
required fields (`recentCaptures: []`, `openRecentCapture: () => {}`)
to keep building — the only other call site.

Frontend: 160 files / 2108 tests, `pnpm build` clean. Commit `ae518d9e`.

### 2026-08-14 — item 6: a cold rebuild announces itself, and offers a way out

Branch `task75-p5-rebuild-offramp`, off `task75-p4-recents`.

**The fact, and who owns it.** A restore that fails ADR 0047's validity
check wipes the persisted pyramids, and the wipe is the last trace of
them: nothing downstream can tell "these caches were thrown away" from
"this capture never had any". So the discard is recorded where it
happens. `SignalCacheStore::restore` sets a latch when it was offered
DBC-backed rows and took none over a capture that came back with frames;
`rebuilding(store_len)` reports it until the caches that replaced them
have decoded to the tip, and clears the latch when they have.
`clear` — the same call a fresh open and the offramp make — drops it
with everything else. The frontend never infers any of this: the host
returns `pyramids_rebuilding` from `restore_scratch_capture` and answers
`signal_pyramids_rebuilding` afterwards.

**Why a queryable fact and not an event.** The rebuild is lazy and
per-signal (ADR 0049): it runs inside plot serves, so "it finished" is
not a moment the host passes through — it is a property of where the
decode cursors have reached. The chip polls that property once a second
and only while it is up; a session that is not rebuilding issues no poll
at all (pinned by a test).

**The surface.** The status line grows the same indeterminate chip the
trace-open census uses (`.trace-scan-bar`, phase 3's affordance reused
rather than a second one invented), labelled **"Rebuilding signal
caches…"**, with **Discard** beside it. The restore's system-log line
says it too, at info — a rejection previously left the log reading
"restored N frames in 600 ms" with the minutes that followed unmentioned.

**The offramp is the existing clear, not a new deletion path.** Discard
calls `resetSession` with Clear's own error policy, which invokes
`clear_trace_store`: `start_session` (raw store, its segments and reopen
manifest, the derived file and the scratch identity) plus
`restamp_scratch_for_capture` (signal caches, notes, filter index) plus
the verification runtime. Nothing new deletes anything. **No new
cancellation was needed either**, and this was checked rather than
assumed: a rebuild is already abandonable mid-flight — it decodes off
the cache lock and drops a chunk whose generation no longer matches
(ADR 0048), which the pre-existing
`the_exit_path_does_not_wait_for_a_cold_rebuild` pins — and the clear is
one of the paths it yields to. The frontend adds only what the clear
does not own: `firstIndex` / `firstIndexTsNs`, the restored capture's
eviction mark, which an empty session cannot have.

**Tests (the falsification was run, not assumed).** Host, written
failing first, in `signal_cache.rs`: a reused set and a restore with
nothing staged announce nothing; a discarded set announces _before any
serve has run_ and stops once the rebuild has caught up; a clear ends
the announcement and leaves the root empty. In `trace_store/flush.rs`,
`discarding_a_restored_session_leaves_nothing_for_the_next_launch` — the
exit criterion's "clean empty session, not a half-deleted scratch",
checked from the next launch's side: the identity gate opens on the
restamped scratch and finds an empty capture, with no derived residue.
In `tests.rs`, an ordinary session (nothing restored, then frames
arriving live) is never rebuilding — the fast-path silence.

Frontend, new `App.rebuildOfframp.dom.test.tsx` (8): the chip appears on
a discarding restore and on nothing else (a reused set and a
`count == 0` restore are both silent); it goes down on the host's answer
rather than a timeout; a non-rebuilding session never polls; Discard
invokes `clear_trace_store`, leaves Clear and Save-capture disabled (an
empty session, observably), takes the chip down, stops the polling, and
keeps the project open (`close_project` never invoked, the window title
still the project's). Falsification: with the chip's render condition
forced false, 5 of the 8 fail.

Docs in the same commits: ADR 0047 gains a decision paragraph ("a
rejection is announced, and the user may decline to pay for it") and a
consequence; README's capture-survives-a-quit paragraph names the chip,
what the rebuild is, and exactly what Discard drops and keeps.

Commits: `1c67c64a` (the cache-layer fact), `dcd5715f` (the restore's
answer + the query command), `4fb96128` (chip, offramp, docs). Host: 656
passed / 6 ignored, clippy clean. Frontend: 161 files / 2116 tests,
`pnpm build` clean.

## Blockers / side effects

- **Latent, out of scope for item 1: the by-id / signal window scan on
  a large stopped capture.** `useByIdView` and `useSignalView` pass
  `scanEnd = winEnd` whenever the trace is stopped, and
  `latest_in_window_where` only takes its O(keys) fast path while
  `end == raw.len()`. On a _fresh_ restore those are equal, which is
  why this is not the launch-hang mechanism (see the status log). But
  the moment the window stops covering the tip — a Clear, a Start, a
  re-anchor — a stopped 57.7 M-frame capture takes a full O(buffer)
  pass **holding the trace-store append mutex**, blocking every other
  command and the health sampler with it. It is once per descriptor
  change by design, but the design was sized before captures this
  long. Noted here rather than fixed: it is not item 1's defect, and
  the fix (chunk it, or bound the snapshot the way the pyramid
  catch-up is bounded by ADR 0049) is its own piece of work.

- **The screenshot harness still launches the GUI against real user
  state** (item 3 leg (c), out of this phase's reading of the ruling).
  `cannet-perf-measurement`'s eyeball-review capture spawns the app
  itself (`screenshot.rs::spawn_gui`, `--project` only), so it writes
  recents, the project registry and the last-opened pointer for every
  run. Passing `--app-data-dir` there is five lines, but it is not a
  free change: an isolated profile starts from **default settings**,
  and the theme those captures are taken in is a user-scope setting —
  so the dark/light run pair would need the theme set inside the
  isolated profile before the flag can go in. Left for whoever owns
  that tool's determinism story; the ADR-0031 self-driving run, which
  is what the ruling named, is isolated.
- **The Servers panel lists the app's own sidecar while a local capture
  is connected** (item 3 leg (a), recorded rather than changed). It is
  a real session against a real address and the row is honest about it
  — it even carries the clock offset the session measured — but it is
  an implementation detail of local-hardware access appearing among the
  servers a user manages, at an address that changes every launch. The
  panel now explains it (leg (b)) and README names it. Whether such a
  row should be there at all is a product question for the owner, not
  something to decide inside a defect fix.

- **The rebuild chip has no natural end on a session with no plot open**
  (item 6, accepted rather than fixed). `rebuilding()` reports the
  rebuild as owed while no DBC-backed cache exists at all, because the
  samples genuinely are gone and the first serve over any signal will
  re-decode the capture. The consequence is that a discarding restore in
  a workspace with no plot panel keeps the chip up until the user opens
  one or hits Discard — honest about the state, but the wording implies
  work in progress. The alternative (treat "no cache yet" as caught up)
  is worse: the chip would clear a frame after appearing, before the
  first serve had run. A third reading — end the chip on the frontend's
  own aggregate of every plot area's `catchingUp` — needs a context
  across all areas and has the same corner from the other side.
- **The chip can clear early under one interleaving** (item 6). If one
  plot area's signals catch up before another area has created its
  caches, the poll sees nothing behind the tip and takes the chip down
  while the second area is still cold. Areas mount together on a restore
  and serve on the same self-paced loop, so the window is roughly one
  tick wide, and the cost is a chip that ends early rather than a wrong
  plot. Recorded rather than papered over with a debounce.
- **Clear leaves the frontend's eviction mark stale** (noticed from item
  6, pre-existing, not changed). `useSessionReset` re-anchors the
  windows, the session clock and the count, but not `firstIndex` /
  `firstIndexTsNs` — so after a Clear over a restored, truncated capture
  the frontend still believes history was dropped below index N, until a
  `trace-grew` tick corrects it (and a cleared session that is never
  started gets none). The discard offramp resets them at its own call
  site; folding them into `useSessionReset` would change Clear, Connect,
  BLF-map-confirm and New alike, which is its own change.

## Exit-criteria walk (2026-08-14, orchestrator, end of phase 5)

- **Item 1 — MET.** All three original observations attributed:
  (a) restore wall-clock = the one-time cold rebuild after the
  phase-2 bleed fix (owner-accepted; and now announced with an
  offramp, item 6); (b) plots-not-updating = the resample loop gated
  on `live` with no mechanism on a stopped trace — fixed test-first
  (phase 1, `catchingUp` latch); (c) transient hlines = (b) made
  visible through the one-sample rule — accepted as cosmetic by
  owner ruling. The added launch-hang observation ended in a
  bounded non-reproduction (finite O(capture) passes ruled out with
  measurements; non-terminating-loop shape remains, x-sync ring
  lead recorded) with the UI-liveness watchdog landed so the next
  occurrence is diagnosable from the log.
- **Item 2 — MET (reading recorded).** Feedback persists through
  the whole import (census + pump, ends at `log-finished`), cancel
  works and is tested through the host's cooperative flag, label
  reads "Loading trace…". Reading: "the plot has the imported
  data" was implemented as import completion; the plot's residual
  catch-up after `log-finished` is covered by phase 1's loop. If
  the chip still ends visibly early on a very large file, extending
  it to the serve-completeness token is the recorded follow-on
  seam.
- **Item 3 — MET.** Origin named with decisive evidence (the app's
  own python-can sidecar's per-launch ephemeral listen port; both
  recorded leads refuted; nothing stored, nothing to clear).
  Harness pins ruled on: none are written; `--app-data-dir`
  isolation landed regardless per the ruling. Forget/token-change
  now render and work on every row state, regression-tested.
- **Item 4 — MET.** Popup converted to the shared
  `useDismissableMenu`; click-outside and Escape tested.
- **Item 5 — MET.** Verdict recorded (palette recents were never
  offered; new behavior by ruling). One "Open recent" command per
  MRU entry, same source and open path as the button, path in
  `keywords`; tested including the empty-list case.
- **Item 6 — MET.** The rebuild announces itself (latched host
  fact, polled chip) and Discard drops the capture through the
  same clear a fresh open runs; both directions tested, including
  clean-empty-next-launch and the silent fast path.

Three recorded side effects stay open in Blockers / side effects
(chip without a plot open; one-tick-early clear; `useSessionReset`
eviction-mark gap) — none blocks the criteria as written.
