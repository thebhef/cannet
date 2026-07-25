# Description formats: there is no open "Ethernet DBC"

Research notes for [Task 39](../0039-ethernet-signals.md). Gathered
2026-07; verify library status when the work starts.

No DBC-equivalent lightweight open exchange format exists for
automotive Ethernet. Industry exchanges are **ARXML** (dominant) or
**FIBEX 4** (BMW sphere); everything else (Wireshark UAT configs,
vsomeip JSON, Franca fidl/fdepl) is generated *from* those, never
exchanged as the master.

## ARXML (AUTOSAR XML)

- Spec PDFs and XSDs freely downloadable from autosar.org. The AUTOSAR
  exploitation license concerns building conformant ECU stacks, not
  parsing files — MIT/BSD open-source parsers exist without issue.
- Communication lives in the **System Template** (`SYSTEM` with
  `FIBEX-ELEMENTS`: `I-SIGNAL`, `I-SIGNAL-I-PDU`, frames,
  `EthernetCluster`/`EthernetPhysicalChannel`, SoAd socket
  connections) and, for Adaptive/SOME-IP, the **Manifest**
  (`ServiceInterface` + `SomeipServiceInterfaceDeployment`: service /
  method / event / field IDs, serialization props). OEM "SOME/IP
  matrix" handoffs are ARXML files containing exactly these elements.
- ~22 revisions of AUTOSAR 4.x; one XSD per release; unified schema
  lineage since AUTOSAR_00042.

## FIBEX (ASAM MCD-2 NET)

- Latest 4.1.2 (2017) — active but frozen; SOME/IP service elements
  since 4.1. Spec is member-only/purchase (unlike AUTOSAR).
- Still canonical for FlexRay, and **BMW's SOME/IP toolchain exports
  FIBEX 4** — which is why the best open SOME/IP tooling is
  FIBEX-based (FibexConverter, afibex).

## Library ecosystem

| Library | Lang | License | Status (2026-07) | Notes |
| --- | --- | --- | --- | --- |
| `autosar-data` (DanielT) | Rust | MIT/Apache-2.0 | active (0.22.0, 2026-06) | read/modify/write ARXML, all 4.x revisions; element-level DOM-with-schema; de-facto standard; Python bindings exist |
| `autosar-data-abstraction` | Rust | MIT/Apache-2.0 | active (0.11.1, 2026-06) | domain view: CAN, Ethernet, PDUs, ISignals, VLANs, **SOME/IP**, E2E; no LIN/J1939; escape hatch to raw elements. Best Rust starting point for a comm matrix |
| `afibex` + `asomeip` (mbehr1) | Rust | MIT/Apache-2.0 | small, alive | FIBEX 4 parse + **working SOME/IP payload decode** (used by the adlt/DLT-Logs ecosystem) — closest existing "decode SOME/IP from a matrix file in Rust" |
| `canmatrix` | Python | BSD-2 | maintained | ARXML support CAN-focused, "very basic"; no SOME/IP (issue #283 closed unimplemented) |
| `autosar` (cogu) | Python | MIT | active | ARXML *generation* for SWCs; not a comm-matrix tool |

## How open tools consume matrix files (prior art for the decode seam)

- **Wireshark**: SOME/IP + Signal-PDU dissectors are configured by UAT
  tables (service/method names, parameter layout, signal lists with
  position/type/scaling/value-names, per-transport binding tables) —
  populated not by hand but by generators.
  **FibexConverter** (Lars Völker) converts FIBEX 4 → Wireshark
  configs; there is no equivalent open ARXML converter.
- **Wireshark's `signalpdu` dissector is the existence proof** for
  "one signal database, many transports": DBC-style bit extraction
  (endianness, scale+offset, value tables, multiplexing) bound to
  CAN, FlexRay, LIN, SOME/IP, PDU-Transport, I-PduM via binding
  tables. Its UAT schema is effectively a portable "Ethernet DBC"
  data model worth studying for our decoder-seam design.
- **vsomeip (COVESA)**: hand-written JSON deployment config + Franca
  IDL for interface shape — deliberately not ARXML; commercial tools
  convert.

## Open question (mirrored in the task doc)

ARXML-first (industry master; `autosar-data-abstraction` is active
and SOME/IP-aware but we'd write the payload-decode layer) vs
FIBEX-first (`afibex`/`asomeip` already decode end-to-end, but FIBEX
is the narrower ecosystem and the spec is paywalled). Both are
MIT/Apache — run evaluate-dependency with real OEM/BMW-style fixtures
when stage 4 becomes current.
