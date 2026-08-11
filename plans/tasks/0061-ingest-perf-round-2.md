# Task 61 — Ingest Perf Round 2

Opened by owner ruling 2026-08-09 from the two largest data-named
items in task 58's ingest profiling (measurements recorded in
0058-ingest-and-rebuild-at-scale.md § Status log, phase 58.A). Both
were out of task 58's scope; both are now one task so the store
change and the string change land against the same benchmark.

## Items

### 1. Disk-spill segment write

At 6.5 M synthetic frames (release), the disk-spill raw-store write
is 0.64 µs/frame — 43 % of the shared per-frame ingest budget, larger
than the whole BLF decode. The cost lives in ADR 0002's store
(`cannet-spill`: payload placement, meta encode, by-id posting, ring
push/pop), so cutting it is a raw-store change, profiled first (the
58.A harness `bench_blf_import` is the instrument — extend, don't
replace).

### 2. `bus_id: Option<String>` interning

Carrying a logical bus id costs 0.22–0.23 µs/frame (~15 %): the
routing clone, the `FrameKey` clone and hash, the retention clone,
and the disk store's bus intern. An `Arc<str>`, or interning the bus
in the trace store the way `DiskRawStore` already interns it, removes
the per-frame allocations. ~297 `bus_id` references across
`cannet-spill`, `cannet-gui`, and the serialized derived state — its
own slice, not a drive-by.

## Non-goals

- No import-specific pathway (ADR 0046 stands).
- No decode-width change: decoding every signal of a message once is
  deliberate (owner, 2026-08-09) — the signals are panel-ready
  instead of waiting twice for the same load.

## Exit criteria

- Both cuts profiled before/after on `bench_blf_import` at the
  multi-million-frame scale, attributions recorded; the shared-path
  per-frame budget improves by an amount consistent with the two
  attributions.
- Live-session behavior unchanged (the shared path serves both; ADR
  0046).
- ADR-0031 gate green (multi-run) at completion.
