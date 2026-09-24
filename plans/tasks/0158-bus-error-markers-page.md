# Task 158 — Bus-Error Markers Page

Opened 2026-09-23 from an owner observation while using the stack.
**Executes now, on the current stack.** Groomed the same day; three
phases.

## Why

From the owner, 2026-09-23: "I am noticing now that maybe we're
maxing out at 256 events? or 256 bus error markers?" On the finding
below: "paging it is probably right." On what a rebuild costs: "it's
rebuildable, but expensive, similar to signal caches." On the shape:
"might be able to squeeze them into our existing pyramid machinery..."
On the Events panel: "yes, paged section."

## Findings (2026-09-23 survey)

- **The cap is real and it is bus-error episodes.** Ingest folds
  error frames into runs — one per bus per episode, a new episode
  after a 1 s gap in frame time (`COALESCE_GAP_NS`) — and holds at
  most `MAX_RUNS = 256` of them (`bus_health.rs`), evicting the
  oldest. A test pins the eviction. The per-bus totals keep counting
  so the bus-health panel's number does not fall, but the evicted
  episode's marker is gone from the plot, the trace and the Events
  panel.
- **The runs reach the views as derived notes, whole, once a second.**
  `spawn_bus_health_emitter` renders the runs with `runs_as_events`,
  puts them in the notes store through `replace_derived`, and emits
  `notes-changed` with the **entire** note list; `PlotPanel` builds its
  timeline events from that list, `EventsPanel` lists it, the trace's
  event rows read it. ADR 0035 §"held in RAM per session … views fetch
  the whole event set" is the rule the cap serves.
- **Nothing persists.** The runs live only in the coalescer; a restore
  from cache starts with none, and the frames that would rebuild them
  are in the capture.
- **No other event kind is capped this way.** Authored notes and
  message-bound comments are bounded by the user; the only other run
  cap is undelivered-transmit runs at 4096.
- **The signal cache already has everything a paged, rebuildable,
  bounded-serve series needs**: per-key pyramids of `(t, value)`
  samples folded 8→1 by min/max (`fold`), a serve that picks the
  coarsest level whose count in the window still exceeds the point
  budget (`window`), catch-up from the capture off the UI thread under
  a deadline (ADR 0048, 0049), hardening on the flush tick and at exit,
  restore keyed on the capture identity, the retention cap and the
  sweep (ADR 0002, 0047). Its record is 16 bytes and its fold keeps a
  bucket's min and max.

## Rulings

- **Page the bus-error markers** (owner, 2026-09-23).
- **On the existing pyramid machinery** (owner, 2026-09-23). Overseer's
  reading, settled from the code: each bus's error stream is a
  **derived series whose value is the cumulative error count on that
  bus** — one level-0 sample per error frame, `(t, running total)`.
  The series is monotone, so the min/max fold keeps each bucket's
  first and last sample, the exact totals at the bucket's edges, at
  every level; the serve is `slice_many` with the view's point budget;
  any two consecutive served points are an exact episode — count is
  the value difference, span the time difference, rate follows — at
  whatever level the window chose. No new record, no new fold, no
  level index on the wire.
- **The Events panel keeps bus errors as a paged section** (owner,
  2026-09-23), read from the same series through the windowed
  primitive.

Settled by the overseer, open to reversal:

- **The key.** A new `SignalOrigin` variant for the error series, keyed
  on the bus like a DBC signal, with a fixed signal name; not listed in
  the signal catalog or the Signals panel in this task (plotting it as
  a stepped "errors on bus X" line is a natural follow-up — backlog).
- **The 1 s gap goes.** Level selection is what thins a busy window;
  a marker per served point, labelled from the deltas. No display-time
  merge rule.
- **Markers, not rows, in the trace.** The derived bus-error events
  leave the trace's event rows: error frames are already trace rows,
  and the trace's collapse-error-frames option is its episode view.
- **Bus-health totals are unchanged**: ingest keeps its counters. The
  coalescer, `MAX_RUNS`, `runs_as_events` and the once-a-second
  `notes-changed` broadcast of derived events go; the notes store holds
  authored events only.
