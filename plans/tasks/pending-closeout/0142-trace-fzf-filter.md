# Task 142 — Fzf Filter in the Trace Panel

Opened by owner instruction 2026-09-11: "fzf filter in trace panel,
for both modes." Groomed 2026-09-20; **executes now.**

## Scope

An fzf-style fuzzy text filter in the Trace panel's toolbar,
narrowing the rows in **both** view modes — chronological and by-id.
Typing filters as-you-type; clearing restores the unfiltered view.
The panel's existing narrowing (the element's sources filter per
ADR 0056, show-events, collapse-error-frames) composes with it —
the fuzzy query narrows further, never replaces.

## Design notes (pre-grooming)

- The app already has one fzf matcher with settled semantics —
  `gridviewFilter.tsx`: contiguous, boundary-aligned matches score
  far above scattered ones, and a relative score floor drops the
  scattered tail. The trace filter must feel like that one, not a
  second dialect. `DatabasePanel` / `PaletteModal` fuzzy search are
  the other reference consumers.
- **The chronological trace is host-paged** (`useTrace` /
  `useFilteredTrace`; one page plus live tail — CLAUDE.md § thin
  views). Fuzzy-filtering in JS over one fetched page is wrong (it
  filters the page, not the row space), so the chronological mode
  needs the match to run **host-side over the row space**, the way
  the filtered trace already applies `fetchFilter`. That means a
  Rust port of (or equivalent to) the frontend scorer, or a groomed
  decision that a simpler host-side match (substring/subsequence)
  is acceptable there.
- The by-id snapshot is one row per id, host-paged and host-sorted
  (`useByIdView`) — small enough that either side could match;
  grooming decides whether it goes host-side for symmetry.

## Findings (2026-09-20 survey)

- **The app's fzf is the npm `fzf` package** (0.5.2), not a hand-rolled
  scorer; `gridviewFilter.tsx` adds the haystack, a relative floor
  (`MIN_RELATIVE_SCORE = 0.7`, a prefix cut on the score-descending
  list) and a 150 ms debounce. Tests pin laziness and one junk-match
  case, not scores or order — a port has no golden vectors to start
  from. Dialects already drift: `settingDescriptors.ts` duplicates the
  floor, `serverList.ts` has none, `PaletteModal`/`Combobox` use
  smart-case defaults.
- **Chronological narrowing is a materialised filter index** host-side
  (`trace_query.rs` `fetch_filtered_trace` over `cannet_spill::
  FilterIndex`, O(log n + page)), keyed on the serialised predicate: a
  predicate change rebuilds the whole index, so the debounce is
  load-bearing, not cosmetic. The predicate algebra (`filter.rs`:
  `all`/`any`/`bus`/`id_range`/`id_list`/`name_regex`/`signal_equals`/
  `error_frame`) narrows through `resolve_candidates` to an id-keyed
  `CandidateSet`; a leaf whose match text is a pure function of
  `(id, extended, bus)` + the DBC set is an `id_list` in disguise and
  rides the fast path with no per-frame scoring. A leaf over
  per-frame text (data bytes, values, timestamps) is un-narrowable.
- **What a row carries host-side** (`ipc.rs` `TraceFrameRecord`): id,
  bus *id*, direction, kind, data, decoded name/transmitter/signals.
  Only the frontend has the id spelling the user reads
  (`format.ts`, `can_id_format`), the bus *name* (but
  `fetch_by_id_page` already receives the name map), and **event
  rows**, which are frontend-merged from `useNotes` — no host
  predicate can see event text.
- **By-id is host-paged and host-sorted** (`useByIdView.ts` holds one
  page; ADR 0044 forbids JS fuzzy over a paged row space). It filters
  after full materialisation, so a fuzzy leaf there is one more
  `filter_map`. By-id is the cheap mode; chronological is the hard
  one.
- **Persistence precedent**: the database panel persists the live box
  text into dockview params only (not element config), selection
  excluded. `useElementPanel.persist(config, extra)` is the hook.
  `panel.find` (Mod+F) precedent: `RbsPanel.tsx` under `elementId`,
  three lines, with `GridviewFilterBox`'s `inputRef`.
- **No Rust fuzzy code or crate in the workspace**; `regex` is the
  nearest tool. `technology-inventory.md` records only the JS `fzf`
  decision. `backlog.md` already lists "host-side fuzzy search for the
  paged views" as the deferred item ADR 0044 acknowledged.

## Rulings

