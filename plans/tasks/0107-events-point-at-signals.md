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

## Grooming — phases and the detail they need (overseer, 2026-08-22)

### Roadmap position — closed

The open question above is answered: the owner set the order
**101 → 106 → 19 → 108 → 107** (2026-08-21), so 107 runs last of this
chain and the provisional slot stands. It also means 107's event-surface
toolbar is built *after* task 108's chip language exists, so the "Link
Events" control is written in that language directly rather than
retrofitted.

### Implementation detail settled by reading the code

- **The substrate is `notes.rs`'s `Note`** — today `id`,
  `timestamp_ns`, `label`, `kind`, `color`, `description`, `tag`,
  `commented_event_type`, with `EventCategory` deciding what persists
  (`persisted()`) and what is exportable (`exported()` /
  `NotesStore::exportable`). Subjects are **one new field on `Note`**,
  not a side table: a `Vec` of tagged references. Any category may
  carry them; only durable ones reach a carrier, which the shipped
  export boundary already enforces.
- **Reference form**, per the settled structural rule, with the one
  detail the ruling left implicit: message identity in this app is
  `(message_id, extended)` everywhere (`SignalKey`, the catalog, the
  filter predicates), so both reference kinds carry `extended`.
  - message → `{ message_id, extended }`
  - signal → `{ message_id, extended, signal_name }`
  - event → `{ id }`

  No bus and no database identity is stored, so nothing here depends on
  ADR 0054 / task 89 signal identity, and a reference resolves against
  whatever databases are assigned at render time.
- **Deletion sweep.** "Broken event references die" means
  `NotesStore::remove` (and `clear`) sweeps every other note's subject
  list for references to the removed id, in the same `Applied`. Signal
  and message references are never swept — they persist unresolved.

### Owner call — link symmetry

A span is "a list of two events", and its band draws "while **one of
the two** is selected or hovered", which reads as symmetric. Two ways
to get that: store the link on both events, or store it once and read
it symmetrically.

**Recommended: store once, read symmetrically.** The authoring gesture
writes one subject entry; every renderer that asks "what is this event
linked to" answers over both directions (`a.subjects ∋ b` or
`b.subjects ∋ a`). Storing both sides creates a two-place invariant
that the deletion sweep, the carrier round-trip and any future importer
each have to maintain, for no user-visible gain.

### Wall clock

Nothing in this task needs an hours-long run. The carrier work in
phase 2 is round-trip tests over generated files (seconds), and the
plot / trace work is exercised at panel tier the way task 98's was.

### Phases

