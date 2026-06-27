# Task 28 — RBS External Value-Source Binding

Let an external, project-specific process (e.g. an EV drive-cycle
simulator) drive RBS signal values over time while cannet's RBS keeps
encoding and transmitting. cannet **connects out** to a value-source
server that streams sparse `(signal, value)` updates by name; RBS
applies them as overrides — the same path `rbs_set_signal` writes — and
keeps its own cadence, CRC, and counters.

Stream **values, not frames**: the source supplies physical values, RBS
stays the encoder ([ADR 0028](../../docs/adr/0028-rest-of-bus-simulation.md),
[ADR 0027](../../docs/adr/0027-calculated-fields-counter-crc.md),
[ADR 0017](../../docs/adr/0017-transmit-signal-encoder-and-bytes-source-of-truth.md)).
cannet stays a **client** (it has no inbound control surface, and won't
grow one) — this is a data input like a bus binding to a server, not a
control plane, and needs no in-app UI. **The simulator lives outside
this repo.**

## Decisions

- **Latest-wins apply.** Stream is `(timestamp, [(name, value), …])`,
  sparse. cannet applies the latest value per signal on arrival.
  Timestamp is carried but **informational in v1** (not used to schedule).
- **Replay is source-paced** — the source paces emission to wall-clock;
  cannet stays latest-wins. Timestamp-scheduled (frame-accurate) replay is
  a **non-goal**; carrying the timestamp now leaves that door open without
  a wire change.
- **Binding is an RBS/project concern** — declared in the project/RBS
  (host:port), persisted there, no sidecar ([ADR 0010](../../docs/adr/0010-no-sidecar-files.md)).
- **Addressed by name.** Source names signals; cannet overrides whatever
  resolves in the bound RBS, ignores+logs the rest
  ([ADR 0014](../../docs/adr/0014-host-system-log.md)). No index handshake.
- **Separate protobuf API** — its own service/`.proto`, not
  `cannet.proto`. This is RBS input, not bus content; separate keeps the
  "bus = content" boundary clean ([ADR 0004](../../docs/adr/0004-grpc-wire-protocol.md)).

## Open

- Value type: mirror `RbsValue` (number / enum label / `0x` hex)? (lean yes)
- Name grammar mapping to `RbsTarget` + signal, and DBC/layout drift.
- Disconnect: overrides hold last value or revert to default? Reconnect resumes.
- One source per binding to start.

## Non-goals

- The drive-cycle engine (out of repo).
- Timestamp-scheduled replay (v1 is latest-wins).
- Generic inbound control API, plugin framework, in-app source UI.
- Feeding signals anywhere but RBS.

## Exit criteria

- New `.proto` (separate from `cannet.proto`) for the streaming
  value-source RPC; cannet connects out as client.
- A bound RBS applies streamed sparse `(name, value)` updates as overrides
  via the existing reconstruct path; CRC/counter/cadence unaffected.
- Unresolvable names ignored + logged; disconnect handled per defined
  hold/revert, reconnect resumes.
- Binding persists in the project/RBS (no sidecar).
- Test source streams a sparse update; the bound message's transmitted
  payload reflects it with encode + CRC/counter applied.
- ADR captured (separate gRPC service, cannet-as-client, name-addressed
  sparse stream, latest-wins, drives RBS overrides); README/rustdoc updated.
