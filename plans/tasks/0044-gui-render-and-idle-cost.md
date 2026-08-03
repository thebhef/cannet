# Task 44 — GUI Render & Idle Cost

The GUI does substantially more work per unit of displayed change than
it needs to, and it does not go quiet when nothing is happening. This
task is the systematic pass over that: find the always-dirty sources,
remove the redundant per-tick work, and give the render path an honest
cadence control instead of the fictional one that was just deleted.

It exists because a symptom kept resurfacing from different directions
— idle render churn at display rate, `PlotArea` rendering ~8× per
resample, a "max Hz" plot control that demonstrably did nothing — and a
2026-08-02 read of the plot, trace, and host paths found they share one
root shape: **fixed-cadence polling with dedup guards that don't
dedup**. Those findings are recorded in "Findings" below.

## The shape of the problem

Three distinct cadences are tangled together and none of them is
gated on "did anything actually change":

- **Fetch** — how often a view asks the host for data.
- **Redraw** — how often a canvas repaints.
- **Readout** — how often diagnostic badges update.

The removed plot "max Hz" combobox gated only the *third-least*
important of these (the idle gap between one loop's ticks), which is
why it appeared inert across most of its range. A control that changes
realised load has to name the cadence it governs.

Related: the frontend already has the right pattern in
`useWindowedQuery` — a throttled tick that short-circuits on a dirty
flag the model sets. Most of this task is bringing other views up to
that bar.

## Scope

Land in tiers, each tier independently reviewable and independently
shippable. **Measure before and after** with the ADR-0031 flow
([`docs/adr/0031-gui-performance-automation-self-driving.md`](../../docs/adr/0031-gui-performance-automation-self-driving.md))
— every claim below is inferred from reading, not measured, and the
point of the tiers is to find out which ones were right.

### Tier 0 — measurement

The existing capture gates "clean → clean" at rest and never exercises
the heavy views, so it cannot see most of what this task changes.

1. Take a release-build baseline on `examples/ev-zonal`. The 2026-07-26
   baseline was a dev-build capture against a release-build
   predecessor, and its same-load movers are unexplained: jsheap peak
   +30 % (188→245 MB) and `tx_late_ms_mean` 4.5→14.2. Plausibly
   dev-build overhead, but unconfirmed — drift rates were flat, so
   there was no leak signal. One release run settles it; promote it as
   the baseline if the numbers move.
2. Add the interaction-driven capture step (synthetic scroll/pan over
   the heavy views, no WebDriver per ADR 0031) so the interaction cost
   this task targets is actually in the gate.
3. Decide the `scroll_jank_pct` question — meter or reality — before
   any smoothness number here is treated as a regression signal. The
   follow-live smoothness gauge
   ([`apps/gui/src/scrollJank.ts`](../../apps/gui/src/scrollJank.ts))
   sat between 37 % and 87 % through a 2026-07-28 connect run that was
   otherwise clean: ~1600 rx/tx fps, `lag ≈ 0 ms`, `longtask = 0 ms`,
   window 1.3 s wide. Either the window genuinely advances unevenly at
   that zoom or the meter over-reads — two flaws in it were already
   found and fixed the same day (a near-zero-rate divide, and sampling
   per repaint rather than per window movement), so a third is
   plausible. A wrong gate is worse than no gate.

### Tier 1 — pure waste

No behavioural change, no smoothness trade-off. Small diffs.

1. **The hidden resample trigger.** `PlotArea`'s "safety net" effect
   resamples on every change of `winEnd` — i.e. on every `trace-grew`,
   a 10 Hz floor independent of the resample loop. Its comment claims
   it is "deduped by the busy-guard and the `renderedThrough` skip";
   `renderedThrough` **does not exist anywhere in the tree**, and the
   busy-guard only drops overlapping calls, not interleaved ones. Gate
   the effect on the condition it actually needs (mount / stopped-panel
   window change) and delete the comment's fiction.
2. **Parked views refetch identical data forever.** `useDecimatedRange`
   keys its memo on `winStart:winEnd:fromSeconds:toSeconds:maxPoints`.
   A zoomed-into-history view pins the visible bounds but `winEnd`
   keeps growing, so the "unchanged" fast path can never fire and every
   tick does a full fetch + decode + merge + normalise + `setData`
   producing pixel-identical output. Make the key reflect "could this
   request return different bytes?".
3. **Trace views render twice per tick.** `TraceView` holds
   `anchoredRow` in state and a layout effect writes it *after* render
   whenever the live tail moves — so render #1 runs the whole row path
   against a stale anchor, is discarded, and forces render #2. Derive
   `firstVisibleRow` instead of storing it.
4. **The flusher stalls ingest every 2 s.** `TraceStore::flush_with`
   holds the append lock across two full recursive `dir_footprint`
   walks (one `metadata()` syscall per file — thousands on a long
   capture), the flush, a full `per_key` rebuild cloning a String and
   payload per entry, and a temp-file+rename JSON write. `scratch.rs`
   documents the correct pattern — clone the dir under the lock, then
   release — and this function doesn't follow it. Snapshot under the
   lock, do the I/O outside it, and drop the redundant first walk.
5. **The system-log mirror is unbounded.** The host ring caps at
   `RING_CAPACITY`; the frontend mirror never trims, and
   `mergeSystemMessage` does an O(n) scan plus an O(n) copy per
   appended message, with `unreadWarnOrError` re-scanning the whole
   array on each change. This is the "no frontend state that grows with
   session time" rule in CLAUDE.md being violated outright, and the new
   `debug` level makes it worse. Cap on merge; track unread
   incrementally.
6. **`useTrace` pages rows nobody reads.** It unconditionally builds a
   1000-row windowed query, but the plot, signals, and by-ID callers
   never read the rows — so every Clear / Connect / DBC reload / Start
   / Stop fetches 1000 decoded frames per open panel and discards them.

### Tier 2 — structural

Each changes a cadence or a fan-out shape. Bigger diffs, real design
choices.

1. **`applyXAll` is O(areas²).** Each area's resample pushes a new
   x-window into *every other* instance, and the equality skip never
   hits because each area evaluates the live edge with its own
   `performance.now()`. Individual-axis mode with 6 signals is 36 full
   canvas redraws per resample interval. Coalesce the follow-live slide
   to one rAF per panel. **This is the change that decouples fetch
   cadence from redraw cadence**, and therefore the prerequisite for
   any honest rate control.
2. **Per-tick diagnostic `setState`s.** Five panel-level setters fire
   per resample feeding only the toolbar perf badge, giving areas²
   React renders. `PlotArea` is not memoized and could not benefit if
   it were, because the panel passes fresh inline arrows every render.
   Ref-accumulate and flush at ~2 Hz; then stabilise the callbacks and
   memoize. Expected to explain the backlog's measured "`PlotArea`
   renders ~8× per resample" (300–400 `render.PlotArea`/s against ~50
   resamples/s).
