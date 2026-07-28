# Capture formats: pcap, pcapng, and friends

Research notes for [Task 39](../0039-ethernet-signals.md). Gathered
2026-07; verify library versions when the work starts.

## pcap vs pcapng

| Capability | classic pcap | pcapng |
| --- | --- | --- |
| Timestamps | 32-bit sec + 32-bit µs (ns variant via magic `0xA1B23C4D`); one resolution per file | 64-bit per packet; resolution **per interface** (`if_tsresol` IDB option, `0x09` = ns) |
| Interfaces | one per file, one linktype | many Interface Description Blocks; every packet names its interface; **each IDB can have a different linktype** |
| Metadata | none | extensible blocks: interface stats (drop counters), name resolution, Decryption Secrets Block (embedded TLS keys), vendor Custom Blocks, per-packet/per-block comments |
| Status | IETF draft, intended Historic | IETF draft (de-facto standard; Wireshark's default save format) |

Implications:

- **pcapng is the read/write target**; classic pcap read-only for
  interop. Multi-interface + per-IDB linktypes means one file holds
  CAN and Ethernet side by side on one timebase — the multi-bus
  container story.
- Reader must normalize timestamps **per IDB**, not per file.
- Custom Blocks and comments are the sanctioned in-file extension
  point for [ADR 0010](../../../docs/adr/0010-no-sidecar-files.md)
  (analogous to DBC `BA_` / BLF `GLOBAL_MARKER`).

## CAN inside pcap: LINKTYPE_CAN_SOCKETCAN (227)

Linux SocketCAN interfaces are network devices; tcpdump/Wireshark
capture them directly, so SocketCAN pcaps are a real interchange
format (Wireshark has a `socketcan` dissector; SavvyCAN has an open
import feature request). `candump -l` writes its own text `.log`, not
pcap — separate ecosystem.

Encoding (per tcpdump.org / `pcap/can_socketcan.h`):

- `can_id` — 4 bytes **big-endian** (unlike kernel-native SocketCAN,
  which is host-endian): low 29 bits = ID; flags `0x80000000` EFF,
  `0x40000000` RTR (classic only), `0x20000000` error frame.
- `payload_length` — 1 byte; `fd_flags` — 1 byte (`0x01` BRS, `0x02`
  ESI, `0x04` FDF); 2 reserved bytes; payload (0–8 classic, 0–64 FD).
- CAN XL has a distinct mixed-endianness layout (priority/VCID
  big-endian, length/acceptance little-endian; flag `0x80` XLF).
- Discrimination: 5th octet bit `0x80` → XL; else record length 72 or
  FDF bit → FD; else classic (length must be 8–16).
- **Trap:** pre-fix tools wrote host-endian `can_id`; Wireshark
  carries heuristics. Canonical files are big-endian.
- Related linktypes: `LINKTYPE_CAN20B` (190, obsolete),
  `LINKTYPE_LINUX_SLL` (113, `any`-device captures can wrap CAN).

## Capture-hardware encapsulations

- **TECMP** (Technica Engineering): capture modules wrap timestamped
  CAN/CAN-FD/LIN/FlexRay/Ethernet traffic in TECMP frames over
  Ethernet; Wireshark dissector in-tree since 3.4.
- **ASAM CMP**: the standardized successor (capture-module protocol,
  hardware timestamps, multi-bus); Wireshark ≥4.2.
- **PEAK PCAN-Ethernet Gateway**: proprietary CAN-in-UDP/TCP framing
  (4–8 frames per packet), documented, PEAK ships a Wireshark
  dissector.
- **AVTP / IEEE 1722 ACF-CAN**: L2 tunneling of CAN/CAN-FD (also LIN,
  FlexRay) in TSCF/NTSCF containers with gPTP timestamps; open
  reference implementation COVESA/Open1722.

All of these carry ordinary CAN frames — unwrap and the existing DBC
pipeline applies. Stage 1 covers SocketCAN (+ ACF-CAN if cheap);
TECMP/CMP/PEAK unwrappers are incremental follow-ups behind the same
import path.

## BLF's Ethernet story (for context)

BLF is itself a multi-bus container: bustypes CAN=1, LIN=5, FlexRay=7,
**Ethernet=11**; object types `ETHERNET_FRAME` (71, with channel,
direction, EtherType, VLAN), `ETHERNET_FRAME_EX` (HW checksum, error
flags), Ethernet error/status objects. Wireshark reads BLF directly
(wiretap, ~3.6+); Technica ships an open BLF→pcapng converter. Our BLF
reader currently skips these as `BlfObject::Other` — a documented
extension route once the model can carry Ethernet events.

## Rust crates

| Crate | Role | License | Status (2026-07) |
| --- | --- | --- | --- |
| `pcap-file` | pure-Rust read **and write**, pcap + pcapng | MIT | active (3.0.0-rc.2, 2026-05); ~13M downloads |
| `pcap-parser` (rusticata) | zero-copy nom parser, streaming reads | MIT/Apache-2.0 | active (0.17.0, 2025-07) |
| `pcap` | libpcap/Npcap bindings — **live capture** only | MIT/Apache-2.0 | active (2.4.0, 2025-11) |
| `pcap-file-gsg`, `pcaparse` | forks/niche | MIT | fallbacks |

Recommended split: `pcap-file` (or `pcap-parser` for huge-file
streaming) for files; the `pcap` crate only if live capture ever comes
in scope. Run evaluate-dependency before adopting; record in
`technology-inventory.md`.

Sources: [pcapng draft](https://datatracker.ietf.org/doc/draft-ietf-opsawg-pcapng/),
[pcapng.com](https://pcapng.com/),
[LINKTYPE_CAN_SOCKETCAN](https://www.tcpdump.org/linktypes/LINKTYPE_CAN_SOCKETCAN.html),
[linktype registry](https://www.tcpdump.org/linktypes.html),
[Wireshark BLF wiki](https://wiki.wireshark.org/BLF),
[COVESA/Open1722](https://github.com/COVESA/Open1722).
