# Task 39 — Automotive Ethernet Signals

Extend cannet beyond CAN: import Ethernet captures (pcapng), decode
automotive Ethernet protocols (SOME/IP, AUTOSAR signal PDUs), and plot
their signals with the same quality the DBC pipeline gives CAN. The
research and design detail lives in
[`0039-ethernet-signals/`](0039-ethernet-signals/):

- [capture-formats.md](0039-ethernet-signals/capture-formats.md) —
  pcap vs pcapng, LINKTYPE_CAN_SOCKETCAN, TECMP/CMP, BLF Ethernet
  objects, Rust crates.
- [protocols.md](0039-ethernet-signals/protocols.md) — SOME/IP(-SD),
  SoAd signal PDUs, SecOC, DoIP, AVTP/ACF-CAN, gPTP; what timeseries
  data actually looks like per protocol.
- [description-formats.md](0039-ethernet-signals/description-formats.md)
  — ARXML and FIBEX (there is no open "Ethernet DBC"), and the Rust
  library ecosystem.
- [prior-art.md](0039-ethernet-signals/prior-art.md) — CANoe,
  Wireshark, asammdf, Vehicle Spy; the market gap this fills.
- [model-impact.md](0039-ethernet-signals/model-impact.md) — what
  changes downstream of the frame pump, and what survives untouched.

## Staged approach

Ordered so each stage ships alone; the cheap stages need no model
changes at all.

1. **pcapng import, CAN linktypes only.** Read pcap/pcapng, unwrap
   LINKTYPE_CAN_SOCKETCAN (and ACF-CAN-in-Ethernet where present) to
   plain `CanFrame`s — the existing seam and DBC pipeline apply
   unchanged. Interop win (tcpdump/Wireshark SocketCAN captures) at
   BLF-import cost.
2. **Step/hold plot semantics.** On-change event series (SOME/IP
   notifications) are irregular step functions: last-value-hold
   rendering, an explicit "no value yet" state before the first
   sample. A signal-side change, shared prerequisite for every
   event-driven source (including any future MQTT source).
3. **Multi-protocol trace model.** The model-level change described in
   [model-impact.md](0039-ethernet-signals/model-impact.md): a
   discriminated trace-event type, protocol-scoped identity keys, a
   decoder seam beside DBC, trace rows as protocol events (PDUs), not
   wire frames.
4. **ARXML/FIBEX-described decode.** SOME/IP events and SoAd signal
   PDUs decoded into named, scaled signals from an imported
   description file; plotted like DBC signals.

## Open questions

- Description format priority: ARXML first (industry master,
  `autosar-data`/`autosar-data-abstraction`) or FIBEX 4 first (what
  the open SOME/IP tooling targets, `afibex`/`asomeip` already decode
  end-to-end)?
- How much stateful decode in v1: SOME/IP-SD instance tracking, TCP
  reassembly, SOME/IP-TP — or UDP-only event decode first?
- Raw-packet drill-down view: keep the wire frame reachable behind the
  PDU row, or drop it entirely (Wireshark exists)?
- Where stages 3–4 sit relative to the rest of the roadmap — they are
  large, and stages 1–2 don't force them.

## Non-goals

- MQTT (would be a live client source, not a capture decode — separate
  task if pursued; stage 2 is its prerequisite too).
- Live Ethernet capture (files first; live needs libpcap/Npcap).
- DoIP/UDS session analysis, SecOC MAC verification, TSN analysis.
- Writing Ethernet captures.

## Exit criteria

Per stage; each stage lands with its own tests and docs.

1. pcapng with SocketCAN linktype imports to the trace/plot exactly as
   an equivalent BLF does (fixture-compared); mixed-linktype files
   import the CAN interfaces and report what was skipped.
2. An on-change series renders step/hold with an explicit pre-first-
   sample gap, under test, without regressing cyclic-CAN plots.
3. ADR for the multi-protocol event model (trace unit = protocol
   event; identity-key and decoder seams); `cannet-core`/spill/IPC
   carry a non-CAN event end-to-end under test.
4. An ARXML- or FIBEX-described SOME/IP fixture capture decodes to
   named scaled signals, plotted with step/hold; description-library
   decisions recorded in `technology-inventory.md`.
