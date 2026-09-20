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
