# Task 64 — MDF (MF4) Capture Export

Opened 2026-08-11 by owner ruling; sequenced after the
production-server tasks (41–43), directly behind
[Task 38](0038-mdf-import.md)'s import so MDF **round-trips**: a
capture read in can be written back out. Captured, not yet groomed —
needs a grooming pass before implementation.

Export a capture to ASAM MDF 4.x. Why MDF (from Task 38's notes,
where export was parked as
"later"): vendor-neutral and read by every major toolchain, and
better equipped than BLF for
[ADR 0010](../../docs/adr/0010-no-sidecar-files.md) — AT attachment
blocks are a sanctioned in-file embedding mechanism (DBC-in-logfile
is standard practice from 4.10), and MD blocks carry custom XML.

## Model gap: message-independent signals

Example MDF data is available from a user (kept out of the repo, like
all user-provided example data) that includes **message-independent
signals** — MDF records signal channels directly in a channel group,
with no bus message carrying them. Our model has no such concept yet:
every signal hangs off a DBC message. It should by the time the MDF
support (this task plus Task 38 import) is done.

## Grooming (open)

- Library: fold write support into Task 38's evaluate-dependency pass
  (one library for read + write, or two?).
- What is exported: raw frames (bus-logging shape), decoded signals
  (signal shape), or both — and where message-independent signals fit.
- Where message-independent signals live in the model, and which
  views serve them.
- Relationship to the existing BLF save flow (`save_capture`):
  shared command surface, format picker, or parallel command?
- Round-trip fidelity: what must survive import → export unchanged
  (timestamps, bus mapping, markers, message-independent signals)?

## Exit criteria

To be defined in grooming.
