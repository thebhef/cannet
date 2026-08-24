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

## Status log

### Phase 1 — the subject model (2026-08-22)

Landed on `task-107-phase-1-subject-model`, off `task-108-phase-6-panel-icons`.

- **`EventSubject`** in `notes.rs`: an internally-tagged, camelCased enum
  with the three groomed kinds — `message {message_id, extended}`,
  `signal {message_id, extended, signal_name}`, `event {id}`. No bus, no
  database identity.
- **`Note.subjects: Vec<EventSubject>`**, `#[serde(default)]`, so a
  pre-subject `notes.json` / BLF-derived note still reads. One field on
  the existing struct, no side table; every category may carry it and
  `exportable()` is untouched.
- **Store operations**: `set_subjects`, `link_events`, `unlink_events`,
  `linked_events`, plus the free `linked_event_ids(&[Note], id)`.
  `link_events` stores **one** entry, on the event named first, and is a
  no-op when the pair is already linked in either direction, when the two
  are the same event, or when either id is unknown. `unlink_events` finds
  the entry from whichever side holds it.
- **Deletion sweep** in `remove`: the removed id is stripped from every
  remaining durable note's subject list inside the same `Applied` and the
  same scratch write. Signal and message references are never swept, and
  neither `replace` nor `restore` sweeps — an unresolved reference is a
  state, not a fault. The host-derived list is not swept either: it is
  recomputed wholesale, so an edit there would be discarded.
- **IPC**: `set_note_subjects`, `link_events`, `unlink_events`, registered
  in `lib.rs`, each emitting the existing `notes-changed`.
- **Frontend types** (no UI): `EventSubject`, `Note.subjects?`,
  `TimelineEvent.subjects`, carried through `noteToEvent` /
  `truncationEvent`, and `linkedEventIds` — the symmetric read the row and
  plot renderers will do at render time over the list they already hold,
  the way `timelineEvents` / `tagsInUse` already work.
- **[ADR 0056](../../docs/adr/0056-an-event-subject-is-a-structural-reference.md)**
  records the model: a subject is a structural reference (§ 1), any
  category may carry one (§ 2), **span-ness is a relationship, never an
  event field** (§ 3), a link is stored once and read from both ends
  (§ 4), and only event references are swept (§ 5). Its consequences
  section states the rule phase 2 needs: a carrier's narrower native link
  fields may be populated as interop, never as the storage form.

**Judgement calls, for the record.**

- `linked_event_ids` / `NotesStore::linked_events` carry
  `#[allow(dead_code)]`. Nothing in the host calls them yet — the carrier
  and the host-side consumers arrive later — but the symmetric read is the
  model's own contract, so it belongs beside the model rather than being
  re-derived by each caller. Same idiom as `bus_health.rs`.
- No README change. This phase ships nothing a user can see; the README
  gains its paragraph when the chips do.
- No perf reading taken: a host-side model with no UI, no render path and
  no live data path.

**Tests** — written first, watched fail, then made pass.

- Rust, 14 new (`notes::subject_tests`): each reference kind round-trips
  through serialization with camelCase keys; a pre-subject note still
  deserializes; subjects survive a scratch round-trip including an
  unresolvable signal and an unresolvable link; `set_subjects` replaces the
  list and touches nothing else; a link is stored once and read from either
  end; unlink works from the side that does not hold it; a chain reads as
  the links at each end; `remove` sweeps event references and leaves signal
  and message references; the sweep rides the same `Applied` and the same
  scratch write; `clear` takes the references with the events; an
  unresolvable reference survives a `replace`; a host-derived event may
  carry subjects and still never be exported; a link to a host-derived
  event reads symmetrically.
- TS, 5 new (`notes.test.ts`): the subject list reaches the rendered event;
  an event with none gets `[]`, never `undefined`; the link reads from
  either end; a chain names both ends from its middle; an unresolved
  reference is absent from the link list without being dropped.
- `cargo test -p cannet-gui` 907 passed; `cargo test --workspace` green
  except the pre-existing failure below; `pnpm --dir apps/gui test` 2762
  passed across 207 files; `cargo clippy --workspace --all-targets` clean
  except the pre-existing warning below.

