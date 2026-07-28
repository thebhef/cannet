# Automotive Ethernet protocols and their timeseries character

Research notes for [Task 39](../0039-ethernet-signals.md). Gathered
2026-07.

## SOME/IP and SOME/IP-SD

Wire format: 32-bit Message ID = 16-bit Service ID + 16-bit Method ID
(method IDs ≥ 0x8000 are events/notifications), Length, Request ID
(Client ID + Session ID), protocol/interface version, Message Type
(REQUEST 0x00, fire-and-forget 0x01, NOTIFICATION 0x02, RESPONSE 0x80,
ERROR 0x81, plus TP segment variants), Return Code, payload. Payload
is AUTOSAR-serialized structs/arrays/strings/unions — layout comes
from a description file ([description-formats.md](description-formats.md)).

**Instance ID is not in the header.** It's resolved via SOME/IP-SD
(UDP 30490, itself SOME/IP messages: Find/Offer Service,
Subscribe/SubscribeAck + endpoint options). A decoder must track SD to
know which service *instance* a port carries, and subscription state
determines when event data flows at all. SOME/IP-TP segments large
payloads over UDP; TCP transport needs stream reassembly.

Specs: [AUTOSAR PRS SOME/IP](https://www.autosar.org/fileadmin/standards/R22-11/FO/AUTOSAR_PRS_SOMEIPProtocol.pdf),
[open consolidated spec (some-ip.com)](https://some-ip.com/).

## AUTOSAR SoAd signal PDUs

Socket Adaptor maps classic I-PDUs (containers of DBC-style signals,
laid out by AUTOSAR COM) onto UDP/TCP sockets; multiple I-PDUs share a
socket via an optional PDU header (32-bit PDU ID + 32-bit length).
**The closest thing to "CAN frames over Ethernet"** — periodic, fixed
layout, signal-packed. Multiplexed/container I-PDUs add
selector-field variants. Wireshark models this as `pdu-transport` +
`ipdum` + `signalpdu` dissectors.

## SecOC

Secured I-PDU = authentic I-PDU + truncated freshness value +
truncated MAC (default profile: 4-bit freshness + 28-bit CMAC
appended). Passive analysis: strip the trailer before signal
extraction (lengths come from the description file); MAC verification
is impossible without keys — non-goal.

## DoIP (ISO 13400-2)

Diagnostics transport (TCP/UDP 13400) carrying UDS. Request/response,
not timeseries — trace-view material only, and out of scope for the
signal pipeline.

## AVTP / IEEE 1722 — ACF-CAN

Tunnels CAN/CAN-FD (and LIN, FlexRay) frames over L2 Ethernet in TSCF
(time-synchronous, gPTP timestamps) or NTSCF containers; each ACF-CAN
message carries CAN ID, flags, payload. **Existing DBC decode applies
unchanged after unwrap** — stage-1 material. Open reference:
COVESA/Open1722; Wireshark `ieee1722`.

## gPTP (IEEE 802.1AS)

EtherType 0x88F7, L2 multicast; AUTOSAR-mandated time sync. Relevant
as (a) traffic to classify, (b) the timebase capture hardware stamps
against. Not a signal source.

## What timeseries data actually looks like

| Traffic class | Character | Plot/decode implications |
| --- | --- | --- |
| SoAd signal I-PDUs | cyclic, fixed layout — behaves like CAN frames | best first target for signal plotting; needs PDU-ID→layout mapping + SecOC trailer handling |
| SOME/IP events / field notifiers | per-event config: cyclic **or on-change** | on-change = irregularly-sampled step function → last-value-hold rendering; value undefined before first notification; gaps ≠ missing data; needs SD state |
| SOME/IP request/response | transactional | trace/sequence view, not plots |
| ACF-CAN / PEAK / TECMP-wrapped CAN | ordinary CAN once unwrapped | DBC applies |
| DoIP/UDS, SD, gPTP | control plane | trace view only |

Decode statefulness ladder (each rung buys more coverage): UDP-only
static PDUs → +SD instance tracking → +SOME/IP-TP reassembly → +TCP
stream reassembly. Where v1 stops is an open question in the task doc.
