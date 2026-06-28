# Task 30 — Code-Quality Debt: Deduplication & God-File Split

A standing-back quality probe of the ~120k-line codebase (run
2026-06-28, after a long hands-off stretch). The structure is mostly
healthy — both languages have a reasonable median file size and the
problems are concentrated in a short tail of outliers plus a handful
of copy-pasted hot-path implementations. This task collects those
findings so they can be paid down in small, reviewable steps rather
than a single sweep.

This is **cleanup debt, not new behaviour**: every item below is a
refactor that must land under a green test suite, with coverage added
first where the area isn't already exercised (CLAUDE.md § Test-driven
development, § Refactors). Slice it — don't try to land it all at
once.

> **Line numbers below are best-effort from an automated probe.**
> Re-confirm each location before extracting; some may have drifted.

## The measured picture

LOC/file distribution (committed files, excluding `.d.ts`):

| | files | mean | p50 | p75 | p90 | p95 | p99 | max |
|--|------|------|-----|-----|-----|-----|-----|-----|
| Rust  | 83  | 507 | 301 | 531 | 937 | 1269 | 2650 | 5447 |
| TS/TSX | 112 | 251 | 120 | 237 | 389 |  826 | 1642 | 3543 |

Medians are fine. The concern is the tail: ~6 outliers per language
carry disproportionate complexity, and the TS p90→max jump (389→3543)
is sharper than Rust's, i.e. frontend complexity is concentrated in a
few god-components.

### God-files worth splitting

| LOC | File |
|----|------|
| 5447 | `apps/gui/src-tauri/src/lib.rs` |
| 3543 | `apps/gui/src/PlotPanel.tsx` |
| 2650 | `crates/cannet-dbc/src/lib.rs` |
| 2446 | `apps/gui/src/App.tsx` |
| 2093 | `apps/gui/src-tauri/src/rbs.rs` |
| 1642 | `apps/gui/src/TransmitPanel.tsx` |
| 1603 | `apps/gui/src/ProjectPanel.tsx` |

`lib.rs` (the Tauri command surface) and `PlotPanel.tsx` are >10× their
language medians and are the two highest-value split candidates. A
split here is mechanical (move cohesive groups into sibling modules /
sub-components) and should be done only when its own area is already
test-covered.

## Duplicate implementations to consolidate

### Rust — highest drift risk first

These are low-level numeric paths where one bugfix + stale copies =
silent decode corruption. Prioritise over the cosmetic TS dups.

1. **CAN-ID extraction copy-pasted 5×** in
   `crates/cannet-blf/src/format/can.rs` (CanMessage, CanMessage2,
   CanFdMessage, CanFdMessage64, CanErrorExt) — identical bit-31
   extended-flag test + 11/29-bit mask. → one free fn / trait method in
   `cannet-core` (or the `can` module); add a test asserting all callers
   agree.
2. **DBC bit-walker decode/encode logic** duplicated across
   `crates/cannet-dbc/src/{decode.rs,encode.rs,calc.rs}` — the subtle
   little/big-endian byte-idx/bit-in-byte math, three times. Highest
   *correctness* risk; unify the walker, keep decode/encode/calc as thin
   callers.
3. **CAN decoder/encoder boilerplate** — 4 near-identical
   parse-header→validate-size→extract-body skeletons in `can.rs`. →
   a `decode_can_object_frame<T>` helper or a small macro.
4. **Frame conversions** scattered across `crates/cannet-spill/src/lib.rs`,
   `apps/gui/src-tauri/src/lib.rs` (`raw_to_core_frame`), and
   `crates/cannet-blf/src/lib.rs` with slightly different field/error
   handling. → centralise the `CanFrame ↔ RawTraceFrame ↔ wire` mapping.
5. **Stats + filter-match** — descriptive stats (mean/max/percentile/
   slope) are siloed in `apps/gui/src-tauri/src/diag.rs`; frame
   id/bus predicate matching is split between
   `apps/gui/src-tauri/src/filter.rs` (`TaggedPredicate::matches`) and
   `lib.rs` (`dbc_applies_to_frame`). Fold the latter into the former.

### TypeScript — several double as thin-view violations

The fetch dups break the documented thin-view rule (CLAUDE.md § GUI
architecture: "domain computation belongs in the model"), so fixing
them pays twice.

6. **Signal catalog fetched independently in 3+ panels** — PlotPanel,
   TransmitPanel, ColorMapPanel each `invoke("list_signals")` into local
   state, each must re-fetch on DBC change. → lift catalog + refresh to
   an `App.tsx` context/provider. *(thin-view violation)*
7. **Value-table fetch duplicated 4×** — ColorMapPanel, PlotPanel,
   RbsPanel, TransmitPanel each `invoke("list_value_tables")` with
   their own setState. → a shared `useValueTable` hook / cached context.
   *(thin-view violation)*
8. **Hex byte / CAN-ID formatting reimplemented inline** in RbsPanel and
   TransmitPanel instead of reusing the `format.ts` helpers
   (`formatData`, `formatId`). → export `formatByte` / a CAN-id value
   formatter and call them.
9. **Bus-id→name `Map` rebuilt 3×** — PlotPanel and ColorMapPanel inline
   a `useMemo` instead of the shared `busLookup()` in
   `traceColumns.ts`. → call the shared helper.
10. **500 ms polling-interval effect copy-pasted** in RbsPanel and
    TransmitPanel (`setInterval` while anything is running). → a
    `usePollingRefresh(enabled, fn, ms)` hook.

Lower-value TS notes (record, don't necessarily act): resample-loop vs.
`useWindowedQuery` throttle overlap, color-resolver derived twice, and
scattered `*FromParams`/`*FromRaw` state-deser helpers.

## Suggested slicing

Each a standalone reviewable commit; order by risk-reduction:

1. Rust #1 (CAN-ID) — small, high drift-risk, easy test.
2. Rust #2 (bit-walkers) — add round-trip coverage first, then unify.
3. Rust #3/#4 (decoder boilerplate, frame conversions).
4. TS #6/#7 (catalog + value-table → context/hooks) — also closes a
   thin-view drift; do under DOM-test coverage.
5. TS #8/#9/#10 (format helpers, busLookup, polling hook) — cosmetic,
   batch as one or two commits.
6. God-file splits (`lib.rs`, `PlotPanel.tsx`) — only where the area is
   already covered; mechanical module/component extraction, no behaviour
   change.

## Exit criteria

- Each duplicate above is either consolidated to a single
  implementation **or** explicitly deferred with a one-line reason in
  this file (don't silently drop items).
- New shared helpers/modules have tests; existing behaviour stays green
  before and after each refactor.
- No new sidecar/thin-view violations introduced; items #6/#7 leave the
  frontend strictly thinner than before.
- This file and the roadmap are updated as items land (CLAUDE.md
  § Planning) — completed items struck through or removed, deferrals
  annotated.