3. **Split the trace context.** One `trace-grew` re-renders all four
   consumers (trace, signals, plot, events) including panels whose
   inputs provably did not change. Split into a stable half (`epoch`,
   `sessionStartSeconds`, `truncationTsNs`, `fetchRange`) and a
   churning half (`count`, `firstIndex`, `liveTail`).
4. **Gate the live tail on demand.** The host ships 256 decoded frames
   per `trace-grew` whether or not anything consumes them; only an
   auto-scrolling *chronological* view reads them. With no trace panel
   open, or all panels in by-ID / stopped / parked state, that is
   ~2560 records/s of parse and allocation for nobody. Let the
   frontend declare the tail size it wants (0 when nothing wants one).
5. **By-ID live refresh re-pages 1024 decoded rows at 4 Hz** for a
   ~30-row viewport, breaking every row memo. Folds in two existing
   backlog items on the same call path:
   - *Paused-snapshot tighten* (former Task 24) — a paused by-ID
     snapshot should return the latest of each id within
     `[since, end)` rather than reading the global latest index.
   - *Live refresh re-pages page 0*, so a by-ID view scrolled into a
     later page is yanked back to the top each tick. Only reachable
     with an unusually large id space (the by-ID set is
     id-space-bounded, so it almost always fits one page). The fix
     needs the windowed primitive to expose "refresh the loaded
     window" as distinct from follow-live's "re-page the tail" —
     which is the same primitive this item needs anyway.
6. **`DbcPanel`'s 500 ms poll has no dirty gate** and runs with no
   capture active, each tick triggering a whole-id-space clone
   host-side. Drive it off `trace-grew`, which already goes quiet.
7. **Host-side per-tick scans.** `latest_in_window` clones every
   `FrameKey` and last-frame payload for every distinct id (under the
   append lock) when the caller wants ten signals;
   `ensure_active_filter_index` re-resolves candidates and re-scans
   every loaded DBC's message/signal names on every
   `fetch_filtered_trace` call, though all of it is a pure function of
   (predicate, DBC generation, seen ids) and could be memoized on the
   index that already caches the predicate.

### Tier 3 — hot-path allocation

Only worth doing if Tier 0 measurement says ingest cost is material.

- Per-frame full-message decode + `Vec` allocation in the signal-cache
  catch-up, where the caller immediately takes the first element.
- Three `String` clones per frame on the ingest path (`route_channel`,
  `FrameKey`, and one purely to satisfy a `per_bus.entry()`); the last
  is removable with no API change.
