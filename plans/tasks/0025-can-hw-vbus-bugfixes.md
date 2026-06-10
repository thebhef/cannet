# Task 25 — CAN HW + Virtual-Bus Bug Fixes

The deferred verify-and-bugfix pass from the virtual-bus work, plus a
small round of GUI fixes found in use. **This is the top of the
roadmap** — the next thing to do. It is a grab-bag of concrete,
independently-shippable fixes rather than a feature; each lands with a
test or a documented manual repro.

## Bug reports

### 1. Broken timestamp handling

- Regular CAN messages look OK at a 100 ms period and inconsistent at
  10 ms. CAN-FD messages are inconsistent at 100 ms. The case is TX on
  a real PEAK-FD interface and receiving on another PEAK-FD interface,
  two logical buses.
- Negative timestamps still show up in historical trace views after a
  session clear. Details captured below — the pattern is not fully
  pinned down, but there's enough to point further investigation.

#### Negative-timestamp observations

- **Symptom location.** The negative value shows up in the trace
  panel's *index* column (the relative-time column the row is keyed
  by), not a dt/delta column. First-clear sets it to 0 as expected;
  second-and-subsequent clears within the same connection set it to
  roughly `-1 * latest_timestamp` — i.e. the new zero appears to land
  at the *start of the session* rather than at "now", so frames
  captured before the clear (which should already be gone) render as
  large negative offsets equal to how far into the session we are.

- **Reproduction.** Open project, connect, start a periodic TX, then
  click *Clear session buffer*. First clear: trace resets to 0
  (correct). Second clear and onward: first frame in the new view
  renders at `~ -session_elapsed_seconds`.

- **Restored-vs-fresh panel pattern.** Negatives appear on
  panels that came back from the saved project. Creating a *new*
  trace panel after project load appears to suppress the bug on
  *all* trace panels — including the restored ones. Removing the
  newly-created panel makes the restored panels exhibit the bug
  again. That's surprising — restored panels and newly-created
  panels both go through `clearedTrace`/`freshTrace` with
  `traceStartOffsetSeconds=null` and otherwise read from the same
  `TraceData`, so a per-panel state difference shouldn't matter to
  the others. Smells like something at the App level — registry
  identity, a cached value tied to panel count, or an effect's
  dependency list — rather than a per-panel field.

#### What's been ruled out (code reading)

The bug is reproducible with the **toolbar Clear** (session
buffer clear), not a per-panel Clear. Given that scope:

- **Stale `useEffect` dep / `countRef`.** The two effects that
  touch `TraceState` (`reanchorToSession` on `[count]`,
  `clearTraceStartOffset` on `[sessionStartSeconds]`) don't read
  the registry — only App state — so panel count can't change
  whether they fire. `countRef.current` is read only in `create`
  / `ensure` / `applyProject`, all of which call
  `clearedTrace(n)` with the default `null` offset.
- **Stale closure in a `setRegistry` callsite.** All ten
  `setRegistry` callsites use the `(prev) => ...` updater form,
  so each is fed the latest registry. The only place a non-null
  offset is *computed* is `currentSessionOffsetSeconds(data)`
  inside `useTrace`'s `start` / `clear` callbacks — both depend
  on `data`, so they re-create on every `data` change rather
  than capturing a stale one.
- **Toolbar Clear writing an offset directly.** `handleClear`
  → `startAllElements()` rewrites every entry to
  `freshTrace(0)` (offset=`null`), then `trace-grew` re-arrives
  with the new `session_start_seconds`; the
  `[sessionStartSeconds]` effect fires and the clear-offset map
  is a no-op since everything is already `null`. No path between
  those steps writes a non-null offset.
- **Stale data through the host pipeline.** `clear_trace_store`
  empties the trace store *and* raises `session_start_ns`, and
  `append` drops any subsequent frame whose `timestamp_ns <
  session_start_ns`. `invalidateCache()` then wipes the
  frontend chunk LRU and the `tailFramesRef`. So a frame with
  pre-clear timestamp shouldn't reach `formatTimestamp`.

That covers every path I can construct statically. The observed
behavior implies one of the rule-outs is wrong somewhere I
haven't found, or there's a state-update interleaving on the
toolbar Clear path that produces a non-null offset on existing
panels while a *fresh* panel resets that state for everyone.

#### Next experiment

Instrument these three sites and reproduce: open project,
connect, send a periodic, click toolbar *Clear* twice. The log
of what gets written between the two clears will pin the
source.

