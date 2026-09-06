# Task 142 — Fzf Filter in the Trace Panel

Opened by owner instruction 2026-09-11: "fzf filter in trace panel,
for both modes." Needs grooming.

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

## Open questions

1. What does a row's match text contain? Candidates: decoded message
   name, id (hex and decimal spellings), bus name, event text,
   signal names within the frame, data bytes. (The gridview pattern
   is: panels build the single string fzf matches against.)
2. Host-side scorer: port the fzf scoring to Rust, or accept a
   plainer host-side match for chronological mode while by-id gets
   full fzf? (Two dialects in one panel would be surprising — lean
   toward one behaviour.)
3. Does the query persist with the panel's view config (as mode /
   auto-scroll / columns do), or reset on close?
4. Live tail interaction: does the tail keep appending matching rows
   while a query is active (the filtered-trace behaviour), and what
   does auto-scroll follow?
5. Keyboard reach: does Ctrl/Cmd+F focus it when the Trace panel has
   focus (the Settings/Database precedent from task 141)?

## Exit criteria (draft — confirm at grooming)

1. A filter field in the Trace panel toolbar filters rows in both
   modes with fzf semantics consistent with the app's existing
   matcher; clearing restores the full view.
2. Chronological mode stays paged end to end with a query active:
   the frontend holds one page of *matching* rows plus the live
   tail; no unbounded accumulation, no JS filtering of the row
   space.
3. The fuzzy query composes with the sources filter, show-events,
   and collapse-error-frames.
4. Red-first tests at each layer (host matching/paging; DOM test for
   the field, both modes).
5. Docs: README trace section names the filter; CONTEXT.md if a new
   term is coined.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-11 — opened at owner instruction; not yet groomed.