| # | Phase | Model | What lands |
|---|---|---|---|
| 1 | The subject model | Opus | Subjects and untyped event links as a field on `Note`; the three reference kinds; the deletion sweep; store operations, serialization and IPC; an ADR for the model (a subject is a structural reference; span-ness is a relationship, never an event field). No UI. TDD throughout. |
| 2 | The carrier — research, then implement | Opus | Investigation-first: what MDF4's EV blocks natively carry (point and range-pair events, channel scoping — the lead worth verifying) against BLF's `GLOBAL_MARKER` / `EVENT_COMMENT`, which anchor to time and messages only. ADR 0010 governs — no sidecar, whatever the answer. Ships the write/read for each format at whatever fidelity it honestly supports, and records in the ADR exactly what a round-trip through the constrained format loses. |
| 3 | Subjects on the event row | Opus | Subject chips on `EventRow` with the `…` expansion (the status bar's pattern, never an unbounded wrap); resolution against the assigned databases at render time, including the unresolved rendering; multi-select in the events view plus the "Link Events" toolbar control, in task 108's chip language. |
| 4 | Authoring gestures | Opus | Shift+click in a plot area with signals selected creates an event whose subjects are those signals and whose time is the clicked x; the trace row's context menu creates an event subjected to that message. Provenance-agnostic — the model does not know which gesture made it. |
| 5 | Highlight and extent | Opus | Acting on an event transiently highlights its subjects in the plot and the trace; a linked pair draws its extent as an event-colored wash at low opacity, **only** while one of the two is selected or hovered. Nothing persists, nothing to undo, nothing draws at rest but the marker lines. |

**The prototype is a design artefact, not a deliverable.** Unlike task
108's, [`plans/prototypes/events-point-at-signals.html`](../prototypes/events-point-at-signals.html)
carries no standing reference role, so it is deleted by the last phase
that consumes it — the pattern the status-bar prototypes followed. Its
trace view and plot panel show the general shape only and are **not** a
cue to redesign any existing GUI surface (owner reading, 2026-08-21).

## Carrier research — grooming (overseer, 2026-08-22)

Answers phase 2's research questions ahead of the phase, so it
implements rather than discovers. Grounded in the crates as they stand,
not in spec memory alone: `mdf4-rs 0.6.0`'s `EventBlock`,
`cannet-mdf/src/events.rs` + `write.rs`, and
`cannet-blf/src/format/marker.rs`.

### MDF4 — native support is close to exact

An `##EV` block is not merely a timestamped label. `EventBlock` exposes,
and `mdf4-rs` already parses and writes, every one of these:

| 107 concept | Native MDF4 field | Fit |
| --- | --- | --- |
| an event at a time | `sync_type = Time`, `sync_base_value` × `sync_factor` | exact (shipped) |
| its label | `name_addr` → `##TX` | exact (shipped) |
| **subject = signal** | `scope_addrs` → `##CN` (channel) | **exact** |
| **subject = message** | `scope_addrs` → `##CG` (channel group) | **exact** |
| **a span of two events** | `range_type` = Begin/End + `range_ev_addr` | close, but *typed* |
| **a chain of events** | `parent_ev_addr` | close, but *single-parent* |
| provenance | `cause` = User / Tool / Script / Error | maps onto `EventCategory` |
| anything else | `comment_addr` → `##MD` `common_properties` | **the format's own extension point, already implemented both ways** |

`scope_addrs` is the headline: MDF4's event model already says *"this
event is about these channels"*, as a list, mixing CN and CG references —
which is 107's subject list, natively, including the mixed case. This is
the common thing, and we should adopt it.

`common_properties` is the MDF analogue of DBC's `BA_`, and
`cannet-mdf` already reads it (`MdfEvent::properties`, `property()`) and
writes it (`comment_xml`). ADR 0010's "use the format's own extension
mechanism when one exists" is satisfied without inventing anything.

**Where the fit stops being exact, and why it matters.** MDF4 has *two
typed* link mechanisms where 107 has *one untyped list*:

- `range_ev_addr` makes a pair a **span**. The owner ruled the opposite —
  *"span-ness is nothing intrinsic to the events"* — so writing Begin/End
  as the storage form would fabricate a property the model denies.
- `parent_ev_addr` is **one** parent. A chain A←B←C survives; an event
  linked to three others does not.

So MDF's link fields are each *narrower* than ours, in different
directions. Adopting them as the storage form would reverse two owner
rulings and lose fan-out.

**Recommendation — adopt the superset, keep ours where theirs is
narrower, and write the native form as a bonus:**

1. **Subjects → `scope_addrs`.** Exact fit; adopt outright.
2. **Also write the structural reference into `common_properties`**
   (`cannet.subject.N` = message id / extended / signal name). A scope
   pointer resolves within *this* file; the structural reference is what
   the model stores and is what survives being read against a different
   database set. Read properties first, fall back to scope.
3. **Event links → `common_properties`** as a list of event ids, with
   `cannet.event.id` giving each event the id MDF has no field for.
4. **Opportunistic interop write:** where a link *happens* to join
   exactly two events and nothing else links either, additionally emit
   `range_type` Begin/End + `range_ev_addr`, so other MDF tools render
   the span. Read it back as an ordinary untyped link. Interop without
   a model change.
5. `cause = User` for user-authored, `Tool` for host-derived — though
   host-derived never reaches a carrier anyway (`exportable()`).

**Open question for the owner** — the one place new information touches
a settled ruling: links were ruled *untyped* before it was known that
MDF4 carries typed ones natively. If interop with other MDF tools
matters more than fan-out, the ruling is worth revisiting. The
recommendation above assumes it stands.

### BLF — no native support, so this is the hand-rolled side

`GLOBAL_MARKER` (object type 96) carries exactly: `commented_event_type`,
foreground/background colour, `is_relocatable`, and three strings —
`group_name`, `marker_name`, `description`. There is **no scope field, no
event→event link, and no event id.** `EVENT_COMMENT` is narrower still.
The prediction in the task file's opening was right: BLF is the
constrained side.

We already write `group_name = "cannet"`, so the namespace claim exists.

**Rejected options.** `group_name` is a *grouping* label that Vector
buckets markers by, so a per-event payload there produces one group per
event — actively worse than nothing. A separate `APP_TEXT` record keeps
user-visible strings clean but associates only by convention, and a tool
that rewrites the file may keep the markers while dropping or reordering
the `APP_TEXT`, silently orphaning every subject. That failure is
invisible and unrecoverable.

**Recommendation — the payload rides inside the record it describes**,
in `description`, behind a sentinel:

```text
<the user's own description, verbatim>
[cannet]{"v":1,"id":"…","subj":[…],"link":[…]}
```

The property that decides it: a tool that copies a marker copies its
metadata, and a tool that drops a marker drops its metadata — which is
correct. Orphaning is impossible by construction, which no out-of-record
option can promise. The cost is one visible line in CANoe, below the
user's own text.

Rules the implementation must hold:

- **Never lose text.** Parse by splitting at the last line beginning
  with the sentinel. If it does not parse, the whole string stays the
  description — a foreign marker whose description happens to contain
  the sentinel must round-trip unharmed rather than being eaten.
- **Versioned** (`"v":1`) from the first write.
- **Structural references only**, matching the model: message id +
  extended flag, plus signal name for a signal. No pointers — BLF has
  nothing to point at.
- The human description comes **first**, so a reader in Vector's tooling
  sees their own words on line one.

### What a round-trip loses, per format

| | MDF4 | BLF |
| --- | --- | --- |
| subjects | kept (native + structural) | kept (hand-rolled) |
| links | kept, and spans additionally legible to other tools | kept (hand-rolled) |
| visible to other tools | yes — scope and range are standard | as a text line |
| survives a foreign tool's rewrite | scope pointers yes; properties usually | yes, travels with the marker |

Phase 2 records this table in the ADR as the honest statement of what
each carrier does, per the task's "records exactly what a round-trip
through the constrained format loses".

### MDF's own vocabularies are closed — ours has to live beside them

Every classification field on an `##EV` block is a **fixed enum**, not an
application-extensible tag. As `mdf4-rs 0.6.0` exposes them:

| Field | Values | Extensible? |
| --- | --- | --- |
| `event_type` | `Recording` 0, `Trigger` 1, `Marker` 2 | no |
| `cause` | `Other` 0, `Error` 1, `Tool` 2, `Script` 3, `User` 4 | no |
| `range_type` | `Point` 0, `RangeBegin` 1, `RangeEnd` 2 | no |
| `sync_type` | time / angle / distance / index | no |

So an application cannot mint a type. This matters directly:
`EventKind` was built to grow — that is task 102's whole premise — and it
**cannot** be carried in `event_type`. The mapping is therefore: write
`event_type = Marker` (the user-marker slot), `cause = User`, and carry
the real kind as a property. Anything else would either lie about the
kind or lose it.

The extension point is `common_properties`, exactly as with the
subjects. That is the sanctioned place for application semantics, and
it is where every open axis of ours belongs.

**One thing phase 2 must verify against the ASAM spec before writing
anything, because we already ship it.** `mdf4-rs` defines three
`EventType` variants numbered 0/1/2, and its `from_u8` returns `None`
for 3–6. Published ASAM MDF 4.x lists seven event types, with
`EV_T_MARKER` at **6** and value 2 meaning acquisition interrupt. If
that is right, the library's numbering disagrees with the standard, and
`write.rs` — which already writes `EventType::Marker` for every note —
has been emitting an `ev_type` a conformant reader would interpret as
something else entirely. Two consequences either way: our existing
markers may be mislabelled to other tools, and a foreign file using
types 3–6 fails to parse for us. **Check the spec, do not trust the
crate or this paragraph**; if the crate is wrong, the fix is ours to
work around at the write boundary and the finding goes to the owner.

### The serialized form — one grammar, two containers

The payload must read as something a person understands when they open
the file in someone else's tool, not as an opaque blob (owner ruling,
2026-08-22). So it is **line-oriented `key: value` text with repeated
keys for lists** — readable, diffable, and each line standing alone —
rather than JSON.

