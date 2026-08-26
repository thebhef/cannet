# Task 102 — The Event Surface: Kinds, Filtering, and Its Own View

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All five
> phases landed 2026-08-21 on the chain (nothing has merged). **This task
> was listed on neither `roadmap.md` nor the owner-review queue until
> 2026-08-23**, so none of its findings had ever reached the owner. Its
> five exit criteria are walked at `### Exit criteria — verdict`: **four
> met** and one **not met** (the macOS check, which needs a Mac). The
> graph-view clause was struck from ADR 0035 by owner ruling 2026-08-26,
> which takes its criterion to met. Findings still owed a verdict:
> owner-review-queue **3.54** and **3.56**. (**3.55** struck 2026-08-26;
> **3.57** closed the same day — import-only is sufficient now that task
> 107's *Create event from &lt;message&gt;* gesture exists.)

Promoted from `plans/backlog.md` § "Cursors and markers" by owner
instruction 2026-08-20, while grooming bus health (task 101): *"I think
it would be nice if they were an event type, and by default not shown
anywhere. Now events have types! I think there's a task on this one
already. Let's ID it and groom it as well."*

There was no task — the work sat in the backlog. This is it. The same
ruling applies that promoted task 89: groomed material belongs in a
task, not the backlog.

## What already exists

[ADR 0035](../../docs/adr/0035-timeline-event-model.md) is the model:
one host-side event store, markers across every timeseries view,
persisted, exported, navigable. Task 18 landed more than the truncation
marker it was scoped to:

- events carry `kind` + `color` (`notes.rs`);
- events **interleave into the chronological trace** by timestamp —
  `eventMerge` splices host-anchored events (`frame_indices_at_ns`)
  into the windowed frame stream;
- a singleton `EventsPanel` (command palette → "Show events") renders
  the trace view's event rows alone;
- `EventContextMenu` edits name / color / remove on any editable row.

**`EventKind` is built to grow and hasn't.** Its rustdoc
(`notes.rs`) says the store holds user-authored durable kinds, that
derived kinds are synthesized in the frontend and never enter the
store, and that *"the set grows as durable kinds (message-bound,
trigger) are added"*. It has exactly one variant: `Note`. The
truncation marker is the one derived kind, frontend-only.

So the concept is in place and unexercised. Everything below is the
first real use of it.

## Scope

### 1. Kinds become a real axis

More than one variant, and every surface that renders events knows
which kinds it is showing. This is the piece task 101 consumes: an
error event must be a kind, and must default to hidden.

- **Per-kind visibility, with a default per kind.** A kind declares
  whether it shows by default; the user overrides per view. "By default
  not shown anywhere" must be expressible.
- **Where the default lives** is a design question below.

### 2. The event view grows up

- Cursors and markers become their own **top-level view** — they are
  global, not per-panel, with a lifecycle like the project view, graph
  view and system messages. (The singleton `EventsPanel` is the seed.)
- Filtering **by kind** and by the user-defined event tag.
- Each marker carries an **editable description**; the row expands to
  show the body, collapsed by default, with a per-marker colour picker.

### 3. BLF record types

- The view shows both BLF record types — `GLOBAL_MARKER` and
  `EVENT_COMMENT` — filterable by record type.
- **Create marker from message**: emit an `EVENT_COMMENT` whose
  `commentedEventType` matches the source message (`can` / `can-fd`)
  and whose object timestamp equals the source message's, so it tracks
  with the message per the BLF spec. The text field is prefixed
  `cannet:event:<user-string>\n` to enable filtering; the UI strips the
  prefix and renders `<user-string>`. Use cases: fault detections,
  contactor open/close, specific commands sent. **UI design needed**
  for picking the source message and authoring the text.
- ~~`EVENT_COMMENT` markers render in the **graph view** when enabled in
  the filter.~~ **Struck 2026-08-26** — there is no timeseries graph
  view, and never was. They render in the **plot** and in both trace
  modes, which is what the clause was reaching for. ADR 0035's decision
  point 3 was amended to match.
- `GLOBAL_MARKER` and `EVENT_COMMENT` items appear in **historical-mode
  trace views**.

### 4. The macOS colour-picker bug

