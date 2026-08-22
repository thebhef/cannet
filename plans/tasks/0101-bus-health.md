# Task 101 — Bus Health: Error Frames, Bus Load, Adapter Status

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback. The
list item read "error frame handling"; grooming widened it to what the
owner actually meant:

> The low-level status of the bus was basically never really considered
> other than when bringing up dongles, and never considered as
> something surfaced in the GUI. Error frames are a real thing on CAN
> bus. So is bus load %. Dongle status info too.

So this is a **bus-health surface**, not an error-frame fix.

## What an error frame is (ISO 11898-1), and why it governs the design

An error frame is not a frame in the sense the rest of the model uses:
no ID, no payload, no CRC, no arbitration. It is an **error flag** —
6 dominant bits (active) or 6 recessive (passive), stretched to as many
as 12 when other nodes superpose their own — followed by an **8-bit
error delimiter**. Total 14–20 bit times; ~28–40 µs at 500 kbit/s.
Smaller than any data frame.

Three properties drive every decision below:

1. **It aborts the frame in flight, which is then retransmitted.** So a
   persistent physical fault — bad termination, a node at the wrong
   bitrate, a shorted line — yields error → retransmit → error at
   roughly the bus frame rate. **An error storm's natural volume is the
   order of the whole bus's frame rate**, thousands per second. This is
   the ordinary failure mode, not an edge case.
2. **It carries no identity.** N consecutive errors from one cause
   carry about as much information as one error plus a count and a
   span. What distinguishes them is the *class* and the *counters*.
3. **Software never sees the raw bits.** Controllers report a status
   event: error class (bit / stuff / CRC / form / ACK), direction, the
   error counters, and the resulting fault-confinement state. SocketCAN
   synthesizes a pseudo-frame with `CAN_ERR_FLAG` set, class in the ID
   bits, detail in the payload; Vector's `CAN_ERROR_EXT` carries an
   error code, flags and counters the same way.

