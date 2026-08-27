# 0112 — The Signal Reference Registry

> **Status 2026-08-24 — opened by owner observation, not groomed.** Came
> out of walking owner-review-queue item 1.3 with the
> owner: *"I wonder if storing the live message mapping in every view is a
> good idea after all. A centralized place would feel like a better place
> to apply this. The per-signal vs per-reference seems like a decision we
> shouldn't have to be making."* No phases yet, and the design questions at
> the end are open.

## The model the owner is asking for

Stated in the session, 2026-08-24:

> *"Conceptually, the signal definition has a dbc. The signal value has a
> signal definition and a raw value/timeseries data, which has a bus
> source (or other data source). I'm kinda looking for that shape in this
> cache and mapping logic."*

Two layers:

```
series  =  definition  ×  data source
              │              │
           one DBC        one bus, or a capture file
```

**The cache already has this shape.** `SignalKey` is the data-source half
— `bus_id: Option<String>` plus `file_backed: bool`, and its own comment
says why they are in the key rather than beside it: *"the two namespaces
must not alias: a group index and a message id are unrelated numbers that
would otherwise collide."* `signal_fingerprint::dbc_encoding` is the
definition half: it *"hashes the `SignalDecodeSpec`s of the one definition
that decodes the series"*, and a file-backed series fingerprints against
`file_source` instead because *"no DBC ever bore on them."*

One refinement in the existing design is worth preserving through any
change: **the cache identifies a definition by what it says, not by which
file it is in.** *"The path is not mixed into any fingerprint … which file
a definition came from must not move it."* That is what lets a copy, a
fresh checkout or a backup tool touching an mtime revive parked pyramids
instead of rebuilding thousands.

**The binding between the two halves also already exists, centrally.**
`AppState::signal_dbc_picks` is `signal identity → the loaded path of the
chosen database` — ADR 0054 part 2's explicit per-signal choice, persisted
in the project file. It is sparse: absent means "resolve by load order".

## What is actually missing

Not the model, and not a place to put it. **References.**

A plot series, a drag payload, a signals-view selection entry and a
colormap target are all `(bus, message id, extended, signal name)` — the
data-source half plus a *name* — with the definition re-derived at every
use. And they live in the project's **opaque** `elements` blob:

> `project.rs:197` — *"The host doesn't read these; the frontend owns the
> shape."*

That one decision is upstream of everything below. It is recorded as a
code comment; no ADR states it (ADR 0011 makes `layout` opaque and says
nothing about `elements`), which is itself part of the problem.

### What the opacity costs, in the code's own words

| Consequence | Where | Its own description |
|---|---|---|
| The host cannot see what is referenced, so views push | [`viewSignalsPush.ts`](../../apps/gui/src/viewSignalsPush.ts) | *"it cannot discover which signals a view references on its own. The frontend pushes them instead"* — on mount, on every config change, un-pushing on unmount |
| A repair must fan out across every store | [`signalRemap.ts`](../../apps/gui/src/signalRemap.ts) | five stores, and *"a rewrite spread across five call sites is five chances to miss one — and the miss is silent, because the repair surface reports success while one view still points at the dead name"* |
| Every future feature inherits the obligation | [`signalRemap.ts`](../../apps/gui/src/signalRemap.ts) | *"**A new persisted signal reference anywhere in the app belongs in here.**"* |

**A push model's failure mode is silence.** A view that does not push is
invisible to the mapping panel, and nothing can detect the omission. Task
111 item 1.30 — generator rules and colour maps missing from the signal
mapping view — is that failure mode, not an oversight.

## The precedent: the host already does this, twice

This is not greenfield. `AppState` is the session store, and two of its
fields are already typed, host-owned registries of exactly this kind:

| Field | What it holds | Governed by |
|---|---|---|
| `notes: NotesStore` | `EventSubject::{Message, Signal, Event}` — structural references to signals and messages | [ADR 0056](../../docs/adr/0056-an-event-subject-is-a-structural-reference.md) |
| `transmit_frames: Mutex<TransmitFrameRegistry>` | message references with `TransmitSource` provenance (`Project` vs `Rbs`) | — |
| `signal_dbc_picks: Mutex<Arc<SignalDbcPicks>>` | the central binding table | [ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md) part 2 |

So an event can name a signal in a typed, host-legible way, and a
transmit row can name a message the same way — but a **plot series
cannot**. The holdouts are the view elements: plot areas' `signals` and
`primarySignalKey`, the signals view's `selection.keys` and
`sections.assignments`, the colormap target, and the pattern-shaped
references in generator rules.

## The questions this answers