- **Marker ids are the error's ordinal** (overseer, 2026-09-23, from
  phase 1's finding): every served point at every level is a real
  level-0 sample — the time of the nth error on the bus and n — so a
  bus-error marker's id is `bus-error:{bus}:{n}`, stable across zoom
  levels and restores. Links (ADR 0056) target that id; phase 2 uses it.
- **ADRs.** ADR 0035 amended: detector-derived events are a windowed
  series family served by the signal cache; authored events stay whole.
  ADR 0002 names the error series among the derived families.

## Open questions

(none — ruled 2026-09-23.)

## Phases

1. **Host: the error series.** The `SignalOrigin` variant and its
   decoder on the catch-up path (an error frame is one sample carrying
   the bus's running total); catch-up, persistence, restore and sweep
   verified by tests over a generated capture (50,000 error frames on
   two buses: bounded serve at every budget, exact deltas across
   levels, restore rebuilds off the UI thread with the pending state,
   a clear drops it); the coalescer, `MAX_RUNS`, `runs_as_events` and
   the derived-notes broadcast removed, bus-health totals kept and
   tested; a windowed command (or `slice_many` through the existing
   plot serve) the frontend can call per bus set and window. ADR 0002
   and ADR 0035 amended here, since the host is where the rule changes.
2. **Plot markers.** `PlotPanel`'s bus-error markers come from a
   windowed query over the series per visible range, one marker per
   served point labelled with count, span and rate from the deltas;
   the Events chip's kind checklist still lists bus errors; DOM tests
   (a window over 50,000 errors renders a bounded marker set; zooming
   in resolves it; labels carry the deltas).
3. **Events panel and trace.** The Events panel's bus-error section as
   a paged gridview over the series (windowed primitive, ADR 0044);
   derived events leave the trace's event rows; README's events,
   bus-health and trace passages; `docs/CONTEXT.md` if a term is
   coined.

## Exit criteria

1. A capture with more than 256 bus-error episodes shows every episode
   on the plot at the zoom where it resolves; nothing is evicted.
2. The series is a signal-cache pyramid: persisted with the others,
   restored with the capture identity, rebuilt from the capture off
   the UI thread when absent, swept and capped like them — host tests.
3. Any window is served within the point budget at every level, and
   consecutive served points give exact count and span — host tests
   across three levels.
4. `MAX_RUNS`, the coalescer and the whole-list derived-note broadcast
   are gone; authored notes still broadcast as before; bus-health totals
   unchanged — tests.
5. Plot markers, the Events panel's paged bus-error section and the
   trace behave per § Rulings — DOM tests.
6. ADR 0035 and ADR 0002 describe the series family; README matches.
7. Tests cover 1–5.

## Blockers / side effects

1. **The panel's error rate still uses a 1 s burst gap.** The prompt
   listed `COALESCE_GAP_NS` for removal *and* required bus-health rates
   unchanged; the rate is "errors/s over the latest burst", which needs
   a burst boundary. Kept as `RATE_BURST_GAP_NS` inside a per-bus tally
   (`ErrorTallies`, bounded by bus count, no list, no cap) that feeds
   only the panel's `error_rate` / `last_error_ts_ns`; documented as
   having nothing to do with markers. Removing it means redefining the
   panel's rate (e.g. over the last second, or read off the series).
2. **Between phases 1 and 2–3 no view shows bus-error markers.** Derived
   events are gone from `notes-changed`/`fetch_notes`; `PlotPanel`,
   `EventsPanel` and the trace's event rows show none until phases 2–3
   read `bus_error_series`.
   README (§ error frames, § timeline events table) still describes the
   coalesced event — phase 3's README pass.
3. **Links to bus-error events.** ADR 0056 lets an authored event name a
   host-derived event by id; the old ids were `bus-error:{bus}:{first_ts}`
   and are no longer in any store, so such a subject now reads as
   unresolved. Phases 2–3 must pick a marker id scheme; a served point's
   time changes with level, so an id stable across zoom is not free.
   (Two `notes.rs` tests that linked to a store-held derived event were
   removed with the derived list.)
4. **Cost of a cold error series.** No by-id index for error frames, so
   a rebuild reads every frame of the capture once (`O(capture)`, under
   the serve budget, off the UI thread), then `O(new frames)` per serve.
   Not measured on a real capture (no perf reading this phase).
5. Pre-existing, not touched: ADR 0002 links ADR 0048 as
   `0048-no-lock-across-rebuild.md`; the file is
   `0048-no-model-lock-across-a-rebuild.md`.
1. **README's `Collapse Errors` tooltip string is still stale.**
   `apps/gui/src/TracePanel.tsx:691` reads "show a run of bus error
   frames as the one summary event the host coalesced it into" — the
   host-side coalescer that sentence describes was removed in phase 1.
   Left untouched: phase 3 owns the trace ("derived events leave the
   trace's event rows"), and the filter this button drives
   (`withoutErrorFrames`) is a plain row-type predicate, unrelated to
   the removed coalescer and functionally unaffected — only the tooltip
   text is wrong.
2. **README line ~3395** ("a kind that is noise until you go looking
   for it (bus errors) starts hidden everywhere") is also stale, but
   predates task 158 entirely (an earlier owner ruling, 2026-09-20,
   already made every kind — including bus errors — visible by default;
   `notes.ts`'s `defaultVisibleKinds` doc comment already says as much).
   Not touched: unrelated to this phase's diff.
3. Between phases 2 and 3, the Events panel still shows no bus-error
   section (phase 1's side effect 2, half-resolved: the plot has
   markers again, the Events panel does not yet).

## Status log

- 2026-09-23 — opened from the owner's observation; the 256 cap found
  (`MAX_RUNS`); owner ruled paging, the existing pyramid machinery and
  a paged Events section; the cumulative-count series settled by the
  overseer.
- 2026-09-23 — **Phase 1 (host: the error series) landed** on
  `task158-error-series` (off `fix-logger-grid-columns`), one commit.
  - `SignalOrigin::BusErrors`, keyed `SignalKey::bus_errors(bus)`, signal
    name `BUS_ERROR_SIGNAL` ("bus errors"), key prefix `sig.b…`; no
    listing reads it.
  - **Grouping.** `scan_chunk`'s `(message_id, extended)` grouping could
    *not* carry it as-is: an error frame's id is whatever the controller
    reported, so the by-id fetch cannot find a bus's error frames. The
    group key became `ScanUnit { Message{id, ext} | BusErrors }`; every
    error series in a batch shares one `BusErrors` group whose fetch is
    `TraceStore::scan_chunk(is error) + frames_at`, and each target takes
    the error frames on its own bus (`scan_error_chunk`). Budget charge
    for that unit is the chunk width (the scan reads every frame).
    Verified by `a_bus_error_series_and_a_decoded_signal_catch_up_in_one_batch`
    (one error fetch for two buses beside one message fetch).
  - **Running total.** Assigned at append under the lock, seeded from the
    cache's widen-only extent max (`error_count`), which survives a
    front-trim that empties level 0 and rides the manifest — so the count
    is exact and monotone across chunks, restore and eviction.
  - **Serve.** New thin command `bus_error_series(buses, fromSeconds,
    toSeconds, maxPoints) -> { series: [{t, v}], complete }` over
    `SignalCacheStore::bus_error_windows`, which ensures the error caches
    and runs the shared `serve_keys` (split out of `slice_many`). Chosen
    over widening `sample_signals`' query because the series is ruled
    unlisted (it would need a new flag on the plot's `SignalQuery` wire
    shape, the frontend's series key and all 28 `CacheQuery` literals),
    and phase 3's Events panel needs it outside any plot. rustdoc on the
    command and the store method states the delta property.
  - **Persistence/restore.** `PersistedSignal.bus_errors` (serde default);
    fingerprint `signal_fingerprint::bus_errors(bus)` (tag `E`, rule
    version 1). Restore judges it by the whole-set gates plus its own
    fingerprint; never parked; a rejected one counts toward `rebuilt` and
    the cold-rebuild announcement (`rebuild_progress` now counts every
    frame-filled cache). `invalidate_dbcs` skips it.
  - **Coalescer removed.** `ErrorRuns`, `ErrorRun`, `MAX_RUNS`,
    `COALESCE_GAP_NS`, `runs_as_events`, `label_for`/`description_for`,
    the emitter's `replace_derived` + `notes-changed`; `NotesStore`'s
    `derived` list, `replace_derived`, `clear_derived`. The store holds
    authored events only; `notes-changed` fires only on authored changes.
    Bus-health totals, rate and last-error kept in `ErrorTallies`
    (per-bus, bounded by bus count).
  - **Tests (in-process, no `#[ignore]`):** 11 new in `signal_cache`
    (counting, 50k-frame budget/exactness, 10,000 episodes, mixed batch,
    cold partial serve, persisted restore + keeps counting, rejected
    restore rebuilds partial-first to the same totals, clear, DBC change
    + sweep, front-trim keeps count); `bus_health` 7 coalescer tests → 5
    tally tests; `notes` 4 derived-list tests removed; `tests.rs`
    storm-export test rewritten (store refuses a bus-error event, file
    carries every error frame), coalescer-producer test removed.
    cannet-gui: 1388 passed, 0 failed.
  - **50,000-frame test readings** (25,000 errors/bus, 500 episodes/bus,
    150,000 frames): pyramid depth 7; levels served across the 9
    budget×window cases {0, 1, 2, 3, 4}. Served length per bus (full /
    tenth / hundredth window): budget 50 → 71 / 80 / 67; budget 200 →
    394 / 315 / 254; budget 2000 → 3126 / 2504 / 254. All ≤ 2 × budget.
  - **Experiments (falsifiability of the new tests):** (1) running count
    seeded at 0 instead of the extent → 4 tests fail (front-trim,
    persisted-restore, cold-partial, rejected-restore); reverted, green.
    (2) bus filter dropped from `scan_error_chunk` → 2 tests fail
    (counting, mixed batch); reverted, green.
  - Docs: ADR 0035 amendment (2026-09-23), ADR 0002 DS-5 paragraph + "on
    disk" table row, `signal_cache.rs` / `bus_health.rs` / `notes.rs`
    module docs, `signal_fingerprint.rs`.
- 2026-09-23 — **Phase 2 (plot markers) landed** on `task158-plot-markers`
  (off `task158-error-series`), one commit `5871aee0`.
  - **Windowed query.** New hook `useBusErrorMarkers` (`apps/gui/src/useBusErrorMarkers.ts`):
    single-flight, newest-wins, memoised against the last *complete*
    answer — the same lifecycle shape as `useDecimatedRange`, sized down
    (no base/winStart anchoring — a bus-error series has no per-signal
    y-extent or `winEnd`-parked-window concept to track). Driven from
    `PlotPanel`'s `onAreaResampled` (the rAF-coalesced callback that
    already runs `slideXWindow` once per frame from every area's own
    resample tick), not a new poller.
  - **Bus set: every session bus** (`useProjectContext().buses`, already
    destructured in `PlotPanel.tsx`), not the plot's own plotted buses.
    Reasoning: every other event kind on this panel is already
    session-wide — `plotTimelineEvents` draws every note regardless of
    which signals/buses this particular panel happens to plot — so
    scoping bus-error markers to "buses this plot's signals touch" would
    make them behave differently from every other marker kind for no
    documented reason, and would need re-deriving on every area/signal
    change. `project.buses` is also simpler: it doesn't go empty just
    because an area is momentarily signal-less.
  - **Point budget: the panel's own rendered width in pixels**
    (`panelRef.current?.clientWidth`, floored at 64), mirroring the
    series fetch's own choice (`PlotArea.tsx`'s `maxPts`, one point per
    canvas pixel). Panel width rather than a single area's canvas width,
    because this is one query for the whole plot — every area shares the
    x axis the markers draw on — and there is no single "the" area's
    canvas to ask.
  - **Marker construction** (`plotEvents.ts`): `busErrorTimelineEvents`
    walks a bus's served `(t, running count)` array from index 1,
    building one `TimelineEvent` per point with `id = bus-error:{bus}:{n}`
    (`n` the point's own value) and a label from the delta to the
    *previous* served point — so index 0 (the window's leading boundary
    sample) supplies the first marker's delta and draws no marker of its
    own, per the ruling. `busErrorMarkerLabel` formats count/span/rate
    (`formatDurationSeconds` for span, a fixed-precision `/s` rate).
    `plotEventsFromTimeline` generalises `plotTimelineEvents`'s
    projection (display-relative seconds, kind-color, visibility filter)
    to take a `TimelineEvent[]` directly rather than a `Note[]`, since a
    bus-error marker has no `Note` to derive from; `plotTimelineEvents`
    itself is refactored to call it (behavior-preserving — its existing
    tests are unchanged and still green).
  - **Merge, not a second renderer.** `PlotPanel`'s `events` (the
    `NoteEvent[]` `PlotArea` draws chips from) is
    `[T0, ...notes, ...busErrorMarkers]`. A second list,
    `allTimelineEvents` (`[...timelineEvents(sessionNotes, ...),
    ...busErrorEvents]`), feeds `eventHighlight` so a linked reference to
    a `bus-error:{bus}:{n}` id resolves — and lights the marker,
    including its extent band — whenever that point is in the currently
    served window; outside the window it reads as unresolved, the same
    as any other event id this list does not hold (`notes.ts`'s
    `linkedEventIds` doc already states that contract).
  - **Counts are a model fact, not a marker tally.** The Events chip's
    `busError` count is overridden after `countByKind` with
    `Σ_bus (last served value − boundary value)` — i.e. the sum of every
    marker's own delta, which is the actual error count the window
    covers. This differs from "number of markers" whenever the pyramid
    folded several errors into one served point at a coarse zoom level.
  - **Pending state.** `useBusErrorMarkers`'s state only updates on a
    successful fetch and is never cleared on a failed or superseded one,
    so a `complete: false` answer (still catching up) or a transient
    invoke rejection both just leave the last-known markers on screen —
    no empty flash.
  - **Tests**, red-then-green against the new production code:
    - `plotEvents.test.ts`: 8 new (`busErrorTimelineEvents` ×3,
      `busErrorMarkerLabel` ×3, `plotEventsFromTimeline` ×3 minus the
      shared one counted once — 33 tests total in the file, up from 25).
    - `useBusErrorMarkers.test.ts` (new file): 7 — empty start, no-op on
      a null/bus-less request, fetch fills state per bus, memoised no-op
      on an identical complete request (and a real re-fetch on a changed
      one), keeps asking while incomplete, single-flight/newest-wins
      under three overlapping requests, keeps the last markers across a
      failed fetch.
    - `PlotPanel.dom.test.tsx`: 5 new, in a `describe("bus-error
      markers", ...)` block — a 50,000-error serve renders a marker set
      ≤ 1200 (`2 × maxPoints` at the 600px test canvas), zooming into a
      slice below the point budget resolves individual ("1 bus error")
      markers where the wide view had folded several into each ("N bus
      error…") one, an exact 5-point fixture asserts the drawn labels
      match count/span/rate exactly and that the leading boundary point
      (t=2, before `fromSeconds`) draws no marker of its own, authored
      notes and bus-error markers appear together in one drawn list, and
      a `complete: false` answer still draws the markers it has.
    - `PlotPanel.dom.test.tsx` harness changes: added `bus_error_series`
      to the mocked `invoke` bridge (with a small windowing/decimation
      stand-in — bounded to `2 × maxPoints`, boundary sample kept each
      side — good enough to exercise the *frontend's* windowing and
      labelling; the pyramid's own decimation fidelity is
      `signal_cache.rs`'s tests, not this tier's), and a `buses` option
      on `renderPanel` (defaults to none, so no existing test's harness
      gained a new round-trip).
  - **A pre-existing flaky test noticed, not touched.** A full `pnpm
    test` run once showed `UnitCustomizations.scale.dom.test.tsx` fail
    under full-suite load (`expected 0 to be 21`) and pass both in
    isolation and on an immediate full-suite re-run (3694/3694 green). I
    did not touch that file; noted here rather than silently ignored.
- 2026-09-24 — **Phase 3 (Events panel and trace) landed** on
  `task158-events-section` (off `task158-plot-markers`), one commit
  `02fb8027`.
  - **The Events panel's bus-error section** (`apps/gui/src/BusErrorEventsSection.tsx`,
    `apps/gui/src/useBusErrorEvents.ts`): a paged gridview (ADR 0044) over the
    level-0 error series, one row per episode — bus, time, count and span
    from the delta to the previous served point, rate. Modelled on
    `ProjectCachesList.tsx` (plain rows over `arrayRowSpace`, not the shared
    column framework — nowhere to persist a resizable layout) rather than the
    virtualized trace/by-id shape, because `bus_error_series` has no
    index-addressable row space to page by offset; it is time-and-budget
    windowed only.
  - **How it pages.** The section's *window* is always `[sessionStartSeconds,
    now)` — "now" is never tracked client-side; `toSeconds:
    Number.MAX_SAFE_INTEGER` lets the host's own `window()`/`level_points`
    clip to the series' live edge, so the query is always "everything so
    far" without this view computing a model fact. The *point budget* starts
    at 100 per bus (`BUS_ERROR_INITIAL_BUDGET`) and **doubles, capped at 4000
    (`BUS_ERROR_MAX_BUDGET`)**, when the reader scrolls the section to its
    bottom edge and the last answer came back at-or-over budget (meaning the
    host still had more to resolve) — the same "zoom in to resolve" the
    plot's markers already do (phase 2), reached by growing a grid instead
    of panning a plot. Every row is a real served point — no interpolation,
    no approximated index — bounded strictly by what the current budget buys
    (CLAUDE.md § GUI architecture: never the whole series). Live-follows via
    `useWindowedQuery`'s existing `followLive`/`extentSignal` lifecycle,
    tied to `TraceLive.count`.
  - **Shared delta math.** `plotEvents.ts`'s `busErrorTimelineEvents` was
    refactored to build on a new exported `busErrorEpisodes` (bus, id,
    timestampNs, count, spanSeconds) — the one place the delta arithmetic
    lives now, so the plot's markers and the panel's rows can't disagree on
    what an episode is. Behavior-preserving refactor; `plotEvents.test.ts`'s
    existing `busErrorTimelineEvents` tests are unchanged and green, plus
    two new tests on `busErrorEpisodes` itself.
  - **Wiring into `EventsPanel.tsx`.** The section renders beside the
    existing whole-list Notes/comments section, gated by
    `kindFilter.visible.has("busError")` — the same Diagnostics-group
    checkbox every other event surface already offers, so toggling
    Diagnostics off hides the section along with whatever else is in that
    group. The checklist's own busError count is no longer read off
    `countByKind(allEvents)` (always 0 in production — the notes store holds
    authored events only since phase 1) but summed from `get_bus_health`'s
    per-bus `errorCount`, the same host truth the bus-health panel already
    reads. `sessionBuses` is `useProjectContext().buses` — every project bus,
    matching phase 2's "session-wide scope" reasoning for the plot's
    markers, not just buses some other view happens to be showing.
  - **Scroll restore.** `EventsPanel` now tracks its own `shownCount` via
    `props.api.onDidVisibilityChange`, the same pattern `SettingsPanel.tsx`
    uses — dockview detaches a hidden panel's element, so the section's own
    scroll offset needs putting back on return (`useScrollRestore.ts`).
  - **The trace was already clean.** `NotesStore` holds authored events only
    (phase 1), and `trace_query.rs`'s event-anchoring functions
    (`anchor_events_to_frames` / the windowed-trace counterpart) operate on
    whatever event list their caller hands them — nothing host-side hands
    them a derived bus error, so there was no merge path to remove. Verified
    by inspection (`git grep` across `apps/gui/src-tauri/src` and
    `apps/gui/src` for `busError`/`bus_error`/`BusError` turned up nothing
    beyond the kind constant, the theme color, the plot/panel consumers, and
    two now-fixed stale test fixtures) and by rewriting
    `TracePanel.dom.test.tsx`'s two tests that manufactured a synthetic
    `busError`-kind `Note` (a scenario the real host can no longer produce)
    to use the truncation marker instead — the one Diagnostics-group kind
    this whole-list surface can still carry. Error *frames* are untouched:
    `TracePanel error-frame collapse` (pre-existing, unedited) still covers
    `withoutErrorFrames`/Collapse Errors row filtering.
  - **Two stale strings fixed**, per the phase-2 handoff:
    `TracePanel.tsx`'s "View-local: whether a run of bus error frames
    reads as the host's one coalesced `busError` event row…" comment and
    the Collapse Errors tooltip ("show a run of bus error frames as the one
    summary event the host coalesced it into…") both described the removed
    coalescer; rewritten to describe the current plain row-type filter
    (`withoutErrorFrames`). Two more stale strings found in the same sweep
    and fixed as in-scope drive-by (both directly about the busError kind
    this phase's own diff touches): `notes.ts`'s `EventKind` module doc
    comment and `defaultVisibleKinds`' rationale comment both still
    described "the host coalesces a run of error frames into one summary
    event" — rewritten to describe the pyramid/episode model. The
    already-flagged README "starts hidden" line (README.md, the events
    passage) was also fixed per the orchestrator's direct "two stale
    strings flagged for you" instruction, which supersedes phase 2's own
    "not touched, unrelated" note on that same line — see the conflict
    logged below.
  - **README.** The Events panel passage (`README.md`, "Timeline events:
    kinds, filtering, and the events view") rewritten: it now describes two
    sections (whole-list Notes/comments; the paged bus-error section) rather
    than one uniform "whole event timeline", drops the false "bus errors
    starts hidden everywhere" claim (every kind has been visible by default
    since a 2026-09-20 ruling — `notes.ts`'s `defaultVisibleKinds` already
    said as much), and "Events view" → "Events panel" throughout that
    passage for the name the component and command palette actually use.
    The bus-health passage (README ~531–563) already described the
    pyramid/marker model accurately (phase 1/2's own doc pass) and named no
    coalesced runs — left untouched, nothing to fix there.
  - **DOM tests, red then green.** `EventsPanel.dom.test.tsx`'s new
    `describe("EventsPanel bus-error section", …)`: a mocked 50,000-error
    serve (a maxPoints-aware stand-in, ~2× the requested budget, mirroring
    `PlotPanel.dom.test.tsx`'s own 50,000-error harness) yields a bounded
    row set (asserted `< 1000` against the 50,000-episode window); scrolling
    the section to its bottom edge re-queries at a doubled point budget and
    renders more rows; rows carry bus/count/span/rate text; a `complete:
    false` answer still renders what it has and shows a "catching up…"
    indicator rather than going blank; authored events and the bus-error
    section list together; the section is absent (query never fires) with
    no session buses, but still says "No bus errors recorded." rather than
    disappearing outright — Diagnostics stays "nothing is hidden and
    unfindable" for an empty answer the same as a filtered-off one; the
    section hides on the Diagnostics checkbox, same as any other kind in
    that group. `useBusErrorEvents.test.ts` (new, 6 tests): the fetch
    lifecycle in isolation — inactive without buses, the exact window/budget
    the first fetch asks for, cross-bus chronological merge, `complete:
    false` handling, `growBudget` doubling with a hard ceiling, and
    "already at full resolution" once a served answer comes back under
    budget. `plotEvents.test.ts`: 2 new tests on `busErrorEpisodes`.
    Existing `EventsPanel.dom.test.tsx`/`EventsPanel.subjects.dom.test.tsx`/
    `eventHighlight.dom.test.tsx` needed a `ProjectContext.Provider` (new,
    since `EventsPanel` now calls `useProjectContext()`) and a real
    `api.onDidVisibilityChange` fake (since it now destructures `api` from
    props) added to every render helper in those three files — mechanical,
    no behavioral assertions changed there.
  - **A design decision recorded, not a groomed-decision conflict**: the
    task text says the section reads `bus_error_series` "with a time window
    and a point budget derived from the section's row space" through
    `useWindowedQuery`, naming the trace/by-id hooks as reference adapters.
    Those two adapters page a *host-index-addressable* row space (a real
    frame index, a real sorted-table offset); `bus_error_series` has no such
    address space, only `(fromSeconds, toSeconds, maxPoints)`. Implemented
    instead: `useWindowedQuery` supplies the fetch *lifecycle* (single-flight,
    descriptor memoisation, live-follow refresh, ADR 0049 partial handling)
    over a single always-`[sessionStart, now)` window whose *budget* — not
    an index range — is the thing that grows on interaction, matching
    `useByIdView`'s *structural* shape (external window state → descriptor →
    `useWindowedQuery` → one page) rather than its *index* semantics. This
    is the closest faithful reading that stays exact (no interpolated
    offset→time guessing) and bounded (CLAUDE.md's paged-view rule).
    Flagged for the owner below rather than landed silently.

## Exit criteria verdicts (2026-09-24, final)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | A capture with >256 bus-error episodes shows every episode on the plot at the zoom where it resolves; nothing is evicted | **Met** (phase 2) — `PlotPanel.dom.test.tsx`'s 50,000-error suite; host's `ten_thousand_episodes_each_resolve_on_their_own` (phase 1). Unaffected by phase 3. |
| 2 | The series is a signal-cache pyramid: persisted, restored with the capture identity, rebuilt off the UI thread when absent, swept and capped like them — host tests | **Met** (phase 1) — 11 `signal_cache` tests listed in the phase-1 log. |
| 3 | Any window served within the point budget at every level; consecutive points give exact count and span across three levels | **Met** (phase 1) — `fifty_thousand_errors_serve_within_budget_with_exact_deltas_at_every_level`. |
| 4 | `MAX_RUNS`, the coalescer and the whole-list derived-note broadcast gone; authored notes broadcast as before; bus-health totals unchanged | **Met** (phase 1) — removed with tests; reconfirmed in phase 3 by inspection (no code path anywhere reintroduces a merge of derived events into any store) and by `cargo test --workspace` staying green (1388 passed / 7 ignored in `cannet-gui`, 0 failed workspace-wide). |
| 5 | Plot markers, the Events panel's paged bus-error section and the trace behave per § Rulings — DOM tests | **Met (full, as of phase 3)** — plot markers (phase 2); the Events panel's paged section (this phase, `BusErrorEventsSection.dom.test.tsx`-equivalent coverage inside `EventsPanel.dom.test.tsx`, plus `useBusErrorEvents.test.ts`); the trace carries no derived bus-error rows (`TracePanel.dom.test.tsx`'s two rewritten tests, plus structural confirmation — `NotesStore` holds authored events only and `trace_query.rs` anchors whatever list it's handed) while error frames still show and collapse (`TracePanel error-frame collapse`, pre-existing, unedited, still green). |
| 6 | ADR 0035 and ADR 0002 describe the series family; README matches | **Met (full, as of phase 3)** — ADRs amended in phase 1; README's Events panel passage now describes the two-section shape and drops the stale "starts hidden" claim; the bus-health and Collapse Errors passages were already accurate (no change needed there). |
| 7 | Tests cover 1–5 | **Met (full)** — host tests (phase 1) cover 2–4 and the host half of 1 and 3; `PlotPanel.dom.test.tsx` (phase 2) covers the plot half of 1 and 5; `EventsPanel.dom.test.tsx` / `useBusErrorEvents.test.ts` / `TracePanel.dom.test.tsx` (phase 3) cover the Events-panel and trace halves of 5. |

Task complete 2026-09-24: 7/7 met. Awaiting owner acceptance (review queue § 4).