1. The `trace-grew` listener at [App.tsx:478-498](apps/gui/src/App.tsx#L478-L498) —
   log `{ newCount, prevCount, session_start_seconds,
   sessionStartBefore }`.
2. The `[sessionStartSeconds]` effect at [App.tsx:553-564](apps/gui/src/App.tsx#L553-L564) —
   log `{ sessionStart, per_entry: [{id, offsetBefore, offsetAfter}] }`.
3. `useTrace`'s computed `baseTimestampSeconds` at
   [trace.ts:201-204](apps/gui/src/trace.ts#L201-L204) —
   log `{ elementId, sessionStartSeconds, offset, base }` on
   every render (or just when `base` changes).

If (3) shows a non-null offset on an existing panel right after
the second toolbar Clear, work backwards through (2) and (1) to
the writer. If (3) shows offset=null but a stale `base`, the
bug is upstream of the offset and we're looking in the wrong
place.

#### ADR 0024 compliance

Both timestamp bugs above are governed by
[ADR 0024](../../docs/adr/0024-trace-like-view-timing.md)
(trace-like view timing); fixing them is what brings the code
back into compliance. Mapping each ADR rule to the code:

| ADR rule | Where it lives | Compliant? |
| --- | --- | --- |
| Session buffer start time, set on start and clear | `TraceStore::session_start_ns`, written by `start_session` (`clear_trace_store` → all Connect/Open/toolbar-Clear paths; BLF replay's first frame). Frontend reads via `trace-grew` event's `session_start_seconds`. | Yes — by construction. |
| Trace start time, `null` means use session | `TraceState.traceStartOffsetSeconds: number \| null`; `useTrace` derives `base = sessionStart + (offset ?? 0)`. | Yes — derivation is `O(1)` per render and tracks the session live. |
| Default `null`, reset on session start | `freshTrace(n)` / `clearedTrace(n)` default to `null`; `startAllElements` writes `freshTrace(0)` on every session-buffer start path; `useEffect([sessionStartSeconds])` is the belt-and-suspenders reset. | Per code reading, yes. Per observation, **NO** — see the investigation above. |
| Set on trace-*Clear* and *Start*-after-*Stop*; preserved by Pause / Resume / Stop | `useTrace`'s `clear` / `start` callbacks capture `currentSessionOffsetSeconds(data)`; `pauseTrace` / `resumeTrace` / `stopTrace` preserve the field. | Yes. |
| Rendered time never negative | The invariant from the ADR. | **NO** — the negative-timestamp bug above. |
| Trace view and plot share one model | Both panels call `useTrace`; both render `frame.timestamp_seconds - baseTimestamp` via `formatTimestamp`. | Yes — already a shared hook + interface; the ADR formalises the contract. |

Cheap documented-contract work that lands with the fix:

- A one-line rustdoc on `TraceStore::start_session` and
  `TraceStore::append` pointing to ADR 0024 (the buffer-side
  guard is part of the contract).
- A tsdoc on `useTrace`, `TraceState`, and
  `currentSessionOffsetSeconds` pointing to the same ADR, stating
  the four timing rules in the hook's doc-comment so a reader who
  opens the hook sees them.
- Fix the stale comment on `PlotPanel.handlePlotClear`
  ([PlotPanel.tsx:625-627](../../apps/gui/src/PlotPanel.tsx#L625-L627))
  — it claims "the trace clear cascades to the host" but
  `trace.clear()` is purely a frontend state update.

### 2. DBC view performance, search, and scrolling

The DBC view is slow with a large database: scrolling is sluggish and
search is poor, both in responsiveness and in result quality. This
needs an iterative pass on the **search behaviour** as well as the
render path.

- **Scrolling / render** — the view should page like the other
  data-bearing views (thin view over a model; see
  [`../../CLAUDE.md`](../../CLAUDE.md) § GUI architecture), not hold
  and render the whole database at once.
- **Search** — iterate on match quality and latency with a realistic
  large database in hand. (The DBC panel already uses the `fzf`
  matcher; this is about how it scales and ranks, not picking a new
  library.)

#### Test fixture: a massive DBC

To exercise the above we need a deliberately large, realistic fixture:

- **Two unique DBCs**, each with **150+ messages**.
- Some messages with **500+ multiplexed signals**.
- **Unique but realistic** message and signal names (not
  `Sig_0001` filler) so search ranking is exercised the way a real
  database stresses it.

Generate it deterministically (like the existing
`examples/generate_blf.py` fixture) so the suite stays reproducible.

### 3. Plot signal colours don't advance

Signals added **one-by-one** from the DBC view to a plot panel all
come up with the **first** colour in the palette (all green) instead
of advancing through it (second orange, third blue, …). Adding several
at once presumably cycles correctly, so the bug is in the
add-one-at-a-time path not consulting / advancing the palette index.

### 4. Dead code: `decimatePoints`

`plotData.ts`'s `decimatePoints` is referenced only by its own test.
Its doc claims it is *"used to keep a plot area's accumulated cache
bounded without a round-trip"* — but the plot cache is no longer
accumulated; each resample replaces it wholesale. Leftover from when
the frontend hoarded plot data. Remove the function, its test, and the
stale comment.

## Exit criteria

- The 10 ms / 100 ms / FD timestamp inconsistency on dual PEAK-FD is
  reproduced, root-caused, and fixed, with a regression test or a
  documented hardware repro in `SMOKE.md`.
- The post-clear negative-timestamp bug is root-caused (per the
  experiment above) and fixed, with a regression test.
- The DBC view pages its content and stays responsive with the large
  fixture open; search latency and ranking are demonstrably improved
  against that fixture.
- The large two-DBC fixture is generated deterministically and checked
  into `examples/`.
- Adding plot signals one at a time advances the colour palette;
  covered by a test.
- The trace timing model is documented per ADR 0024: rustdoc on
  `TraceStore::start_session` / `append`, tsdoc on `useTrace` /
  `TraceState` / `currentSessionOffsetSeconds`, and the stale
  `PlotPanel.handlePlotClear` comment corrected.
- `decimatePoints` and its test are removed (dead code — the plot
  cache is replaced wholesale on each resample, not accumulated).
