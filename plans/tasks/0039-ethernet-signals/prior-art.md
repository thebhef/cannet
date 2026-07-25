# Prior art: tools combining CAN + automotive Ethernet

Research notes for [Task 39](../0039-ethernet-signals.md). Gathered
2026-07.

## The incumbents

- **Vector CANoe/CANalyzer (.Ethernet option)** — the reference.
  Ethernet/SOME-IP plugs into the *same* Trace and Graphics windows as
  CAN; the trace shows Ethernet frames expandable into contained PDUs;
  once a payload is described (ARXML or FIBEX), its signals plot
  exactly like CAN signals. The unifying abstraction is *signal*,
  regardless of transport. BLF stores Ethernet natively.
- **Intrepid Vehicle Spy 3** — closest architectural analog to "CAN
  tool grows Ethernet": CAN + LIN + Ethernet + video "on one screen,
  time-aligned"; own .VSB format (keeps error frames pcap can't) but
  reads/writes pcap.
- **Technica ANDi** — "Wireshark for Automotive" pitch, Python
  scripting, paired with their TECMP capture hardware.

## The open-source landscape

- **Wireshark** — the de-facto free automotive Ethernet analyzer:
  mainline dissectors for SOME/IP(-SD/-TP), DoIP/UDS, AUTOSAR-NM,
  I-PduM, PDU-Transport, Signal-PDU, TECMP, ASAM CMP, IEEE 1722,
  SocketCAN; reads BLF directly. **Weak at signal plotting** — I/O
  Graphs aggregate per interval; the 4.6 Plots dialog is raw per-field
  scatter, nowhere near a DBC-style multi-signal workflow.
- **asammdf** — plots well, and MDF 4.1+ standardizes storing raw
  Ethernet frames (`ETH_Frame` bus events; 4.3.0 adds a SOME/IP
  associated standard) — but its bus-logging decode implements **CAN
  and LIN only**. Even in the MDF world, Ethernet decode is an open
  gap.
- **SavvyCAN, can-utils, python-can** — CAN only.
- **Python building blocks**: Scapy automotive layers (SOME/IP, DoIP,
  UDS), eth-scapy-someip, pyshark (tshark wrapper) — useful for
  generating test fixtures.

## The gap

Wireshark dissects everything but plots poorly; asammdf plots well
but doesn't decode Ethernet. **DBC-quality signal plotting over
SOME/IP signals only exists at CANoe / Vehicle Spy price tiers.**
cannet's plot UX applied to Ethernet signals is the differentiator.

## Container-of-record observations

Three candidates for mixed CAN+Ethernet capture: **BLF** (de-facto,
proprietary-but-reverse-engineered; our reader already skips its
Ethernet objects rather than failing), **pcapng** (open,
Ethernet-native, CAN via SocketCAN linktype; the interop lingua
franca), **MDF 4.1+** (standards-track, thinnest decode tooling).
Conversion paths exist between all three (Wireshark reads BLF;
Technica BLF→pcapng; Vector converts BLF↔pcapng for Ethernet).

Design lesson repeated across every serious tool: **one timeline,
shared analysis windows, signal as the unifying unit** — Ethernet is
another source feeding the same trace and plot, not a parallel app.
