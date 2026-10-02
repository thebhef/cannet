# Task 147 — Collapse Database Items Under a Filter

Opened by owner instruction 2026-09-19 from user feedback (ungroomed
item 13). **Executes now, on the current stack.** Grooming in
progress.

## Why

From the feedback: "Not being able to collapse DBC items when a
filter string is present sucks." While the database view has a filter
string, branch nodes cannot be collapsed, so a filter that matches
broadly pins the whole tree open.

## Scope

To groom. The database view's branch nodes collapse and expand under
a filter the same way they do without one.

## Findings (2026-09-19 survey)

- Expansion is a per-node `Set<string>` owned by `DatabasePanel.tsx`
  (persisted to layout params beside the filter string). The shared
  filter slot (`gridviewFilter.tsx`, ADR 0044) computes
  `effectiveExpanded = expanded ∪ ancestorsOfMatches` while a query
  is active — a union the writer never sees, so a collapse on an
  ancestor of a match is either a no-op (id not in the user set) or
  a silent removal that only takes effect when the filter clears.
- Keyboard is worse: `ArrowLeft` on such a row neither collapses nor
  walks to the parent (`gridviewRows.ts`).
- The RBS panel (`RbsPanel.tsx`) has the same shape, with an inverted
  state model; one test there asserts today's behaviour on purpose.
  Task 142 (trace fzf filter) plans to copy the pattern, so the fix
  belongs in the shared slot before 142 inherits it.
- The union was deliberate (a deep match visible without unfolding
  the path); nobody wrote down what happens when the user then
  disagrees with it.

## Rulings

- **Regular collapse and expand keep working while the filter has a
  string in it** (owner, 2026-09-20). Nothing more. The use case is
  collapsing whole buses, DBCs or ECUs that are not interesting.
  Overseer's reading into mechanism: the auto-expand becomes a
  **one-shot write** into the ordinary expansion set when a query
  settles (ancestors of matches are added, so a deep match is still
  visible without unfolding the path), instead of a union applied on
  every read. After that the tree is the tree: the chevron,
  `ArrowLeft` and `ArrowRight` write the same set they always do, no
  separate override set, no hidden-match affordance, and clearing
  the filter leaves the tree however the user left it. The fix
  lands in the shared slot so the RBS panel inherits it and task
  142's trace filter starts from the fixed pattern; the RBS test
  that asserts the force-reopen is inverted.

## Phases

One phase, one branch: the slot change (`effectiveExpanded` read
merge replaced by a settle-time write into the view's expansion
set) with its unit test, the database and RBS panels wired to it,
tests inverted or added per the exit criteria. ADR 0044's
filter-slot paragraph amended.

## Exit criteria

- Typing a query still opens the path to every match.
- With the query still present, the chevron or `ArrowLeft` on any
  expanded row collapses it and removes its subtree from the rows;
  `ArrowRight` or the chevron reopens it; `ArrowLeft` on a collapsed
  row walks to its parent. Same as unfiltered.
- Editing the query opens the paths to the new matches and touches
  nothing else; clearing it leaves expansion as it is.
- Both the database panel and the RBS panel behave this way, through
  the shared slot; `RbsPanel.gridview.dom.test.tsx`'s force-reopen
  assertion is inverted; `gridviewFilter.dom.test.tsx` pins the
  settle-time write.
- The bounded-render guarantee (`DatabasePanel.dom.test.tsx`'s
  ev-zonal filtered render) still holds.
- ADR 0044 records the rule.

## Status log

- 2026-09-19 — task opened from ungroomed feedback item 13; grooming
  started.
- 2026-09-20 — ruled: regular collapse/expand keep working under a
  filter, nothing more (overseer's first cut with an override set and
  hidden-match counts was over-built and withdrawn). One phase cut;
  exit criteria drafted. Grooming complete.
- 2026-09-20 — phase implemented on `task147-collapse-under-filter`
  (commit `2ea32f86`). `gridviewFilter.tsx`'s `effectiveExpanded`
  read-merge is gone; `useGridviewFilter` instead takes an optional
  `onMatchesSettled` callback, fired once per settled query (from a
  `useEffect` keyed on the memoised `ancestorsOfMatches`) with the
  match ancestors. `DatabasePanel.tsx` and `RbsPanel.tsx` each fold
  those ids into their own expansion set the same way a chevron click
  does, and read that same set everywhere a row's open/closed state
  is asked for — no separate merged view. `gridviewRows.ts`'s cursor
  arithmetic needed no change: it already read `isExpanded` off
  whatever the adapter gave it, so unifying the read source was the
  whole fix. `RbsPanel.gridview.dom.test.tsx`'s force-reopen
  assertion is inverted (collapsing a match's ancestor mid-filter now
  removes it); `gridviewFilter.dom.test.tsx` and
  `DatabasePanel.dom.test.tsx` each gained a case pinning the same
  settle-then-collapse-sticks behaviour, plus a case pinning that
  clearing the query touches expansion not at all. ADR 0044 amended.
  Full frontend suite green (247 files / 3491 tests) and `pnpm build`
  green at the branch tip; Rust/cargo lanes unreachable (diff touches
  only `apps/gui/src` and `docs/adr/`). No deviation from the ruling.
- 2026-09-20 — review finding fixed (pre-amend `007441f4`): the seed
  effect was keyed on `ancestorsOfMatches`' object identity, memoised
  through `buildEntries`. For RBS, `buildFilterEntries` depends on
  `view`, which `useHostMirror` replaces with a fresh object on every
  `rbs-changed` / 500 ms poll tick, so a settled, unchanged query got a
  fresh-identity, same-contents ancestor set on every poll and the
  effect re-fired — reopening a row the user had just collapsed within
  500 ms. Fixed by comparing the ancestor set's contents (size +
  membership) against the last set the seed fired for, via a ref, and
  skipping when unchanged; clearing the query resets the ref so a later
  retyped query still seeds fresh. Added
  `gridviewFilter.dom.test.tsx`'s "does not re-fire the seed when
  entries rebuild but the settled matches don't change" (written first,
  watched fail against the pre-fix code with 2 seed calls instead of
  1). Full frontend suite green (247 files / 3492 tests), `pnpm build`
  green, comment-references grep clean.
