# ADR 0057 — One text block carries an event; a format's own fields are interop

Status: accepted (2026-08-22)

## Context

A timeline event ([ADR 0035](0035-timeline-event-model.md)) now carries
more than a moment and a label: a stable id, a kind, a user tag, and an
ordered list of structural subject references
([ADR 0056](0056-an-event-subject-is-a-structural-reference.md)) naming
messages, signals and other events. All of that has to survive a save and
come back, in **both** capture formats, and
[ADR 0010](0010-no-sidecar-files.md) rules out putting any of it beside
the file.

The two formats are not close to each other in what they can hold.

**MDF4's `##EV` block is rich.** It has a name, a comment (`##MD`, with a
`<TX>` free-text element and a `common_properties` key/value element), a
scope list reaching channels and channel groups, a typed begin/end range
pair, a single parent pointer, and fixed enums for the event's type and
cause. Two of those fields look like they model what we model, and both
are **narrower than our model, in different directions**:

- `ev_ev_range` makes a pair a *span*. Our model says the opposite — span-ness
  is a relationship, never a field on either event (ADR 0056 § 3).
- `ev_ev_parent` is **one** parent. An event linked to three others has no
  form here at all.

MDF's classification enums are closed, too: an application cannot mint an
`ev_type`, so `EventKind` — which exists to grow — cannot be carried in
one.

**BLF's `GLOBAL_MARKER` is poor.** It has a group name, a marker name, a
free-text description, two colours, a relocatable flag, and the object
type of a commented event. There is no scope, no link, and no id.
`EVENT_COMMENT` is narrower still: one text field and the commented
object type.

## Decision

### 1. The `cannet-event/1` block is the record of record, in both formats

Everything the model holds that a carrier has no field for is serialized
into **one line-oriented text block**, appended to the event's own text
field:

| Carrier | Field |
| --- | --- |
| BLF `GLOBAL_MARKER` | `description` |
| BLF `EVENT_COMMENT` | its one text field |
| MDF `##EV` | the comment's `<TX>` element |

Same grammar, same serializer, same parser, all three. A reader takes the
block first, always; it is the only thing that carries the model exactly.

```text
Contactor opened under load

cannet-event/1
id: 7f3a1c
kind: note
tag: fault
signal: 0x180 Pack Current
message: 0x2A1
link: 91c2de
```

**Text, not JSON.** The field it lives in is one a person reads when they
open the capture in someone else's tool. Lines are readable, diffable, and
each stands alone; a blob is none of those.

**The grammar.**

- The **human description comes first and verbatim**, then a blank line,
  then the header — so a reader in Vector's tooling sees their own words on
  line one.
- The header is `cannet-event/1`: the name and the schema version in one
  token, so a reader sees the version without parsing.
- Then `key: value` lines, repeated for lists.
- A reference's id is `0x` hex with `/ext` suffixed for a 29-bit id
  (`0x18DA00F1/ext`) — message identity in this app is
  `(message_id, extended)`, so both halves are on the line.
- `signal: <id> <name>` — the name is *the rest of the line*, so a name
  containing a space survives. `message: <id>` carries no name: the
  reference is structural and the name belongs to whatever database is
  assigned at render time. `link: <event id>`.

**The parsing rules are as much of the contract as the fields.**

- Split at the **last** line that is exactly a recognised header. With no
  header the whole string is the description — a foreign marker whose prose
  happens to mention `cannet-event` round-trips unharmed rather than being
  eaten.
- A key this version does not understand, and a line that does not parse,
  are **kept verbatim** and do not invalidate the block.

### 2. The block carries only what the container cannot

Where a record has a field of its own, that field is authoritative and the
block leaves the key out. A marker's name is its label; a marker's fill is
its colour; an `##EV` block's name is its label. `EVENT_COMMENT` has
neither a name nor a colour, so those ride the block there — and only
there.

The consequence worth stating: renaming a cannet marker in another tool
renames the event, because the tool edited the field that holds the name.
That is the right outcome, and it is why the block does not duplicate it.

**One exception, and it is deliberate: `commentedEventType`.** The BLF
`EVENT_COMMENT` record has its own `mCommentedEventType`, and that field
is still written, because it is what makes a foreign reader tie the
comment to its message. The block carries the value as well, so the
grammar reads the same on every carrier rather than being one key short
on exactly one record type. Reading takes the record's field where there
is one.

### 3. A format's own event fields are populated as interop, never as storage

MDF's native fields say as much about our events as they honestly can, and
say nothing our model does not:

| Field | Written as | Why |
| --- | --- | --- |
| `ev_tx_name` | the label | exact |
| `ev_type` | `EV_T_MARKER` | the user-marker slot; the enum is closed, so the *kind* rides the block |
| `ev_cause` | `EV_C_USER` | every exported event is user-authored — the export boundary keeps host-derived ones out |
| `ev_ev_range` + `ev_range_type` | a begin/end pair, **only** where a link joins exactly two events and nothing else links either | where the two models agree |
| `ev_ev_parent` | never | one parent cannot express a fan-out, and a chain is already in the block |
| `ev_scope` | never | see below |

A range pair another tool wrote reads back as one more untyped link. It is
an interop courtesy in both directions; the link itself is carried by the
block whether or not a range accompanies it.

