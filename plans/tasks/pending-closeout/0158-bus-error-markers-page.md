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

- **Episodes down to a minimum time window** (owner, 2026-09-24, on
  phase 3's growing-budget section): "it should be possible to see
  them down to some minimum time window (like 5 seconds, maybe user
  configurable, probably down to like 1s minimum.), and without losing
  details, such as they are — i.e. different _types_ of failures which
  occurred in a window, if we even have that detail. Individual bus
  faults don't seem valuable." Overseer's reading, settled from the
  code: an **episode** is a burst of errors on one bus separated from
  the next by at least the **episode gap**, a setting (`bus_error_episode_gap_s`,
  default 5, minimum 1); the Events section lists episodes, newest
  first, **paged by offset** over a host-held episode list per
  `(bus, gap)` derived incrementally from the level-0 series (bounded
  by capture time ÷ gap, rebuilt from the pyramid on restore off the
  UI thread); each row carries bus, first and last time, count, span
  and rate. Phase 3's growing point budget over the whole capture is
  replaced. **Failure types are not captured today**: `CanFramePayload::Error`
  carries no kind and the wire, spill and BLF reader flatten the
  controller's error code away — recorded under § Blockers as a
  follow-up, not this task's.

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
- **Event times read as wall time on hover** (owner, 2026-09-25, after
  phase 4: "events should show the wall time when you mouse over their
  timestamps like messages do"): every event row — the Events panel's
  authored events, the inline event rows in the trace views, and the
  bus-error episodes section — renders its time through the same
  `TraceTimeCell` the message rows use, so hovering it names the local
  date and time; a session with no wall-clock origin gets no tooltip,
  as for messages. No second implementation.

- **Plot markers are episodes, in the events' own style** (owner,
  2026-10-02, with a screenshot): a 20 s outage draws as a thick band of
  per-point markers, each labelled with a sub-millisecond delta ("1 bus
  error over 0.000277996 s (3597/s)"), and "they really don't look like
  any of the other events … a completely different visual style, which
  is not acceptable." Two episodes for the two outages read correctly in
  the Events section. Ruling: the plot draws **one marker per episode**
  at the configured gap — the same renderer, chip, gutter and line as an
  authored event, labelled with the episode's bus, count, span and rate,
  its extent drawn the way a linked pair's extent is — and no bus-error
  styling of its own. When a window holds more episodes than fit, the
  effective gap doubles until they do, so a long window reads as fewer,
  longer episodes rather than a cap. Phase 2's "one marker per served
  point" ruling is superseded.

## Open questions

(none — ruled 2026-09-23; plot markers re-ruled 2026-10-02.)

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
4. **Episodes at a minimum window.** The `bus_error_episode_gap_s`
   setting (descriptor, settings view, default 5 s, minimum 1 s); the
   host's per-`(bus, gap)` episode list derived incrementally from the
   level-0 series with a paged, offset-addressed serve (count known, so
   `useWindowedQuery` pages it like the trace); the Events section
   rebuilt on it, newest first, with the growing-budget query removed;
   a gap change re-derives; host and DOM tests; README's Events passage
   and the settings entry documented.
5. **Event times read as wall time on hover** (owner addition,
   2026-09-25). The trace views' event rows (`EventRow` in
   `TraceView.tsx`) and the bus-error episodes section render their
   time through `TraceTimeCell` (`traceTable.tsx`), the message rows'
   cell; DOM tests extend `traceTimeTooltip.dom.test.tsx` (an event
   row and an episode row show the local date and time on hover; no
   tooltip without a wall-clock origin). Frontend only.
6. **Plot markers are episodes** (owner ruling 2026-10-02; regroomed
   2026-10-02 from the code). The plot's bus-error markers already go
   through `plotEventsFromTimeline` as kind `busError` with the authored
   events' renderer, chip and gutter, coloured by their kind's token
   (`eventBusError`) as every kind is — there is no band drawing. The
   "thick bands" are the data source: one marker per served point at
   `maxPoints = widthPx`, so a 20 s burst of thousands lands one chip
   per pixel column. The phase changes what is asked for, not how it is
   drawn. Host: a windowed episodes query
   (`bus_error_episodes_in_window(buses, from, to, gapSeconds,
   maxMarkers)` → episodes intersecting the window, the effective gap in
   the reply) **derived from phase 4's per-bus episode list at the
   setting's gap**: the window is a binary search on that chronological
   list, and episodes at gap 2g are exactly the merge of adjacent gap-g
   episodes closer than 2g, so fitting `maxMarkers` is a merge-fold over
   the slice with the gap doubling until it fits — no level-0 walk, no
   per-zoom refold, the Events panel's list untouched; `complete` as the
   phase-4 page reports it. Plot: `useBusErrorMarkers` asks for episodes
   per visible range, not points; one marker at the episode's first
   error, its extent to the last error drawn as a linked pair's extent
   is, label "<bus>: N bus errors over S (R/s)", id
   `bus-error:{bus}:{lastOrdinal}` kept so links and highlight resolve;
   `busErrorSpans` and `busErrorTimelineEvents` go; the Events chip's
   kind checklist still hides them. `maxMarkers` is the panel width over
   one chip's minimum width. DOM tests: two bursts give two markers with
   the authored events' classes; a 50,000-error burst is one marker with
   its extent; a window of 400 one-second episodes at a 300-marker
   budget comes back at a doubled gap under budget with the effective
   gap reported; the kind filter hides them; the label. Host tests:
   window selection by binary search, the merge-fold equals a direct fold
   at the doubled gap, the burst. ADR 0035's amendment and README's plot
   passage say a marker is an episode.

7. **Episodes join the Events panel's one list** (owner ruling
   2026-10-02; groomed 2026-10-02, order ruled Q2: **chronological**).
   The Events panel is the trace view rendering only events (ADR 0035):
   a whole authored list in `EventRow`s, oldest first, following live,
   with a kind filter and a tag filter; the bus-error section
   (`BusErrorEventsSection.tsx`) is a second, host-paged grid, newest
   first, with its own row template and no selection. Phase 7 makes one
   list. Host: an `events_page(offset, limit, kinds, tagQuery)` command
   merging the authored events (`notes.rs`, whole) with every bus's
   episode list at the setting's gap (phase 4's `with_episodes`) by time,
   count known, bounded per ADR 0049 (`complete` while episodes still
   fold); a `version` the frontend watches bumps on a note change, an
   episode append and a gap change. Frontend: the panel pages it through
   `useWindowedQuery` like the trace; an episode is an `EventRow` of kind
   `busError` — time through `TraceTimeCell` (phase 5), label
   `<bus>: N bus errors over S (R/s)`, no ✎/× (derived events are not
   editable), **selectable**, so selecting one lights its extent on the
   plot (phase 6's transient extent becomes reachable; queue § 1 item
   resolves as "keep transient" if the owner agrees). A tag query hides
   episodes (they carry no tags; `matchesTagQuery` as it is). The
   section, its hook (`useBusErrorEvents`) and its CSS go; the
   "episodes at N s" hint becomes the Diagnostics kind row's tooltip.
   Links authored ↔ episode keep resolving by
   `bus-error:{bus}:{lastOrdinal}`. Branch `task158-events-merged` off
   `fix-trace-filter-feedback` (beneath `ci-fmt-check`). Host tests: the
   merge is chronological across notes and two buses, ties stable;
   paging by offset over 400 episodes and 5 notes; a note edit and an
   episode append bump the version; the kind filter excludes `busError`.
   DOM tests: one list with both row kinds in time order; an episode row
   has no edit controls and is selectable; a tag query hides episodes;
   the Diagnostics kind unticked hides them; scrolling pages (one page
   plus the live tail); the time cell's wall-time hover still holds.
   README's Events passage and ADR 0035's amendment say the one list.

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
7. Tests cover 1–5 and 8.
8. The Events section lists episodes at the configured gap (default
   5 s, minimum 1 s), pages by offset over the whole capture down to
   single episodes, and re-derives when the setting changes; the
   count of episodes is bounded by capture time ÷ gap — host and DOM
   tests.