- **The haystack** (owner, 2026-09-20): bus, message, signal, and
  enum values; and event text. Overseer's reading into mechanism:
  - *bus* = the bus name (the host is handed the id→name map as
    `fetch_by_id_page` already is); *message* = the decoded message
    name, its transmitting ECU name (owner, 2026-09-20), and the id
    in both spellings (hex, decimal), since a hex id is how a message
    is most often named; *signal* = the message's signal names. These are id-keyed, so the leaf narrows to a
    candidate id set and rides the filter index with no per-frame
    work.
  - *enum values* = the value-table label of a decoded signal's
    current value. Matching the query against the DBC's value-table
    labels yields (signal, label) pairs; the leaf then narrows to the
    messages carrying those signals and tests each frame the way
    `signal_equals` does today — decode-dependent and per-frame, but
    bounded to the candidate ids, so the index stays cheap. Payload
    bytes, numeric values and timestamps are not in the haystack.
  - *event text* = the note/event body. Events are frontend-merged
    and no host predicate can see them, so the query also runs a JS
    `fzf` over the bounded event list (`gridviewMatches`, applied to
    `visibleEvents` before `buildEventMerge`). One JS matcher and one
    Rust matcher therefore coexist and must agree on floor and
    casing.

- **The scorer is an in-repo Rust port of fzf's scoring** (owner,
  2026-09-20), with the TypeScript `fzf` package as the oracle: a
  golden-vector test generated from the JS matcher over a fixture of
  real DBC names pins that both sides rank the same. No new crate;
  `technology-inventory.md` records the port beside the JS `fzf`
  entry.

Settled by the overseer from the rulings and the code, open to
reversal:

- **One app rule for floor and casing**: case-insensitive, relative
  floor 0.7 as a prefix cut on the score-descending list. Stated once
  (the frontend constant exported from `gridviewFilter.tsx`, the Rust
  side mirroring it), and `settingDescriptors.ts`'s duplicate floor
  reads the shared one.
- **The 150 ms debounce stays in the frontend** and only the settled
  query enters the predicate: the query is part of the filtered
  trace's descriptor, and a predicate change rebuilds the host's
  filter index.
- **Composition**: the fuzzy leaf is ANDed into the existing
  `fetchFilter` (`all` of sources, collapse-errors, fuzzy);
  chronological mode switches onto the filtered-trace path whenever
  a query is present, even with no other predicate.
- **Live tail and auto-scroll**: the existing filtered-trace
  behaviour, unchanged — the tail is the last page of *matching*
  rows, auto-scroll follows the newest match.
- **Persistence**: the live box text persists into dockview params
  only, as the database panel does; not into the element config or
  the project file.
- **Keyboard**: Mod+F (`panel.find`) focuses and selects the box when
  the trace panel has focus, the RBS panel's three lines.

## Phases

1. **Host**: `fuzzy.rs` port of fzf scoring with the golden-vector
   test (the fixture and expected ranks generated by a small script
   over the TS package, checked in); the `fuzzy` `TaggedPredicate`
   leaf in `filter.rs` with its candidate resolution (id-keyed text)
   and the decode-dependent enum-label test; wired into
   `fetch_filtered_trace` and `fetch_by_id_page` with the bus-name
   map; inventory entry. Rust tests only.
2. **Panel**: the shared `GridviewFilterBox` in the trace toolbar;
   the settled query into `fetchFilter` for both modes and the
   chronological switch onto the filtered path; the JS `fzf` over
   the event list; params persistence; `panel.find`; DOM tests for
   the box, both modes and the events; README trace section.