**`ev_scope` is not written, and the reason is about our own file.** A
scope link points at a `##CN` or `##CG` *in this file*, and a
cannet-written MDF has neither of the things a subject would name: its
bus-logging groups are one per frame *structure*
(`CAN_DataFrame` / `CAN_ErrorFrame` / `CAN_RemoteFrame`), not one per
message, and it deliberately writes no DBC-decoded signal channels — the
frames plus the attached database already say everything they would. So
there is nothing in the file for a message or signal subject to point at,
and pointing a message subject at `CAN_DataFrame` would say "this event is
about every data frame", which is false. If per-message channel groups are
ever written, this becomes writable and should be revisited.

**`ev_type` is written as the byte 6, not through the library's enum.**
`mdf4-rs 0.6.0` numbers `EventType::Marker` **2**; ASAM MDF 4.x assigns 2
to `EV_T_ACQUISITION_INTERRUPT` and puts `EV_T_MARKER` at **6**. asammdf,
an independent implementation, agrees with the standard. Every note cannet
had written before this ADR carried `ev_type = 2`, and a conformant reader
would have read it as an interrupted acquisition.

### 4. In BLF, an event's colour is the marker's fill

`GLOBAL_MARKER` carries a foreground and a background colour, which in
Vector's tooling are the label's text and its chip. The event's colour is
the **fill** — `background_color`, under a white `foreground_color` —
which is how python-can's independent BLF writer packs one, and the only
reading under which the pair means text-on-a-chip. An uncoloured event
keeps the neutral black-on-white default.

On read the colour is the fill unless the fill is white, in which case it
is the foreground. That reads the neutral default as "uncoloured" and, for
free, reads every marker cannet wrote before this convention, which put
the colour in the foreground.

Because it is a *pair* of fields, "no colour chosen" and `#000000` are
distinct records — white-on-black is a chosen black chip, black-on-white
is the untouched default — so no colour is lost and the format needs no
help from the block.

## What a round-trip loses, per format

Everything below is exercised by tests over generated files, not asserted
in prose.

| | MDF4 | BLF |
| --- | --- | --- |
| id, kind, tag, description | kept (block) | kept (block) |
| label | kept (`ev_tx_name`) | kept (`marker_name`; block, for a comment) |
| colour | kept (block) | kept (fill) |
| message / signal / event subjects | kept (block) | kept (block) |
| the record a comment is attached to | kept (block) | kept (`mCommentedEventType`, and the block) |
| a link to an event the file does not carry | kept, unresolved | kept, unresolved |
| **visible to another tool** | yes — name, marker type, cause, and a span as a real range pair | as a text block under the user's own words |
| **subjects visible to another tool** | no — nothing in the file to scope to | no |
| **survives a foreign tool's rewrite** | with the comment | with the marker |
| **a key from a later schema version** | kept (passthrough) | kept (passthrough) |

Two of those want a sentence each.

- **A dangling link.** Saving is not deleting. ADR 0056 sweeps event
  references when an event is *removed*; an event kept out of a file by the
  export boundary leaves a reference behind, and that reference is written,
  read back, and resolves to nothing — a state, not a fault.
- **A key from a later schema version.** The parser keeps an unrecognised
  line verbatim, and `Note` carries those lines through as a passthrough
  field, so a file written by a later version — opened and saved by this
  one — comes out still carrying the fields this one cannot read. They are
  written back after the keys this version does know, in the order the file
  had them.

## Consequences

- One serializer and one parser cover both formats and all three records.
  A third carrier needs a text field and nothing else.
- Anything a format models *natively and exactly* — a name, a colour — stays
  in that field, so another tool's edit of it reaches the model.
- Anything a format models *narrowly* is written as a courtesy and read as
  a hint. No carrier's vocabulary reaches back into `Note`; the
  untyped-link ruling of ADR 0056 stands unchanged by MDF having typed ones.
- The blocks are visible to a user reading the file in another tool, under
  their own text. That is the cost of the guarantee that a tool copying an
  annotation copies its metadata and a tool dropping one drops its
  metadata — orphaning is impossible by construction.
- The forms cannet wrote before this ADR — a BLF `cannet:event:` packing, a
  bare id, and MDF `cannet.*` `common_properties` — are still read and no
  longer written, so a capture saved by an earlier build opens with its
  events intact.

## Rejected alternatives

- **A JSON payload.** Compact and unambiguous, and unreadable in the field
  it lives in. The field is one a person sees.
- **`common_properties` decomposition** (`cannet.subject.0`,
  `cannet.link.0`, …). MDF's own extension point, and it would put the same
  data in two encodings in the same file for no gain the native fields do
  not already give interop. It also has no BLF counterpart, so it would
  cost a second serializer.
- **A separate BLF `APP_TEXT` record.** Keeps the user-visible strings
  clean, and associates with its marker only by convention: a tool that
  rewrites the file may keep the markers while dropping or reordering the
  `APP_TEXT`, silently orphaning every subject. That failure is invisible
  and unrecoverable.
- **The marker's `group_name`.** It is a *grouping* label Vector buckets
  markers by, so a per-event payload there produces one group per event —
  actively worse than nothing.
- **MDF's `ev_ev_range` / `ev_ev_parent` as the storage form.** Reverses two
  owner rulings at once: it makes span-ness an event property, and it caps
  a chain at one parent. Adopting a carrier's narrower vocabulary as the
  model is exactly what ADR 0056's consequences forbid.
- **A sidecar.** ADR 0010, and it would have been easy.
