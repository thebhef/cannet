# Task 101 — Bus Health: Error Frames, Bus Load, Adapter Status

> **Status 2026-08-23 — code-complete, awaiting acceptance.** All six
> phases landed 2026-08-22 on the chain (nothing has merged). The five
> exit criteria are walked at `## Exit criteria — verdicts`, all met, one
> qualified "met in code, unverified on hardware". **That hardware
> verification was run by the owner on 2026-08-22 and failed** — which is
> what opened task 109 item 2 — and, after task 109 phases 2 and 2c fixed
> what it exposed, **was re-run on 2026-08-23 and confirmed working**
> (owner-review-queue 3.38). Findings still owed a verdict:
> owner-review-queue 1.17, 1.18, 1.27, 3.13, **3.52**, and the Vector leg
> of the same work (3.40), which no agent can test.

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

- ~~**Nobody produces `InterfaceState`.** No driver path emits it.~~
  **Wrong, checked 2026-08-22:** the python-can sidecar runs a
  state-poll thread that emits one on every change and pushes a
  snapshot to each subscriber on attach. It is the only hardware
  producer there is — `cannet-server` is a BLF-replay / virtual-bus
  server with no controller behind it.
- **Nobody consumes it.** `cannet-client` explicitly discards it in an
  ignore arm alongside `ConfigureBus`.
- **Nothing computes bus load live.** The only bus-load number in the
  codebase is the one Vector wrote into a BLF.
- ~~**`TraceView.tsx` never reads `kind`.**~~ **Imprecise, checked
  2026-08-22:** it does, through `formatKind`, in the `type` column —
  which is `defaultHidden`. The observation holds: in the default column
  set an imported BLF's error frames render as ordinary rows with an
  empty payload, indistinguishable from a zero-byte data frame. Error
  frames are already in our historical data, silently.

## Groomed decisions (owner, 2026-08-20)

- **Error frames are surfaced as rows, coalesced.** Owner: *"I do think
  that error frames should be surfaced as frames, but I don't want it
  to fill the trace buffer with error frames if we're getting flooded
  with them."* Coalesce consecutive errors on a bus ~~by class~~ into
  one row carrying a **count and a span**. Given property 2 above this
  loses almost nothing; given property 1 it is what makes the trace
  survive a fault at all.

  **"By class" could not be implemented as written (2026-08-22).**
  `CanFramePayload::Error` is a unit variant: the model carries no error
  class anywhere, the wire's `FRAME_KIND_ERROR` has no field for one,
  and python-can does not surface one uniformly across drivers. BLF's
  `CAN_ERROR_EXT` has an `ecc` byte and `can_error_ext_to_frame`
  discards it, so even for imported data the class is not in the model.
  Coalescing is therefore **by bus**, which is the closest faithful
  reading — property 2 says the errors carry no identity, so the count
  and the span are what the summary was for. Carrying the class would
  mean a new field on the core payload plus the wire, BLF, MDF and
  sidecar paths that round-trip it; see Blockers.
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
- ~~**Who produces `InterfaceState`?**~~ **Answered 2026-08-22 by
  reading the code: the python-can sidecar already does, and it is the
  only hardware path there is.** `cannet-server` replays BLFs and hosts
  virtual buses, neither of which has a controller; the in-process vbus
  likewise. So nothing needed producing — only consuming.

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

**Phase 2 — a run of errors becomes one event beside the frames.**

- *Observation.* An error frame aborts the frame in flight, which is
  retransmitted, which errors again. A persistent fault therefore
  produces errors at roughly the bus's whole frame rate — thousands a
  second — and each one is indistinguishable from the next.
- *Hypothesis.* Folding consecutive errors on a bus into one run with a
  count and a span bounds what the views hold without touching what the
  store holds, so the trace survives a fault *and* a saved capture stays
  complete.
- *Experiment.* `ErrorRuns` (`bus_health.rs`) is pure — no clock, no
  locks, no Tauri — so the rule is testable on its own.
  `a_storm_at_bus_frame_rate_becomes_one_summary` feeds 10 000 errors
  100 µs apart and asserts one run. **Controls**:
  `a_quiet_gap_starts_a_new_episode` (without it, "one run" would also
  pass on a coalescer that merged forever) and
  `the_run_set_is_bounded_but_the_count_is_not` (alternating
  fault-and-quiet is the shape that would otherwise grow the event set
  without limit). Both were then run against a **mutated** coalescer
  with the gap filter deleted: 3 tests failed, and the storm test
  passed — which is exactly why the gap test is its control and not a
  duplicate of it. A second mutation made an unknown bitrate read `0 %`
  instead of absent, and
  `load_is_absent_without_a_bitrate_and_zero_on_a_silent_configured_bus`
  failed.
- *Data.* 14 tests in `bus_health::tests`; 3 fail under mutation, 0
  under the real implementation.
- *Conclusion.* The gap, not the bus alone, is what makes a run a run.

