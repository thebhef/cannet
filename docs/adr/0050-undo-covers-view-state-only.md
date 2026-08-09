# ADR 0050 — Undo/redo covers view state only, never the bus

Status: accepted (2026-08-09)

## Context

`Mod+Z` / `Mod+Y` ([ADR 0018](0018-command-keybinding-framework.md))
undo and redo changes to the user's views. As that coverage grows past
panel add/close/move — plot areas, signals, solo, colors, columns,
sections, renames, and the wiring that scopes what a view fetches — the
chords start reaching state that is no longer purely about what is on
screen.

The application is a bus tool. Some of the state a user edits in the
same windows, with the same gestures, *transmits*: an RBS element's Run
flag and its `.cannet_rbs` file, a transmit element's messages, modes
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
| Plot areas / signals / solo / visibility / collapse / y-axis mode / primary / sort / patterns; colors, colormap + generator rules; trace & signals columns, sections; element renames; panel open / close / move; filter add / remove, predicate edits, sources rewiring | `rbs.run` / `rbs.path`; all transmit config; connection; capture control; DBC set; project open / save; settings; notes / markers |

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
  accidental undo of a Run flag costs whatever the bus did in between —
  there is no redo for frames already sent. The asymmetry, not the
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