The same grammar serves both carriers, because both already hold
repeated keys: BLF's marker `description` is free text, and
`cannet-mdf`'s `parse_properties` / `comment_xml` already round-trip
duplicate `<e name="…">` entries in order.

**BLF — inside the marker's `description`:**

```text
Contactor opened under load

cannet-event/1
id: 7f3a1c
kind: note
signal: 0x180 PackCurrent
signal: 0x180 ContactorState
message: 0x2A1
link: 91c2de
```

**MDF — the same fields as `common_properties` entries:**

| key | value |
| --- | --- |
| `cannet.event.id` | `7f3a1c` |
| `cannet.event.kind` | `note` |
| `cannet.subject` | `signal 0x180 PackCurrent` |
| `cannet.subject` | `message 0x2A1` |
| `cannet.link` | `91c2de` |

MDF additionally carries the subjects natively in `scope_addrs`; the
properties are the structural form, and the reader prefers them.

**Grammar**

- A reference's id is `0x` hex, with `/ext` suffixed for a 29-bit id:
  `0x18DA00F1/ext`.
- `signal: <id> <name>` — the name is *the rest of the line*, so a name
  containing a space survives.
- `message: <id>` — no name; the reference is structural and the name
  belongs to whatever database is assigned at render time.
- `link: <event id>`.
- The header line is `cannet-event/1`: the name and the schema version
  in one token, so a reader sees the version without parsing.

**Parsing rules, which are as much of the contract as the fields**

- The human description comes **first and verbatim**, then one blank
  line, then the header. A reader in Vector's tooling sees their own
  words on line one.