**And the write path, proved off the producer rather than a hand-built
note.** `a_real_storm_coalesces_to_one_event_while_every_frame_reaches_the_file`
(`tests.rs`) runs 10 000 error frames through the real `ErrorRuns`, hands
`runs_as_events`' output to `NotesStore::replace_derived`, and asserts
`events()` holds exactly one summary while `exportable()` holds nothing —
then writes the frames through `write_blf_capture` off the very
expression `save_capture` builds its marker list from and reads all
10 000 back with their exact timestamps, with `marker_count == 0`. The
existing guard from the event-surface work covers the same boundary from
the other side, with a user note as its control.

**Where the coalescer sits.** `run_pump` — the single ingest path for a
remote session, an in-process virtual bus and a file import alike — folds
each error frame in *after* routing and *after* the frame that mints a
replay capture has cleared the previous session's health. Republication
is a **1 Hz poll**, not a callback: the producer runs at bus rate on a
worker thread and must not be the thing that decides when a `WebView`
repaints. The same reasoning, and the same cadence, as the clock-status
emitter.

**Phase 3 — the controller state that was already arriving.**

- *Observation.* `InterfaceState` is defined in `cannet.proto`,
  round-trip tested, forwarded untouched by the server and the proxy,
  **and produced** by the sidecar's state poll. `cannet-client` drops it
  in an ignore arm whose own comment says "the GUI host bridges them into
  its own surfaces".
- *Hypothesis.* Nothing bridged it because the session has no outward
  channel for a non-frame: `FrameReceiver` yields frames and nothing
  else.
- *Experiment.* Give it one, shaped like `SessionClock` —
  `ControllerStates`, a cheap-to-clone handle the worker writes and a
  control surface reads. `controller.rs`'s tests were then run against a
  **mutated** `record` that took the lock and discarded the write: 4 of 5
  failed, the survivor being the enum-naming test, which does not touch
  the map.
- *Data.* 5 tests; 4 fail under mutation.
- *Conclusion.* The map is genuinely written and genuinely shared across
  clones.

It lives on the **session**, not in the bus-health singleton, so a
disconnect takes the reading with it rather than leaving a stale one that
looks live. A state this build cannot name (`UNSPECIFIED`, or anything a
future peer sends) is dropped rather than stored — asserted by
`a_state_this_build_cannot_name_is_not_reported_at_all`, whose second
half proves an unknown report does not displace a known one.

**Phase 4 — bus load, computed where the bitrate is known.**

- *Observation.* A frame's on-wire occupancy was already modelled once,
  privately, inside `shared_bus.rs::frame_duration`.
- *Hypothesis.* Bus load needs the same number, and a second copy of it
  would be a second answer.
- *Experiment.* Promote it to `CanFramePayload::on_wire_bits`, returning
  the count **split by the phase each bit is clocked at**, and refactor
  `frame_duration` onto it under the existing green `shared_bus` suite.
  Four new tests pin the numbers, the discriminating one being
  `only_a_bitrate_switched_fd_frame_puts_bits_in_the_data_phase`: without
  BRS the frame runs end to end at the nominal rate, and charging its
  payload to the data rate would understate the wire it used.
- *Data.* `cannet-core` 43 → 47 tests, all passing, `frame_duration`'s
  own tests unchanged.

The store accumulates those bit times per bus through
`RateTrack::observe_weighted` — the same windowed sampler and pruning its
frame rates already use, over a different unit.
`bits_per_second_by_bus_reads_the_wire_not_the_frame_count` is the
experiment that shows the two are different measurements: two buses at an
**identical** frame rate, one carrying empty frames and one carrying
eight bytes, read 470 and 1110 bit/s while their `f/s` figures match to
1e-9.

**Where bus load is computed, and why there.** In three places, each
holding the only part it can know:

| piece | where | why there |
|---|---|---|
| bit times on the wire, per bus, per phase | `TraceStore` (`rate.rs::by_bus_bits`) | it is a fact about the frame stream, and the store already owns the windowed rate machinery the figure has to share to be consistent with `f/s` |
| the denominator | `ConnectionStates` (`AppliedBusConfig::speed_bps`) | `ConfigureBus` is fire-and-forget, so what the host *sent* is the deepest truth available about a controller's timing |
| the division | `bus_health::load_percent` / `health_rows` | it needs both, and CLAUDE.md § thin views puts domain computation host-side — the frontend formats the percentage and never derives it |

The status bar's single figure is `worst_load_percent`: the **worst**
load across the buses that report one, because the bar has room for one
number and an average over four buses hides the one that is saturating.
It rides `trace-grew` with every other metric, so ADR 0055's "every
figure is the host's" holds literally.

**Phase 5 — the panel, the launcher, and the prototype's deletion.**
`busHealth.ts` joins three host models against the project's own bus
list; `BusHealthPanel.tsx` renders them; `App.tsx` passes
`busHealthProps` to `StatusBar`, which is the one prop the launcher was
waiting for, and `busLoadPercent` to `statusMetrics`, which is the one
argument the metric was waiting for. `plans/prototypes/bus-health.html`
is deleted in the same commit.