`[bug]` The native colour picker for events opens in the wrong location
on macOS; the plot series picker opens correctly, so the two anchoring
paths differ. **A candidate fix has landed and is unverified on
macOS**: `.trace-event-swatch-input` now fills the swatch's real
footprint (`inset:0`, no `width/height:0`) rather than collapsing to a
zero-size point, giving the native picker a concrete anchor rect. If a
Mac confirms it, close the item; if not, revert the CSS and investigate
the virtualized-row scroll-offset anchor path instead. (Originally task
32 QA.) **Needs a Mac to verify** — schedule it, or the item cannot
close.

## Open questions — grooming

- ~~Durable or derived for error events?~~ **Resolved 2026-08-20 by
  the overseer from the architecture rules, not owner preference —
  flagged here for the owner to overturn if wrong.**

  ADR 0035's split is two-way: user-authored kinds persist to the host
  store; derived kinds are synthesized in the frontend and never enter
  it (the truncation marker is the only one). A coalesced bus error
  fits neither. It is not user-authored, so it does not belong in the
  durable store; but coalescing a storm at bus frame rate into one row
  with a count and a span is **domain computation over the frame
  stream**, which CLAUDE.md § "thin views over a paged model" places
  host-side without exception — and a frontend that had to see every
  error frame in order to collapse them is exactly the unbounded
  accumulation the rule forbids.

  So there is a **third category: host-derived** — computed by the
  model, not persisted, not user-editable, delivered to views the same
  way durable events are. **ADR 0035 is amended in the same commit** to
  name all three and say which properties each has (persisted?
  editable? survives a capture clear?).

  The `EventKind` rustdoc in `notes.rs` currently asserts the two-way
  split as fact and must change with it — it is the only written
  statement of the rule outside the ADR.
- ~~Where does per-kind default visibility live?~~ **Decided by the
  overseer 2026-08-20: the kind's own declaration, plus a view-local
  override.** The default is a property of the kind — "a bus error is
  noise until you ask for it" is true of every project — so it belongs
  next to the kind, as one global truth with no new persisted state.
  The user's override is view-local, like every other toggle
  (CLAUDE.md § frontend state is view-local). Nothing new is written to
  the project or to host settings until there is evidence people want
  their choice to survive a restart; adding persistence later is
  cheap, removing it is not.
- ~~Does the top-level event view replace `EventsPanel` or subsume
  it?~~ **Decided by the overseer 2026-08-20: it *is* `EventsPanel`,
  grown up.** They are one surface at two levels of ambition, and
  shipping both would be a duplicate view over one model — the thing
  this repo's architecture rules exist to prevent. The singleton panel
  gains filtering, the expandable description and the record-type
  columns; it does not acquire a sibling.

## Exit criteria (draft — firm at grooming)

- `EventKind` carries more than one variant and every event surface
  filters by kind.
- A kind can declare itself hidden by default, and is then absent from
  the trace, the plot and the event view until enabled.
- The event view is top-level, filters by kind / record type / tag, and
  shows an expandable description per marker.
- `GLOBAL_MARKER` and `EVENT_COMMENT` round-trip and appear in
  historical trace views and (for `EVENT_COMMENT`) the graph view.
- The macOS picker item is closed by a verdict from a Mac — confirmed
  fixed, or reverted with the anchor path investigated.

## Status log

### 2026-08-21 — (branch `task-102-event-surface`)

**Phase 1 — the third category.** `EventKind` splits two ways in the code
today only in prose; the split is now typed. `EventCategory`
(`notes.rs`) names **user-authored** and **host-derived**; the third,
*frontend-derived*, deliberately has no Rust variant because those kinds
(the truncation marker) never cross the wire, and the rustdoc says so.
`EventKind::BusError` is the first host-derived kind. Category — not the
individual kind — fixes the lifecycle: `persisted()` and `exported()`
both derive from it.

The store grew a second list. `NotesStore::inner` stays the durable,
scratch-persisted set; `derived` is the host-derived one, replaced
wholesale by `replace_derived` and never written anywhere. Three read
paths, deliberately distinct:

| reader | returns | why |
|---|---|---|
| `snapshot()` | durable only | what the scratch file is |
| `events()` | merged, chronological | what every view renders |
| `exportable()` | durable ∧ `kind.exported()` | what Save Capture writes |

`fetch_notes` / `notes-changed` now carry `events()`; `save_capture`
takes `exportable()`. `add()` refuses a non-durable kind outright, so
there is no path by which a host-derived event becomes user data.

