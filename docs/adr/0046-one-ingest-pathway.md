# ADR 0046 — One ingest pathway

Status: accepted (2026-08-08)

## Context

Frames reach the model through exactly one seam,
`cannet_core::CanFrameSource`: a pull-based `next_frame()` that the
host's `run_pump` drains into `TraceStore::append`. Every producer wears
that seam — the BLF reader, the gRPC session adapter, the virtual-bus
loopback — and `run_pump` is the only thing that turns a `CanFrame` into
a stored frame. Bus routing, the replay session anchor, ingest-time
verification (ADR 0027) and the append itself all live in that one loop.

That the seam exists is written down ([ADR 0009](0009-dbc-blf-readers.md)
for the BLF adapter, [ADR 0021](0021-virtual-bus-server.md) for the
virtual bus, and the MDF plan assumes it absorbs a new format without
model changes). That there may only ever be **one** loop behind it is
not, and the pressure to add a second is real and recurring: a file
import knows its whole input up front, so a batched bulk-append that
skips the per-frame work looks like free speed. It was proposed
concretely against a 6.5-million-frame BLF import and rejected.

The same file-import path had also grown two whole-file pre-passes — a
capped channel census that decoded every frame to read one `u16`, and a
marker walk that decoded the file a second time before the pump started
— so a "one pathway" claim was true of the pump and false of the import
as a whole.

## Decision

**There is one ingest pathway. Every frame that enters the model enters
it through `CanFrameSource` → `run_pump` → `TraceStore::append`.**

Concretely:

- A new source implements `CanFrameSource` and nothing else. It does not
  get its own append loop, its own bulk-insert entry point, or its own
  variant of the routing / session-anchor / verification logic.
- **A file import is a source, not a mode.** It streams through the same
  pump a live session uses, at the same granularity, one frame at a
  time. "We know the whole input up front" is not a licence to fork.
- **An ingest optimization lands in the shared path.** If profiling names
  a per-frame cost, the cut is made where every source pays it. A cut
  that only a file import can benefit from is a design smell: it means
  the cost was accidental to ingest rather than essential to it.
- **A pass over the input is a resource, not a free action.** Anything a
  consumer needs from a file — its annotations, its channel census, its
  time span — is collected on a pass that is already happening, or on a
  pass that is *explicitly* justified. The BLF source's marker sink is
  the shape: markers ride the pump's own walk.
- One deliberate exception stands: the **pre-ingest census**
  (`cannet_blf::scan_blf`) reads the file before any frame is imported,
  because the channel → bus mapping it feeds is an input to the import,
  not an output of it. It is header-only — no per-type decode, no
  payload allocation — and it is the *only* sanctioned extra walk.

## Why

- **Two ingest paths means two sets of bugs, and only one gets
  exercised.** The live path runs constantly; a file-only path runs when
  someone opens a log. Session anchoring, the skip-channel rule,
  timestamps predating the session start, ingest-time verification, the
  retention overlay — each is a behaviour that would have to be
  reimplemented and would drift. Bugs would show up as "importing gives
  a different trace than recording the same bus", which is exactly the
  class of defect a capture tool cannot afford.
- **The fork would remove the pressure to make the shared path fast.**
  The per-frame budget a batched import would route around is paid by
  every live session, at every rate the hardware can deliver. Forcing
  imports through it keeps the cost measured, visible, and worth fixing
  — a file import is a repeatable, profileable benchmark of the live
  path, which is the hardest thing to get for a live path.
- **Speed was available without the fork.** Profiling the import at
  multi-million-frame scale put the BLF decode at a small fraction of
  the budget and the store's append at most of it; the two whole-file
  pre-passes were pure duplicate work. None of the wins needed a second
  pathway, and all of them help live capture too.
- **It keeps the seam honest for the next format.** MDF, and anything
  after it, is then a reader crate plus a `CanFrameSource` impl — the
  same review surface, with the hard parts already shared.

## Rejected alternatives

- **An import-specific batched append** (`append_many` over a chunk of
  decoded frames). Rejected: it duplicates the pump's per-frame
  semantics at a second granularity, and it optimizes the one case that
  is *not* latency-sensitive while leaving live capture as slow as it
  was.
- **A "bulk mode" flag on the shared path** that skips derived-state
  maintenance during an import and rebuilds it at the end. Rejected for
  the same reason in a smaller package: it is a second code path with a
  second set of invariants, and it makes a plot watching an import go
  blank — the opposite of what the import experience needs.
- **Keeping the decode-based channel pre-scan and simply raising its
  cap.** Rejected: the cap was the bug (a late channel was silently
  dropped from the mapping dialog), and decoding whole frames to read one
  field is work the census never needed.
- **Reading a file's markers from the pre-census walk instead of the
  pump's.** Tempting — the census sees them — but the census runs before
  the user has confirmed the mapping, and the import must be correct
  whether or not a census preceded it. The pump's own walk is the pass
  that always happens.

## Consequences

- `run_pump` is the single place where ingest behaviour changes, and any
  change to it is a change to every source at once — which is the point,
  and is why it warrants tests at the seam rather than per-source.
- Import throughput and live-capture throughput are the same number.
  Regressions in either show up in both, and the import benchmark
  (`bench_blf_import`) is the cheap way to see it.
- A source that has non-frame information to offer surfaces it through
  its own API (`BlfCanFrameSource::on_marker`, `scan_blf`), never by
  bypassing the pump.
- Trace-timing rules ([ADR 0024](0024-trace-like-view-timing.md)) hold
  for imported and live captures identically, because the session anchor
  is set in the one loop both use.