3. **Feedback while the filter works** (owner feedback 2026-10-02: "the
   filter in the traceview needs to give some feedback about what's
   happening"; groomed the same day). The box renders nothing while the
   host walks a new predicate's index — one blocking
   `ensure_active_filter_index` call per settled query — and nothing
   after. `GridviewFilterBox` takes an optional host-supplied
   `{ count, pending }` beside its browser-side `matchSet.size` count
   and renders `N matches`, or `searching…` while pending; the Database
   panel's count is unchanged. `useWindowedQuery` exposes `pending` as
   render state (today `fetching`/`pending` live in a ref the render
   never sees); `useFilteredTrace` passes it through and `TracePanel`
   hands `{ count, pending }` to the box while the filter is active, in
   both modes. No host change: the count is the page's `count` the hook
   already holds. **Ruled out** (owner, 2026-10-02, Q1): a progressive
   count during the index walk — that needs a resumable walk and a
   partial-answer protocol, and `searching…` covers the interval.
   Branch `fix-trace-filter-feedback`. DOM tests: typing shows
   `searching…` until the page lands, then `N matches` (singular at 1);
   clearing hides it; the chronological mode shows it too; the Database
   panel's count unchanged.

## Exit criteria

1. A filter field in the Trace panel toolbar narrows rows in both
   modes; a query over a bus name, a message name or id, a signal
   name, or an enum label finds the frames it should; clearing
   restores the full view.
2. The Rust scorer reproduces the TS `fzf` ranking on the checked-in
   golden vectors; the floor and casing rule is stated once and used
   by both.
3. Chronological mode stays paged end to end with a query active:
   one page of matching rows plus the live tail; no JS filtering of
   the row space; the host index is rebuilt at most once per settled
   query.
4. The query composes with the sources filter, show-events and
   collapse-error-frames; event rows are narrowed by the same query
   in JS.
5. The query survives a restart through dockview params and does not
   dirty the project; Mod+F focuses the box.
6. Red-first tests at each layer: host scoring and predicate; DOM
   tests for the field, both modes, events, persistence and Mod+F.
7. README trace section names the filter; CONTEXT.md if a term is
   coined.

8. While a query's rows are being fetched the trace toolbar reads
   `searching…` after the box, and once they land it reads the host's
   match count; nothing shows with the box empty — DOM tests.

## Blockers / side effects

- **The fzf port does not implement the package's `normalize: true`
  diacritic folding** (phase 1). fzf-for-js normalises the haystack to
  NFC and folds ~700 precomposed Latin code points to their base
  letter; reproducing that in Rust means either a new crate (the ruling
  forbids one) or ~700 lines of generated table in a 500-line module.
  The port instead ranks such text as `normalize: false` would. The
  reachable haystack is DBC identifiers (ASCII by the DBC grammar),
  arbitration-id spellings and ECU names, plus the project's bus names
  — a diacritic in a bus name is the only case, and there the host
  ranks it slightly differently from the frontend's event matcher.
  Case folding, which is what the app depends on, *is* ported in full
  and the golden vectors pin it. **Needs an owner yes/no** before
  close-out: accept the boundary, or reopen the no-new-crate ruling.
- **A bus rename now drops the active filter index**
  (`AppState::set_project_bus_names`). A bus *name* is part of a fuzzy
  leaf's haystack, so an index resolved against the old name would keep
  narrowing by it. The cost is a full filter-index rebuild on rename,
  which is rare; the alternative (a bus-name generation counter in the
  resolution memo) was not worth the machinery. Regression test:
  `renaming_a_bus_drops_a_filter_index_built_on_its_old_name`.
- **`FilterPredicate::matches` / `matches_fields` changed shape**: both
  now take a `&MatchContext` first and `matches_fields` takes
  `extended` (the id spelling in the haystack differs between an 11-bit
  and a 29-bit id of the same number). `cannet-perf-measurement`'s three
  call sites pass `EMPTY_MATCH_CONTEXT`; a fuzzy leaf evaluated against
  that matches nothing, the same rule an unparseable predicate follows.
- Phase 2 must export `MIN_RELATIVE_SCORE` from `gridviewFilter.tsx` as
  the app's one floor (the Rust side already names it in `fuzzy.rs` and
  the golden-vector generator asserts the two agree), and make
  `settingDescriptors.ts`'s duplicate read the shared one.


## Status log

- 2026-09-11 — opened at owner instruction; not yet groomed.
- 2026-09-20 — groomed: haystack ruled (bus, message, signal, enum
  values; event text in JS), scorer ruled (in-repo port, TS fzf as
  oracle); two phases cut; exit criteria confirmed. Added to this
  session's scope by owner instruction.
