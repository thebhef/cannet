# ADR 0050 — Undo/redo covers view state only, never the bus

Status: accepted (2026-08-09); amended 2026-08-23 — an event's references are in;
amended by [ADR 0058](0058-panel-document-edits-are-undoable.md)
(2026-08-29) — the Signal and RBS panels' document edits are in, as
step/inverse pairs; the boundary is now document edits vs runtime
actions, not view state vs host state

## Context

`Mod+Z` / `Mod+Y` ([ADR 0018](0018-command-keybinding-framework.md))
undo and redo changes to the user's views. As that coverage grows past
panel add/close/move — plot areas, signals, solo, colors, columns,
sections, renames, and the wiring that scopes what a view fetches — the
chords start reaching state that is no longer purely about what is on
screen.

The application is a bus tool. Some of the state a user edits in the
same windows, with the same gestures, *transmits*: the `.cannet_rbs`
file an RBS element references, a transmit element's messages, modes
and periods. A chord that silently re-enables a schedule, or restores a
message the user had just removed, is a chord that puts frames on a
physical bus because someone pressed a key twice.

An undo history that covers everything is also an undo history whose
scope the user cannot predict. The scope has to be a rule, not an
accident of which state happened to be easy to snapshot.

## Decision

**Undo/redo applies to view state only. It never applies to values on
the bus, to the connection, or to the capture.**

The undoable set is an allowlist, applied where history is captured and
again where a step is restored:

| In (undoable) | Out (never) |
|---|---|
| Plot areas / signals / solo / visibility / collapse / y-axis mode / primary / sort / patterns; colors, colormap + generator rules; trace & signals columns, sections; element renames; panel open / close / move; filter add / remove, predicate edits, sources rewiring; **what an event refers to** — links between events, and the messages and signals it names | `rbs.path`; all transmit config; connection; capture control; DBC set; project open / save; settings; note *content* — adding, removing, renaming, recoloring, retagging, describing |

**What an event refers to is in; what it says is not.** A reference
([ADR 0056](0056-an-event-subject-is-a-structural-reference.md)) is a
relationship, not an annotation: it carries no text the user would
lose, it has exactly one inverse, and it is made and unmade by the same
pointing gestures as everything else in the left-hand column. The two
kinds of reference are stored differently — a link lives on one of the
two events, a subject on the event's own list — but that is a storage
fact, not something the reader is asked to hold: the `×` on a chip
means one thing whether the chip names a linked event or a signal, so
both are undone by one chord. Half of the chips on a row being
reversible would be the surprising rule, not the complete one.

Note *content* stays out, and that boundary is deliberate rather than
unfinished: it is what keeps `Mod+Z` from ever destroying something the
user typed. Undoing an "add note" would delete text; undoing a rename
would replace it. The rule the user holds is "your views undo, and what
your notes point at; what you wrote does not."

Two further boundaries follow from the same rule:

- **Zoom, pan and scroll are outside undo.** They are transient view
  state, already unpersisted; undo does not try to restore them.
- **Undo never re-runs a host side effect.** Where a view change had a
  host consequence (removing a transmit element withdraws its messages
  from the host pool, removing an RBS element unloads it), undoing the
  view change does not put the host state back.

## Why

- **Redo makes undo cheap to reverse, and only within the allowlist.**
  An accidental undo of a display change costs one `Mod+Y`. An
  accidental undo of a transmit row's payload costs whatever the bus
  did in between — there is no redo for frames already sent. The asymmetry, not the
  category, is what draws the line.
- **The wiring family scopes fetches, not traffic.** Filters,
  predicates and sources decide what a view asks the host for and what
  it displays; they never write the bus. The worst case of an undone
  rewire is a perturbed fetch rate. That is why the wiring family is
  *in* while transmit config is out, even though both feel like
  "configuration".
- **This is a deliberate trade, not a safety claim.** cannet's RBS is
  explicitly not safety-rated ([ADR
  0028](0028-rest-of-bus-simulation.md)), and operators are responsible
  for what they put on a bus during development. The rule exists so the
  tool never *surprises* an operator into transmitting — not because
  the tool is the last line of defence.
- **A reference is view-shaped; note text is not.** The asymmetry test
  above is what decides it. Reversing a link or a subject costs nothing
  but that reference — every event's label, tag and description is
  untouched, and one more chord puts it back. Reversing a note edit
  costs prose the user wrote and cannot re-derive, which is the same
  shape of loss the rule exists to prevent, just off the bus instead of
  on it.
- **An allowlist fails closed.** A new field on an element is outside
  undo until someone adds it to the list. A denylist would make every
  new transmit-shaped field undoable by omission, which is exactly the
  direction the failure must not go.
- **A predictable rule beats a complete one.** "Your views undo; the
  bus does not" is a sentence a user can hold in their head. It is
  worth more than undo coverage of the last few fields.

## Consequences

- The allowlist is stated once and enforced twice: a captured snapshot
  carries only allowlisted fields, and a restore writes back only
  allowlisted fields. An excluded field therefore cannot be replayed
  even if a snapshot were taken while it was changing.
- **An event's references are recorded as steps, not snapshots** (a
  third stack, `eventLinkHistory.ts`, interleaved with the other two by
  the same order log). A link's inverse is another link; a subject
  list's inverse is the list as it was, which the step carries whole
  because `set_note_subjects` replaces the list. Snapshotting the notes
  list instead would hold more state, and would drag every other note
  edit into undo's reach on the way — the boundary above would then be
  enforced by nothing but care. A link step also records *which end*
  the host stores the reference on, so a restore puts it back on that
  event rather than moving it to the other one.
- **The recording lives at the dispatch layer**, not at the gesture. A
  view calls `setNoteSubjects` and gets an undo step without asking, so
  a second way to add or drop a subject cannot be added without one.
- Undoing an element removal restores the view, not the element's host
  state: an RBS element that comes back is not re-loaded and not
  running, and a transmit element's messages are not re-added to the
  host pool.
- Some gestures are only partly undoable — removing a transmit element
  is one gesture whose view half reverses and whose host half does not.
  The alternative (refusing to undo the view half too) leaves the user
  with no way back at all.
- This rule is hard to reverse once muscle memory forms. Broadening the
  allowlist later is a change to what a key the user has already
  learned does, and needs the same scrutiny as adding a new destructive
  command.
