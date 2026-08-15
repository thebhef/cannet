# Task 66 — Database Panel Round: Import Trace, File-Backed Signals, Picker Cleanup

Owner feedback from first live use of the Task 38 surfaces
(2026-08-12).

## Owner feedback (verbatim intent)

- **One "Import trace" action** instead of separate BLF / MDF
  buttons: a single file-open whose filter list offers both (and
  "all supported"); format routing stays explicit host-side as
  already built.
- **File-backed signals were undiscoverable.** They should be listed
  in the DBC panel — which gets **renamed "Database"**, since it is
  no longer strictly DBC content. The Database view is **the primary
  mechanism for choosing signals to add** to other views; copying
  signals out of other views stays as already supported.
- **Remove the signal picker in the signal view** — same cleanup as
  the picker already removed from the plot panel. Any remaining
  picker of that first-draft style is a cleanup target ("first-draft
  GUI we never developed and isn't great").

## Grooming needed before implementation

- Sweep for every remaining first-draft signal-picker instance
  (signal view confirmed; find any others) and confirm each removal
  leaves an add-signal path via the Database view / copy-drag.
- How file-backed signals render in the Database tree: their own
  top-level branch ("Capture file" / per source file?) beside the
  DBC branches; what their rows show (name, unit, group, sample
  count) and what drag-out carries.
- Rename blast radius: panel title, command palette entries,
  CONTEXT.md term (DBC panel → Database view), docs/README, test
  names — code identifiers only where cheap (no drive-by churn).
- "Import trace" placement: toolbar + palette naming, and whether
  recent-files (currently BLF-only) unifies in the same pass (the
  Task 38 phase-3 scope trim noted MDF has no recents entry).

## Exit criteria (draft — firm up at grooming)

- One "Import trace" entry point offering BLF + MDF; both formats
  land through their existing scan/mapping flows.
- The Database panel lists file-backed signals from the open
  capture beside the DBC content; adding them to plot/grid views
  works from there; the panel is renamed everywhere a user sees it.
- The signal view's picker is gone; no orphaned add-path (Database
  view + copy/drag cover it); any other first-draft pickers found in
  the sweep are removed or explicitly deferred with a note.
- CONTEXT.md and README reflect the rename and the file-backed
  signal surfacing.