### Phase 2 — the carrier (2026-08-22)

Landed on `task-107-phase-2-carrier`, off `chain-ci-repair` (`1ef20769`).

**One grammar, three records.** `apps/gui/src-tauri/src/event_text.rs` is
the whole serializer and parser: the `cannet-event/1` block, written into
a BLF marker's `description`, a BLF comment's text field, and an MDF
event comment's `<TX>`. The block carries only what the container cannot —
id, kind, tag, subjects, and (where the record has no field of its own)
label, colour and the commented object type. The human description comes
first and verbatim; the split is at the **last** header line; unknown keys
and malformed lines are kept rather than dropped.
[ADR 0057](../../docs/adr/0057-one-text-block-carries-an-event.md) records
it, including the per-format loss table the phase was asked for.

**MDF gained the `<TX>` half of the event comment.** `comment_xml` now
emits `<TX>` before `common_properties` (the `EVcomment` schema's order)
and `read_events` parses both, so a foreign tool's properties still
round-trip while the block rides the text element.

**Native interop, written where it is honest.** `MdfEvent` gained
`range: Option<MdfEventRange>` and the writer emits a begin/end pair —
patching the link address in the trailer, since an end event points back
at a begin block written after it — only where a link joins exactly two
events and nothing else links either. A fan-out link gets no range. Read
back, a foreign range pair becomes one more untyped link, deduplicated
against whatever the block already said.

**`ev_type` was wrong, and had been.** See the investigation below.

**BLF's second colour, fixed as queued.** `append_marker` now puts the
event's colour in `background_color` under a white `foreground_color` —
python-can's convention, text on a filled chip. An uncoloured event keeps
`build`'s neutral black-on-white, byte-identical to before. On read the
colour is the fill unless the fill is white, in which case it is the
foreground — which reads the neutral default as uncoloured and, for free,
reads every marker written under the old convention. Two shipped
assertions moved from `foreground_color` to `background_color`
(`cannet-blf` lib and `scan` tests), as expected.

**Legacy read paths kept.** The `cannet:event:` packing, the bare-id
marker, and the MDF `cannet.*` `common_properties` are still read and no
longer written. Judgement call: this file's `note_from_marker` already
carried a bare-id fallback, so keeping two more is the module's own idiom,
and dropping them would make an existing capture open with its ids and
tags mangled. Twelve lines and one test.

#### Investigation — `ev_type` (scientific method)

- **Observation.** `mdf4-rs 0.6.0` `EventType` is `Recording = 0`,
  `Trigger = 1`, `Marker = 2`, and `from_u8` returns `None` for 3–6.
  `write.rs` has been writing `EventType::Marker` for every note since the
  MDF writer landed.
- **Hypothesis.** The crate's numbering disagrees with ASAM MDF 4.x, which
  puts `EV_T_MARKER` at 6 and assigns 2 to `EV_T_ACQUISITION_INTERRUPT`.
- **Experiment.** Ask an implementation that is not the one we link:
  `asammdf`'s `blocks.v4_constants`, read directly.
- **Data.** `EVENT_TYPE_MARKER 6`, `EVENT_TYPE_ACQUISITION_INTERRUPT 2`,
  `EVENT_TYPE_TO_STRING {…, 2: 'Acquisition interrupt', 6: 'Bookmark'}`.
  `EventCause` and `EventRangeType` both match the crate.
- **Conclusion.** The crate is wrong on this one enum. The write boundary
  now stamps the byte directly (`EV_TYPE_MARKER = 6`), the read side is
  unaffected (`cannet-mdf` never consults `ev_type`), and the oracle
  asserts the byte through asammdf.

#### `ev_scope` is not written, and the grooming's condition is never met

The research recommended `scope_addrs` for subjects that resolve to a
`##CN` or `##CG` in the file. Reading the writer: a cannet MDF has three
bus-logging groups, one per frame *structure*, and one group per
file-backed signal — no per-message channel group, and deliberately no
DBC-decoded signal channels. So a message subject has nothing to point at,
and pointing one at `CAN_DataFrame` would claim the event is about every
data frame. Scope is left empty; ADR 0057 records the condition under
which it becomes writable. Queued as 3.29.

#### A groomed rule that needs a model change to hold fully

"Unknown keys are preserved verbatim on rewrite" holds at the text layer
(parse → serialize keeps them, with a test) but **not** through
`file → Note → file`: `Note` has no field to hold them, and adding one is
a durable-schema change phase 1 fixed. Implemented the closest faithful
reading, recorded the gap in ADR 0057's loss table, queued as 3.30.

**Not done, deliberately.** No UI — subjects reach the row in phase 3. No
perf reading: a save/open path with no render surface and no live data
path, and the harness exercises neither.

**Tests** — 33 new, the grammar's written first and watched fail.

- `event_text` (14): the description comes first and the block follows;
  every subject kind round-trips; an extended id is distinguishable; a
  signal name with a space survives; no header means all description;
  prose that merely mentions the block is not a block; the last header
  wins; an unknown key, a malformed line and an unknown kind are each kept
  verbatim; nothing-but-a-description writes no header; a carrier with no
  name or colour field carries them in the block; a multi-line description
  keeps its blank lines; every kind's key matches its wire spelling.
- `cannet-gui` integration (7): every subject kind survives a BLF
  round-trip on both records, and an MDF round-trip; an unambiguous pair
  also gets MDF's native range and a fan-out does not; a foreign MDF range
  pair reads back as a link; a link to an unexported event survives
  unresolved; `#000000` reads back uncoloured from BLF and survives in
  MDF; both pre-block forms are still read.
- `cannet-mdf` (6): `<TX>` and the properties share one comment, in schema
  order; markup in the text survives escaping; a comment without text
  yields none; a native range pair links both ways and leaves a point
  event alone; an event is written as the standard's marker type.
- `cannet-blf` (1): a marker carries the event colour as its fill over
  white text, with an uncoloured marker as the control.
- The asammdf oracle now checks each event's `<TX>` text, `ev_type`,
  `ev_cause`, `ev_range_type` and the address its range link resolves to;
  `export_sample` writes a range pair and a `<TX>` block so it has
  something to check.

All six CI jobs run locally and green.

### Phase 3 — subjects on the event row (2026-08-22)

Landed on `task-107-phase-3-subject-chips`, off `task-107-phase-2-carrier`
(`8d8e105a`). The first phase of 107 with any UI, and no Rust changed.

**Resolution is a pure function, and it is the phase's centre.**
`apps/gui/src/eventSubjects.ts` turns an event's subjects into the chips a
row draws: `subjectIndexFor(catalog)` is what the assigned databases can
name (message id + extended → name; message + field → does it exist),
cached in a `WeakMap` on the catalog array so a viewport of rows shares
one index; `subjectChips(event, events, index, idFormat)` returns the
chips. Message and signal subjects come first in the order the event
stores them, then the links.

- **Unresolved is drawn, not repaired.** A chip whose reference no
  assigned database names keeps its label — the field name, or the
  arbitration id — goes muted and italic, and says why in its tooltip.
  Four tests pin it, including the same event read against an empty
  catalog.
- **A message chip reads `s:1A2 BMS_Status`**, the trace's own id
  spelling and the view's own id format, rather than the prototype's
  `0x1A2`. `formatId` grew a raw-pair twin (`formatArbitrationId`) so
  there is one place the prefix rule lives.
- **No swatch on a signal chip.** The prototype draws one. A subject
  stores no bus (ADR 0056) and `signalKey` — what the colour resolver
  takes — is bus-scoped, so a structural reference has no single colour
  to draw. Kinds are told apart by ink instead: a message in
  `--text-message` (the trace's id column), a link by the registry's
  `link` glyph, everything muted-italic when unresolved. Prototype
  updated to match, in this commit.
- **`linked_event_ids` was already called** — phase 2's `capture.rs`
  got there first, and its `#[allow(dead_code)]` is gone. The caller
  this phase adds is the **frontend** twin `linkedEventIds`, which
  `subjectChips` uses for the link chips, so both events in a pair chip
  each other though only one stores the reference. See the blocker below
  for `NotesStore::linked_events`, which is still uncalled.

**Overflow: the shared planner, an unshared destination.** The chips are a
run through `useToolbarFit` / `planToolbarFit` — the same measurement and
the same arithmetic the status bar and both toolbars use, not a second
implementation. What could not be shared is where the collapsed chips
*go*: the status bar drops an absolutely-positioned menu, and an event row
cannot. `.trace-rows` is `overflow: auto; contain: strict` and the sticky
row stack inside it is `overflow: hidden`, so a dropdown from a row is
clipped by construction; portalling one out is a larger change than this
phase. The row already has an expansion — the body that discloses the tag
and the description — so `…` opens that, and the body gained an **about**
line carrying every chip. Same promise as the status bar's: nothing is
more than one click away, and the row never grows with the subject count.

Two details that decide whether the measurement is stable:

- **The chips container grows** (`flex: 1 1 auto`), so its `clientWidth`
  is the room the row has left over rather than a function of what is in
  it. Measuring a shrink-to-fit container would make the planner chase
  its own tail: collapse a chip, the container narrows, the planner
  collapses another.
- **It must not clip.** The hook's own docs say a clipping bar swallows
  its overflow; here fit is guaranteed by removing chips, and clipping
  would instead hide them silently.

**Multi-select and the Link Events chip.** ADR 0044 leaves selectability
to the adapter, so `TraceView` grew `selectableEvents` and the Events view
sets it; `onEventSelectionChange` reports the selected event ids up rather
than the panel keeping a second selection model. The chip is a plain
`ChipButton` with the registry's `link` icon — the 108 prototype's
events-view bar, built as drawn. `NotesContextValue` gained `linkEvents` /
`unlinkEvents` over phase 1's IPC. The pair is sorted chronologically and
the reference is stored on the **later** event, so the stored form is
predictable; nothing reads the direction. Both changes are queued for the
owner (3.20, 3.21 → queue 1.20, 1.21).

**Judgement calls, for the record.**

- **The chip is not a `ChipButton`.** A subject chip is neither a command
  nor a state report — it names a thing, and in this phase it does
  nothing when pressed. It is its own small element on the chip
  language's tokens (2px radius, `--border-wash` hairline, 11px). The
  `…` control *does* borrow the status bar's
  `.status-bar-overflow-button` outright, plus a density modifier — the
  sanctioned "shared class on a bespoke button", so "there is more, one
  click away" looks the same everywhere.
- **The Link Events chip unlinks too**, which the groomed scope did not
  say. Built strictly as scoped, a link could be made and never unmade
  and `unlink_events` would keep its no caller. Queued rather than
  assumed.
- **The subjects body line is keyed off the stored list, not off what
  resolves**, so assigning or dropping a database never moves the row
  geometry underneath the reader.

**Perf.** Three 60 s ADR-0031 captures on ev-zonal, release build,
`--perf-interact scrub`, load verified (`ids_measured` 173, rx ≈ 1607 f/s,
tx ≈ 1610 f/s). `check` passed on runs 1 and 3; run 2 failed one metric,
`tx_late_ms_max` 73.8 (baseline 15.3, limit 55.7), with 19.3 and 20.9 on
the other two. Read as the known worst-of-N tail rather than this change:
the ev-zonal project carries no events, so no chip renders in the capture
at all, and tx lateness is the host's transmit scheduler. Memory came in
*under* baseline on every tier (renderer peak 310–313 MB vs 316; tree peak
725–728 MB vs 742).

*A rig note, since the run instructions omit it:* `--connect-on-start`
alone gives a 0 f/s capture on ev-zonal — the load is the RBS, and
`--rbs-run-on-start` is what arms it. The first attempt read `rx_fps 0`,
`tx_fps 0`, `rx_gap: null` with both dongles enumerated and no other
cannet running; it was discarded, not filed.

**Tests** — 33 new, written first and watched fail.

- `eventSubjects` (14): the index is shared per catalog and rebuilt for a
  new one; a message and a signal each resolve; an unresolvable one keeps
  its label and says why; an extended reference is distinct from the
  standard id of the same number; the id follows the view's format; a
  signal whose message resolves but whose field does not is unresolved; a
  link reads from the storing end and from the other end; a link to an
  absent event chips nothing; subject order is kept with links last;
  every key is distinct.
- `EventSubjectChips` (7): everything draws when there is room; what does
  not fit collapses into a `…` carrying its count; the chips come back
  when the room does; a single overflowing chip still gets the `…` rather
  than being dropped; pressing it discloses the row and opens no menu;
  the press does not reach the row's own click; it reports the row's
  disclosed state.
- `EventsPanel.subjects` (12): a signal and a message resolve on the row;
  an unresolvable pair renders muted and still names what it points at;
  the same event read against no database resolves nothing; an event
  about nothing draws no chip region; a link chips on both events; a link
  to an absent event chips nothing; the body's about line lists every
  subject; subjects give a non-editable event something to disclose;
  Link Events is off until exactly two are selected, links storing on the
  later event, becomes Unlink Events on an already-linked pair, and goes
  off again when the selection collapses.
- Two shipped assertions changed with the behaviour: the events view's
  event row now *does* carry `aria-selected` (the trace's still does
  not, pinned where it was), and `TraceView.gridview`'s fixture event
  gained the `subjects: []` every real event carries.
- `pnpm --dir apps/gui test` 2795 passed across 210 files. All six CI
  jobs run locally and green.

### Phase 4 - authoring gestures (2026-08-22)

Landed on `task-107-phase-4-authoring`, off `task-107-phase-3-subject-chips`
(`bbb1062f`). Frontend only; no Rust changed.

**One constructor is the whole design.** `authorEvent(timestampNs,
subjects, existingCount)` in `notes.ts` mints every user-authored event -
id, `note N` label, the wheel colour at the existing count, and the
subject list. The plot's note cursor now goes through it too, so the
three ways to make an event produce one indistinguishable shape.
Provenance-agnostic is not a field we left out; it is a function nobody
can route around. A test pins it: two events authored from different
gestures have the same key set and differ only in subjects and time.

**Plot - Shift+left-click over a selection.** `PlotArea`'s `mouseup`
dispatcher gained one branch, ahead of the cursor-mode dispatch:

- **Ahead of it, not inside it.** The gesture is a modifier of its own,
  so it reads the same in `x` / `y` / `note` / `off`. Putting it after
  the `cursorMode === "off"` early return would make it silently dead in
  the mode a plot spends most of its time in.
- **Gated on the selection naming something**, so with nothing selected
  the click falls through and behaves exactly as it did before. That is
  what keeps it from stealing a gesture: Shift was read nowhere in
  `mousedown` / `mouseup`, so Shift+click *was* a plain click - and with
  no selection it still is.
- **The subjects come from the model's own selection**, per logical area
  (`selectionSubjectsByArea` in `PlotPanel`, over `subjectsForSelection`
  in `plotEvents.ts`). Clicking any axis of the area that holds the
  selection names the whole selection; an area that does not hold it
  names nothing.
- **Time comes from the path that already existed** - `onAddNote(x)`'s
  `baseSeconds + t`, unchanged. Nothing new re-derives time from pixels.

**Trace - the row's context menu rides the panel's existing one.**
`TraceView` gained `onFrameContextMenu`; a frame row given one keeps the
right-click (`preventDefault` + `stopPropagation`, the column header's
settled precedent) and hands the frame up. `TracePanel`'s menu state
grew the frame, and `SourcesContextMenu` grew a `rowAction` slot that
draws **above** the checklist - the more specific target's command
first, the view-wide sources where they have always been.

The alternative, a second menu of its own, was rejected: the panel opens
its sources picker on *any* right-click, and rows are almost all of the
panel, so a row-owned menu would take that affordance away over most of
the surface. One menu, two scopes, nothing lost.

**Judgement calls, for the record.**

- **`NotesContextValue.addNote` now takes the whole `Note`** rather than
  four positional arguments. `authorEvent` returns exactly the struct
  `add_note` accepts, and a fifth positional argument for subjects was
  the alternative. `App.tsx`'s dispatcher shrank to one `invoke`.
- **A file-backed series contributes no subject.** Its `messageId` is a
  signal channel group index, not an arbitration id, so a structural
  reference built from it would name a message that does not exist. A
  selection of nothing but file-backed rows therefore names nothing and
  the gesture falls through. Recorded as a blocker rather than papered
  over.
- **The trace row's event is labelled `note N`, not `<message> marked`**
  as the prototype drew it. A label that names the gesture's input is a
  provenance tell in everything but the schema - you could sort events
  by how they were made. The subject chip already says what it is about.
- **No dialog.** The existing creation path is silent (auto label, auto
  colour, edited in place afterwards); both gestures match it. The
  prototype's trailing ellipsis on the menu item, which promises one, is
  dropped.
- **Neither gesture needs `NotesStore::linked_events`.** Phase 3 named
  this phase its next plausible caller. It is not one: authoring writes,
  it does not read links, and nothing here runs host-side at all. The
  `#[allow(dead_code)]` stays, and phase 5's highlight work - which does
  read links - reads them in the frontend through `linkedEventIds`, so
  it will not be the caller either. Worth a decision.

**README.** The events section gains the two gestures and the
provenance-agnostic statement; the Notes paragraph no longer claims the
note cursor is the only way one is placed.

**Perf.** Three 60 s ADR-0031 captures on ev-zonal, release build,
`--perf-interact scrub`. Load verified on every run before reading
anything: `ids_measured` 173, rx 1601-1608 f/s, tx 1604-1610 f/s. The
canonical three-report `check` passed, 69 metrics gated, nothing failed.
`tx_late_ms_max` came in at 24.4 / 18.4 / 24.8 ms against a 55.7 limit -
the ~20 ms neighbourhood phase 3 saw on two of its three runs, with no
sign of its 73.8 ms outlier. Memory under baseline on every tier
(renderer peak 310-312 MB vs 316; tree peak 725-730 vs 742). Reports
committed as `2026-08-22-bbb1062f-authoring-run{1,2,3}.json`, named for
the base commit the way phase 3's siblings are.

**Perf-recipe documentation fixed, at the overseer's instruction.**
`README.md`'s worked capture recipe used `--connect-on-start` alone, and
`--rbs-run-on-start` appeared nowhere in the frontend perf instructions -
two phases in a row followed the documented recipe and measured an idle
bus. The code block now carries the flag, it has its own bullet saying
why (an RBS Run flag is session state no project carries, per ADR 0028,
and a fresh `--app-data-dir` has none to resume, so `--connect-on-start`
alone connects successfully to a silent bus), and the always-on/off table
carries a row for it. The prose that claimed the run flag was "already in
the saved project" was wrong and is corrected. The three runs above are
the corrected recipe run verbatim.
`crates/cannet-perf-measurement/README.md`'s Idle-scenario line was
checked and left alone: its "launched without `--connect-on-start`"
describes the *screenshot* harness, which passes neither flag (the RBS
flag appears nowhere in that crate's source), so with no connection
there is no load whatever the RBS flag says.

**Prototype.** Updated in this commit to match what shipped - the plot
gesture's mode-independence and its no-selection fall-through, and the
trace item riding the panel's existing menu. Phase 5 deletes the file.

**Tests** - 23 new, written first and watched fail; the plot gesture's
were additionally mutation-proved by disabling the branch (3 of the 5
flipped red, the two no-regression guards correctly did not).

- `notes` (5): the constructor mints at the given time with the given
  subjects; the label numbers and the colour cycles off the existing
  count; ids are distinct; two gestures' events have the same key set;
  an unsubjected event is what it always was.
- `plotEvents` (5): the selection becomes subjects in the area's order;
  only what is selected; the extended flag survives; the same signal on
  two buses collapses to one subject; a file-backed series contributes
  none.
- `PlotPanel` (5): Shift+click authors about the selection; the event
  records nothing about the gesture; it works in `x` / `y` / `note`; with
  nothing selected nothing happens; the note cursor's plain click stays
  subject-less.
- `TraceView` (3): a frame row hands the frame up and stops the event;
  with no owner it bubbles as before; an event row offers nothing.
- `TracePanel` (5): the menu leads with the action and keeps the picker;
  the id is named when no database is; the event is about that message
  at that frame's time and closes the menu; the extended flag survives;
  a right-click that hit no row offers no action.
- One shipped assertion moved with the dispatcher's signature
  (`PlotPanel.dom.test.tsx`'s wheel-colour test reads `note.color`
  instead of the fourth positional argument).
- `pnpm --dir apps/gui test` 2818 passed across 210 files. All six CI
  jobs run locally and green.

## Blockers / side effects

### Phase 1 (2026-08-22) — both since repaired

Both were **inherited from the base branch**
(`task-108-phase-6-panel-icons`, `d846c48d`), reproduced with phase 1's
changes reverted, and were in files phase 1 did not touch. `1ef20769`
(`chain-ci-repair`) fixed both; phase 2 branched off it and `cargo test
--workspace` and `cargo clippy --workspace --all-targets -- -D warnings`
are clean.

- **`cannet-perf-measurement` unit test fails.**
  `screenshot::tests::the_scenarios_drive_labels_the_frontend_still_defines`
  panics with *"a scenario clicks 'Add transmit panel', which App.tsx no
  longer defines"*. The label is absent from `App.tsx` at the base commit
  too, so the icon sweep renamed the command without updating the
  screenshot scenarios. `cargo test --workspace` is red until it is fixed,
  and the fix is a choice of label that belongs to whoever renamed it.
- **`cannet-dbc` clippy pedantic warning.** `crates/cannet-dbc/src/tests.rs:615`
  — `redundant_closure_for_method_calls` on `.is_some_and(|c| c.is_empty())`.
  Byte-identical at the base commit. `cargo clippy --workspace --all-targets
  -- -D warnings` — the pre-commit hook and the CI job — fails on it.

### Phase 2 (2026-08-22)

- **Every `##EV` block cannet has ever written carries `ev_type = 2`**,
  which ASAM MDF 4.x reads as `EV_T_ACQUISITION_INTERRUPT`. New files are
  correct; files already on disk are mislabelled to any conformant reader,
  and nothing rewrites them. Ours read them fine — `cannet-mdf` does not
  consult `ev_type`.
- **`mdf4-rs 0.6.0`'s `EventType` is wrong and `from_u8` rejects 3–6**, so
  a foreign file using those types parses as `Marker` rather than being
  reported. The write side is worked around here; the read side is
  untouched because nothing reads the field. Worth an upstream issue.
- **A BLF marker's colours changed meaning.** A coloured event's bytes are
  different from every previous release's — the colour moved from
  `foreground_color` to `background_color`. Ours reads both; another tool
  will draw a filled chip where it used to draw coloured text. Nobody has
  watched CANoe draw either, so the reading is still corroboration rather
  than observation.
- **A `#000000` event loses its colour through BLF** (§ ADR 0057's loss
  table). Pre-existing — the packed `0` has always meant both black and
  uncoloured — and now pinned by a test rather than left implicit.

### Phase 3 (2026-08-22)

- **`NotesStore::linked_events` still has no caller and keeps its
  `#[allow(dead_code)]`.** Phase 1 named this phase its intended caller
  and asked for the attribute to go. It could not: the caller this phase
  adds is a *renderer*, and renderers are the frontend, which reads the
  symmetric link over `TimelineEvent[]` through the TS twin
  `linkedEventIds` — now called for real. The Rust free function
  `linked_event_ids` did get its production caller, in phase 2
  (`capture.rs`, the MDF range-pair interop write), and its attribute is
  already gone. What remains dead is the one-line `NotesStore` wrapper,
  exercised only by its own tests. Left in place rather than deleted: it
  states the model's contract beside the model, and phase 4's authoring
  gestures are the next plausible host-side caller. Worth a decision if
  they turn out not to be.
- **The `…` opens the row's body instead of a menu.** The prototype and
  the status bar both drop an absolutely-positioned list. `.trace-rows`
  is `overflow: auto; contain: strict` and the row stack inside it is
  `overflow: hidden`, so a dropdown from a row is clipped by
  construction — this is a property of the virtualized scroller, not of
  the chip language, and it would take portalling the menu out of the
  scroller to change. The disclosure is the app's own expansion
  mechanism and reaches the keyboard cursor for free, so it was the
  closest faithful reading; the prototype was updated to match.
- **A signal chip has no colour swatch, though the prototype draws
  one.** A subject stores no bus (ADR 0056) and signal colour is
  bus-scoped (`signalKey`), so one structural reference can map to
  several coloured series. Nothing here should grow a colour; if the
  owner wants a swatch, the honest version picks a bus, which is a model
  change.
- **`--connect-on-start` alone measures an idle bus on ev-zonal.** The
  designed load is the RBS, and `--rbs-run-on-start` arms it. Without
  it the capture is real, the report is written, and every gated metric
  passes on nothing — exactly the silent-disarm failure mode the perf
  rules warn about. The frontend perf instructions in
  `crates/cannet-perf-measurement/README.md` do not name the flag.

### Phase 4 (2026-08-22)

- **Shift+click was not a free gesture, only an unread one.** Shift is
  inspected nowhere in the plot canvas's `mousedown` / `mouseup`, so
  Shift+left-click has always behaved as a plain left-click: place
  cursor A in `x` mode, H1 in `y`, a note in `note`. It now authors an
  event **when the clicked area holds a signal selection**, and does the
  old thing otherwise. Nobody could have been relying on the difference -
  there was none to rely on - but it is a change to what a modified click
  does on a shipped surface, and it is deliberately mode-independent, so
  it also fires in `off`, where a click used to do nothing.
- **A right-click on a frame row no longer opens the plain sources
  picker.** It opens the same menu with one extra action on top. The
  picker is intact and in the same place; what changed is that the menu
  now has an item above it, and the row's right-click no longer reaches
  the panel handler (the row's own handler puts the same menu up).
- **A file-backed series cannot be an event's subject.** Its
  `messageId` is a signal channel group index, not an arbitration id, so
  `EventSubject`'s structural form has nothing true to say about it.
  Shift+click over a selection of nothing but file-backed rows names
  nothing and falls through to the cursor mode. Closing it means a
  fourth referent kind - a file-backed signal reference - which is a
  model change (ADR 0056).
- **The plot gesture is undiscoverable.** Nothing on the plot says
  Shift+click does anything; the README does. The prototype showed a
  hint in the plot bar ("Shift+click to mark ...") that the shipped
  toolbar has no room for, and the chip language has no hint-text
  element. Recorded rather than invented.
- **`NotesStore::linked_events` still has no caller**, for the second
  phase running. Phase 3 nominated this phase; authoring writes rather
  than reads, and phase 5's highlight work reads links in the frontend
  through `linkedEventIds`, so it will not be the caller either. The
  `#[allow(dead_code)]` should probably be resolved by deleting the
  wrapper - the free `linked_event_ids` it delegates to has a production
  caller and states the same contract.
- **An event created from a trace row is timestamped through the wire's
  `f64` seconds.** `TraceFrameRecord` carries `timestamp_seconds`
  (`timestamp_ns / 1e9`), so the gesture inverts that division. At
  absolute unix ns the double's ulp is ~238 ns, far below the ~600 us
  mean inter-frame gap at ev-zonal's 1608 f/s, so the event anchors to
  its own frame in practice. It is not exact, and a capture with
  duplicate-timestamp frames could anchor an event one row late.
  `Note.timestampNs` is a JS number on the same wire, so this is the
  system's existing precision floor rather than a new one.