Everything below was open during the 2026-08-24 walk and is settled by
seeing where the pieces already live. Recorded so they are not re-opened.

| Question | Answer |
|---|---|
| **Per-signal or per-reference binding?** | Neither, and the fork was the wrong shape. **Holders are per-reference** — that is what `NotesStore` and `TransmitFrameRegistry` already are. **The binding is per-signal and already central** (`signal_dbc_picks`). Two layers, not a choice. |
| Should the binding be explicit rather than derived? | It already can be. ADR 0054 part 2 sanctions an explicit per-signal choice; what is missing is that one is not *recorded* when the app knows the answer. |
| Does ADR 0054 part 1 have to be amended? | **No.** Its objection is to a *series identity* naming a database, because that would mean two decodes of one signal. A binding table beside the identity is a different thing and the ADR already has one. |
| Is path-keyed binding too brittle — a moved DBC breaks it? | No worse than today. `signal_dbc_picks` is already path-keyed, and `signal_source` already handles the stale case: *"a stale pick must never silence a signal something still defines."* The fingerprint's path-independence is a separate mechanism and is untouched. |
| Does a transmit row need its own DBC field? | **Yes, independently of this task.** A transmit row is an encode target, not a decoded series, so ADR 0054 does not govern it — and `TransmitFrameRegistry` is already typed and host-owned, so the field is cheap. |
| Is a central registry a rewrite? | **No.** The pattern exists twice and the binding table exists once. This is bringing three element kinds onto it. |

Still open, and deliberately not answered here: **whether dragging a
signal out from under a specific database should record a binding.** It is
a binding-layer question, separable from the registry, and it carries a
consequence worth ruling on — a pick is project-wide, so a drag into a
plot would change how the trace decodes that signal.

## What it would change

**Split element config in two.** Which signal a view references becomes
typed and host-owned — a registry keyed by `(element, slot)` carrying the
identity and its binding. Colour, axis assignment, ordering and layout
stay opaque and frontend-owned, which is what the blob's flexibility was
for.

Then:

- the mapping panel **reads** the registry instead of being pushed to
- remap and re-point are one registry edit rather than a five-store walk
- generator rules and colour maps are entries like anything else
- `viewSignalsPush.ts` and most of `signalRemap.ts` stop existing

## Findings and items this bears on

### Open findings it addresses

| # | Finding | How |
|---|---|---|
| [3.47](../owner-review-queue.md) | Three surfaces compute in the frontend what `CLAUDE.md` says the model owns | (a) `useViewSignalsAttentionCount` fetches every row to keep a count — a registry answers the count host-side. Its *"ratify the exception, or move the display-status rule host-side so one answer serves all three"* is this task's question asked from the other end. |
| [3.41](../owner-review-queue.md) | The view-signals panel is unvirtualized, and pattern rows widen it to ~1,074 rows on `ev-zonal` | The panel is unpaged because it is fed by pushes rather than backed by a model. A registry makes it a paged view like every other, which is what `CLAUDE.md` requires of any view over a growing list. |
| [3.1](../owner-review-queue.md) | `decode_frame` (per signal) and `encode_frame` (per message) can disagree | Addressed by the transmit row's own DBC — **now this task's**, as of 2026-08-25. A signal pick stops moving a transmit row, so the two cannot disagree. |
| [3.31](../owner-review-queue.md) | A file-backed series cannot be an event's subject — its `messageId` is a channel group index | Same root: `EventSubject::Signal` carries `(message_id, extended, signal_name)` and cannot express the data-source half. A typed reference that carries source *and* definition covers both provenances. |

### Sent-back items this obviates or modifies

| # | Item | Effect |
|---|---|---|
| **1.30** | Generators and colour maps in the signal mapping view | **Moved here 2026-08-25** by owner ruling, having been obviated as scoped. Under a push model the fix is *another pusher*; under a registry they are entries. Doing it the current way builds more of what the owner identified as wrong. The ask — *"generators and color maps should indicate error as well … It is a signal mapping concern"* — is satisfied either way; only the mechanism changes. |
| **1.3** | The transmit row's own database | **Moved here whole, 2026-08-25.** See below — it is a reference like any other. |
| **1.19** | Re-pointing a busless plot series | **Eased, not obviated, and not task work.** The repair exists and works; a registry turns its five-store rewrite into one edit. Its one remaining leg is a *look*, not a build — see the queue index. |

The rest of the sent-back items went elsewhere: 1.6, 1.26 and 1.13c to
[113](0113-rbs-as-a-grid.md); 1.37, 1.33b and 1.17 to
[114](0114-one-name-per-thing.md); 1.23, 1.13ab, 1.34, 1.35 and 1.33a to
[115](0115-trace-row-menu-scope.md) through
[119](0119-duplicate-id-example-dbcs.md); 1.16 and 1.18 were dropped.

