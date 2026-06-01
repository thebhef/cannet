# ADR 0024 implementation — trace timing

Tracking doc for bringing the code into compliance with
[ADR 0024](../docs/adr/0024-trace-like-view-timing.md) and for the
investigation into the remaining negative-timestamp bug.

This is a planning doc, not a long-lived contract. Fold completed
items into the relevant phase or delete them; archive the
investigation notes once the bug is closed.

## Current compliance

Mapping each ADR rule to the code as of writing (branch
`phase-13-virtual-bus`):

| ADR rule | Where it lives | Compliant? |
| --- | --- | --- |
| Session buffer start time, set on start and clear | `TraceStore::session_start_ns`, written by `start_session` (`clear_trace_store` → all Connect/Open/toolbar-Clear paths; BLF replay's first frame). Frontend reads via `trace-grew` event's `session_start_seconds`. | Yes — by construction. |
| Trace start time, `null` means use session | `TraceState.traceStartOffsetSeconds: number \| null`; `useTrace` derives `base = sessionStart + (offset ?? 0)`. | Yes — derivation is `O(1)` per render and tracks the session live. |
| Default `null`, reset on session start | `freshTrace(n)` / `clearedTrace(n)` default to `null`; `startAllElements` writes `freshTrace(0)` on every session-buffer start path; `useEffect([sessionStartSeconds])` is the belt-and-suspenders reset. | Per code reading, yes. Per observation, **NO** — see investigation below. |
| Set on trace-*Clear* and *Start*-after-*Stop*; preserved by Pause / Resume / Stop | `useTrace`'s `clear` / `start` callbacks capture `currentSessionOffsetSeconds(data)`; `pauseTrace` / `resumeTrace` / `stopTrace` preserve the field. | Yes. |
| Rendered time never negative | The invariant from the ADR. | **NO** — the bug below. |
| Trace view and plot share one model | Both panels call `useTrace`; both render `frame.timestamp_seconds - baseTimestamp` via `formatTimestamp`. | Yes — already a shared hook + interface; the ADR formalises the contract. |

## Open work to reach compliance

### Documented contract (cheap)

- Add a one-line rustdoc on `TraceStore::start_session` and
  `TraceStore::append` pointing to ADR 0024 (the buffer-side
  guard is part of the contract).
- Add a tsdoc on `useTrace`, `TraceState`, and
  `currentSessionOffsetSeconds` pointing to the same ADR. State
  the four rules in the hook's doc-comment so a reader who
  opens the hook sees them.
- Update the stale comment on `PlotPanel.handlePlotClear`
  ([PlotPanel.tsx:625-627](../apps/gui/src/PlotPanel.tsx#L625-L627))
  — it claims "the trace clear cascades to the host" but
  `trace.clear()` is purely a frontend state update.

### Negative-timestamp bug (root cause unknown)

The ADR forbids the symptom; the code path that produces it
hasn't been pinned down. Notes are below; do not close the
ADR-compliance item until the bug is closed.

## Negative-timestamp investigation

### Observation (from the user)

- Trigger: **toolbar Clear** (session buffer clear). Not the
  per-panel Clear.
- First clear after Connect: trace resets to 0 (correct).
- Second clear and onward: first frame in the new view
  renders at `~ -session_elapsed_seconds` in the time column.
- Restored-vs-fresh panel pattern: negatives appear on panels
  restored from the saved project. Creating a *new* trace
  panel after project load suppresses the bug on *all*
  panels, including restored ones. Removing the newly-created
  panel makes the restored panels exhibit it again.

### What the ADR says should happen

Per [ADR 0024](../docs/adr/0024-trace-like-view-timing.md), on
toolbar Clear:

1. The session buffer's start time is raised to wall-clock now.
2. Every trace's start time is reset to `null` (session-buffer
   start implies trace-start reset).
3. Subsequent frames render at `frame.timestamp - sessionStart`
   ≥ 0.

If a trace is rendering negative, one of (1)–(3) is being
violated. (1) is host-owned and the unit tests pin it down.
(3) is mechanical given (1) + (2). So the suspect is (2): the
trace's offset is somehow non-null when it shouldn't be.

### What code reading has ruled out

- **Stale `useEffect` dep or `countRef`.** The two effects
  that touch `TraceState` (`reanchorToSession` on `[count]`,
  `clearTraceStartOffset` on `[sessionStartSeconds]`) read
  only App state. Panel count cannot change whether they
  fire. `countRef.current` flows only to
  `clearedTrace(n)` callsites that default the offset to
  `null`.
- **Stale closure in a `setRegistry` callsite.** All ten
  `setRegistry` callsites use the `(prev) => …` updater
  form, so each is fed the latest registry. The only place a
  non-null offset is *computed* is
  `currentSessionOffsetSeconds(data)` inside `useTrace`'s
  `start` / `clear` callbacks — both depend on `data`, so
  they're re-created on every `data` change.
- **Toolbar Clear writing a non-null offset directly.**
  `handleClear` → `startAllElements()` writes
  `freshTrace(0)` (offset=`null`) into every entry; then
  `trace-grew` re-arrives with the new `session_start_seconds`
  and the `[sessionStartSeconds]` effect's clear-offset map is
  a no-op since everything is already `null`. No path between
  those steps writes a non-null offset.
- **Stale data through the host pipeline.** `clear_trace_store`
  empties the trace store *and* raises `session_start_ns`,
  and `append` drops any subsequent frame whose `timestamp_ns
  < session_start_ns`. `invalidateCache()` wipes the frontend
  chunk LRU and `tailFramesRef`. So a frame with a pre-clear
  timestamp shouldn't reach `formatTimestamp`.

That covers every path constructible statically. The observed
behavior implies one of the rule-outs is wrong somewhere not
yet found, or there's a state-update interleaving on the
toolbar-Clear path that produces a non-null offset on existing
panels while a *fresh* panel resets it for everyone.

### Next experiment: instrument and reproduce

Add console logging at three sites, run the repro (open
project, connect, send a periodic, click toolbar *Clear*
twice), and watch what gets written between the two clears.

1. **The `trace-grew` listener** at
   [App.tsx:478-498](../apps/gui/src/App.tsx#L478-L498) — log
   `{ newCount, prevCount, session_start_seconds,
   sessionStartBefore }`.
2. **The `[sessionStartSeconds]` effect** at
   [App.tsx:553-564](../apps/gui/src/App.tsx#L553-L564) — log
   `{ sessionStart, per_entry: [{id, offsetBefore,
   offsetAfter}] }`.
3. **`useTrace`'s computed `baseTimestampSeconds`** at
   [trace.ts:201-204](../apps/gui/src/trace.ts#L201-L204) —
   log `{ elementId, sessionStartSeconds, offset, base }` on
   every render (or just when `base` changes).

Reading the log:

- If (3) shows a non-null offset on an existing panel right
  after the second toolbar Clear: work backwards through (2)
  and (1) to the writer. There is one we haven't found.
- If (3) shows `offset = null` but a stale `base`: the bug is
  upstream of the offset — in `sessionStartSeconds`, or in
  the per-frame `timestamp_seconds` — and the offset story is
  a red herring.
- If (3) is correct (offset=null, base=new sessionStart) and
  the visible time column is still negative: the bug is in
  rendering — `formatTimestamp` or whoever supplies its
  `base` arg — not in the timing model at all.

### Status

Open. The fix path is gated on the experiment above.
