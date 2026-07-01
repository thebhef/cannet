# Task 27 — Live Disk-Watch for Project & RBS Files

Generalize the DBC auto-reload watcher (`apps/gui/src-tauri/src/dbc_watcher.rs`)
so that an externally-edited **project (`.cannet_prj`)** or **RBS
(`.cannet_rbs`)** file is picked up automatically, the same way a loaded
DBC already is. Today only DBCs are watched; project and RBS files
require a manual reload.

Reuse the existing watcher's semantics (parent-dir watch + refcount,
re-read + re-parse on any relevant event, parse failures log and leave
the in-memory copy intact, deletions don't unload). The hand-written
surface should stay small — register the project/RBS paths with the
same watch set and route events to the existing reload commands.

An ADR should be captured about reloading files.

## Scope

- Project file: re-read and reconcile on external change.
- RBS file: re-read via the existing `.cannet_rbs` load/reload path
  (`rbs.rs`), preserving run/stopped state per the load contract.
- Emit the appropriate frontend change event so open panels refresh.
- **Fix the existing DBC propagation gap.** Today a DBC auto-reload
  fires (`auto-reloaded DBC …` logs, `dbc-changed` emitted) but edits to
  enum value *names* (`VAL_` value descriptions) don't reach the RBS or
  plot views. Leads (unconfirmed): RbsPanel listens for `rbs-changed`,
  not `dbc-changed`, so confirm `rbs::refresh_all_elements` actually
  re-fetches enum labels; and `state.signal_caches` is not cleared in
  `reload_one` (`dbc_watcher.rs`), so stale decoded/label state may be
  served. The right propagation/invalidation contract here is the
  reference for the project/RBS watches above.

## Exit criteria

- Editing a loaded `.cannet_prj` or `.cannet_rbs` on disk updates the
  GUI without a manual reload.
- A transient broken parse leaves the working copy intact (matches DBC
  behavior).
- Editing an enum value name (`VAL_`) in a loaded DBC on disk updates
  the label shown in the RBS and plot views without a manual reload.
  Driven by a failing test that renames a `VAL_` entry and asserts the
  new label surfaces.
- Tests cover the reload-and-swap pipeline for both file types.
