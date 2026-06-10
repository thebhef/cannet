# ADR 0021 — Virtual-bus primitive, server, and bridging

Status: accepted (2026-05-27)

`cannet-core` grows a `shared_bus` primitive: one CAN bus shared by
N participants with configurable bitrate, ISO 11898-style arbitration, and
support for bridge participants that front a physical CAN interface on a
remote wire endpoint. `cannet-server --virtual-bus` wraps it as a
gRPC service ([ADR 0004](0004-grpc-wire-protocol.md)) for the
remote case; the GUI host uses the same primitive in-process for
local virtual buses (and, later, rest-of-bus simulation). The
existing `--loopback` mode (and `cannet-core::loopback_bus`) is
retired: a virtual bus with the GUI's already-synthesised Tx row
covers every use case loopback served, with less surface.

The bar: an analyzer connected to a participant observes behaviour
indistinguishable from real CAN on the dimensions our model carries
(frame timing, arbitration, error frames including bridged ones,
bus load).

## Glossary

> **Why "participant" rather than "node"?** CANopen (Phase 21) uses
> "node" / "node ID" as a first-class protocol concept. Reserving the
> word for that meaning keeps the language unambiguous; the primitive
> here uses **participant** for the analogous bus-level thing.

- **TEC / REC** — ISO 11898-1 Transmit / Receive Error Counters,
  per participant, drive Active / Passive / Bus-off transitions.
- **Error frame** — A first-class frame kind. On real CAN a
  participant emits one (six dominant bits, plus delimiter and
  idle) when it detects a frame error; receivers discard the
  in-flight frame. `cannet-core::CanFramePayload::Error` already
  represents it; the wire envelopes must round-trip it.
- **Allocated participant** — A virtual participant created when a
  session subscribes to the bus factory. No physical referent.
- **Bridge participant** — A participant on the bus whose RX is fed
  by, and TX forwarded to, a physical interface on a remote wire
  endpoint. The controller is the source of truth for its TEC, REC,
  state, and error frames.

## Decision

### Two server roles, in brief

The wire protocol supports two server roles. This ADR covers the
**virtual-bus server**; the **hardware server** is defined in
[ADR 0022](0022-hardware-server-model.md).

- **Virtual-bus server** (`cannet-server --virtual-bus`, this
  ADR): hosts a virtual CAN network — arbitration / fan-out, a
  factory interface, bridge orchestration. Doesn't own physical
  interfaces; doesn't proxy state, stats, or config from hardware
  it bridges to.
- **Hardware server** ([ADR 0022](0022-hardware-server-model.md)):
  owns physical interfaces — per-interface lifecycle (`Subscribe`
  / `Unsubscribe`-gated start/stop), `ConfigureBus`,
  `InterfaceState`, the physical frame stream.

A bridge installed on a virtual-bus server is, from the hardware
server's side, an ordinary client session. A client monitoring a
bridged physical interface keeps two sessions: one to the virtual-
bus server (frames via the virtual bus, bridge topology) and one
to the hardware server (state, config, the physical stream).

### Primitive: `cannet-core::shared_bus`

The fan-out + arbitration primitive lives in `cannet-core`, not
`cannet-server`, so the GUI host can use it in-process: local
virtual buses are the primary in-process consumer today,
rest-of-bus simulation will be another later. Surface:

```rust
SharedBus::new(BusConfig)
  -> SharedBus
SharedBus::attach_participant(&self)
  -> (LocalSink, LocalSource)
SharedBus::attach_bridge(&self, name, remote_sink, remote_source)
  -> BridgeHandle
SharedBus::reconfigure(&self, BusConfig)
```

`BusConfig` carries `speed_bps`, `fd_data_speed_bps` (optional;
classic-only buses leave it empty), and a classic-vs-FD enable
flag. Drop a `LocalSink`/`LocalSource` pair to detach. `loopback_bus`
goes away in the same change — no caller is preserved.

### Factory-shaped interface listing

`cannet-server --virtual-bus` publishes:

- One **factory** entry `virtual:bus0`. Subscribing allocates a
  fresh server-side participant; the server returns
  `Body::InterfaceAllocated { interface_id: "virtual:bus0/p0" }`.
  Allocated ids are monotonic per server lifetime and never
  re-used. A session may subscribe many times to operate as many
  participants. Session end disposes that session's participants.
- Zero or more **bridge** entries (`virtual:bus0/bridge-<name>`),
  one per installed bridge. Not allocatable; subscribing to a
  bridge id is an observer subscription delivering the bridge's
  share of bus fan-out. Controller state for a bridged interface
  is observed on the hardware server (see *Server roles*).

### Multi-client; no claim conflicts

The mode accepts any number of concurrent sessions. The factory
has no shared id to conflict over; allocation is per-subscribe.
BLF replay keeps its single-client `BUSY` gate (different design,
out of scope here).

### Shared-medium fan-out

`FrameBatch` from a session's allocated participant fans out as `Rx` to
every **other** participant on the bus, each delivery tagged with the
sender's id so attribution survives. Bridges forward fan-out to
their physical backend; physical frames a bridge receives fan
inwards. The originator's session does not receive its own frame
back — the GUI's locally synthesised `Tx` row is the originator's
only record, matching real bus-monitor behaviour for a participant's own
transmissions.

A frame with zero recipients reaches no acknowledger and the
originator gets `Error { code: NoAcknowledger }`.

### Per-participant TX queue, frame-boundary arbitration

The bus runs one timeline (`busy_until`). Each participant holds its own
FIFO TX queue; `FrameBatch` enqueues frames in order. At each
arbitration round, every non-empty queue contributes its head;
lowest CAN id wins (same-id ties resolve FIFO by enqueue time);
the winner pops; the bus advances by the frame's duration computed
from `BusConfig` and on-wire size, with FD BRS applied for FD
frames. Losing arbitration is not a TX error.

Matches real CAN per-participant FIFO fairness — one frame per participant per
round, no participant monopolises with low-id frames. Model is
frame-boundary, not bit-level; bridge participants delegate timing AND
arbitration to the physical controller (its "bus idle observed"
event drives `busy_until`; its bit-level arbiter decides wins).
Same delegation, not two.

### Error model

**Allocated participants carry no ISO error state machine.** Active /
Passive / Bus-off progression for a participant with no physical referent
is fiction. A participant whose TX reaches zero recipients receives
`Code::NoAcknowledger` per attempt; that's the entire error
surface.

**Bridge participants do not synthesise controller state on the
virtual-bus server.** TEC, REC, and Active / Passive / Bus-off live
on the hardware server that owns the underlying controller, which
pushes `Body::InterfaceState { interface_id, state, tec, rec }`
to its own subscribers. A client wanting that visibility for a
bridged interface observes it on the hardware server directly
(see *Server roles* above).

**Error frames are first-class wire content.** A bridge participant
forwards error frames its controller emits into the bus's fan-out
the same way it forwards data frames. The wire envelope
(`frame_to_proto` / `proto_to_frame`) gains round-trip support for
`CanFramePayload::Error` if it doesn't already. Allocated participants
don't generate error frames; the primitive accepts them via the
sink so a future fault-injection layer can inject them.

### Bridge installation

Installing a bridge is the same primitive in either direction —
open a `cannet-client` session to a remote wire endpoint, subscribe
to the named interface, call `SharedBus::attach_bridge` with the
session's sink/source, and let the bus pump both ways.