- The 10 Hz status tick takes 3 store locks even when it skips and 9
  when it emits; one `status_snapshot()` under a single lock.
- The ingest verifier locks a mutex per frame *before* checking whether
  any calc field is configured, and rebuilds the same keys twice.
- By-ID "sort by bus" allocates two Strings per comparison.

### Tier 4 — the plot cadence knob

Only after Tier 2 #1, because before that a fetch-rate control cannot
keep the view smooth — which is what made the old one inert.

Expose the plot's fetch cadence as a field in `settings.json`
(ADR 0034), surfaced in the Settings panel, **not** as a per-panel
toolbar control: the removed combobox was per-panel, and per-panel is
the wrong scope for a machine-load trade-off.

The honest justification is *consistency, not user value*. Nobody is
going to spend much time tuning this — the point is that
`settings.json` should be the single place every app-level knob lives,
and a hard-coded module constant governing how hard the app works is
exactly the kind of thing that belongs there. It is carried here
because this task is what makes the number meaningful; the broader
sweep of app-level settings that bypass the store is
[Task 45](0045-settings-store-consolidation.md).

Decide at that point whether redraw cadence needs its own field or
should stay pinned to rAF. Default stays the current effective value so
an untouched install behaves identically.

## Findings

Recorded 2026-08-02 from a three-way read of the plot path, the
trace/table path, and the Rust host. Everything is **inferred from
code** unless marked verified. Findings verified by direct reading at
the time: the missing `renderedThrough` guard, the `winEnd`-keyed memo,
the `anchoredRow` double render, and the `flush_with` lock hold.

What the audit found *clean*, and should not be re-litigated without
new evidence: the transmit scheduler (fully event-driven, idle-parked),
the DBC watcher (`notify`-callback driven), the filter module's
compiled-regex memo, `signalCatalogContext`, `ConnectionManagement`,
`useWindowedQuery`'s dirty-gated interval, and the trace virtualiser's
row sizing (no overscan bloat). Model work is genuinely host-side —
sorting, filtering, rate estimation, time↔index anchoring and by-ID
aggregation all round-trip, per the CLAUDE.md architecture rule.

## Documentation deliverables

- [`CLAUDE.md`](../../CLAUDE.md) cites "the chronological trace (LRU
  chunk cache in `App.tsx`)" as one of three reference implementations
  of the paging rule. **There is no such cache in `App.tsx`.** Comments
  in `TraceView.tsx` still reason about "the shared chunk cache" and
  "the LRU" too. Establish what replaced it and fix the rule's citation
  and the stale comments together.
- Whatever cadence contract Tier 2 #1 lands (one rAF per panel, fetch
  independent of redraw) belongs in an ADR or in ADR 0024's timing
  rules — it governs any future trace-like renderer.
- The `renderedThrough` comment is the cautionary example: a dedup
  guard was deleted and the comment asserting it survived, hiding a
  10 Hz floor for however long. Worth a line wherever the repo talks
  about comment rot.

## Exit criteria

- A release-build ADR-0031 baseline exists, with an interaction-driven
  capture step, and `scroll_jank_pct` is either trusted or excluded
  from the gate with a reason.
- Idle cost is measurably ~0: with no capture running and no
  interaction in flight, no view re-renders and no timer does work.
  This closes the backlog's "idle render churn — ~120 FPS on macOS with
  nothing changing" item.
- `render.PlotArea` tracks `plotarea.resample` within the factor the
  axis split accounts for — closing the "renders ~8× per resample"
  item.
- A parked / zoomed plot panel issues no host round-trips while the
  capture grows.
- Frontend state holds nothing that grows with session time or capture
  length.
- The ingest pump is not blocked by the flusher's directory walks.
- Each tier's before/after numbers are recorded here, including the
  ones that turned out not to matter — a finding that measured flat is
  as useful to future readers as one that paid off.

## Tier 1 results

Landed 2026-08-02, one commit per item. **No ADR-0031 capture was
taken** (the machine was in use), so these are code- and test-level
observations, not measured deltas — Tier 0 still owes the before/after
numbers, and until it lands none of the six can be called *measured*.

1. **The hidden resample trigger** — finding confirmed exactly as
   recorded; `renderedThrough` existed only in that comment. Before: a
   running panel issued one `sample_signals` per window growth on top of
   its loop (6 growths → 8 fetches). After: ≤2, and that slack is fixed
   one-off work — identical at 6 and at 18 growths. The other half of
   the trigger (a stopped panel whose window moves under it) is now
   covered by its own test; it previously had none.
2. **Parked views refetch identical data** — confirmed. A slice ending
   behind the last frame already seen now keys without `winEnd`, so a
   zoomed-into-history panel makes no round-trip while the capture
   grows. The finding assumed the output was pixel-identical; the plot
   data is, the live edge is not — `lastT` freezes with the fetch, and
   it is what feeds the panel's data extent. That shipped as a *Fit
   Data* regression and was fixed on top; see "Fit Data over a parked
   window" below.
