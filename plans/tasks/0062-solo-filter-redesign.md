# Task 62 — Solo Filter Redesign

Opened 2026-08-09 from owner feedback on live use ("I don't really
get visibility on what indices are produced or which ones are showed…
I would like things that don't match the regex at all to not be
solo'd / for it only to apply to the areas with matches"), after a
semantics map of the current implementation (2026-08-09) confirmed
the behaviors behind each symptom. Groomed to completion 2026-08-09;
slotted first in the roadmap by owner directive 2026-08-09
("implement 0062").

## Current semantics (mapped 2026-08-09)

- One solo per panel (`SoloState` in `plotSolo.ts`), matching the
  **bare signal name only**, case-insensitive — while area patterns
  match the full `bus/ecu/message/signal` path case-sensitively (two
  regex dialects in one panel).
- Solo masks **panel-wide**: a zero-match area is force-hidden
  entirely and collapses (`collapsedBySolo`); a zero-match pattern
  blanks the whole panel (currently pinned by a dom test as
  intended).
- Stepping is a single-match cursor over one flat panel-wide match
  list — no pages, no "all" re-entry: from `1/3`, PgUp wraps to the
  last match. The all-visible label (`3`) vs last-match label (`3/3`)
  is ambiguous by the module's own doc comment. Escape/× clears the
  pattern entirely.
- Feedback: one toolbar counter + a right-click-only match menu; a
  solo-hidden row styles identically to a user-hidden row.
- `solo_page_size` setting (default 1) added 2026-08-09 as a stopgap
  stepper knob; this redesign gives it its real meaning (groups per
  page).

## The groomed design (owner rulings 2026-08-09)

### 1. Scope — zero-match areas are untouched

Solo applies only to areas with at least one match; an area with
none renders exactly as if solo were off — no masking, no collapse.
A pattern matching nothing anywhere therefore touches nothing (the
dom pin asserting today's blank-panel behavior flips deliberately).

### 2. Match subject — the pattern dialect, exactly

Solo matches the full `bus/ecu/message/signal` path, case-sensitive
— identical to the area-pattern regex dialect. One regex language in
the panel. Unanchored regexes still match bare names as the path's
tail, so quick name filters keep working. (Rejected: bare-name-only
(today), and a case-insensitive hybrid.)

### 3. Stepping — group-by-capture, paged, with All in the cycle

- **Group key**: if the regex has capture groups, each match's key
  is the captured text; distinct keys form the step sequence. One
  step highlights every signal sharing the key, across all areas
  (`Cell(\d+)` steps by cell index). No capture group → each matched
  signal is its own group (positional stepping).
- **Key ordering**: numeric-aware ascending per component (Cell2
  before Cell10). Multi-group keys are tuples; priority is
  declaration order, overridable by a `$N` ordinal suffix in a named
  group's name — `Cell(?<cell$2>\d+)_Bank(?<bank$1>\d)` makes bank
  primary. The suffix is stripped for display; ordinal-less groups
  follow the ordinal-carrying ones in declaration order; `(?:…)`
  opts a group out of the key. (Identifier note: JS group names
  cannot start with a digit but may contain `$`.)
- **Pages**: a page is `solo_page_size` consecutive groups (default
  1). With `Cell0*(\d+)` and page size 5, page 1 = cells 0–4, page 2
  = cells 5–9 — the range-bucketing the owner attempted with
  `Cell0*([0-4]||5-9])` falls out with no special regex.
- **Cycle**: All → page 1 → … → page N → All. PgDn from All → page
  1; PgUp from page 1 → All; wrapping past the last page returns to
  All. **Entering or modifying the pattern lands on page 1** (owner
  detail). Escape/× keeps clearing the pattern entirely; ‹ › follow
  the same cycle.
- **Labels**: always two-form and unambiguous — `all (96)` vs
  `2/12 · cell=07 (16 of 96)` (named), `2/12 · "07" (…)` (unnamed),
  ranges as `1/2 · "0"–"4" (40 of 96)`. The bare-number form dies.

### 4. Visibility feedback (all four approved)

1. Solo-masked rows styled distinctly from user-hidden rows (a solo
   marker, not the plain hidden treatment).
2. A per-area match chip while solo is active (`3 of 12 match`);
   zero-match areas show nothing — they are untouched.
3. The toolbar readout is the aggregate two-form label, with an
   explicit `no matches` state.
4. Left-click on the position label opens the match menu
   (right-click stays).

### Design consequences (recorded, not separately asked)

- Restored solo state against a catalog that has not yet populated
  pattern rows is no longer a blank-panel hazard (zero matches →
  untouched panel); a restored page index past the end clamps to the
  last page.
- Persisted solo state becomes `{pattern, page}` (a page of group
  keys, not raw match indices).

## Exit criteria

- Zero-match areas render untouched under an active solo (dom-tested
  both ways: matching area masked, zero-match area identical to
  solo-off); a zero-match pattern touches nothing and the toolbar
  shows `no matches`.
- Solo and area patterns share one regex dialect (path,
  case-sensitive), pinned by a test that runs the same regex through
  both.
- Group-by-capture stepping: keyed grouping, numeric-aware ordering,
  `$N` ordinal override, `(?:…)` opt-out, tuple keys — each
  pure-function tested; paging honors `solo_page_size`; the
  All-cycle and enter-lands-on-page-1 rules dom-tested.
- The four feedback surfaces land (distinct solo styling, per-area
  chip, two-form/no-matches readout, click-to-open match menu),
  dom-tested.
- Stale-restore behavior: page past end clamps; pre-catalog restore
  leaves the panel untouched until matches exist (dom-tested).
- Docs updated where solo behavior is described; ADR only if a
  boundary proves hard-to-reverse (grouping semantics are view-local
  and revisable — default is no new ADR).