- Split at the **last** line that is exactly a recognised header. If
  there is none, the entire string is the description — a foreign
  marker whose text happens to mention `cannet-event` must round-trip
  unharmed rather than being eaten.
- **Unknown keys are preserved verbatim on rewrite.** A file written by
  a later version, opened and saved by this one, keeps the fields this
  version does not understand.
- A malformed line is preserved, not dropped, and does not invalidate
  the block.

### Owner ruling 2026-08-22 — two axes, and which one bends

> *"Our datamodel should be supported by our payload schema… we should
> stick the payload in both places in a reasonable text field. Interop
> with other MDF supporting tools seems like it would be best supported
> by populating the MDF metadata as well as we can support, given our
> datamodel, which we're not adjusting to MDF other than as an add-on
> for this compatibility."*

Two axes, separated:

1. **Fidelity — ours.** The `cannet-event/1` text block is the record of
   record, and it goes in **both** carriers, in each one's natural text
   field: BLF's marker `description`, and the MDF event comment's `<TX>`.
   Same grammar, same serializer, same parser, both formats. Read this
   first, always; it is the only thing that carries the model exactly.
2. **Interop — theirs, best effort.** MDF's native fields are populated
   from our model as far as they honestly go, as an **add-on**. They are
   never the source of truth and never constrain the model.

**This closes the open question above: the untyped-link ruling stands.**
`range_ev_addr` and `parent_ev_addr` are written where our data happens
to fit them and skipped where it does not — a link joining exactly two
events with nothing else attached gets Begin/End so other tools draw the
span; a fan-out link simply has no native form and is carried in the
text block alone. Nothing about MDF's narrower vocabulary reaches back
into `Note`.

Consequences for the phase:

- `common_properties` decomposition (`cannet.subject`, `cannet.link`) is
  **dropped**. One text block in one field beats the same data in two
  encodings, and the properties bought nothing that the native fields do
  not already buy for interop.
- **`cannet-mdf` cannot write `<TX>` today.** `comment_xml` emits
  `<EVcomment><common_properties>…` only. Phase 2 adds the `<TX>`
  element and its read side; the existing property reader stays, since
  foreign properties must still round-trip.
- Native interop write, per event: `scope_addrs` for subjects that
  resolve to a `##CN` or `##CG` in the file, `cause = User`,
  `event_type = Marker` (pending the numbering check above), and the
  range pair where a link is unambiguously a span.

### BLF's second colour — nothing uses it

`GLOBAL_MARKER` carries `foreground_color` and `background_color`, both
`0x00RRGGBB`. In Vector's tooling they are the label's text and fill.

Ours: `capture.rs` maps **`foreground_color` → `Note.color`** on read,
and the writer sets it from the event's colour. `background_color` is
parsed, preserved through a round-trip, and **never reaches the model** —
`format::marker::build` hardcodes it to `0x00FF_FFFF` and nothing reads
it back. It is not a second colour we maintain; it is a field we keep
byte-honest and ignore.

Worth knowing for the extent bands (§ band styling: an event-coloured
wash at low opacity): the wash is **derived** from the event's one
colour at render time, not stored. Nothing here needs a second colour,
and the model should not grow one just because BLF has a slot.

### The second colour, checked against a reference implementation

Vector publishes no field semantics we could find, but **python-can**'s
BLF writer is an independent implementation and its literals settle the
reading. It packs a global marker as:

```python
GLOBAL_MARKER_STRUCT.pack(
    0, 0xFFFFFF, 0xFF3300, 0, len(text), len(marker), len(comment))
#      ^fg white  ^bg orange
```

White foreground on a saturated background only makes sense as **text on
a filled chip**; the inverse convention would have put the saturated
colour in `foreground`. Two independent implementations naming the
fields the same way and choosing values consistent with one reading is
strong corroboration — it is still not Vector documentation, and nobody
has watched CANoe draw one.

**Consequence for our writer, which does the opposite.**
`append_marker` sets `foreground_color` to the event's colour and
hardcodes `background_color` to `0x00FF_FFFF` (white). Under the
text-on-fill reading that renders the label's *text* in the event colour
on a white chip — legible, but the event's colour is carried by thin
glyphs rather than by the fill, where python-can's convention makes it a
solid block. If the point of an event's colour is recognition at a
glance, we are probably under-using the field.

Not changed here: it is a one-line default, it affects only how other
tools draw our markers, and the honest test is empirical — write two
markers with clashing colours and open the file in CANoe, which needs
the owner's machine. Recorded so the choice is deliberate rather than
inherited.

**Also worth knowing for interop expectations:** python-can's *reader*
ignores object type 96 entirely — it writes global markers and never
parses them back. Ours reads them. So a tool built on python-can will
not show cannet's events at all, and that is the reader's limitation,
not our encoding's.
