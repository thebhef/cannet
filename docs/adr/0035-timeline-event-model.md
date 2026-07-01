# ADR 0035 — Timeline events: one host-side model for markers across every timeseries view

Status: accepted (2026-06-28)

## Context

The trace timeline ([ADR 0024](0024-trace-like-view-timing.md)) already
carries one kind of non-frame entity: user **notes**. A note is
`{ id, timestamp_ns, label }` — a labelled point on the timeline — held
host-side in a session-scoped `NotesStore`, rendered in the plot panel as
an event cursor plus an event list, and round-tripped to BLF
`GLOBAL_MARKER` records on Save / Open Capture (in-file, no sidecar —
[ADR 0010](0010-no-sidecar-files.md)).

Several pending capabilities want more of the same shape:

- a "history truncated here" marker when the disk-spill store drops its
  oldest history, shown in both the plot and the trace;
- message-bound markers (`EVENT_COMMENT`) created from a source message,
  coloured and described, filterable by a user tag;
- those same markers rendered in the chronological/filtered trace and the
  graph view, not just the plot;
- a global panel for browsing, filtering, and editing markers;
- utilities/plugins that scan the stream and emit markers for detected
  conditions (faults, contactor open/close, specific commands).

Left unmanaged these drift into per-feature one-offs: each view
re-derives "a labelled point on the timeline," and persistence, export,
and navigation get decided ad hoc per feature. The note feature already
embodies the right shape; the question this ADR settles is whether to
generalise it into one model or let each feature fork it.

## Decision

Establish a single **timeline-event model**.

1. **An event is a labelled entity on the canonical trace timeline**
   (`timestamp_ns`, [ADR 0024](0024-trace-like-view-timing.md)), carrying
   a **kind** and kind-specific metadata. The existing note is its first
   kind.

2. **The host owns it; it is global, not per-panel.** One session-scoped
   event store (today `NotesStore`) is the source of truth, observed by
   every view through change events — never copied authoritatively into a
   panel. This mirrors the existing note rule and CLAUDE.md's thin-views
   principle: a marker placed over a timeline is visible in every view
   over that same timeline because there is one model, not one per panel.

3. **Every history/timeseries view reads it.** The plot (cursor / line),
   the chronological and filtered trace (an event row), and the graph
   view all render events from the same store in their own coordinate
   system. A new timeseries view inherits events for free.

4. **Persistence is per-kind, and durable kinds persist with the
   scratch.** Events that belong to the capture are written into the
   disk-spill scratch ([ADR 0002](0002-disk-spill-store.md) DS-7) so a
   reopened spill restores them — not only a BLF round-trip. *Derived*
   events (e.g. the truncation marker, recomputed from the store's
   low-water mark) are **not** persisted; they regenerate on reopen.

5. **Export is per-kind, and durable kinds export to BLF** as
   `GLOBAL_MARKER` / `EVENT_COMMENT` ([ADR 0010](0010-no-sidecar-files.md)
   — in-file, no sidecar), the interchange home. System/ephemeral events
   (truncation) do not export: they are not user data.

6. **Events are navigable.** A single "goto event" primitive moves any
   timeseries view to an event's time, over the shared model.

7. **A singleton panel is the eventual home** for browsing, filtering,
   and editing events — lifecycle like the project / graph / system-
   messages panels — because events are global, not per-panel.

**Kinds are an open set.** A kind declares four things: is it editable, is
it persisted to the scratch, is it exported to BLF, and how does it
render. Named so far:

| Kind | Editable | Scratch | BLF | Source |
|---|---|---|---|---|
| note | yes | yes | `GLOBAL_MARKER` | user (exists) |
| truncation | no | no (derived) | no | disk-spill low-water mark |
| message-bound | yes | yes | `EVENT_COMMENT` | created from a message |
| trigger | no | yes | `EVENT_COMMENT` | plot trigger fires |
| plugin/utility | varies | varies | varies | detector output |

## Why

- **One model, many views.** Each feature otherwise re-derives the same
  timeline math, persistence, export, and navigation, and the result is
  inconsistent behaviour across views. The note feature already proved
  the shape; generalising it is cheaper than forking it per feature.
- **Per-kind persistence/export is the load-bearing distinction.** It is
  what lets an ephemeral system marker (truncation) and a durable user
  annotation share rendering and a store without sharing a lifecycle. A
  derived marker is **not** the trace origin and must not be persisted or
  exported as if it were user data — making "did the user author this, or
  did the system derive it?" a property of the kind keeps that honest.
- **Host ownership keeps views thin** (CLAUDE.md; [ADR 0032](0032-machine-local-ui-state-host-side.md))
  and is exactly what makes "visible in every view over the same
  timeline" hold — the reason notes are session-scoped already.
- **A sanctioned output for detectors.** Utilities and plugins that find a
  condition emit an event through the same store and inherit rendering,
  persistence, export, and goto — no per-detector UI plumbing.

## Consequences

- `NotesStore` is the seed of the event store; the note wire shape
  (`{ id, timestamp_ns, label }`) grows a kind discriminant and per-kind
  metadata as kinds are added. The concept rename needs no data
  migration; the scratch and BLF encodings evolve per kind.
- The disk-spill truncation marker renders through this model (a plot
  cursor and a trace floor row) as a derived, non-persisted,
  non-exported kind — it never becomes user data, and it is distinct from
  the view's time origin.
- Scratch persistence of durable events is the first persistence instance
  of this model; the BLF path remains the export/import home.
- Coloured/described markers, message-bound `EVENT_COMMENT`, rendering in
  the trace and graph views, and the markers panel are all consequences
  of this decision, sequenced separately.
- **Events are a separate sparse channel**, not paged through the
  windowed row-page contract ([ADR 0025](0025-frontend-windowed-source-contract.md)).
  The collection is small and bounded by user/detector activity and held
  in RAM per session, unlike the `O(capture)` frame stream — so views
  fetch the whole event set, not a window of it.

## Rejected alternatives

- **Per-feature markers** — a truncation line, a trigger line, and notes
  each as their own thing. Duplicates timeline math, persistence, export,
  and navigation, and guarantees the views disagree on behaviour.
- **Frontend-owned events.** Breaks "visible in every view," loses host
  persistence, and contradicts [ADR 0032](0032-machine-local-ui-state-host-side.md)
  and the thin-views rule.
- **Move the view origin to mark a truncation.** Conflates the offset
  anchor ([ADR 0024](0024-trace-like-view-timing.md)) with a timeline
  event and silently shifts every displayed offset. Truncation is an
  event on the timeline, not the timeline's origin.
- **Events as frames in the raw store.** They are not CAN frames, carry
  no arbitration id, and have different persistence/export rules; forcing
  them into the frame contract pollutes the raw store and its by-id index.