3. **Trace views render twice per tick** — confirmed; measured 2 renders
   per `count` change before, 1 after. The anchor is now derived while
   pinned. The doc deliverable landed with it: CLAUDE.md's paging rule
   cited an "LRU chunk cache in `App.tsx`" that does not exist —
   `useTrace` over `useWindowedQuery` (one loaded page plus the live-tail
   overlay) is what actually pages the chronological trace — and the
   stale "shared chunk cache" / "the LRU" comments in `TraceView.tsx`
   and `TracePanel.tsx` went with it.
4. **The flusher stalls ingest** — confirmed; fixed **in part, by
   choice**. Both `dir_footprint` walks now run off the append lock. The
   derived-state snapshot *and* its JSON write stay inside one lock
   hold: `start_session` deletes that file and empties `per_key`, so a
   write outside the lock can recreate it describing the session that
   just ended. The write is small by construction (id-space-bounded);
   the walks are not. "Drop the redundant first walk" turned out to be
   wrong — neither walk is redundant. The pre-flush one must see bytes
   written since the last flush
   (`cap_eviction_does_not_over_evict_raw_for_derived_family_footprint`
   fails against a cached value) and the post-flush one must include
   what this flush just wrote
   (`scratch_footprint_bytes_is_none_for_ram_and_tracks_disk`). **No new
   test:** the lock-hold reduction is not observable through the store's
   public surface without a timing-dependent concurrency probe, which
   would be flaky in both directions.
5. **The system-log mirror is unbounded** — confirmed. Capped at the
   host ring's capacity, dedupe against the tail alone (O(1)), and the
   unread tally carried forward per message instead of re-scanned. The
   bulk recount now runs once, on the boot snapshot.
6. **`useTrace` pages rows nobody reads** — confirmed, and slightly
   wider than recorded: `PlotPanel` and `SignalsPanel` read no rows at
   all, and `TracePanel` reads them only in *unfiltered chronological*
   mode (by-id pages through `useByIdView`, filtered chronological
   through `useFilteredTrace`). Three of the four call sites now opt
   out, so a Clear / Connect / DBC reload / Start / Stop no longer
   fetches 1000 decoded frames per open plot, signals or by-id panel.

### Fit Data over a parked window

Tier 1 item 2 shipped a regression: with the panel's live-edge readout
frozen, *Fit Data* fitted to the extent as of the moment the window
parked, so the plot ended early — as though the capture had stopped
when the user panned away. Nothing looked broken; it just showed less
than everything.

Characterised first, three questions, three tests
(`PlotPanel.dom.test.tsx` → "Fit Data over a parked window"):

- **Does it reproduce?** Yes. Parked at a 2 s live edge, capture grown
  to 9 s, Fit Data fits to 2.
- **Does it self-heal?** **Yes — on the second press**, contradicting
  the expectation that it would stay wrong for the session. Fitting to
  the stale edge lands the right edge *on* it, and the ±20 % fetch
  margin then puts the requested slice back past the last frame seen —
  which un-parks the window, so the re-sample Fit Data forces refreshes
  the extent and the next press is right. The bug was "one press
  stale", not "stuck until follow-live".
- **Does a live area rescue it?** **No, and it cannot.** `sharedExtent()`
  maxes across areas, but the x window is *panel*-wide (`xSyncRef`), so
  every area requests the same slice and parks as one. The premise of a
  panel with one parked and one live area is unreachable. (An area whose
  windowed source re-anchors — a signal added or removed — does refetch
  and would refresh the extent, but that is a signal-set change, not a
  live area.)

**The fix.** `fitData` asks the host where the window ends *now*
instead of trusting the extent the areas last drew. `last_seconds` is a
fact about the window — the host reads it off the store's anchors, not
off the queried signals — so an empty `signals` list is the same query
with the per-signal slicing left out: `fetchWindowExtent` in
`useDecimatedRange.ts`. One round-trip per press, none per tick.
Rejected alternatives: a per-tick extent query (puts the skipped
round-trip straight back); deriving the edge from `winEnd` (a frame
*index* — index→time mapping is host-side); reading `data.liveTail`'s
last row (couples to a payload Tier 2 item 4 plans to gate off, and
says nothing about a window short of the tip).

**No exit criterion is now unmet.** "A parked / zoomed plot panel
issues no host round-trips while the capture grows" still holds — the
new round-trip is on a user gesture, and the two-area test asserts the
zero-round-trip claim directly while the capture grows. Still no
ADR-0031 capture, so the cost of that one press is un-measured; it is
a `window_anchors` binary search with no decode, so it should not be
visible.
