# ADR 0045 — Cross-panel drag payloads: signals and patterns travel together, patterns stay live

Status: accepted (2026-08-05); amended (2026-08-07) — flipped the grip
rule to whole-row drag as the norm, grip/`stopPropagation` only where
proven necessary.

## Context

Drag-and-drop between panels is raw HTML5 DnD over private mime
types (`application/x-cannet-*`), hand-parsed, sharing one namespace
with dockview's own tab drag; mime filtering during `dragover` is the
only isolation, and it has to be, because HTML5 exposes only the
*type list* — not the data — until the drop lands. The existing
signal payload (`dragSignals.ts`) carries concrete signal references.
With pattern-defined selections ([ADR 0020](0020-filter-defined-plot-areas.md))
now first-class in the signal view's sections and the plot's areas, a
drag must be able to carry a *pattern* — a live selection rule — as
well as concrete signals, and the gridview base
([ADR 0044](0044-gridview-interaction-base.md)) makes multi-item
drags routine.

## Decision

**One combined payload: signals and/or patterns.** The signal mime's
payload becomes `{signals: DraggableSignalRef[], patterns: string[],
sourcePanelId?}`. The payload kind stays in the mime so targets can
show valid-drop feedback during `dragover`. A target that supports
only one half acts on that half.

**What a grab means:**

- A **signal row** drags that concrete signal — even when it is in
  the view only as a pattern match (it lands as a manual pick;
  ADR 0020's materialize-on-touch).
- A **pattern chip** drags that pattern, live. Pattern chips are
  selectable alongside rows, so a mixed selection drags both kinds.
- A **message row** (by-ID or chronological trace) drags the
  message; a line inside its expanded decoded block drags that one
  signal.
- A **section header** drags the whole unit: the section's assigned
  signals *and* its patterns.
- If the grabbed row is in the selection, the whole selection drags
  (the file-manager convention); multi-item drag is v1 behaviour.

**Patterns stay live across a drop.** Dropping patterns on a plot
area appends them to the area's ADR 0020 `patterns` list (onto empty
plot space: a new area holding them); dropping them on the signal
view creates a section carrying them; dropping on a section merges
them into it. A later DBC load feeds the target exactly as it feeds
the source. Flattening a pattern to its current matches happens only
through the explicit materialize path — never silently by drop.

**Drop semantics by payload and target:**

| Payload ↓ Target → | Plot area | Transmit panel | Signal view | Signal-view section |
| --- | --- | --- | --- | --- |
| Signal(s) | add series | one TX frame per distinct message | add to manual picks | add + assign to that section |
| Message | add all its signals as series | one TX frame | add its signals to picks | add + assign |
| Pattern(s) | append to area patterns, live | rejected (no concrete message set) | new section carrying the patterns | merge into target section |

Within the signal view: signals dropped on a section (header or row
span) move their assignment there — an explicit assignment, which
wins over other sections' patterns; a section header dropped between
sections reorders the sections, and the pattern-claim tie-break
follows the new visual order, keeping claim priority readable off
the panel.

**A single drop never duplicates.** A payload that overlaps itself
(a message plus some of its own signals in one selection) or the
target's existing content lands each signal at most once — dedup at
the payload edge (`dedupeSignalRefs`) plus the target's own
descriptor-key dedup.

**No confirmation dialogs.** A wide message dropped on a plot
creates all its series in one gesture; remove is cheap and the
gesture says what it says.

**Whole-row drag is the norm.** A row drags from anywhere on it,
including over a button or input it holds — HTML5 drag only starts
once the pointer moves past a threshold while held, so a plain click
on an inner control still just clicks. An inner element that needs to
be a drag source of its own (a pattern chip, a section header's label)
suppresses the row drag with `stopPropagation` on its own
`dragstart` (`DecodedSignalCell` is the precedent). No special
affordance — a grip, a `stopPropagation` guard — is added for an
inner control until dragging the row whole is shown to break it; the
transmit rows' and the plot area's reorder grip predate this rule and
stay as they are, because their rows are dense enough with editable
fields that a grip was already the proven answer.

## Why

- **One payload, not payload-per-surface:** the same drag must read
  identically at every target, and a mixed selection (signals +
  patterns) is one gesture, not two.
- **Live, because that is what a pattern *is*** (ADR 0020's
  set-and-forget rationale). Flatten-on-drop would silently freeze a
  rule the user wrote to stay current; anyone wanting a frozen copy
  has the materialize path.
- **Kind-in-the-mime, because dragover cannot read data.** Valid-drop
  feedback has to come from the type list alone.
- **Dedup structurally, not by dialog:** overlap is a normal
  consequence of selection composition, not a user error to confirm
  away.

## Rejected alternatives

- **A drag-and-drop library** (dnd-kit, react-dnd). The app already
  interoperates with dockview's raw HTML5 tab drag in one namespace;
  a library abstraction would sit on top of that anyway, and the
  hand-rolled surface is small and mime-scoped.
- **Flatten patterns to matches on drop.** See Why.
- **A separate mime per source surface.** The payload's meaning is
  what it carries, not where it came from; `sourcePanelId` already
  covers the one case that needs provenance (move-vs-add within a
  panel).
- **Confirmation on wide drops.** Chrome for a reversible action.

## Consequences

- `dragSignals.ts` grows the `patterns` field; existing targets that
  predate it ignore what they don't support until taught otherwise.
- The transmit panel rejects pattern payloads by mime feedback (no
  concrete message set to build frames from).
- Section reorder-by-drag makes pattern-claim priority
  user-arrangeable; the tie-break rule itself is unchanged (earlier
  section on screen wins).
