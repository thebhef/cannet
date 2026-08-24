# Task 107 — Events Point at Signals

Opened by owner instruction 2026-08-21, during task 19 grooming:
*"I'd like to look at having events be associated with signals.
Currently I don't have this concept. But if you imagine looking at
dozens of events in a trace, you probably want to know what each
points at."*

Today an event references only a *moment* (`timestampNs`, plus
label / color / kind). This task gives an event an optional
**subject**, so a trace full of events tells you what each one is
about. Entirely new scope — deliberately **not** part of task 102
(the event surface: kinds, filtering, own view), which is fixed.

## Status

Groomed with the owner 2026-08-21; the prototype is **approved**
(owner ruling same day) with an explicit reading: its trace view and
plot panel show the general shape only, and **nothing in it is a cue
to redesign any existing GUI surface**. What it proposes — and all it
proposes — is the subject chips, the extent bands, the transient
highlight, and the authoring / linking gestures. Implementation adds
those to the surfaces as they are. Roadmap position is the one open
question.

## Settled (owner rulings 2026-08-21)

- **A subject is a signal, a message, or another event** — one
  subject concept, three referent kinds. Not buses. An event's
  subjects are a **list**, possibly mixed: multiple signals,
  multiple messages.
- **Acting on an event highlights its subject(s)** — not just names
  them on the row.
- **A span is a list of two events**, linked through the
  event→event subject mechanism — not a separate type with an
  extent field. The same mechanism documents *chains* of events
  ("this fault ← this contactor open ← this command").
- **Links are untyped** (owner ruling 2026-08-21, revising the
  earlier typed-relation lean): an event→event link is just a link;
  the events' colors and labels establish what a pair means. Typed
  relations can come later if ever needed.
- **Extent bands are highlight-only** (owner ruling 2026-08-21): a
  linked pair draws its extent on the plot only while one of the
  two events is selected or hovered. At rest, only the marker lines
  show.
- **107 owns the model.** Producers (task 23 triggers, imports,
  task 69 plugins when extensions exist) arrive with their own
  tasks. Storage in the capture formats is part of the model work:
  research how MDF and BLF idiomatically carry this metadata.
  *Lead to verify:* MDF4's EV (event) blocks natively support point
  and range-pair events and can scope to specific channels —
  possibly an exact fit; BLF's `GLOBAL_MARKER` / `EVENT_COMMENT`
  anchor to time/messages only, so it is likely the constrained
  side (ADR 0010: no sidecars, whatever the answer).
- **Every provenance produces them**: by hand, the tool from rules
  (task 23's triggers are the obvious producer), imports, and —
  once extensions exist (task 69) — plugins. The model and its
  creation surface must be provenance-agnostic; the producers
  arrive with their own tasks.

Further rulings, same day:

- **Span-ness is nothing intrinsic to the events.** A span is a
  relationship built on two events; renderers derive extents from
  the link, never from event fields.
- **Highlights are transient** — they hold while the event is
  selected / hovered; nothing persists, nothing to undo.
- **Authoring gestures:** create-from-signals is **Shift+click in a
  plot area with signals selected** (the event's subjects are the
  selected signals, its time the clicked x); create-from-message is
  the trace row's **context menu**; the events view carries the
  "link these two events" gesture for chains and spans.
- **Prototype first.** The behaviours and views get an HTML
  prototype before implementation:
  [`plans/prototypes/events-point-at-signals.html`](../prototypes/events-point-at-signals.html)
  (app tokens, both themes; the event rows are the app's own
  `EventRow` markup and CSS, and the plot is real uPlot from the
  workspace install, configured as `PlotArea` configures it, with
  overlays in a draw hook) — it demonstrates subject chips,
  transient highlighting, extent bands derived from untyped links,
  Shift+click-in-plot and context-menu authoring, and multi-select
  linking, and carries its own list of questions it is meant to
  settle (chip density, broken-reference rendering, band styling,
  linking gesture).

Prototype-question rulings, same day:

- **Chip density:** subject chips overflow into a `…` expansion,
  the status-bar prototype's pattern — never an unbounded wrap.
- **Reference form is structural, not database-bound:** a message
  reference is the arbitration ID; a signal reference is the
  message ID plus the signal field name. It resolves against
  whatever databases are assigned at render time, and it
  **remains** when unresolvable — no database identity is stored,
  so nothing here depends on ADR 0054 / task 89 signal identity.
- **Broken event references die.** When a linked event is deleted,
  references to it are removed — there is no broken-chip state.
  Signal / message references never die this way; they persist and
  simply resolve (or not) against the current databases.
- **Band styling:** event-colored wash at low opacity.
- **Linking gesture:** multi-select + toolbar button.

Reviewed 2026-08-21 against task 102 phase 1 as shipped: ADR 0035's
three-category event model (`EventCategory` in `notes.rs`:
user-authored persisted, host-derived never written, frontend-derived
never crossing the wire) is the substrate this task builds on.
Consequences: subjects and event→event links are fields of the
durable store's schema and may appear on any category; the
provenances ruled above map onto categories (by-hand and
trigger-created events are user-authored/durable, an import's are
durable, a plugin's declare theirs); and the shipped export boundary
(`exportable()` — host-derived events are never written) already
enforces that only durable subject-bearing events reach the MDF/BLF
carrier this task researches. The frontend still types `EventKind`
as `"note" | "truncation"` — 107's schema work lands on top of 102's
later phases, not around them.

Chrome ruling (owner, 2026-08-21): the event surface's toolbar
speaks task 108's chip language — its "Link Events" control appears
in the 108 prototype's all-views sweep, and the prototype here
renders it in the chip shape.

## Open questions

- **Roadmap position** — provisionally slotted after task 108 in
  the roadmap; confirm or move.
