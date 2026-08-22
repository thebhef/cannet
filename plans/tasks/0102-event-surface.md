# Task 102 — The Event Surface: Kinds, Filtering, and Its Own View

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
- `EVENT_COMMENT` markers render in the **graph view** when enabled in
  the filter.
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
