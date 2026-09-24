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

## Blockers / side effects

(none yet)

## Status log

- 2026-09-11 — opened at owner instruction; not yet groomed.
- 2026-09-20 — groomed: haystack ruled (bus, message, signal, enum
  values; event text in JS), scorer ruled (in-repo port, TS fzf as
  oracle); two phases cut; exit criteria confirmed. Added to this
  session's scope by owner instruction.
