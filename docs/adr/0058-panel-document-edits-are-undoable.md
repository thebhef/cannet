# ADR 0058 — The Signal and RBS panels' document edits are undoable, as step/inverse pairs

Status: accepted (2026-08-29). Amends
[ADR 0050](0050-undo-covers-view-state-only.md), whose "view state
only" boundary this deliberately moves. Amended same day (owner
ruling): **values are out** — see the boundary below.

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

**Undo/redo covers project contents — except values. It never affects
live values on the bus.** (Owner ruling, 2026-08-29, verbatim intent:
*"Undo/redo does not affect live values on the bus. It can affect
project contents except for values."*)

Three exclusions, stated once:

1. **Values are out — with no exceptions.** An RBS signal value
   override, its clear, and the Not Encoded row's Drop all go to the
   host unrecorded — no chord ever changes what a message *carries*.
   This holds whether or not anything is running: the rule is about
   the category, not the moment, so it stays predictable. A dead-entry
   carve-out (recording the Drop, since nothing encodes what it
   deletes) was tried and reversed the same day (owner ruling
   2026-08-30): the chord is global, and an absent-minded `Mod+Z` run
   must never be *able* to write an override — an exception the user
   has to reason about is worth less than a rule with none. The cost
   is accepted openly: a removed value has no way back but re-typing
   it, which is why every value-shaped remover — the value cell's
   clear × and the grid's Drop — confirms before it acts (the transmit
   panel's two-stage remove). The period and designation clears stay
   one-click: a period is undoable, and a designation is not a value.
2. **Runtime actions are out** (Run/Stop, connect/disconnect, capture
   control, transmission itself).
3. **File operations are out** (open, save, reload).

Everything else the View Signals and RBS panels edit is undoable:
the mapping panel's ambiguity pick, remap, re-point and accept
(`set_signal_dbc_pick`, the shared rewrite in `signalRemap.ts` and the
colour that travels with a rename); the RBS panels' enables at every
level (bus / ECU / message — structure, not payload) and period
overrides.

**The transmit panel has no undo at all.** Its editing never records.
The one chord that reaches the transmit pool is a remap's calc-field
retarget, and it is recorded as a **rename instruction**
(`transmitCalcRetarget`: "calc targets naming X now name Y"), never as
frame snapshots: the restore reads the pool *as it is then* and moves
only the calculated fields' signal names, so payload bytes, modes and
periods can never ride an undo step — transmit-panel edits made
between the remap and its undo survive. (Replaying entries whole was
the original task-129 shape; the owner's ruling retired it.) The
likely future direction, noted for when it is asked for: transmit
row / element **add and remove** may join undo, with a re-added row
**disabled regardless of its state before removal** — restoring
structure must not resume sending.

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

### The accepted consequence — and the line it stops at

Undoing a disable **re-enables**. On a running RBS element with a
connected bus, that resumes that message's transmission — exactly as
pressing its checkbox would. This is the case ADR 0050 used to rule
the state out, and it is accepted now for the same reason the checkbox
is: the chord does what the edit did, no more, and Run — the actuating
switch — remains outside undo entirely.

The value exclusion is where that acceptance stops. Resuming a message
sends what the configuration already says; rewriting an override
changes *what the frames say*. The first is structure, the second is
payload, and only the first is a risk the checkbox already carries.
"Your edits undo, except what goes in the frames" is the sentence the
user holds.

## Consequences

- A pick, an enable, a period and a remap each cost one `Mod+Z`; the
  remap restores every store it touched as one step. A value override
  costs nothing to undo because it cannot be undone — re-enter the
  value or clear it by hand.
- A restore is best-effort like the edit it replays: the host answers
  with the same change announcements, so every open view converges the
  same way it does on the original edit.
- The inverse is frontend-captured. If a row's data goes stale between
  the read and the write (another instance editing the same file), the
  restore re-establishes what this panel saw — the same
  last-writer-wins the edits themselves have.
- Transmit-panel editing keeps its ADR 0050 status (out); the one
  pool-touching op is the remap's calc-field retarget above — a rename
  over the pool as it is at restore time, carrying no frame content.