9. Hovering the time of any event row — an authored event in the
   Events panel or a trace view, or a bus-error episode — shows the
   same local date and time a message row shows, through the same
   cell; no tooltip without a wall-clock origin — DOM tests.
10. The plot draws one marker per bus-error episode at the configured
    gap (doubled when the window holds more than fit), rendered by the
    same path and with the same classes as authored events, no style
    of its own; a 20 s burst of thousands is one marker with its extent
    — host and DOM tests.

11. The Events panel is one chronological, host-paged list of authored
    events and bus-error episodes; an episode row is selectable and not
    editable; the separate bus-error section is gone — host and DOM
    tests.

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
- 2026-09-24 — **Failure types are not available.** The owner asked
  that an episode keep "different types of failures which occurred in
  a window, if we even have that detail"; it does not: the core frame's
  error payload carries no kind, the sidecar reports only the
  controller's bus state (active / passive / bus-off), and the BLF
  reader flattens the error code. Surfacing it is a wire, spill and
  BLF-reader change — a task of its own, not this one.
- 2026-09-24: **One gap per bus is held at a time.** Two views asking
  at different gaps would rebuild each other's list on every serve.
  Today only the Events panel asks, and it always uses the setting.
- 2026-09-24: **An episode row's first time comes from the host's
  fold.** A front-trim keeps an episode it cuts through whole, so its
  first time and count can refer to errors whose level-0 samples are
  gone. The row stays true; only a link to a first error there would
  not resolve (links target the last error).
