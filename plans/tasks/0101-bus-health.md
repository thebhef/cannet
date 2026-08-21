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
- **Coalescing is model work.** It happens host-side, before the trace
  store, not in a renderer (CLAUDE.md § thin views). The uncoalesced
  frames are counted, not stored.

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
  - The **chip** is the always-visible summary — the worst current
    state across buses — so bus-off is noticed without going looking
    for it, and it opens the panel. It lives in the **status bar
    directly beneath the toolbar**, beside the connection chip
    (`plans/prototypes/toolbar-status-bar.html`). **There is no window
    footer** — owner ruling 2026-08-20, correcting an overseer
    misreading that built one.
  - **Prototype the chip before building it.** This repo's practice is
    an HTML prototype under `plans/prototypes/`, reviewed with the
    owner, deleted by the phase that implements it (task 89 did exactly
    this). The chip is the first instance of a wider direction —
    see [task 103](0103-toolbar-status-chips.md) — so its visual
    language is not this task's to invent alone.
- **Who produces `InterfaceState`?** The local driver path and the
  server both need to emit it; today neither does. Scope check: is the
  python-can sidecar in scope, or only local buses?

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