- 2026-09-20 — **phase 1 (Host) landed** on `task142-host-fuzzy`.
  - `apps/gui/src-tauri/src/fuzzy.rs`: fzf v2 scoring transcribed from
    the npm package's `algo.ts`, including its v1 fallback for a match
    matrix wider than the package's 100 KiB slab, its
    `casing: "case-insensitive"` path, and the score-descending /
    input-order tie rule its score-bucket concatenation produces.
    `MIN_RELATIVE_SCORE` + `above_floor` state the floor once.
  - Golden vectors: `apps/gui/scripts/fzf-golden.mjs` runs the TS
    package with exactly the options `gridviewFilter.tsx` passes over
    1585 real ev-zonal names (ECUs, messages, transmitters, signals,
    `VAL_` labels), 5 joined host-shaped haystacks, 3 bus names and one
    10 257-char synthetic that crosses the slab threshold; 21 queries.
    `apps/gui/src-tauri/fixtures/fzf-golden.json` is the checked-in
    result and the Rust test asserts **identical order and identical
    scores**, not just the cut. No JS-number quirk needed excusing.
    Falsification check: changing `BONUS_CAMEL_123` by one fails it.
  - `filter.rs`: the `{"fuzzy": "<query>"}` leaf, `FuzzyCandidate` /
    `FuzzyLabel` / `FuzzyResolution` / `MatchContext`, `fuzzy_queries`,
    and `CandidateInputs.fuzzy`. The leaf narrows through
    `resolve_candidates` like any other and is `membership: false`,
    because the same id can occur on two buses and the bus name is in
    the haystack.
  - `trace_query.rs`: `resolve_match_context{,_with,_against}` builds
    one `FuzzyCandidate` per `(bus, id, extended)` the capture has seen
    and one `FuzzyLabel` per `VAL_` row a *bus-assigned* database
    defines; both lists are ranked in **one** list under **one** floor.
    Wired into `fetch_trace_range`, `fetch_by_id_page` (which already
    receives the bus-name map) and `ensure_active_filter_index`, which
    caches the resolution beside `candidates` / `decode_ids` on the same
    key-generation memo.
  - `cannet-dbc` gained one borrowing accessor,
    `Database::message_transmitters()`, so building the haystack does
    not clone a rich descriptor per message.
  - **Why the resolution exists at all** (the design question the
    grooming did not settle): the floor is a *prefix cut on a ranked
    list*, so "does this frame match" is not answerable from one frame.
    Ranking therefore happens once per settled query and the per-frame
    test is a map lookup — which is also what makes the ruling's "no
    per-frame work" true. The enum-label half is the only part that
    reads a decode, and only for the ids defining a matching label:
    `only_the_enum_label_half_of_a_fuzzy_leaf_asks_for_a_decode` and
    `a_settled_fuzzy_query_resolves_once_however_often_its_pages_are_fetched`
    pin both halves.
  - Debugging note (scientific method). **Observation**: `cargo test`
    hung with no output, two `cargo` processes alive, no test result
    line. **Hypothesis**: `ensure_active_filter_index` holds
    `state.databases()` for its build and the new context resolver took
    the same `std::sync::Mutex` again — a re-entrant lock, which
    deadlocks rather than failing. **Experiment**: read the two lock
    acquisitions on the one call path; the hang is in the only test
    that reaches both (`a_settled_fuzzy_query_...`), and the earlier
    runs that did not reach it passed. **Data**: confirmed by
    inspection of the call path, and by the suite going green once
    `resolve_match_context_against` was split out to take the
    already-held `&[LoadedDbc]`. Not a port bug.
  - Rust only, as the phase says; the golden-vector script and fixture
    sit outside the app's tsconfig `include` and the vite entry graph,
    so the bundle is untouched (`scripts/frontend-gate.sh` green).
- 2026-09-20 — **phase 2 (Panel) landed** on `task142-trace-filter-panel`.
  - `TracePanel.tsx`: the shared `GridviewFilterBox` in the toolbar,
    beside the mode toggle (both modes narrow, so it isn't gated on
    `mode`). It borrows `useGridviewFilter` for the 150 ms debounce and
    the settled `query` only — the trace has no client-side row space,
    so `buildNoTraceFilterEntries` is always empty and `matchSet` /
    `ancestorsOfMatches` go unread.
  - `sinkPredicate.ts` gained `withFuzzyQuery` (same flatten-not-nest
    shape as `withoutErrorFrames`), ANDing the settled query onto
    `fetchFilter`; a blank/whitespace query leaves the predicate
    untouched (never sends `{fuzzy: ""}`). Reaches both
    `fetch_filtered_trace` and `fetch_by_id_page`, and — being non-null
    whenever a query is active — is what switches chronological mode
    onto the filtered-trace path even with no other predicate.
  - Events: `gridviewMatches` (the JS fzf, same floor and
    case-insensitive casing as the host leaf) runs over the bounded,
    kind-filtered event list before `buildEventMerge`; haystack is
    label + disclosed body.
  - Persistence: the live box text rides `useElementPanel`'s
    `extraParams` into dockview params only (`DatabasePanel`'s
    precedent) — never the element `config`, so it can't dirty the
    project. `panel.find` (Mod+F) focuses and selects it, the
    RBS/Database panels' three lines.
  - Closed phase 1's Blockers obligation: `settingDescriptors.ts`'s
    `MIN_RELATIVE_SCORE` duplicate now imports the constant
    `gridviewFilter.tsx` already exported, rather than restating it.
  - Added the `fuzzy` leaf to the frontend `FilterPredicate` union
    (`types.ts`) — phase 1 was Rust-only and didn't touch it.
  - `README.md`'s trace section names the filter; no new term coined,
    so `CONTEXT.md` is untouched.
  - Red-first DOM tests (`TracePanel.dom.test.tsx`): settled-value-only
    wiring in both modes, the empty/whitespace box omitting the leaf,
    composition with an existing filter, the chronological switch,
    event narrowing (label and body), params persistence across a
    remount without touching element config, and Mod+F.
  - The diacritic-folding boundary (phase 1's Blockers, still open in
    `plans/owner-review-queue.md`) is unaffected by this phase — no new
    owner decision raised here.
