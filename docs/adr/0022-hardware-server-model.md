# ADR 0022 — Hardware-server wire model: session-gated lifecycle, multi-client, `ConfigureBus` + `InterfaceState`

Status: accepted (2026-05-28)

A **hardware server** is any cannet wire server that exposes
physical CAN interfaces. The reference implementation is the
`cannet-python-can` sidecar ([ADR 0008](0008-python-can-sidecar.md));
future Rust-native vendor sidecars and remote test-rig servers
implement the same model.

This ADR is the companion to
[ADR 0021](0021-virtual-bus-server.md), which covers the
**virtual-bus server**. The two server roles share the wire schema
(ADR 0004) and the discovery RPCs (ADR 0016); they differ in what
they own and what they do with the session envelopes.

## Two server roles, in brief

- **Virtual-bus server** (ADR 0021) hosts a virtual CAN network:
  arbitration / fan-out, a factory interface, bridge orchestration.
- **Hardware server** (this ADR) owns physical interfaces:
  per-interface lifecycle, fault-confinement state, configuration,
  the physical frame stream.

A bridge installed on a virtual-bus server is, on the hardware
server's side, an ordinary client session. The hardware server
doesn't know or care that one of its clients is a bridge.

## Decision

### Interfaces are physical, listed via `ListInterfaces` / `WatchInterfaces`

Each interface the sidecar exposes (`socketcan:can0`, `vector:0`,
`pcan:usb1`, …) appears in `ListInterfaces` and any active
`WatchInterfaces` stream per [ADR 0016](0016-interface-discovery-pull-and-watch.md).
The id format is the sidecar's; cannet doesn't standardise it
beyond requiring stability for the session's lifetime.

### Session-gated lifecycle, reference-counted on subscriptions

The hardware server owns start / stop. Clients do not send
explicit `Start` or `Stop` envelopes; their `Subscribe` /
`Unsubscribe` activity *is* the lifecycle signal.

- **First** `Subscribe(interface_id)` from any session → server
  opens the underlying interface (python-can `Bus(...)` or
  equivalent).
- **Last** `Unsubscribe(interface_id)` (or last subscribing
  session ending) → server closes it.
- While ≥1 client is subscribed, the interface is up and frames
  flow.

Reference-counting on active subscriptions matches the actual
intent: an interface is up because someone wants it up. No
separate claim envelope, no zombie-up state when nobody's
listening.

### Multi-client, by python-can's native behavior

Multiple sessions may subscribe to the same interface
concurrently. The sidecar opens the underlying device once on the
first subscribe; subsequent subscribers attach to the same open
device. Fan-out of physical RX to all subscribers and acceptance
of TX from any subscriber follow whatever python-can's backend
naturally does (SocketCAN on Linux: kernel-multiplexed; Vector XL
and PCAN-Basic on Windows: driver-multiplexed; etc.).

We don't impose exclusive ownership at the application layer.
Whatever conflicts arise in the wild are observed and addressed in
the sidecar; this ADR's contract is "multi-client allowed."

### `ConfigureBus`: any client may send, semantics deliberately open

`Body::ConfigureBus { interface_id, speed_bps, fd_data_speed_bps?,
fd_enabled }` from any subscribed session is forwarded to the
underlying interface. What happens when multiple clients send
conflicting configs, or when one sends while another is mid-
transmit, is **left to the underlying driver's behavior**.

This is deliberate: python-can already abstracts the driver
particulars, and we don't yet know which scenarios warrant
defending against. Step 6 wires the envelope through; usage
patterns will tell us whether a future ADR needs to add ownership
or last-writer-wins semantics.

### `InterfaceState`: pushed to active subscribers

While an interface is up, the sidecar pushes
`Body::InterfaceState { interface_id, state, tec, rec }` to every
subscribed session whenever the controller's ISO 11898-1
fault-confinement state changes. `state` is one of `Active` /
`Passive` / `BusOff`; `tec` / `rec` are the current Transmit /
Receive Error Counters.

