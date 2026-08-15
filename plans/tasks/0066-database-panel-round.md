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
- ~~How file-backed signals render in the Database tree~~ —
  resolved 2026-08-13 (owner): **one top-level branch per source
  MDF file, labeled with the filename** — the MDF fills the same
  structural role a DBC does, so it's tracked the same way in the
  tree (file branch → group → signal rows, name + unit). Drag-out
  carries the provenance-keyed signal reference (the `f`-flagged
  `signalKey`) so existing drop targets work unchanged. **Not a
  project member**: same lifecycle as capture contents (lives and
  dies with the capture; never persisted into the project file),
  unlike DBC references. No sample counts on rows.
- ~~Rename blast radius / naming boundaries~~ — resolved
  2026-08-13 (owner), elevated to **ADR 0052** (format-plural
  Database view): the panel is "Database" everywhere a user sees
  it; every signal-defining format is first-class in it, each
  organized per its own canonical structure (DBC: ECU→message→
  signal; MDF: file→group→signal; a future ARXML per ARXML's
  canon); format-specific operations keep naming their format
  ("Add DBC…", watcher messages). CONTEXT.md term, README, palette
  entries update; code identifiers rename only where cheap.
- Added 2026-08-13 (owner): the command palette keeps a **"DBC
  panel" alias** resolving to the Database panel — muscle memory
  and old docs keep working; the alias surfaces the new name in
  its result label (check how the palette supports aliases/keyword
  matching; follow its pattern).
- ~~Recents unification~~ — resolved 2026-08-13 (owner): unified
  list named **"Recent captures"**, BLF + MDF entries; settings key
  `recent_blfs_limit` kept (no migration) with label/help updated
  to the new name; format routing at open time by extension.
- "Import trace" placement: toolbar + palette naming.

## Exit criteria (groomed 2026-08-13)

- One "Import trace" entry point offering BLF + MDF; both formats
  land through their existing scan/mapping flows; the recents list
  is "Recent captures" and covers both formats (settings key kept).
- The Database panel (renamed everywhere a user sees it) lists
  file-backed signals per ADR 0052: one branch per source MDF file
  (file → group → signal, name + unit), capture lifecycle, beside
  the DBC branches; drag-out to plot/grid works with the
  provenance-keyed reference; format-specific operations keep
  naming their format.
- The SignalsPanel catalog picker is gone (sweep verdict: it was
  the only remaining first-draft picker; the plot's SourcesPicker
  is a different mechanism and stays); add-paths proven by test
  via the Database view and copy/drag.
- ADR 0052 committed; CONTEXT.md and README reflect the rename,
  the format-plural principle, and the file-backed surfacing.