**Where coalescing happens, and the write-side contract.** Coalescing
itself is not built here — it belongs to the bus-health producer. What
is built is the rule it must obey: a coalesced summary is an event, the
frames it summarises are frames, and only the frames are written.

- *Observation.* A `busError` event and a user note are both timeline
  events in one store; a save must write exactly one of them.
- *Hypothesis.* Routing Save Capture through `exportable()` rather than
  the merged set is what makes that true.
- *Experiment.* `a_coalesced_bus_error_summary_never_displaces_the_error_frames_it_summarises`
  (`tests.rs`) writes a 200-frame error storm plus one note plus one
  coalesced `busError` through `write_blf_capture`, off the very
  expression `save_capture` builds its marker list from. Control: the
  user note, which must survive — without it, "no bus-error marker"
  would also pass on a save that dropped all markers.
- *Data.* `marker_count == 1`, the surviving marker is `storm starts`,
  and all 200 error frames read back with their exact timestamps. With
  `exportable()` swapped to `events()` the same test reads
  `marker_count == 2` and fails.
- *Conclusion.* The export boundary, not the renderer, is what keeps the
  file lossless; the summary is display-only by construction.

ADR 0035 amended in the same commit with the three-category table and
the two consequences that follow (a summary is not a substitute for what
it summarises; the delivery path is shared, the storage is not).

**Phase 2 — kinds become a real axis, and default visibility with them.**
The TS mirror (`notes.ts`) gains `EVENT_KIND_META`: per kind, its
category, whether it is `visibleByDefault`, whether it is `editable`, and
which BLF record it round-trips as. Two things fall out of putting the
declaration there rather than in each view:

- **`noteToEvent` no longer hardcodes `editable: true`.** Editability
  follows the kind, so a host-derived event arriving on the same wire as
  a note cannot become editable by sharing it.
- **The record type is a property of the kind**, which means filtering by
  kind *is* filtering by record type — one control, not two that can
  disagree.

`useEventKindFilter` (`EventKindFilter.tsx`) is the view-local override:
`useState` seeded from `defaultVisibleKinds()`, nothing persisted, per
the grooming ruling. The same `EventKindFilter` checklist renders in all
three surfaces — the trace toolbar, the plot's toolbar menu, and the
events view — and lists every kind with its count **even while it is
switched off**, because hidden must not mean unfindable.

The plot's event projection moved into a pure `plotTimelineEvents`
(`plotEvents.ts`), which also collapsed the panel's separate `notes` and
`truncation` memos into one: the truncation marker is just another
filterable kind now, not a special case beside the notes.

