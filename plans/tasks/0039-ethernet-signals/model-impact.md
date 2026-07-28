# Model impact: what changes downstream of the frame pump

Design notes for [Task 39](../0039-ethernet-signals.md) stage 3, based
on the current code (2026-07). This is the map of what a non-CAN event
source touches; the stage-3 ADR will fix the actual design.

## Today's seam, and why it's CAN-shaped

The format seam is `CanFrameSource`/`CanFrameSink`
(`crates/cannet-core/src/io.rs`); its currency is `CanFrame`
(`crates/cannet-core/src/frame.rs`): `timestamp_ns`, `channel: u8`,
`CanId { raw: u32, extended }`, direction, payload
(Classic/Fd/Remote/Error). Downstream, `RawTraceFrame`
(`crates/cannet-spill`), the trace store's always-on by-id index, the
IPC `TraceFrameRecord`, and the DBC decode path all assume those CAN
fields. Any source that can be unwrapped to CAN frames (SocketCAN
pcap, ACF-CAN, MDF bus logging) slots in with **zero** model change —
that's what Task 39 stages 1–2 and Task 38 exploit.

## The four changes native Ethernet events force

1. **Frame currency → discriminated trace event.** Shape to explore:

   ```
   TraceEvent { timestamp_ns, bus_id, kind }
   kind = Can(CanFrame) | SomeIpEvent{..} | SignalPdu{..} | ...
   ```

   Ripples through `RawTraceFrame`, `PersistedPayload`, the spill
   record layout, and IPC `TraceFrameRecord` — all currently carry
   bare CAN fields (`id: u32`, `extended`).

2. **Identity keys become protocol-scoped.** The by-id index keys on a
   u32 arbitration id. New identities: SOME/IP service+method (32-bit,
   near-fit), PDU ID (u32), and eventually strings (topics, service
   names) — the index key needs to become a protocol-scoped enum
   and/or interned value.

3. **A decoder seam beside DBC.** `cannet-dbc` keys on `CanId` and is
   intrinsically CAN. Non-CAN protocols need sibling decoders
   (ARXML/FIBEX → SOME/IP and signal PDUs) behind a shared
   "decode event → signal samples" interface. The **output** side —
   `SignalRecord`, signal cache/sampler, plot — is protocol-agnostic
   and survives (with the two cracks below).

4. **Trace unit = protocol event, not wire frame.** A raw Ethernet
   frame view is Wireshark territory; the useful trace row is the
   PDU/event (SOME/IP notification, signal PDU). One Ethernet frame
   may yield N rows (multi-PDU socket), or zero (TCP segment
   mid-reassembly). Consequence: stateful unwrap (TCP reassembly,
   SOME/IP-TP, SD instance tracking) runs host-side **before** the
   store — the store holds events, not packets. Whether a raw-packet
   drill-down layer is kept is an open question in the task doc. CAN
   is the degenerate case (frame == event), so today's trace view is
   unchanged. This matches the CANoe model (frame rows expandable
   into PDUs).

## Signals side: survives, with two cracks

- **Sampling semantics.** Cyclic CAN resampling is fine. On-change
  events are irregular step functions: last-value-hold rendering and
  an explicit "no value yet before first event" state
  ([protocols.md](protocols.md)). Sampler + renderer change, not a
  model rewrite — pulled forward as stage 2 because any event-driven
  source needs it.
- **Value types.** DBC yields numerics/enums. SOME/IP payloads carry
  strings, structs, arrays. v1: numeric leaves only, structs
  flattened to paths (the Wireshark-signalpdu / telemetry-tooling
  precedent); string/blob channels are a later decision.

## Untouched

`bus_id` routing (ADR 0023), absolute-`timestamp_ns` timing
(ADR 0024), the paged-view architecture, and the spill machinery all
hold as-is. `channel: u8` may be too small/wrong-shaped for Ethernet
interface naming — minor, fold into change 1.