### The transmit row is a reference too · 1.3's residual

**Ruled 2026-08-24:** *"the tx message pick should include the dbc. Make
the default decision about which one and let the user change it."* Then the
model, 2026-08-25:

> *"you don't pick signals in the transmit view, you pick messages.
> dragging a message from the database view implicitly gives you the DBC.
> the user has to specify the bus, they can enter just an ID, and we can
> resolve it to a DBC. They should be able to choose which DBC we look in."*

A transmit row is **bus + message id + which database to look in** — the
same `definition × data source` shape this task is built on, which is why
it belongs here and not in 111. The owner drew that circle explicitly:
*"every single signal came from a single DBC, regardless of whether it is
**encoded** or decoded or mapped."*

| Born by | Database |
|---|---|
| dragging a message out of the Database panel | comes with the drag |
| typing an id | resolved from the bus, and the user can change it |

Three pieces of work, and the middle one is why the row half could not
usefully ship alone in 111:

1. **`dbc_path: Option<String>` on `TransmitFrame` plus a picker.**
   `TransmitFrame` is already host-owned and typed, so this part is small.
2. **The drag has to carry the database.** `DraggableSignalRef`
   ([`dragSignals.ts:35-48`](../../apps/gui/src/dragSignals.ts#L35-L48)) is
   `{busId, messageId, extended, signalName, messageName, unit,
   fileBacked?}` — **no database field.** So "the drag implicitly gives you
   the DBC" is intent, not behaviour, and a picker shipped without it is a
   control the drag never prefills.
3. **A signal pick stops moving a transmit row.** The panel is per-message
   ([`TransmitPanel.tsx:197`](../../apps/gui/src/TransmitPanel.tsx#L197)
   groups by `(canId, extended)`, discarding signal identity), yet
   [`transmit_commands.rs:64-69`](../../apps/gui/src-tauri/src/transmit_commands.rs#L64-L69)
   says *"a pick on one of the message's signals moves it."* That is the
   incoherence being removed — **a deletion with a test, not an addition.**

**It supersedes accepted item 1.32's reasoning**, which was accepted
because *"the alternative is stamping a DBC path on every transmit row"*.
The stamp is now wanted; 1.32's heuristic stops being needed. The
acceptance stands, its justification does not.

Queue finding **3.1** (`decode_frame` per signal vs `encode_frame` per
message) is answered by piece 3: they stop being able to disagree because
the transmit row names its own database.

## Open design questions

1. **What is a reference's binding keyed on** — the loaded path, as picks
   are today, or the content hash the fingerprint already computes? Path
   matches the existing mechanism; content survives a file moving. They
   can also coexist: path as the record, content as the revival key.
2. **Does the registry replace `signal_dbc_picks` or sit beside it?** The
   picks map is per signal; the registry is per reference. If the binding
   stays per signal, the registry holds identities and the picks map holds
   bindings, unchanged.
3. **Do generator rules and section patterns get registry entries?** They
   are patterns, not identities, and re-evaluate live —
   `viewSignalsPush.ts` already treats them as identity-only. A registry
   has to decide whether a pattern is an entry or a producer of entries.
4. **Does a drag record a binding?** Carried over from the session; see
   above.
5. **Does this get an ADR of its own, or amend one?** The opacity of
   `elements` is currently a code comment and no more. Whatever this task
   decides, that decision should be an ADR — including if the answer is
   "keep it opaque".

## Exit criteria

*Not written yet — this task is not groomed.* What follows is the shape
they should take, so the next session does not start from nothing.

1. Every persisted signal reference in the app is reachable from one
   host-side registry, and `signalRemap.ts`'s five-store walk is gone —
   proved by removing it, not by adding a sixth store to it.
2. The signal mapping panel is fed by the registry rather than by pushes,
   and `viewSignalsPush.ts` is deleted.
3. Generator rules and colour maps appear in the mapping view without any
   view calling a push (queue item 1.30, satisfied structurally).
4. The panel is paged, as `CLAUDE.md` requires of any view over a growing
   list — closing 3.41 rather than leaving it to a later pass.
5. Cache revival is unchanged across the whole change: a project reopened
   after it adopts nothing new and rebuilds nothing it did not before.
6. An ADR records what `elements` now is and where a binding lives.

## Not in scope

- The transmit row's own DBC field. It is cheap, it is independent, and it
  is part of the transmit-row work this task took on 2026-08-25.
- Virtualization of any other panel.
- Any change to how a definition is *resolved* — ADR 0054's rule stands.
