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

The reload contract is written down in
[`docs/adr/0053-reload-when-it-applies-and-what-it-tells.md`](../../docs/adr/0053-reload-when-it-applies-and-what-it-tells.md)
— when a disk change is applied, and what a reload must tell.

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

## Grooming notes (2026-08-19)

Grilled with the owner ahead of implementation; this task came into
scope alongside tasks 81 and 86 (it runs last of the three).
Resolutions:

1. **This task owns the DBC-change propagation contract.** Task 86's
   item 3 (enum overlays only render after a view remount) is the same
   hole as the `VAL_`-rename gap recorded here: nothing tells the
   views that labels changed. Owner ruling — 27 owns it, so the RBS
   half is fixed with the plot half rather than after it.

2. **The project watch notifies; it applies only when safe.** A
   project file is not a DBC: the app writes it (explicit Save, plus
   autosave-on-exit), and the session can hold unsaved changes, so a
   blind auto-reload can discard the user's work and autosave-on-exit
   can discard the external edit. Apply silently only when nothing is
   at risk; otherwise surface "project changed on disk" with an
   explicit Reload action. **Mid-capture is never safe** (owner):
   reloading re-roots the session (ADR 0042) and drops the
   connection. The reload itself runs the existing `open_project`
   path — no new element-level reconciliation engine.

3. **An RBS file is safe to apply when it is clean and stopped.**
   Unsaved edits to that element, or the element actively
   transmitting, both mean do not swap underneath it — a running RBS
   is putting frames on a real bus. Otherwise notify, with
   apply-anyway as the explicit action in the notification.

4. **One ADR, covering reload end to end.** Two halves: when a disk
   change is applied (externally-owned inputs such as DBCs swap in
   place; app-owned documents apply only when safe and otherwise
   notify), and what a reload must tell (the invalidation and
   notification obligations, so every view rendering derived state —
   enum labels included — sees the change). One ADR rather than two:
   the gap recorded in this task exists because those halves were
   never written down together.

## Phases

1. **The reload ADR and the propagation contract.** Write the ADR
   (landed as ADR 0053),
   then implement the propagation half: a DBC-set change (add, remove,
   re-scope, watcher reload) invalidates and notifies every consumer
   of derived state, with the failing `VAL_`-rename test from the exit
   criteria driving it. Covers task 86 item 3's consumers.
2. **Project-file watch.** Register `.cannet_prj` with the existing
   watch set; the safety rule from note 2; notification UI and the
   explicit Reload action.
3. **RBS-file watch.** Same for `.cannet_rbs`, with the clean-and-
   stopped rule from note 3.
