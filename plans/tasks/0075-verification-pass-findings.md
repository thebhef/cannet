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
