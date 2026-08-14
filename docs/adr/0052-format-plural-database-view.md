# ADR 0052 — The Database view is format-plural, each format organized canonically

Status: accepted (2026-08-13)

## Context

The panel historically called the "DBC panel" was named for the one
signal-definition format it carried. MDF import brought a second kind
of signal-defining artifact (message-independent signal groups carried
inside a capture file), and more are expected — ARXML for automotive
Ethernet, EDS for CANopen. Each of these formats has its own canonical
way of organizing signals: DBC by ECU → message → signal; MDF by file →
channel group → signal; ARXML by its own packaging. The question is
whether the catalog surface normalizes them into one unified hierarchy
or presents each format on its own terms.

## Decision

1. **One catalog surface — the Database view** — is where every
   signal-defining artifact appears: DBC databases, capture-carried
   signal definitions (MDF), and future formats (ARXML, EDS, …). No
   per-format panels.
2. **Each format's branch is organized per that format's own canonical
   structure.** DBC: ECU → message → signal. MDF: source file →
   channel group → signal. A future ARXML lands organized however
   ARXML canonically organizes its signals. No normalization into a
   lowest-common-denominator hierarchy; recognizability to a user who
   knows the format beats uniformity across formats.
3. **Format ingestion, monitoring, and display remain first-class,
   format-accurate concerns.** Operations on a specific format name
   that format ("Add DBC…", DBC file-watch messages); only the
   panel-level surface is format-neutral ("Database").
4. **Lifecycle is per source kind, not unified.** A DBC reference is a
   project member. Capture-carried definitions (MDF signal groups)
   share the capture's lifecycle and are never persisted into the
   project. Future formats choose the lifecycle their usage implies.
5. **The Database view is the primary mechanism for choosing signals
   to add to other views**; drag-out carries a provenance-keyed signal
   reference so drop targets are format-agnostic. Copying signals
   between views remains supported.
6. **Formats end at the catalog boundary. In the model, a signal is
   one abstract entity.** Decoding, encoding, caching, and every
   consumer path (plot, grid, RBS, export) are format-agnostic;
   provenance rides in a signal's identity, never as behavioral
   branching in consumers. Format-specific knowledge lives in exactly
   two places: the ingestion parsers and the Database view's branch
   shape.

## Why

- **Recognizability.** A user who knows their format finds their
  signals arranged the way that format's own tooling arranges them; a
  normalized tree would be a third arrangement nobody knows.
- **Losslessness.** Normalization forces a lowest common denominator
  and drops format-specific structure (multiplexing groups, PDU
  packaging) that users navigate by.
- **Additive growth.** A new format lands as a new branch shape plus a
  provenance-keyed reference kind — no re-mapping of existing formats,
  no schema churn in drop targets.

## Rejected alternatives

- **A normalized unified hierarchy** across formats — lossy, and every
  new format renegotiates the common schema.
- **Per-format panels** — multiplies chrome, and cross-format
  workflows (drag a DBC signal and an MDF signal into one plot) would
  span windows.
- **Keeping the panel DBC-only and surfacing other formats elsewhere**
  — the discoverability failure that prompted this decision: MDF
  signals hidden in an add-signal picker were effectively invisible.