Subscribers get a snapshot on subscribe (current state at the
moment of subscription) plus pushes on subsequent transitions.

### Frame flow

- `FrameBatch(interface_id, frames…)` from a client → TX on the
  physical bus.
- `FrameBatch(interface_id, frames…)` from the server → physical
  RX. Whether a client's own TX echoes back to it depends on the
  underlying driver (SocketCAN loopback semantics vs vendor
  driver semantics); cannet doesn't normalize this.

Error frames round-trip as `CanFramePayload::Error` per
[ADR 0021's *Error model*](0021-virtual-bus-server.md), so a
hardware server's controller-emitted error frames reach the wire
in their first-class form.

## Wire envelopes the hardware server handles

| Envelope | Direction | Effect |
| --- | --- | --- |
| `Subscribe(interface_id)` | client→server | Attach; first subscriber starts the interface |
| `Unsubscribe(interface_id)` | client→server | Detach; last unsubscribe stops the interface |
| `FrameBatch` | bidirectional | TX from client; RX to client |
| `ConfigureBus(interface_id, …)` | client→server | Forward to driver; conflict semantics open |
| `InterfaceState(interface_id, state, tec, rec)` | server→client | Fault-confinement state change |
| `Error` / `Log` | bidirectional | Per ADR 0004 / ADR 0014 |

Envelopes a hardware server does **not** handle (ADR 0021):
`InterfaceAllocated`, `AttachBridge`, `DetachBridge`,
`Code::NoAcknowledger`.

## Why

**Session-gated start/stop instead of explicit envelopes.**
Subscribing already declares interest. Adding `Start` / `Stop`
envelopes makes them two ways to say the same thing, with
inevitable cases where they disagree (subscribed but stopped, or
started with no subscribers). Reference-counting is the natural
shape.

**Multi-client because python-can already does it.** The drivers
we target (SocketCAN, Vector XL on Windows, PCAN-Basic on Windows)
all permit concurrent process attachment. Forcing exclusive
ownership at the wire layer would be working against the
underlying stack. Concurrent semantics are the driver's; the wire
just exposes them.

**`ConfigureBus` semantics open.** Specifying exclusive-owner
rules or last-writer-wins before observing real usage commits to
behavior we can't justify yet. Step 6 ships the envelope; usage
informs the next step.

**`InterfaceState` over `ResetInterface`.** We considered an
explicit reset envelope but couldn't justify it: bus-off recovery
can come from stop + start (last unsubscribe + fresh subscribe),
which already exists. A separate envelope would be one more piece
of surface with no use case it uniquely serves.

**No proxying of hardware state through other servers.** A
bridged physical interface's `InterfaceState`, stats, and config
live on the hardware server. A client wanting that visibility for
a bridged interface keeps a session to the hardware server, not
just to the bus server in front of it. Two narrow contracts beat
one wide one with relay semantics.

## Rejected alternatives

- **Explicit `Start` / `Stop` envelopes.** Duplicates the
  information already in `Subscribe` / `Unsubscribe` and creates
  reconcilable-but-real edge cases between the two.
- **Single-owner / exclusive sessions.** Doesn't match python-can
  behavior; would require us to invent a claim envelope and a
  conflict code, then enforce semantics the underlying driver
  doesn't enforce.
- **`ResetInterface` envelope.** No use case stop + start doesn't
  cover; adds wire surface without justification.
- **Proxying `InterfaceState` / stats through the virtual-bus
  server.** Conflates two roles; adds relay semantics; harder to
  reason about than "go ask the hardware server directly."

## Known unknowns (to revisit after Step 6)

- **`ConfigureBus` conflict semantics under multi-client.** What
  python-can actually does when two clients race. Observe; ADR if
  we need to formalize.
- **TX echo to the sending client.** SocketCAN and vendor drivers
  diverge; whether to normalize is open.
- **Per-interface stats surface.** Frame rates, dropped counts,
  bus load — useful for the GUI but not in this ADR. To be added
  when there's a concrete consumer.