*The experiment that matters here is the em dash.*
`BusHealthPanel.dom.test.tsx` renders a bus-off bus, a healthy bus and a
virtual bus together and reads the cells off: the bus-off row is
`0 %` / `256` / `9,471 (2.1k/s)`, the virtual bus is `—` / `—` / `—`.
**Control:** a second test renders the same project with an empty host
map and asserts every one of those cells is an em dash — so the first
test is reading "we cannot know" and not merely "there is no number".

## Blockers / side effects

- **Coalescing is by bus, not by class.** The groomed wording said "by
  class" and the model has none: `CanFramePayload::Error` is a unit
  variant, the wire's `FRAME_KIND_ERROR` carries no field for one, the
  BLF reader discards `CAN_ERROR_EXT`'s `ecc`, and python-can does not
  expose a class uniformly. Adding one means a new field on the core
  payload plus every path that round-trips it (BLF, MDF, the proto, the
  sidecar's frame mapping) **and** a producer that can fill it for live
  hardware — otherwise the coalescing key would differ between an import
  and a live session, which is worse than not having it. Recorded as a
  divergence rather than implemented; the task file's groomed decision
  is annotated in place.
- **A summary cannot name its bus.** The host holds bus *ids* (`b1`,
  `b2`); the project's bus **names** are the frontend's, pushed
  host-side only into the RBS runtime. So a coalesced event's label
  reads "1 284 bus errors over 4.1 s" and the bus rides the event's
  `tag`, which is the axis the event view already filters on. The health
  panel — which ADR 0055 makes the place "which bus" is answered — names
  it properly. Giving the host the name map would want one small sync
  command; not built, because nothing else needs it.
- **Bus load excludes stuff bits.** The number of them depends on the
  transmitted bit pattern including the controller-computed CRC, which
  the model does not retain, so the figure is a **floor** and reads low
  against a heavily-stuffed stream. `on_wire_bits`' rustdoc says so and
  the README says so. Computing them exactly would mean synthesising the
  CRC-15 / CRC-17 / CRC-21 for every frame on the ingest path.
- **The virtual bus's adapter cell differs from the mock.** The mock drew
  `driver default (nothing sent)` against the Sim row; that is
  `describeAppliedConfig`'s answer for a *real* adapter left on its own
  default, and a virtual bus has no controller at all, for which the
  formatter answers nothing. Reusing the formatter was the ruling, so the
  formatter's answer stands and the cell is blank. Flagged for the owner
  in case the mock's reading was the intent.
- **No hardware verification.** The owner's own session holds the PCAN
  dongles, and this session neither launched the GUI nor ran the perf
  harness, per the contract. Everything below the wire — the sidecar's
  state poll, the client's consumption, the coalescer, the load
  arithmetic, the panel — is covered by tests, but no error-passive
  dongle was put in front of it. The end-to-end path is the one thing
  only hardware can close.
- **The 1 Hz emitter is not unit-tested as a task.** It is a thin
  composition (`collect_health_rows` → `runs_as_events` →
  `replace_derived` → emit) over functions that are each tested, and the
  suite has no `AppHandle` harness — `tests.rs` says so in several
  places about `run_pump` too. Worth an integration harness if one ever
  lands; not worth inventing one here.

## Exit criteria — verdicts (2026-08-22)

| criterion | verdict | earned by |
|---|---|---|
| An error frame is never rendered as an ordinary empty data frame | **met** | `TraceView.gridview.dom.test.tsx` — "says what it is in the default columns, and marks the row", with "leaves a zero-byte data frame alone" as the control |
| An error storm at bus frame rate does not grow trace memory in proportion to the errors; tested with a synthetic storm | **met, on the post-correction reading** | `a_real_storm_coalesces_to_one_event_while_every_frame_reaches_the_file` — 10 000 errors, one event; `a_storm_at_bus_frame_rate_becomes_one_summary` and `the_run_set_is_bounded_but_the_count_is_not` bound the set at `MAX_RUNS`. The *frames* do grow, and must: the correction above rules they are stored like any other frame, subject to the same windowed-ring bound. What coalescing controls, and what this criterion can now mean, is the event set the views hold whole in RAM |
| A saved capture still contains every error frame that was received | **met** | the same test: all 10 000 read back from the written BLF with their exact timestamps, `marker_count == 0`, `exportable()` empty |
| Controller state and TEC/REC are produced, carried and displayed for a bus that reports them | **met in code, unverified on hardware** | produced — the sidecar's state poll (read, not changed); carried — `controller.rs`'s five tests plus the client's `InterfaceState` arm; displayed — `busHealth.test.ts` "separates an error-passive bus and carries its counters" and `BusHealthPanel.dom.test.tsx`. No dongle was available to close it end to end; see Blockers |
| Bus load is shown where it can be known and absent where it cannot; never estimated from an unknown bitrate | **met** | `load_is_absent_without_a_bitrate_and_zero_on_a_silent_configured_bus`, `a_configured_bus_reports_a_load_and_a_silent_one_reports_zero`, `a_row_carries_no_load_where_the_host_has_no_bitrate_for_the_bus` (bits on the wire with no bitrate is still not a load), and `BusHealthPanel.dom.test.tsx`'s em-dash pair |