*Experiment / control.* Three tests assert a `busError` is absent until
enabled — `EventsPanel.dom.test.tsx` ("hides a kind that declares itself
hidden…"), `TracePanel.dom.test.tsx` ("keeps a hidden-by-default kind out
of the trace…"), `plotEvents.test.ts` ("leaves out the kinds this panel
is not showing"). Control: flipping `busError.visibleByDefault` to `true`
fails all three (`expected [ 'bus error x40', 'boom' ] to deeply equal
[ 'boom' ]`), so they are reading the declaration and not a coincidence.

**Phase 3 — the event grows a body, and the view grows a tag filter.**
An event now carries a `description` (the disclosed body) and a `tag`
(the second filter axis), edited through `describe_note` / `retag_note`.
Both ride the scratch, the BLF and the MDF, in the same commit that made
them editable — a field the user can fill and a save that drops it is the
lossy write this codebase does not accept.

**How they fit in a BLF marker, which has no field for either.** A
`GLOBAL_MARKER` gives us `marker_name` (the label), `foreground_color`
(the color) and an opaque `description` we already used for the id. The
tag and the body pack into that field behind a `cannet:event:` prefix —
`cannet:event:<tag>\n<id>\n<description>` — and a note carrying neither
still writes the bare id, byte-for-byte what it always wrote. In the
file, no sidecar. The bare-id case is the control in
`a_marker_carries_the_event_tag_and_description_without_a_sidecar`: it
proves the round-trip is reading the structured form rather than echoing
whatever text it found.

**The disclosure reuses the trace's own machinery rather than forking
it.** A message row already discloses its decoded signals as rows of the
row space in their own right (ADR 0044). What was `signalCount` /
`signalsOf` in `TraceView` is now one notion — `contentCountOf` /
`contentNameAt` — that answers for both: a frame's signals, or an
event's `tag` and `description` lines. Row heights, the scroll spacer
and the keyboard cursor all read the same function, so they cannot
disagree, and the cursor walks into an event's body the way it walks
into a message's signals.

Filtering by **record type** turned out to need no control of its own:
the BLF record a kind round-trips as is a property of the kind
(`EVENT_KIND_META[kind].blfRecord`), so the kind checklist *is* the
record-type filter. Two controls over one fact could only ever
disagree.

**Phase 4 — both BLF annotation records.** `EventKind::MessageBound` is
the second user-authored kind, and it exists because of the record it
rides: `EVENT_COMMENT` (type 92) attaches to the event it sits beside,
where a `GLOBAL_MARKER` floats on the timeline. `EventKind::blf_record()`
is now the single statement of that mapping, and `exported()` is derived
from it — a kind is written out exactly when it has a record.

`cannet-blf` grew the three pieces it was missing: `append_comment` on
the writer, an `on_comment` sink on `BlfCanFrameSource` (the same deal
`on_marker` already offered — found on the walk the pump was making, no
second pass), and `BlfScan::comments` so the import dialog's count
matches what the import will produce.

An `EVENT_COMMENT` has one text field and nothing else, so the id, tag,
label and description pack into it behind the same `cannet:event:`
prefix. **The `commented_event_type` had to become a field on the
event**: without somewhere to hold it, an imported comment would
re-export with type 0 and come loose from the message it was attached
to — a silent degradation of somebody else's file, which is the failure
this codebase does not accept. It is `Option<u32>`, `None` on every
other kind, and MDF has no analogue so an MDF round-trip is documented
as losing it.

*Experiment / control.* `both_blf_annotation_records_round_trip` writes
a note and a message-bound comment, walks them back, and asserts the
`Note`s equal what went in — kind, tag, description and commented event
type included. The control is a **third-party comment**: unpacked prose,
written straight through `append_comment`, which must still come back as
an event (first line the label, remainder the description, deterministic
synthetic id, object type preserved). Reading only our own packing would
silently drop every comment a CANalyzer user made. Falsified by making
`MessageBound.blf_record()` return `GlobalMarker`: the round-trip then
reads back `kind: Note, commented_event_type: None` and fails.

**Historical-mode trace views** need nothing extra: both kinds are
visible by default and the chronological trace splices whatever the
event set holds, which `TracePanel.dom.test.tsx` exercises directly.

**Phase 5 — the goto palette obeys the same default.** "By default not
shown anywhere" reaches the command palette's go-to-event list too, so
it filters to the default-visible kinds. The events view lists every
kind with its count and offers a goto on each row, so a hidden kind is
still one place away rather than unreachable (`gotoEvent.test.ts`,
"leaves out a kind that is hidden by default").

### Where the backlog-era prose had gone stale

Two of the four scope items no longer fit the code, and one of them is
an exit criterion.

1. **"`EVENT_COMMENT` markers render in the graph view."** **Struck
   2026-08-26 by owner ruling**, in ADR 0035 and here. There is no
   timeseries graph view. The only graph view is `ProjectGraphPanel` —
   a topology of gateways, buses and filters, no time axis — and the
   backlog section this item was promoted from sits two headings above
   "### Graph view (and bus topology)", so it did mean that one. A
   timeline event has no coordinate to land on there. What ships
   instead: message-bound comments render in the **plot**, which is the
   timeseries view the clause was presumably reaching for, and in both
   trace modes. ADR 0035's decision point 3 carries the same stale
   clause; the amendment records the observation rather than striking
   it, because deleting a decision point is the owner's call.
2. **"Create marker from message."** The task itself says "UI design
   needed for picking the source message and authoring the text", so it
   is deferred by its own terms and not built. Note what that leaves:
   `messageBound` events arrive from imported captures only. That is
   still the more valuable half — before this change cannet read a BLF
   full of another tool's comments and wrote it back without them.

Everything else in the scope held up.

### Exit criteria — verdict

| Criterion | Verdict | The test that earns it |
|---|---|---|
| `EventKind` carries more than one variant and every event surface filters by kind | **met** | four variants (`note`, `messageBound`, `busError`, `truncation`); `notes.test.ts` "gives every kind a category, and the category fixes the lifecycle"; per surface — `TracePanel.dom.test.tsx` "keeps a hidden-by-default kind out of the trace until this trace enables it", `plotEvents.test.ts` "leaves out the kinds this panel is not showing", `EventsPanel.dom.test.tsx` "lists both BLF annotation records and filters them apart" |
| A kind can declare itself hidden by default, and is then absent from the trace, the plot and the event view until enabled | **met** | `notes.test.ts` "declares which kinds are noise until asked for" plus the three per-surface tests above; `gotoEvent.test.ts` "leaves out a kind that is hidden by default" extends it to the palette. Control: flipping `busError.visibleByDefault` to `true` fails all of them |
| The event view is top-level, filters by kind / record type / tag, and shows an expandable description per marker | **met** | top-level already — `useCommands.tsx` registers `singleton(EVENTS_PANEL_ID, "Events", …)` beside Project / Graph / System messages. Kind **is** record type (`EVENT_KIND_META[kind].blfRecord`), asserted in `EventsPanel.dom.test.tsx` "lists both BLF annotation records and filters them apart"; tag — "narrows to the events carrying a matching tag"; description — "keeps the body collapsed until the row is disclosed" and "edits the description in place and commits it to the host" |
| `GLOBAL_MARKER` and `EVENT_COMMENT` round-trip and appear in historical trace views | **met** | round-trip: `both_blf_annotation_records_round_trip`, with a third-party comment as the control. Historical trace views: both kinds are visible by default and splice into the chronological trace (`TracePanel.dom.test.tsx`). The graph-view half of this criterion was **struck 2026-08-26** — no such view exists; see the finding above |
| The macOS picker item is closed by a verdict from a Mac | **not met** | no Mac available to this session; see Blockers |

### Blockers / side effects

- **The macOS colour-picker item cannot close here.** The candidate CSS
  fix (`.trace-event-swatch-input` filling the swatch's footprint) is
  still unverified, and this session has no Mac. Nothing in this change
  touched that CSS. The item needs a Mac scheduled against it, exactly
  as the task already said.
- **The graph-view clause needs an owner ruling** — strike it from ADR
  0035 decision point 3 and from this task's exit criteria, or restate
  it against a view that has a time axis. Recorded in the ADR
  amendment.
- **An MDF round-trip drops a comment's `commented_event_type`.** MDF
  `##EV` has no analogue for "the object type of the event this comment
  is attached to", so a message-bound event saved to MDF and reimported
  comes back freestanding. Documented at `note_from_event`; BLF is the
  interchange home for annotations and round-trips it exactly.
- **`NotesStore::replace_derived` is `#[allow(dead_code)]`** until a
  host-side detector calls it. It is the host-derived category's only
  entry point, so the category is unreachable without it; the bus-health
  producer is its first caller.

### Handoff to bus health (task 101)

What is built, so 101 does not rebuild it:

- `EventKind::BusError` exists, is host-derived, and is hidden by
  default in every surface. Its display label is "Bus Errors" and its
  default colour is the new `eventBusError` theme entry.
- `NotesStore::replace_derived(Vec<Note>)` is the producer's entry
  point: hand it the current coalesced set and every view updates
  through the existing `notes-changed` broadcast. It drops any
  non-derived kind, so it cannot be used to smuggle an event into the
  durable store, and the derived set is cleared by a capture clear and
  by an Open Capture.
- Nothing derived is persisted or exported. `save_capture` reads
  `NotesStore::exportable()`, and
  `a_coalesced_bus_error_summary_never_displaces_the_error_frames_it_summarises`
  guards it.
- A coalesced event's detail goes in `label` and `description` — the
  description is the disclosed body the events view already renders. If
  a structured count and span turn out to be needed as fields rather
  than text, add them then; nothing here is shaped to prevent it.

**One thing 101's own file contradicts itself on, which this
handoff resolves in favour of the later ruling.** Under "Groomed
decisions" it says *"Coalescing is model work. It happens host-side,
before the trace store. The uncoalesced frames are counted, not
stored."* Under "Open questions" the overseer then resolved *"coalesce
for display, preserve on write — a saved capture keeps every error
frame that was received."* Those cannot both hold: frames that are
counted and not stored cannot be in the saved capture. The write-side
contract built here follows the later ruling — **error frames go into
the trace store like any other frame, and the coalescing produces a
`busError` event beside them, not instead of them**. The earlier
sentence should be corrected when 101 is picked up.
