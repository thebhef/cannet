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
