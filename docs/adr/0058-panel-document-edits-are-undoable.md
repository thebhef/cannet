# ADR 0058 — The Signal and RBS panels' document edits are undoable, as step/inverse pairs

Status: accepted (2026-08-29). Amends
[ADR 0050](0050-undo-covers-view-state-only.md), whose "view state
only" boundary this deliberately moves.

## Context

ADR 0050 drew undo's line at view state: host-owned configuration —
the `.cannet_rbs` enables and overrides, the transmit pool, the
per-signal database pick — sat outside it, partly because a chord that
re-enables a schedule can put frames on a physical bus.

Using the tool said otherwise. The owner, reviewing the mapping
panel's resolution picks (2026-08-28): *undo/redo should apply to
signal mapping selections … everything we can do in the signal or RBS
panel should be undo/redoable.* These are the panels where a user
does most of their **editing** — and an edit the chords cannot reach
is an edit the user re-does by hand, from memory, wrongly.

## Decision

**Everything the View Signals and RBS panels edit is undoable.** The
boundary is restated: undo covers *document edits* — state that is
saved to a file and describes intent — wherever they are made. What
stays out is **runtime actions** (Run/Stop, connect/disconnect,
capture control, transmission itself) and **file operations** (open,
save, reload).

In scope, concretely: the mapping panel's ambiguity pick, remap and
re-point (`set_signal_dbc_pick`, the shared rewrite in
`signalRemap.ts` including its transmit-pool half and the colour that
travels with a rename); the RBS panels' enables at every level, value
overrides and their clears, and period overrides.

### The mechanism: steps with captured inverses, one stack

These edits live host-side, so they undo the way event links do
([ADR 0050]'s 2026-08-23 amendment): as **step/inverse pairs**, never
snapshots. The panel reads the inverse from the row it is looking at
*before* the write erases it (the serving database, the current
enable, the override text, the period), records one
`PanelEditStep { undo, redo }` on the `edits` stack
(`panelEditHistory.ts`), and a restore dispatches the step's ops
through the very commands that made them — without re-recording. The
stack rides the same interleaving log as layout, elements and event
links, so one chord reverses the most recent change whichever kind it
was; a multi-store gesture (the remap) coalesces its element half and
its host half into one entry through the undo gesture.

### The accepted consequence

Undoing a disable **re-enables**. On a running RBS element with a
connected bus, that resumes that message's transmission — exactly as
pressing its checkbox would. This is the case ADR 0050 used to rule
the state out, and it is accepted now for the same reason the checkbox
is: the chord does what the edit did, no more, and Run — the actuating
switch — remains outside undo entirely.

## Consequences

- A pick, an enable, an override, a period and a remap each cost one
  `Mod+Z`; the remap restores every store it touched as one step.
- A restore is best-effort like the edit it replays: the host answers
  with the same change announcements, so every open view converges the
  same way it does on the original edit.
- The inverse is frontend-captured. If a row's data goes stale between
  the read and the write (another instance editing the same file), the
  restore re-establishes what this panel saw — the same
  last-writer-wins the edits themselves have.
- Transmit-panel editing keeps its ADR 0050 status (out) until it gets
  the same treatment; the pool writes covered here are only the ones
  the remap makes as part of its one step.
