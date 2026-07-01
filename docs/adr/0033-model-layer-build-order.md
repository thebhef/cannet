# ADR 0033 — Build a model layer's dependencies before the layer itself

Status: accepted (2026-06-27)

## Decision

The host model is layered: some stores depend on others (decoded-signal
caches, RBS message resolution, and plot labels all read the loaded DBC
set). A layer — and any view that reads it — is set up only **after** the
layers it depends on are fully populated. Never concurrently.

Project open applies this, each stage awaited before the next:

1. **DBC set** — the decode dictionary everything below resolves against.
2. **RBS elements** — resolve messages against it.
3. **Views / layout.**
4. **Replayed capture** (ADR 0002 DS-7) — sampled against the full set.

## Why

A layer read before its dependencies are in place doesn't error — it
computes a wrong result (an empty decode against a not-yet-loaded DBC)
and **caches it**. There is no correct result to compute against a
dependency that isn't there yet, so ordering is the fix; awaiting it is
simpler and more obviously right than making every dependent view
re-validate as the dependency fills in.

This is the model-side complement to "thin views over a paged model"
(CLAUDE.md § GUI architecture): the model must be whole before a view
reads it.

## Consequences

- `applyProject` is async and sequenced by dependency; new open steps slot
  in by what they depend on.
- The project / RBS / DBC disk-watch reloads follow the same order when
  rebuilding dependent state.
- Setting up a layer waits on its dependencies — the accepted cost of never
  caching a result computed against a half-built one.
- The same rule applies to a dependency that changes **after** open, not
  just ordering during it. The decode dictionary (the DBC set) can change
  in-session — a DBC loaded, removed, re-scoped to different buses, or
  auto-reloaded from disk — and the layers below it cache lazily, each
  advancing its own decode cursor to the store tip and never revisiting a
  frame. So any DBC-set mutation **drops** the derived decode state (the
  per-signal decoded-sample caches and the active filter index) to force a
  rebuild against the new set. Without this, a frame the old set couldn't
  decode is skipped forever; on a stopped/reloaded capture (no new appends
  to trigger a rebuild) the plot and filtered view stay empty or partial.
  Ordering fixes open; clear-and-rebuild-on-change fixes the rest.