Fault confinement is self-limiting per node, not per bus: TEC/REC
climb, the node goes error-passive above 127 (its flags turn recessive
and stop destroying others' traffic), and bus-off at TEC > 255 removes
it from the wire.

## What already exists

More than it looks like. Nothing here needs inventing.

| piece | state |
|---|---|
| `CanFramePayload::Error` (`cannet-core/src/frame.rs`) | in the model, round-tripped through BLF, MDF and the wire |
| BLF `CAN_ERROR_EXT` (type 73) | **parsed** (`cannet-blf/src/format/can.rs`), decoded to `CanFramePayload::Error` |
| BLF `CAN_STATISTIC` | **parsed**, carries Vector's own `bus_load` in 1/100 % (`format/diagnostics.rs`) |
| `InterfaceState` + `ControllerState` (`cannet.proto`) | **in the protocol**: active / passive / bus-off plus ISO 11898-1 TEC and REC. Round-trip tested; forwarded untouched by the server and the proxy |
| IPC `CanFrameKind::Error` | **already sent to the frontend** (`ipc.rs`) |

And what is missing:

- **Nobody produces `InterfaceState`.** No driver path emits it.
- **Nobody consumes it.** `cannet-client` explicitly discards it in an
  ignore arm alongside `ConfigureBus`.
- **Nothing computes bus load live.** The only bus-load number in the
  codebase is the one Vector wrote into a BLF.
- **`TraceView.tsx` never reads `kind`.** So an imported BLF's error
  frames render *today* as ordinary rows with an empty payload,
  indistinguishable from a zero-byte data frame. Error frames are
  already in our historical data, silently.

## Groomed decisions (owner, 2026-08-20)

- **Error frames are surfaced as rows, coalesced.** Owner: *"I do think
  that error frames should be surfaced as frames, but I don't want it
  to fill the trace buffer with error frames if we're getting flooded
  with them."* Coalesce consecutive errors on a bus by class into one
  row carrying a **count and a span**. Given property 2 above this
  loses almost nothing; given property 1 it is what makes the trace
  survive a fault at all.
- **An error is an event kind, hidden by default.** Owner: *"I think it
  would be nice if they were an event type, and by default not shown
  anywhere."* So this consumes **[task 102](0102-event-surface.md)** —
  event kinds and per-kind default visibility — and cannot start before
  it. It is *not* a new parallel concept.
- **The kind is named `busError`.** Owner 2026-08-20: the kind should
  clearly say CAN bus error or CAN bus fault, *"not sure which is more
  common/idiomatic. I don't think I care which."* **Error** is the
  spec's word — ISO 11898-1 has error frames, error flags, error
  counters, error-active and error-passive — whereas *fault* appears in
  the standard essentially only in **fault confinement**, the state
  machine that owns TEC/REC and bus-off. Because this task surfaces
  both the events and that state machine, naming the events "faults"
  would collide with the one concept genuinely called a fault. The
  displayed label says "Bus Error" for the same reason.
- **Coalescing is model work.** It happens host-side, not in a renderer
  (CLAUDE.md § thin views). ~~The uncoalesced frames are counted, not
  stored.~~ **Corrected 2026-08-21 while building
  [task 102](0102-event-surface.md):** that clause contradicts the
  ruling two sections below, which this task's exit criteria also carry
  ("a saved capture still contains every error frame that was
  received"). Frames that are counted and not stored cannot be in the
  saved capture. **The error frames go into the trace store like any
  other frame; the coalescing produces a `busError` event beside them,
  not instead of them.** The write-side contract for that is already
  built and guarded — see the handoff below.

## Open questions — grooming

- ~~Does an error event replace the error frame, or accompany it?~~
  **Decided by the overseer 2026-08-20: coalesce for display, preserve
  on write.** A saved capture keeps every error frame that was
  received; the trace shows one coalesced row.

  This is not a preference. Task 90 item 1 fixed `WindowedSource`
  silently truncating an out-of-range import, and the finding that made
  it urgent was that **cannet writes files it then truncates** —
  degrading data on the way to disk is the one failure this codebase
  has already decided it will not accept. Display-side coalescing is
  reversible; a lossy capture is not.
- **Where does bus load come from?** Three sources, and they disagree:
  computed host-side from the frame stream (needs the bitrate — the
  app knows it only for a *configured* remote bus, and a vbus
  deliberately has none, `project.rs`); reported by the adapter (ixxat
  and others expose it; python-can does not surface it uniformly); or
  read from the file (`CAN_STATISTIC`). Recommendation: **compute
  host-side where the bitrate is known, display nothing where it is
  not** — a wrong load figure is worse than none.
- ~~What is "dongle status"?~~ **Resolved 2026-08-21 (owner): it shares
  its formats and information with what the project panel already
  presents.** The Adapter column is the interface's `display_name`
  followed by the applied bus configuration rendered by
  **`describeAppliedConfig`** (`connectionStates.ts`) — the same
  function the project panel calls to render `live: …` on a bus row,
  producing `500k · FD data 2M`, `500k`, or
  `driver default (nothing sent)` through `formatBitrate`. One
  formatter, two surfaces: a bitrate must never acquire a second
  spelling.

  **A consequence to decide rather than discover: driver and firmware
  version are not available.** The wire's `Interface` message carries
  exactly three fields — `id`, `display_name`, `fd_capable` — and
  `InterfaceRecord` mirrors them. Anything richer (driver name and
  version, firmware, serial, channel count) needs **new protocol
  fields plus a producer on the server side**. That is a scope call for
  this task, not a gap to fill with invented data; the prototype was
  showing fabricated driver and firmware strings until this was
  checked.
- ~~Where does it show?~~ **Resolved 2026-08-20 (owner): a health
  panel plus a status chip**, with a prototype first. In the owner's
  words: *"health panel + status chip. We're gonna start transforming
  toolbar buttons into something a bit more polished. We probably ought
  to prototype this."*

  - The **panel** carries the detail: one row per bus with controller
    state, TEC/REC, load, error rate and adapter identity.
  - The always-visible summary lives in the **status bar directly
    beneath the toolbar**, beside the connection chip. **There is no
    window footer** — owner ruling 2026-08-20, correcting an overseer
    misreading that built one. Task 103 has since built that bar and
    ruled the summary an **icon launcher rather than a chip** (a single
    summary cannot name which bus is off): `BusHealthLauncher.tsx`
    exists and `StatusBar` takes it as a `busHealth` prop, which this
    task supplies once there is a health model to feed it and a panel
    for it to open. See
    [ADR 0055](../../docs/adr/0055-status-chips-and-the-status-bar.md).
  - **Prototype the chip before building it.** This repo's practice is
    an HTML prototype under `plans/prototypes/`, reviewed with the
    owner, deleted by the phase that implements it (task 89 did exactly
    this). The chip is the first instance of a wider direction —
    see [task 103](0103-toolbar-status-chips.md) — so its visual
    language is not this task's to invent alone.
- **Who produces `InterfaceState`?** The local driver path and the
  server both need to emit it; today neither does. Scope check: is the
  python-can sidecar in scope, or only local buses?

## What task 102 already built for this task

Landed on `task-102-event-surface`. Phase 3 of the plan below — "host-side
coalescing into the `busError` event kind, hidden by default" — no longer
has to invent any of the event machinery:

- **`EventKind::BusError` exists** (`apps/gui/src-tauri/src/notes.rs`) as
  the first **host-derived** kind — a third source category added to
  [ADR 0035](../../docs/adr/0035-timeline-event-model.md) for exactly this
  event. Host-derived means: not editable, not persisted to the scratch,
  not exported. The displayed label is "Bus Errors"; the default colour is
  the `eventBusError` theme entry.
- **It is hidden by default in every surface.** `EVENT_KIND_META`
  (`apps/gui/src/notes.ts`) declares `visibleByDefault: false`, and the
  chronological trace, the plot and the events view each carry the shared
  per-kind checklist that turns it on view-locally. The events view lists
  the kind with its count even while it is off, so it is findable.
- **`NotesStore::replace_derived(Vec<Note>)` is the producer's entry
  point.** Hand it the current coalesced set; every view updates through
  the existing `notes-changed` broadcast. It drops any non-derived kind,
  so it cannot be used to smuggle an event into the durable store, and the
  derived set is cleared by a capture clear and by an Open Capture. It is
  `#[allow(dead_code)]` until this task calls it.
- **The write path is already guarded.** `save_capture` reads
  `NotesStore::exportable()`, which is user-authored events only, and
  `a_coalesced_bus_error_summary_never_displaces_the_error_frames_it_summarises`
  (`tests.rs`) writes a 200-frame error storm plus a note plus a coalesced
  `busError` and asserts every error frame survives while only the note is
  written as a marker.
- **A coalesced event's detail goes in `label` and `description`.** The
  description is the body the events view discloses under the row. If a
  structured count and span turn out to be wanted as fields rather than
  text, add them then — nothing is shaped to prevent it.

What is *not* built here, deliberately: the coalescer itself, anything
reading `CanFramePayload::Error`, `InterfaceState`, bus load, or the health
panel. This task owns all of it.

## Suggested phases

1. **Investigation** — what each supported adapter actually reports
   (python-can `BusState` and error counters, SocketCAN error frames,
   the vbus), written up as data before any surface is designed.
2. Error frames render distinctly in the trace *at all* (read `kind`) —
   the smallest honest improvement, independent of coalescing.
3. Host-side coalescing into the `busError` event kind, hidden by
   default.
4. `InterfaceState` produced and consumed: controller state, TEC, REC.
5. Bus load where the bitrate is known.
6. The health panel and the status bar.

**Prototype written 2026-08-20 by owner instruction ("we should
prototype the bus health panel and status bar as well"):**
`plans/prototypes/bus-health.html`. It carries one row per logical bus
across every state that matters — error-active, error-passive, bus-off,
not connected, and an in-process virtual bus — the status bar fixed at
the foot of the window with the connection and health chips in it, and
the four questions it exists to settle.

Two decisions are baked into the mock and should be read as proposals:

- **Absent is not zero.** A virtual bus has no configurable bitrate
  (`project.rs` says so deliberately) and therefore no defined load,
  and a bus with no binding has no counters. Those cells read an em
  dash. This is the earlier ruling — compute where the bitrate is
  known, display nothing where it is not — rendered.
- **Bus-off shows 0 % load, not absent.** The controller is off the
  wire, so zero is the true reading. "No traffic" and "we cannot know"
  are different answers and only one of them is an alarm; a panel that
  renders them alike is worse than no panel.

## Exit criteria (draft — firm at grooming)

- An error frame is never rendered as an ordinary empty data frame.
- An error storm at bus frame rate does not grow trace memory in
  proportion to the errors; tested with a synthetic storm.
- A saved capture still contains every error frame that was received.
- Controller state and TEC/REC are produced, carried and displayed for
  a bus that reports them.
- Bus load is shown where it can be known and absent where it cannot;
  never estimated from an unknown bitrate.

## Status log

### 2026-08-22 — (branch `task-101-bus-health`)

**Phase 0 — investigation, before any surface was designed.** Four of
this file's "what is missing" claims were checked against the code, and
two of them are stale.

| claim in this file | verdict | evidence |
|---|---|---|
| "Nobody produces `InterfaceState`. No driver path emits it." | **false for the sidecar** | `servers/cannet-python-can/.../server/shared_interface.py` runs a state-poll thread that calls `ch.state()` and emits an `InterfaceState` envelope on every change, and pushes a snapshot to each subscriber on `attach`. `driver_python_can.py::state()` maps python-can's `BusState` onto active / passive / bus-off and reads `tec`/`rec` where the driver exposes them. So the producer exists; the consumer is what is missing. |
| "Nobody consumes it. `cannet-client` explicitly discards it." | **true** | the ignore arm at `crates/cannet-client/src/lib.rs`, whose own comment says "the GUI host bridges them into its own surfaces" — which nothing does, because the client offers no surface to bridge from. |
| "Nothing computes bus load live." | **true** | the only bus-load number is Vector's, parsed out of a BLF `CAN_STATISTIC`. |
| "`TraceView.tsx` never reads `kind`." | **imprecise, but the observation holds** | it does read it, through `formatKind` in the `type` column — and that column is `defaultHidden: true` (`traceColumns.ts`). So in the default column set an error frame really is indistinguishable from a zero-byte data frame: same blank data cell, same blank message cell, `len` 0. |

Two further findings that shaped the design:

- **The model carries no error *class*.** `CanFramePayload::Error` is a
  unit variant. BLF's `CAN_ERROR_EXT` has an `ecc` byte, and
  `can_error_ext_to_frame` drops it; the wire's `FRAME_KIND_ERROR` has
  no room for one; python-can does not surface a class uniformly across
  drivers. So "coalesce by class" cannot be implemented as written —
  see Blockers.
- **A frame's on-wire bit count already exists in the codebase**, as
  `shared_bus.rs::frame_duration`'s private arithmetic (47/67 header
  bits, 8 per data byte, an FD data-phase tail of 25 + 8/byte, 13 bits
  for an error frame). Bus load needs the same number, so it was
  promoted rather than written a second time.

**Phase 1 — an error frame stops reading as an empty data frame.**

- *Observation.* A BLF carrying `CAN_ERROR_EXT` records imports today
  and renders each one as a row with a blank data cell, a blank message
  cell and `len` 0 — identical to a zero-byte data frame.
- *Hypothesis.* The distinction is missing from the **default** column
  set, not from the data: `kind` reaches the frontend and `formatKind`
  already renders "ERR", but only in a column that is hidden by default.
- *Experiment.* `TraceView.gridview.dom.test.tsx` renders one error-kind
  row with the default columns and asserts the row carries
  `trace-row-error-frame`, that its message cell reads "Bus error", and
  that it has an explanatory `title`. **Control**: a second test renders
  a *classic* frame that also carries no payload and asserts the row has
  none of those. Without the control, "the row says Bus error" would
  also pass on a change that labelled every empty frame.
- *Data.* Before the change the error test failed on the class
  (`Received: trace-row`) while the control passed. After it, both pass.
- *Conclusion.* The message cell is where the row says what it is; the
  class only tints it, so the distinction survives a reader who cannot
  see the colour.
