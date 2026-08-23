# ADR 0056 — An event's subject is a structural reference, and span-ness is a relationship

Status: accepted (2026-08-22)

## Context

A timeline event ([ADR 0035](0035-timeline-event-model.md)) says
*when*: a timestamp, a label, a kind, a colour. It does not say *what
about*. Looking at a trace with dozens of events, the one thing a reader
wants from a row — which signal, which message, which other event this
one concerns — is the thing the model cannot express.

Three things have to be nameable, because all three are what people
actually annotate: **a signal**, **a message**, and **another event**.
The third is what makes a *span* (a start and an end) and a *chain*
("this fault, after this contactor open, after this command")
expressible without a second entity type.

Naming them is not obvious, because the app's names are not stable:

- A signal's name comes from whatever database is assigned to the bus
  the frame arrived on. Assignments change, databases are reloaded and
  swapped, and a value's definition is resolved per frame
  ([ADR 0054](0054-a-decoded-value-has-one-definition.md)).
- Nothing that outlives a session may store a resolved *display* string,
  or the annotation says something different once the databases change
  underneath it.
- The annotation must survive being read against a *different* database
  set — the file is opened somewhere else, or the same file is read
  against next year's DBC — and it must survive resolving to nothing.

And spans invite a shortcut that would be wrong. The obvious model gives
an event an `extent` or an `is_end_of` field. It is wrong because
span-ness is not a property any single event has: an event is a moment,
and two moments *together* bound a region.

## Decision

### 1. A subject is a structural reference, and an event carries a list of them

An event has **`subjects`**, an ordered list of references, mixing kinds
freely. There are exactly three:

| Kind | What it stores |
| --- | --- |
| message | `(message_id, extended)` |
| signal | `(message_id, extended, signal_name)` |
| event | the referenced event's id |

`message_id` plus `extended` is what message identity *is* everywhere
else in this app, so a reference is directly comparable to a decoded
frame, a filter predicate, and a catalog entry.

**A reference stores no bus and no database identity.** It names a
structure, not a resolution. It resolves against whatever databases are
assigned when a view renders it, and **an unresolvable reference
remains** — it is a state to render, not a fault to repair, and nothing
in the model may drop one. This is what makes an annotation portable:
nothing about it depends on which database was loaded when it was
written.

A subject is never a rendered name. The name shown on a chip is
resolved at render time, and it changes when the databases do.

### 2. Any category of event may carry subjects; the export boundary is unchanged

Subjects are a field on the event, not a side table, and all three
source categories of [ADR 0035](0035-timeline-event-model.md) may
carry them. Which subject-bearing events reach a file is decided where
it was already decided — the export boundary that keeps host-derived
events out of a capture. Subjects add no second rule.

### 3. Span-ness is a relationship, never an event field

**No event knows that it is the end of a span.** A span is a pair of
events joined by an event reference, and a renderer derives the extent
from the pair. A chain is the same mechanism with more links. There is
no extent field, no start/end flag, and no span type.

Links are **untyped**: an event→event reference is just a link. What a
pair *means* comes from the events' own labels and colours. A typed
relation can be added later if a need ever appears; inventing one now
would put a vocabulary in the durable schema that no user asked for.

The consequence a renderer must respect: a linked pair's extent is drawn
from the relationship, transiently, while one of the two events is
selected or hovered. At rest there is no span to draw, because at rest
there are two events.

### 4. A link is stored once and read from either end

The authoring gesture writes **one** reference, on whichever event it
touched. Every reader answers "what is this event linked to" over both
directions: the event's own subjects, plus the events whose subjects
name it.

The alternative — writing the reference on both events — makes a
two-place invariant that the deletion sweep, every carrier round-trip,
and every future importer would each have to maintain, and buys nothing
a reader can see.

### 5. Deleting an event takes the references to it; nothing else is ever swept

Removing an event sweeps every remaining event's subject list for
references to it, **in the same change** — so no observer ever sees a
reference to an event that is gone, and there is no broken-link state to
render.

**Message and signal references are never swept.** They are structural,
they refer to something outside the store, and an unresolved one is a
legitimate state (§ 1). The two behaviours differ because the referents
differ: an event id is only meaningful inside the event set, and a
message id is meaningful without it.

Loading is not deletion. Opening a capture, restoring a session, or
migrating a project keeps every reference it finds, including references
to events that set does not contain.

## Consequences

- A row can show what an event is about without the model storing a
  single resolved name, and the same annotation read against a different
  database set shows that set's names — or shows an unresolved
  reference, honestly.
- Spans and chains cost no new entity, no new field, and no new
  vocabulary. Anything that can express "these two events are related"
  can express both.
- Renderers must do the symmetric read; asking only the event in hand
  finds half the links.
- A carrier format that natively models spans as a *typed* begin/end
  pair, or chains as a single parent pointer, is narrower than this
  model in two different directions. Such a field may be populated as an
  interop courtesy where the data happens to fit it, and it is never the
  storage form and never constrains what the model can express.
- Producers are unconstrained. A hand gesture, a rule that fires on the
  stream, an import, or an extension all produce the same references;
  the model does not record which made it.

## Rejected alternatives

- **A resolved name on the event** ("Pack Current on BMS_Status"). Cheap
  to render, wrong the moment a database changes, and impossible to
  highlight from — a string cannot be matched against a decoded frame.
- **A subject table beside the events.** A second entity with its own
  lifecycle, its own deletion rules, and its own serialization, for data
  that has exactly one owner. The list belongs on the event.
- **An `extent_ns` or an `end_event_id` field.** Puts span-ness inside
  an event, contradicting § 3, and leaves chains needing a second
  mechanism anyway.
- **Typed relations from the start** (`caused_by`, `ends`). A vocabulary
  invented ahead of the need, which every carrier and importer would
  then have to preserve. Colour and label already say what a pair means.
- **Storing the bus, or the database, with the reference.** Pins an
  annotation to the session that made it. A reference that resolves
  against today's assignments is the portable one.
