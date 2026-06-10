# ADR 0001 — Captures are indefinite-length; the raw store is random-access and disk-spilled

Status: accepted (2026-05-20)

## Context

cannet targets multi-hour to multi-day capture sessions — 10^7 to 10^9
CAN frames. Indefinite capture length is a hard product requirement,
and every historical row must stay addressable for the life of the
capture: the user can scroll the trace, change a filter, or plot any
point in the whole history at any time.

The host trace store is currently `Vec<RawTraceFrame>`
(`apps/gui/src-tauri/src/trace_store.rs`) — entirely RAM-resident. At
10^9 frames that is tens of gigabytes; it cannot stay in memory.

## Decision

The raw frame store is the single source of truth for a capture. It
**spills to disk** as a **random-access indexed** store: a frame index
maps to a file offset, so any row N is O(1) to fetch regardless of how
long ago it was captured. A bounded hot window stays in RAM; older
frames live on disk and are paged back on demand.

No historical frame is ever evicted, overwritten, or made unreachable.
Derived projections (decoded-signal cache, by-id snapshot, per-signal
min/max latch) are bounded and rebuildable from the raw store; they
are not part of this source-of-truth guarantee.

## Alternatives considered

- **Ring buffer with eviction.** Keep the last N frames, overwrite the
  oldest. Rejected: it makes old rows unreachable, which violates the
  "any historical row addressable" requirement — a user cannot scroll
  or plot past the ring's horizon.
- **Bounded scrollback.** Keep a large but fixed cap; refuse to grow
  past it. Rejected: it makes capture length bounded, contradicting
  the indefinite-length requirement; the user would have to stop and
  restart a capture to keep recording.
- **Append-only disk file without a random-access index.** Cheaper to
  write, but answering "give me row N" means a scan. Rejected: random
  access to any row is required for scrolling, filtering, and plotting
  deep history.

## Consequences

- The host accessor contract — `RowPage` and `DecimatedRange`, see
  [`../../plans/windowed-model-convergence.md`](../../plans/windowed-model-convergence.md)
  — must be async and paged, and must never assume the capture fits in
  RAM. The contract is the same whether the underlying store is
  RAM-only or disk-spilled.
- The filtered-trace scan and the decoded-signal cache cannot stay
  O(capture) or unbounded when the capture exceeds RAM. A filter
  index and a decimated decoded-sample tier are the required perf
  work; both are decided in
  [`0002-disk-spill-store.md`](0002-disk-spill-store.md).
- Frontend views must page and never hold the whole capture — the
  thin-views-over-paged-model contract of
  [ADR 0003](0003-tauri-shell-react-frontend.md).
- The on-disk format, the index structure, the hot-window eviction
  policy, and the decimated tiers are out of scope for this ADR — it
  fixes only that the store is random-access and loss-free. Those
  decisions are made in
  [`0002-disk-spill-store.md`](0002-disk-spill-store.md).