- 2026-10-02: **An episode's extent is not reachable from the UI yet.**
  It draws as a linked pair's does — only while the episode is lit — and
  today nothing lights one directly: plot chips take no hover, and the
  Events panel's bus-error rows set a grid cursor but not a selection.
  It shows when an authored event linked to the episode is selected.
  Phase 7 (episodes join the Events list) makes the rows selectable,
  which lights it.
- 2026-10-02: **At a doubled gap, a merged episode's id is its last
  error's**, so a link to an inner gap-`g` episode reads as unresolved
  while the window is zoomed out far enough to merge it, and resolves
  again when zoomed in. Same rule as before for anything outside the
  served window.
- 2026-10-02: Widening a slice at a doubled gap walks out of the window
  for as long as neighbours keep joining — `O(chain)` under the lock,
  bounded by the list (capture time ÷ gap). Not measured on a real
  capture.

## Status log

- 2026-09-25 — **Phase 5 opened** on the owner's addition after phase 4:
  event timestamps read as wall time on hover, as message rows do.
  Survey: message rows use `TraceTimeCell` (`traceTable.tsx`, from the
  trace-hover change #158); event rows (`EventRow`, `TraceView.tsx`)
  and the episodes section (`BusErrorEventsSection.tsx`) call
  `formatTimestamp` directly with no hover. Branch
  `task158-event-wall-time` off `task158-episodes`.
- 2026-09-25 — **Phase 5 (event times as wall time on hover) landed** on
  `task158-event-wall-time` (off `task158-episodes`), one commit
  `2ef0be83`, five files (+99/-9).
  - `EventRow` (`TraceView.tsx`) and the episode row
    (`BusErrorEventsSection.tsx`) render their time through
    `TraceTimeCell` (`traceTable.tsx`), class names and text unchanged;
    the cell itself is untouched, so the no-wall-clock rule comes with it.
    `EventRow` is the one renderer behind the Events panel's authored
    events and the trace views' interleaved event rows.
  - Tests, red then green: `traceTimeTooltip.dom.test.tsx` "the trace
    view's event row" (hover names the local date and time; a null base
    gives no title); `EventsPanel.dom.test.tsx` "EventsPanel bus-error
    section" (two cases on the existing `hostEpisodes` fixture, with a
    wall-clock session start added for them). Falsified by reverting the
    two production edits: both pairs failed, then passed restored.
  - README's time-column sentence extended to event rows and bus-error
    episodes; no ADR change (the model is unchanged).
  - Verification: frontend suite 3712 passed, build green, grep clean;
    Rust lanes unreachable (no `.rs` touched). No side effects, nothing
    queued.
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
- 2026-09-24: **Phase 4 (episodes at a minimum window) landed** on
  `task158-episodes` (off `task158-events-section`), one commit
  `c690af82`.
  - **Setting.** `bus_error_episode_gap_s`: default 5, `min: Some(1)` on
    the descriptor (`MIN_BUS_ERROR_EPISODE_GAP_S`), max 3600
    (`MAX_BUS_ERROR_EPISODE_GAP_S`) enforced in `validate` and stated in
    the help text. `Control::Int` has no max field; this follows the
    `float_mantissa_decimals` precedent. Surface **Trace**, next to
    `trace_show_events`: no settings row describes bus health, and Trace
    is the only surface with an events row. Kind Behaviour,
    UserOverridable.
  - **Where the list lives.** `SignalCache.episodes: Option<EpisodeList>`
    sits on the bus's error-series cache in `signal_cache.rs`, beside the
    level 0 it folds. The pure fold and paging are in the new
    `bus_error_episodes.rs`. The list is **held in memory, not
    persisted**. It is bounded by capture time ÷ gap, and rebuilding it
    is a sequential read of 16-byte level-0 samples with no decoding.
    Persisting it would add a manifest field and a validity rule for a
    derivation that already runs in about 6 ms per 30k errors. It is
    dropped with the cache on a clear, trimmed on a front-trim (episodes
    that ended before the mark), and started afresh when a serve asks
    at a different gap. The cache holds one gap at a time.
  - **Derivation.** The cursor is the next unfolded level-0 slot
    (absolute, so a trim doesn't move it). Each step folds at most
    `EPISODE_CHUNK_SAMPLES` = 16,384 samples per bus under one lock hold
    (ADR 0048). The serve catches the series up first, then folds within
    the same `ServeLimit` budget, at least one step per serve.
    `complete` is true only when the series is caught up and every list
    has reached level 0's end (ADR 0049).
  - **Serve.** `bus_error_episodes(buses, gapSeconds, offset, limit) ->
    { count, start, episodes: [{bus, firstT, lastT, count, span, rate,
    lastOrdinal}], complete }`. Newest first by first time, ties to the
    lower bus index. The page start is found by rank (binary search per
    bus), so a page costs `O(buses × log² n + limit)` at any offset. The
    gap is clamped to the setting's bounds in the command.
  - **Frontend.** `useBusErrorEvents(buses, gap)` is a thin adapter over
    `useWindowedQuery` (offset paging, `refresh: "window"`,
    descriptor `epoch:buses:gap`). A partial answer bumps
    `extentSignal`, so a stopped capture that is still rebuilding keeps
    being asked. `BusErrorEventsSection` is a fixed-height (8 × 22 px)
    virtualized row space on `traceViewport.ts`'s geometry. Rows show
    bus, first time, count, span and rate (the rate is served by the
    host). The id is `bus-error:{bus}:{lastOrdinal}`. The header reads
    "episodes at N s". The growing budget, `BUS_ERROR_*_BUDGET`,
    `growBudget` and the whole-capture window are removed.
    `plotEvents.ts`'s `busErrorEpisodes`/`BusErrorEpisode` were renamed
    `busErrorSpans`/`BusErrorSpan`, because the per-marker delta is not
    an episode in the new sense (CONTEXT.md).
  - **Tests.** Host: `bus_error_episodes` ×4 (gap rule incl. exactly-at-gap,
    just-under, trim, offset paging vs a whole sort over every offset);
    `signal_cache` ×8: bursts of known shape on two buses (counts,
    spans, ordinals, the id is a real sample), incremental in three
    appends equal to whole, gap change re-derives (100 ↔ 2 episodes),
    offset paging in pages of 7 equal to one page, 10,000 episodes at 1 s
    all present (count ≤ span ÷ gap + 1), restore rebuilds partially
    and then equals the original, clear, front-trim. `settings`: gap
    bounds. cannet-gui 1401 passed / 7 ignored.
    DOM/hook: `EventsPanel.dom.test.tsx` bus-error section ×7 and
    `useBusErrorEvents.test.ts` ×5 (offset paging over 10,000, fields,
    ids by last ordinal, newest first, scroll to the oldest single
    episode, gap change refetches from offset 0, quiet partial answer
    that keeps asking). The phase 3 tests pinned the growing budget and
    were replaced. No wait sits on a debounce path; the default
    `waitFor` ceiling applies.
  - **Red then green.**
    - Frontend: the new tests run against phase 3's section and hook
      failed 11 of 12. The one that passed, "no buses asks nothing", is
      a regression guard.
    - Host falsification (E1): with `<` changed to `<=` in the gap
      rule, 2 tests failed (the pure gap rule and store bursts).
    - E2: with the gap-change reset disabled, `a_gap_change_re_derives`
      failed.
    - E3: with the cursor skipping one slot per serve, 4 tests failed:
      incremental, paging, 10k, front-trim.
    - E3 as first written (cursor left at the chunk start) hung
      `all_episodes`, because the list never completes. The test
      binary was killed. That mutation is caught, but only as a hang.
  - **Cost on the 10,000-episode fixture** (30,000 errors, one bus, debug
    build, derivation plus a first page of 100): 6.2 / 6.4 / 6.3 ms
    over three runs.
  - Docs: README Events passage and a settings bullet; ADR 0035's
    2026-09-23 amendment now says "the plot has no gap rule" and has a
    bullet for list-at-a-gap (owner ruling 2026-09-24); CONTEXT.md adds
    **Bus-error episode**.
  - Release host: `target/release/cannet-gui.exe` (`tauri build
    --no-bundle`). No perf reading was taken.
- 2026-10-02 — **Phase 6 (plot markers are episodes) landed** on
  `task158-plot-episodes` (off `task158-event-wall-time`), one commit
  `e7006038` (first cut `8248c1f9`, amended in review).
  - **Host.** New command `bus_error_episodes_in_window(buses, fromSeconds,
    toSeconds, gapSeconds, maxMarkers) -> { episodes, gapSeconds,
    errorCount, complete }` (`sampling.rs`, wire `BusErrorEpisodeWindow` in
    `ipc.rs`) over `SignalCacheStore::bus_error_episodes_in_window`. It
    shares phase 4's catch-up and fold verbatim: the old body of
    `bus_error_episodes` became `with_episodes` (ensure caches, catch up,
    fold within the serve budget, then one lock hold handing the per-bus
    lists to a reader); both serves call it. The held list stays at the
    asked-for gap, so the plot and the Events panel (same setting) never
    rebuild each other's list.
  - **Fit** (`bus_error_episodes.rs`, pure): `in_window` is two
    `partition_point`s (last ≥ from, first ≤ to). While the count is over
    `maxMarkers` and some bus has more than one episode, the gap doubles,
    each bus's slice is widened by the out-of-window neighbours the wider
    gap joins to it (`widen` — without it a merged episode straddling the
    window edge would be cut short), and merged at the gap (`merge_at`).
    Result chronological, ties to the lower bus index. `errorCount` is the
    episodes' counts summed host-side (feeds the Events chip's
    Diagnostics count).
  - **Frontend.** `useBusErrorMarkers` asks for episodes (same
    single-flight/newest-wins/memo lifecycle); state holds the episodes
    (bounded by `maxMarkers`), the effective gap and `errorCount`.
    `plotEvents.ts`: `busErrorSpans`/`busErrorTimelineEvents`/
    `BusErrorSeries`/`BusErrorSpan` removed; `busErrorEpisodeEvents` (one
    `busError` `TimelineEvent` per episode at its first error, id
    `bus-error:{bus}:{lastOrdinal}`, label `<bus name>: N bus errors over
    S (R/s)` via `busErrorMarkerLabel`) and `busErrorEpisodeExtents`.
    `PlotPanel` passes the `bus_error_episode_gap_s` setting and
    `maxMarkers = floor(panel width / eventChipMinWidthPx())`; the Events
    chip count reads `errorCount`. Renderer, chip, gutter and colour
    untouched.
  - **Chip minimum width.** The chips are canvas-drawn, so no CSS holds a
    width. `PlotArea.tsx` now names `drawChip`'s padding
    (`CHIP_PAD_X_PX = 4`) and exports `eventChipMinWidthPx()` = 2 × that +
    one average character of the marker-label font (the same
    `MARKER_LABEL_WIDTH_SAMPLE` average `markerLabelWrapWidth` uses) —
    ≈ 13.7 px, so ≈ 43 markers on a 600 px panel (was 600).
  - **Extent.** Drawn exactly as a linked pair's: an `EventExtent` through
    `plotEventExtents` → `drawEventExtents`, **transiently**, while the
    episode is lit (active, or linked to the active event) — ADR 0056 § 3
    ("drawn … while one of the two events is selected or hovered; at rest
    there is no span"). Hidden with the kind.
  - **Tests.** Host (`bus_error_episodes.rs` ×5 new):
    `the_window_is_the_episodes_that_intersect_it` (binary search vs a
    linear filter over 300 windows), `merging_at_a_doubled_gap_equals_folding_the_errors_at_it`
    (2g/4g/8g over sliding windows, edge-straddlers included),
    `a_fifty_thousand_error_burst_is_one_episode`,
    `too_many_episodes_for_the_budget_double_the_gap_until_they_fit`
    (400 one-second episodes, budget 300 → gap 2, where every 1 s silence
    joins into one episode, equal to a
    direct fold at 2), `a_fit_across_buses_is_chronological_and_stops_at_one_episode_a_bus`;
    `signal_cache.rs` ×1 through the store
    (`a_plot_window_reads_the_episode_list_at_its_gap_and_fits_the_budget`:
    50,000-error burst → 1 episode, errorCount 50,000; 400 episodes →
    gap 2, ≤ 300; the paged list still 400 at gap 1). DOM
    (`PlotPanel.dom.test.tsx` "bus-error markers", rewritten, 5): asks at
    the setting's gap with `maxMarkers = floor(600 / eventChipMinWidthPx())`;
    two bursts → two chips whose chip ops (`fillRect, strokeRect,
    fillText`) and marker line equal an authored note's; a 50,000-error
    burst → one chip, no wash at rest, a 100 px→300 px wash once selected;
    Diagnostics row shows the host's `errorCount` and unticking hides the
    chips; `complete: false` still draws. No sleeps — every wait is a
    `waitFor` on the drawn result. `plotEvents.test.ts` (3 new, span tests
    removed), `useBusErrorMarkers.test.ts` (7, rewired to the episode
    reply).
  - **Falsification.** Host: `widen` disabled → the 2g-merge test fails;
    `first_t <= to` → `< to` → the window test fails. DOM: extents never
    lit → the 50,000 test fails; `maxMarkers = widthPx` → the request test
    fails; `counts.busError = 0` → the kind-filter test fails. All
    restored green.
  - **Docs.** ADR 0035's 2026-09-23 amendment: "Views read episodes at a
    gap" (rulings 2026-09-24 and 2026-10-02) and a "plot marker is an
    episode" bullet (doubling rule, transient extent). README: error-frames
    passage, the timeline-events category table row, the Events passage's
    "same list" sentence. `docs/CONTEXT.md` *Bus-error episode*: the plot
    draws one marker each. `notes.rs` `EventKind::BusError` doc.
  - Verification: cannet-gui 1407 passed / 7 ignored; clippy, fmt,
    rustdoc `-D warnings` clean; frontend 3710 passed (252 files), build
    green; comment-references grep empty.

- 2026-10-02 — **Phase 6 review fixes** (fix mode), amended into the one
  commit, now `e7006038` (was `8248c1f9`).
  - **A gap setting change refetches at once.** `PlotPanel`'s gap effect
    now calls `fetchBusErrorMarkers()` instead of only updating the ref,
    which the area-resample callback alone read, so a stopped capture
    nobody panned stayed at the old gap. DOM test "a gap setting change
    asks again at the new gap, with the window unmoved": after the mount's
    one-shot rebuild has settled (`settleMountedAreas`), the next request
    carries the new gap with the same from/to and no area resample.
    Experiment: with the call removed and the mount **not** settled, the
    test still passed — the mount's owed rebuild resampled twice
    (`plot.areaResampled` +2) and carried the new gap by accident.
    Settling first, the same mutation fails (`expected 5 to be 12`). With
    the fix restored it passes.
  - **`bus_error_series` removed**: the command (`sampling.rs`), its wire
    types `BusErrorPoints`/`BusErrorWindows` (`ipc.rs`) and its
    registration (`lib.rs`). No caller anywhere (`git grep` over the tree
    found only phase 1's test names). There was no frontend type left
    for it. `SignalCacheStore::bus_error_windows` kept.
  - Tip run: `cargo test -p cannet-gui` 1407 passed / 7 ignored;
    clippy `-D warnings`, `cargo fmt --check` and rustdoc `-D warnings`
    clean; `pnpm --dir apps/gui test` 3711 passed (252 files);
    `pnpm --dir apps/gui build` green; the comment-references grep is
    empty.

## Exit criteria verdicts (2026-09-25, final)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | >256 episodes all on the plot at the zoom where they resolve; nothing evicted | **Met** (phase 2): `PlotPanel.dom.test.tsx` 50,000-error suite; `ten_thousand_episodes_each_resolve_on_their_own` (phase 1). Unaffected by phase 4. |
| 2 | Series is a signal-cache pyramid: persisted, restored, rebuilt off the UI thread, swept, capped | **Met** (phase 1): the 11 `signal_cache` tests. |
| 3 | Any window within budget at every level; exact deltas across three levels | **Met** (phase 1): `fifty_thousand_errors_serve_within_budget_with_exact_deltas_at_every_level`. |
| 4 | `MAX_RUNS`, coalescer, whole-list derived broadcast gone; authored notes as before; totals unchanged | **Met** (phase 1). Workspace tests are green (2201 passed, 0 failed). |
| 5 | Plot markers, the Events panel's paged section and the trace behave per § Rulings (DOM tests) | **Met**. Plot: phase 2. Trace: phase 3. Events half: phase 4, which lists episodes paged by offset per the 2026-09-24 ruling (`EventsPanel.dom.test.tsx` "EventsPanel bus-error section", `useBusErrorEvents.test.ts`). |
| 6 | ADR 0035 and ADR 0002 describe the series family; README matches | **Met**. ADR 0035's amendment now also covers the list at a gap; README's Events passage and settings list are updated in phase 4. |
| 7 | Tests cover 1–5 and 8 | **Met**. Host tests: 1–4 and 8 (phases 1 and 4). DOM tests: 1, 5 and 8 (phases 2–4). |
| 8 | Events lists episodes at the configured gap (default 5 s, min 1 s), pages by offset over the whole capture down to single episodes, re-derives on a setting change; count bounded by capture time ÷ gap (host and DOM tests) | **Met** (phase 4). Host: `episodes_group_each_bus_at_the_gap_…`, `a_gap_change_re_derives_the_episodes`, `paging_episodes_by_offset_is_stable_and_newest_first`, `ten_thousand_episodes_at_a_one_second_gap_are_all_listed` (asserts count ≤ span ÷ gap + 1), `a_restored_series_rebuilds_its_episodes_off_the_serve`, `a_bus_error_episode_gap_outside_its_bounds_is_refused_and_reported`. DOM: pages 10,000 by offset, scrolls to the oldest single episode, re-derives on the setting change. |
| 9 | Hovering any event row's time — an authored event in the Events panel or a trace view, or a bus-error episode — shows the message row's local date and time through the same cell; no tooltip without a wall-clock origin (DOM tests) | **Met** (phase 5): `TraceTimeCell` is the sole time renderer for message, event and episode rows. DOM: `traceTimeTooltip.dom.test.tsx` "the trace view's event row" (2), `EventsPanel.dom.test.tsx` "EventsPanel bus-error section" (2 new). |

Task complete 2026-09-24: 8/8 met. Reopened 2026-09-25 for the owner's
addition (phase 5, criterion 9), landed the same day: 9/9 met. Awaiting
owner acceptance (review queue § 4).
- 2026-10-02 — owner test (20 s dongle unplug): the episode-gap setting's
  placement and maximum **accepted**; the count "seems fine" but is
  "maybe a bit misplaced in the Events panel"; and "it doesn't seem like
  it works — what looks like thousands of errors on the bus". Overseer
  reading: the Events section groups at the gap, but the plot's markers
  are still one per served point (phase 2, ruled before episodes
  existed) and so draw a 20 s burst as a wall of markers. Awaiting the
  owner's answer on where the thousands were seen before reopening;
  candidate phase 6: plot markers draw episodes.
- 2026-10-02 — owner answered with a screenshot: the thousands are on the
  **plot** (thick per-point bands, sub-millisecond delta labels); the
  Events section's two episodes match the two outages. Ruling recorded
  (§ Rulings): markers are episodes, in the authored events' own style.
  **Phase 6 opened**, criterion 10 added; task reopened. Branch
  `task158-plot-episodes` off `task158-event-wall-time`.
- 2026-10-02 — owner on the Events panel: "with the grouping working as
  it is, it would be totally fine for the error events to live in the
  same view as other events, so long as they get summarized properly and
  stably, which they do appear to be doing." Reading: the separate
  paged bus-error section goes; episodes join the Events panel's one
  list, in time order with the authored events, as one row kind among
  them. The list is host-paged already for episodes and whole for
  authored events (ADR 0035), so the merge is a host page over both.
  **Phase 7 to groom**; not yet opened.
- 2026-10-02 — criterion 10 **met** (phase 6, `e7006038`: one marker per
  episode through the authored events' path; host + DOM tests). Open:
  phase 7 (to groom) and the extent yes/no in the queue.
- 2026-10-02 — phase 7 groomed (above); owner ruled the one list's order
  **chronological** (Q2), as every trace-like view. Branch
  `task158-events-merged`.
- 2026-10-03 — **Phase 6 defect, fixed** (owner: "the bus error markers
  I was able to induce looked better, but I had to zoom in/out before
  it appeared"; "yes, fix now"). Root cause: the episode fetch ran only
  off an area resample (live-follow only) and a gap change, and
  `useBusErrorMarkers` dropped a repeat request for an unmoved window
  once complete — new errors inside it never showed. Fix on
  `fix-plot-marker-refresh` (off `ci-fmt-check`), one commit `f8b17451`:
  `PlotPanel` sums `useBusHealth()`'s `errorCount` over the plotted
  buses and asks again when it moves (the host's `bus-health-changed`
  fires on every poll tick a row changed); the sum rides the request
  key as `errorsSeen` (not sent). Red→green: hook test "same window,
  higher `errorsSeen` asks again"; DOM test "a bus fault asks again for
  the unmoved window" (settled mount, same from/to, one new request).
  Frontend 3722 passed (252 files), build green; no Rust touched.
  README marker passage: one sentence. Residual (not seen): on a still
  window a `complete: false` answer is re-pulled only on the next
  error-count move or resample.