- 2026-09-21 — owner accepted the diacritic-folding boundary: the
  Rust port ranks as `normalize: false`; a diacritic in a bus name is
  the one case, and it stands. Queue item dropped.
- 2026-10-02 — owner feedback: the filter needs feedback about what is
  happening. Groomed as phase 3 / criterion 8 (count + `searching…`;
  progressive count ruled out, Q1). Task reopened for it.
- 2026-10-03 — **Phase 3 (feedback while the filter works) landed** on
  `fix-trace-filter-feedback` (off `task158-plot-episodes`), one commit
  `82693c13`. Agent's status text follows (condensed).
  - **What landed.**
    Trace filter box shows `searching…` while the host walks a new query's
    index, then the host's own match count (singular at 1), in both
    chronological and by-id mode (`GridviewFilterBox.hostMatches`,
    `useWindowedQuery`'s new `pending`, piped through `useFilteredTrace` /
    `useByIdView` into `TracePanel`). This was already implemented and
    reviewed; this session's job was fixing one defect the by-id test
    exposed, answering a code question it raised, and running the checks.
  - **The hang — cause and fix.**
    **Observation.** `TracePanel.dom.test.tsx`'s "reads searching… then the
    match count — by-id mode too" never terminated: killed at 120 s with no
    output, run alone. Every other test in the file passes in ~5 s.
    **Hypothesis.** The fixture's `byIdPageGate`/`filteredTraceGate` returns
    the *same* `Gate.promise` for every `fetch_by_id_page` (or
    `fetch_filtered_trace`) call while the gate variable is set — not just
    the one call it was meant to hold open. Once the test resolves it, every
    later call to that command gets the same already-settled promise back
    synchronously.
    **Experiment.** Read `useWindowedQuery.ts`'s `load()`: a descriptor
    change resets the window to empty and fetches page 0; `ByIdTable`'s
    prefetch effect (`ByIdTable.tsx:201-204`) calls `ensureVisible` whenever
    `count`/`ensureVisible` changes, with no `autoScroll` guard (unlike
    `TraceView.tsx:470-473`, which skips the call outright while
    auto-scrolling — `TracePanel.tsx:452`'s chronological path routes
    through that guard, which is why the chronological twin of this test
    doesn't hang). The test's by-id gate resolved with
    `{ count: 2, start: 0, rows: [] }` — 2 claimed, 0 delivered. `ensureVisible`
    sees `win.rows.length (0) < end` and calls `load()` again; the already-
    resolved gate promise answers instantly (microtask, not a macrotask),
    `ByIdTable`'s effect fires again on the new `win` identity, and the
    cycle repeats as a tight synchronous microtask recursion that never
    yields to Node's timer phase — hence no vitest per-test timeout firing,
    and 120 s of silence.
    **Conclusion.** Root cause confirmed: the fixture's gate wasn't one-shot,
    and the gated reply was internally inconsistent (`count` > `rows.length`)
    for a view whose prefetch effect has no guard against re-asking. Fixed
    both halves:
    1. `TracePanel.dom.test.tsx`'s `invoke` mock: the gate is now consumed
       by the first matching call after it's set (`filteredTraceGate = null`
       / `byIdPageGate = null` immediately on that call), falling through to
       the normal fixture for every later call. Tests that resolve a gate
       now capture it in a local `const gate` before firing the triggering
       event, since the shared module-level variable is cleared as soon as
       the gated call lands.
    2. The by-id gate's resolved payload now carries two rows consistent
       with its `count: 2` (`byIdRow(0x100)`, `byIdRow(0x200)`, a minimal
       `ByIdSnapshotRecord`) instead of `rows: []`, so the by-id view's
       loaded page actually covers what `ensureVisible` asked for and the
       prefetch effect has nothing left to chase.
    No production code changed for this fix — it was a test-fixture defect.
  - **The code question: can production refetch unboundedly?.**
    **No.** Read `trace_query.rs::fetch_by_id_page_inner` (lines 508-580):
    `count` and the returned `rows` are both derived from the same in-memory
    `snaps` vector within one call — `count = snaps.len()`, `rows =
    snaps.skip(off).take(lim)` — so a single reply is always internally
    consistent: `rows.length == min(count - start, limit)`. There is no path
    in the host command that trims rows independently of the count it
    reports in the same response.
    The only place `useWindowedQuery` can let `count` (`win.fetchedTotal`)
    drift from the loaded `rows` is the count-only stale refresh (`load(0,
    false, true)` in the throttled-tick effect, `useWindowedQuery.ts:259`),
    which updates `fetchedTotal` alone. For by-id (`useByIdView.ts`) that
    path requires `!followLive && !extentKnown` — true while paused, since
    `extent` is never passed — but it only fires when `dirty` is set, and
    `dirty` is only set when `extentSignal` or `followLive` changes
    (`useWindowedQuery.ts:241-243`). By-id's `extentSignal` is `winEnd +
    (running ? 0 : 1)` (`useByIdView.ts:126`); while paused (`running ===
    false`) that's `winEnd + 1`, constant unless `winEnd` itself moves. So a
    paused, static by-id snapshot never re-arms `dirty`, the count-only tick
    never fires, and `count`/`rows` can't desync. While running, the
    `followLive` branch always does a full-row fetch (`refresh: "window"`),
    never a count-only one, so the two stay in lockstep there too.
    Conclusion: the by-id view cannot refetch unboundedly in production —
    the host's own response is always self-consistent, and the one
    mechanism that could introduce a count/rows mismatch is inert for this
    view while paused and bypassed while running. No code change made; this
    is a test-fixture-only defect.
  - **Item 3 — `pending` transitions.**
    Confirmed by reading `useWindowedQuery.ts`: `setPending(true)` is called
    only in `load()` when a fetch is kicked off or when a request gets
    queued behind one in flight; `setPending(false)` is called only in the
    `finally` block when no further request is queued. No other call site
    sets it, so it cannot flip on a steady-state render. `useByIdView.ts`'s
    only change is destructuring `pending` out of `useWindowedQuery` and
    passing it through on the returned `ByIdView` — no new logic. The
    existing (this phase's) `useWindowedQuery.test.ts` cases "reports
    pending while a fetch is in flight, clearing once it resolves" and
    "supersedes a pending fetch rather than dropping the request — pending
    stays true throughout" exercise exactly this and pass.
  - **Checks (scoped per-phase tier — frontend + README only).**
    | Check | Command | Result | Duration |
    |---|---|---|---|
    | Targeted vitest | `timeout -k 5 240 pnpm --dir apps/gui exec vitest run src/TracePanel.dom.test.tsx src/useWindowedQuery.test.ts src/gridviewFilter.dom.test.tsx --testTimeout=10000` | 77/77 passed (3 files) | ~10 s |
    | Full frontend test suite | `timeout -k 5 540 pnpm --dir apps/gui test` | 3720/3720 passed (252 files) | ~94 s |
    | Frontend build | `timeout -k 5 540 pnpm --dir apps/gui build` | built, `tsc -b && vite build` clean | ~7 s |
    | Rust / Python | — | skipped — diff is frontend + README only | — |
    | `comment-references` grep | `git grep --untracked -Ein "task [0-9]|plans/" -- apps/ crates/ clients/` | empty (clean) | — |
  - **Beyond the fixture.**
    Only the test fixture (`TracePanel.dom.test.tsx`) and this status file
    changed. No production code (`useWindowedQuery.ts`, `useByIdView.ts`,
    `useFilteredTrace.ts`, `TracePanel.tsx`, `gridviewFilter.tsx`,
    `index.css`, `README.md`) was touched beyond what phase 3 already had —
    the code question's answer is "no defect," so nothing there needed a
    guard.
- 2026-10-03 — criterion 8 **met** (`82693c13`; DOM tests in
  `TracePanel.dom.test.tsx`, `gridviewFilter.dom.test.tsx`,
  `useWindowedQuery.test.ts`). Task back to pending closeout.