- **In-process** (host's local virtual bus): the host orchestrates
  directly — opens its own client session, calls `attach_bridge`.
- **Over the wire** (`cannet-server --virtual-bus`):
  `Body::AttachBridge { remote_address, interface_id, name? }` from
  any session asks the server to do the same orchestration on the
  client's behalf; the server then pushes the updated interface
  list through `WatchInterfaces`. `Body::DetachBridge { name }`
  tears one down.

The remote endpoint (python-can sidecar, another virtual-bus
server, anything that speaks the wire) sees only an ordinary
session — bridge knowledge lives entirely on the orchestrating
side.

**Bridging into another virtual bus works the same way.** A bridge
whose remote endpoint is another `cannet-server --virtual-bus`'s
factory (`virtual:bus0`) is just a bridge whose backend happens to
be a virtual bus. The remote sees one extra session, allocates it
a participant, fans out to it like any other client; the orchestrator's
local bus treats it as the bridge's RX source / TX sink. Both buses
keep acting as full virtual buses for their other clients. The
**CAN-over-IP gateway** falls out: each of two machines runs a
virtual bus with a bridge to its local physical CAN interface;
one of the two also bridges to the other machine's factory, so
traffic crosses the network through that single inter-server
bridge. A symmetric setup (both sides bridging the other) would
loop fan-out and is avoided.

### Bus configuration

In-process, `SharedBus::reconfigure(BusConfig)` mutates the bus's
config (re-derives frame durations, applies FD enable) — used by
the GUI host for local virtual buses. The virtual-bus *server*
does not handle `ConfigureBus`; its bus parameters are set at
startup via CLI flags (`--speed-bps`, `--fd-data-speed-bps`) and
are not configurable over the wire.

Hardware-server `ConfigureBus` semantics live in
[ADR 0022](0022-hardware-server-model.md).

### GUI host integration

The host instantiates `SharedBus` **in-process** for local virtual
buses — no sidecar, no port, no stdio capture, no IPC. The trace
store ingests fan-out from the bus's participants the same way it ingests
frames from a gRPC session. Bridges on a local virtual bus are
installed by the host opening a `cannet-client` session to the
bridge target (typically a python-can sidecar) and wiring those
streams into `SharedBus::attach_bridge`. `cannet-server
--virtual-bus` exists for the *remote* case — a `cannet-server`
instance on a test-rig machine with hardware bridges, accessed
across the network — and is built from the same workspace but is
not bundled with the GUI for in-process use.

Project bindings exist in three shapes, each round-tripped through
the project file:

- `{ kind: "remote", address }` — connect on load, don't spawn.
- `{ kind: "remote-virtual-bus", address }` — same as `remote`,
  marked so the GUI rehydrates by subscribing to the factory
  rather than pinning a now-stale allocated id.
- `{ kind: "local-virtual-bus", bus_config, bridges }` — on load,
  construct an in-process `SharedBus` with `bus_config`, install
  the recorded `bridges` by opening client sessions to their
  remote endpoints. Lives for the project's session.

Project panel grows "Create virtual bus" (creates a
`local-virtual-bus` binding, instantiates the bus in-process) and
per-binding "Add bridge" (for a local bus, opens the client
session and calls `attach_bridge`; for a remote-virtual-bus,
sends `AttachBridge` over the wire). Existing `remote` bindings
migrate cleanly; `PROJECT_SCHEMA_VERSION` bumps.

### Wire-protocol additions

Envelopes introduced for the virtual-bus server:

| Addition | Direction | Purpose |
| --- | --- | --- |
| `Body::InterfaceAllocated { interface_id }` | server→client | Factory-allocated participant id |
| `Body::AttachBridge { remote_address, interface_id, name? }` | client→server | Install a bridge |
| `Body::DetachBridge { name }` | client→server | Remove a bridge |
| `Code::NoAcknowledger` | server→client | TX reached zero recipients |
| Error-frame round-trip in `frame_to_proto`/`proto_to_frame` | bidirectional | Bridges forward controller-emitted error frames |

`ConfigureBus` and `InterfaceState` are defined for the
hardware-server role in [ADR 0022](0022-hardware-server-model.md).
The virtual-bus server doesn't handle them.

All variants exhaustive in `cannet-server` and `cannet-client`.
BLF replay rejects `AttachBridge` / `DetachBridge` with
`Code::TxRejected`.

## Why

**Primitive in `cannet-core` (not the server).** Rest-of-bus
simulation will need the same multi-participant bus primitive in-process.
Putting it where the GUI host can call it directly avoids
re-implementing fan-out / arbitration.

**Loopback retired.** The virtual bus is a strict superset of what
loopback did. Keeping both means two server modes whose Venn
overlap is most of loopback.

**Factory model.** Pre-allocating participants + growing on demand needed
an unclaimed-spare invariant, a claim-conflict error, and growth
notifications — none of which a factory needs.

**Allocated ids echoed back, not opaque.** RX frames need the
sender's id; multi-participant sessions need distinct ids per TX.

**No ISO error machine for allocated participants.** A simulated
Active / Passive / Bus-off progression with no physical referent
is fiction. `NoAcknowledger` per failed TX is enough; the session
decides what to do. State machinery only for bridges, where it
reflects something real.

**Bridges as participants, not as a separate mechanism.** One bus code
path; the bridge layer is a thin adapter between a wire session
and a `shared_bus` participant.

**Bridge orchestration lives on the bus side, not in the sidecar.**
Whoever calls `attach_bridge` — the GUI host (in-process) or a
`cannet-server --virtual-bus` (on behalf of a client) — opens an
ordinary session to the sidecar. The python-can sidecar stays
virtual-bus-agnostic; future vendor sidecars plug in unchanged.

**Hardware state stays on the hardware server, not proxied.** A
bridged physical interface's controller state, fault-confinement,
config, and stats live where the controller does. The virtual-bus
server doesn't relay them: the GUI's already-rendered "remote
session" surface (per ADR 0016) handles observer subscriptions to
the hardware server directly. Two narrow responsibilities beat one
wide one that has to invent proxy semantics.

**Cross-server bridging is the same primitive.** No "gateway mode"
— `AttachBridge` against another virtual-bus server's factory is
just a bridge whose backend happens to be another virtual bus.
The CAN-over-IP gateway shape falls out for free.

**The virtual-bus server has no controller to configure.** Its
bus params come from CLI flags at startup. Wire-level
`ConfigureBus` semantics live in
[ADR 0022](0022-hardware-server-model.md).

**Error frames as first-class wire content.** A bridge that drops
its controller's error frames lies to the analyzer. Closing this
gap in the wire model is overdue regardless of virtual-bus
landing.

**Local vs remote binding kinds in the project.** A local virtual
bus is host-owned state, not a network endpoint; "connect on load"
doesn't apply to it. Distinguishing the binding kind makes the
lifecycle (construct in-process vs. open a session) explicit
rather than encoding it in flag fields.

## Rejected alternatives

- **Pre-allocated pool with monotonic growth.** Required
  unclaimed-spare invariant + claim-conflict code + growth
  notifications.
- **Opaque allocation (client only sees `virtual:bus0`).** RX
  needs sender attribution; multi-participant sessions need TX
  disambiguation.
- **Bridges as a separate `cannet-server --bridge` mode.**
  Duplicates the wire-endpoint surface; splits bus state.
- **Virtual-bus knowledge in the python-can sidecar.** Intrusive;
  bridges in `cannet-server` keep responsibilities clean.
- **Bus config via Subscribe extensions only.** A separate
  envelope reads cleaner; a config change without re-subscribe is
  the common case.
- **Pool-of-frames arbitration.** Unfair under batched submissions.
- **Bit-level arbitration with mid-frame preemption.** Identical
  steady-state ordering; needs a bit-time clock.
- **Full ISO error machine on allocated participants.** Fiction with no
  physical referent.
- **Keep `--loopback` for backwards compatibility.** No users
  outside this repo; a one-line CLI removal saves a server mode's
  worth of code.

## Known deviations

- **Same-id contention between virtual participants resolves FIFO.** Real
  CAN sees a bit-level collision (error frames, both retry).
  Bridge-to-bridge contention is bit-level (delegated to the
  controllers).
- **Allocated participants have no error state machine.** `NoAcknowledger`
  is the only error surface; no TEC, REC, or Bus-off
  progression.
- **Frame-boundary arbitration on the virtual side.** Bridges
  arbitrate bit-level (delegated).
- **Participant identity does not cross a bridge.** CAN carries no participant
  id on the wire; multiple virtual participants appear as one real participant
  from the physical bus's POV, and vice-versa. Intrinsic to CAN.
- **Cross-network bridging adds latency.** CAN-over-IP gateways
  pay network round-trip time; suitable for distributed test rigs
  with bandwidth headroom and millisecond-tolerant apps.
