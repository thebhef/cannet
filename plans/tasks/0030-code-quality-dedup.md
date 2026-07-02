# Task 30 — Code-Quality Debt: Deduplication & God-File Split

A standing-back quality probe of the codebase. First run 2026-06-28
(automated probe); **refined 2026-07-02 by a multi-agent audit** — 11
scoped reviewers (per-subsystem, duplication hunters, architecture)
each followed by an adversarial verifier that re-checked every claim
against the code. 81 findings survived verification, 0 were refuted;
verifier corrections are folded into the items below. The structure is
mostly healthy — the problems concentrate in a short tail of god-files
plus copy-pasted hot-path machinery.

This is **cleanup debt, not new behaviour**: every item lands under a
green test suite, with coverage added first where the area isn't
already exercised (CLAUDE.md § Test-driven development, § Refactors).
Slice it — don't try to land it all at once. Behavioural bugs found
during the audit went to `plans/backlog.md`, not here.

> **Line numbers verified 2026-07-02 at commit `67251de`.**
> Re-confirm each location before extracting; they will drift.

## The measured picture

LOC/file distribution (committed files, excluding `.d.ts` and gencode):

| | files | mean | p50 | p75 | p90 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rust | 83 | 529 | 303 | 551 | 1047 | 1484 | 5701 |
| TS/TSX | 123 | 241 | 113 | 236 | 466 | 826 | 3577 |

Medians are fine. The tail carries the complexity, and it has grown
since the June probe (`lib.rs` 5447→5701, `PlotPanel.tsx` 3543→3577).

## God-files worth splitting

Each entry now has a verified decomposition sketch. Split only where
the area is already test-covered; each region's tests move with it.

| LOC | File | Split into |
| --- | --- | --- |
| 5701 | `apps/gui/src-tauri/src/lib.rs` | see sketch below |
| 3577 | `apps/gui/src/PlotPanel.tsx` | see sketch below |
| 2650 | `crates/cannet-dbc/src/lib.rs` | parse / model / decode / encode / view-builders modules (tests are lines 1491–2650) |
| 2441 | `apps/gui/src/App.tsx` | see sketch below |
| 2158 | `apps/gui/src-tauri/src/trace_store.rs` | five separable concerns (impl 60–1302, tests 1304–2158): store facade, rate tracking, scratch breakdown, by-id, flush |
| 2093 | `apps/gui/src-tauri/src/rbs.rs` | directory split along its own section banners (43/257/655/1132): file model / runtime reconciliation / view shaping / 15 commands. Pure relocation — `generate_handler` tolerates re-exported commands; helpers stay `pub(super)` |
| 1642 | `apps/gui/src/TransmitPanel.tsx` | 13 components in one file — extract the row/editor subcomponents |
| 1603 | `apps/gui/src/ProjectPanel.tsx` | connection-management UI (lines 556–1603, two thirds of the file) → its own file |
| 1045 | `servers/cannet-python-can/.../server.py` | four modules: gRPC service / shared-interface + pumps / enumeration-watch / helpers |

**`lib.rs` sketch** (regions are self-contained, sharing only
`AppState` + decode helpers — mechanical, but land as several staged
commits): `capture.rs` (BLF open/save/scan, `raw_to_core_frame`),
`dbc_commands.rs`, `trace_query.rs` (paging, by-id sort,
`ActiveFilterIndex` machinery), `session.rs` (remote/vbus connect +
pump, `resolve_bus_route`), `transmit_commands.rs` (TX commands +
scheduler), `sampling.rs`, `emitters.rs`; notes commands fold into
`notes.rs`; `AppState` and the derived-state refreshers move to an
`app_state.rs` that submodules legitimately depend on (today rbs.rs,
project.rs, dbc_watcher.rs, crash.rs all reach *up* into `crate::`).
**Do not merge the three refreshers into one**: the subset selection is
deliberate (`invalidate_derived_caches` drops signal pyramids + the
on-disk filter index — reserved for rare DBC-set changes;
`rbs::refresh_all_elements` already chains the other two). lib.rs ends
at ~700 lines of wiring + `run()`.

**`PlotPanel.tsx` sketch**: `PlotArea` alone is ~1,670 lines mixing six
concerns, and the panel↔area interface has exploded — 46 props, a
21-field ref mirror, five epoch counters, six report callbacks. Fix
the interface first (group the props into a few cohesive objects /
contexts), then extract: uPlot lifecycle glue, cursor/marker layer,
signal-list sidebar, event-log rows, drag/drop handlers (drop-target
logic is itself duplicated between area surface and row,
3193–3215 vs 3398–3421). Extract a `plotSignalIdentity.ts` module
(identity + palette) that both PlotPanel and `plotFilter.ts` import —
kills the triplication under plotFilter's "keep in sync" comment (the
palette has *already* drifted; bug entry in backlog).

**`App.tsx` sketch**: one 2,250-line component owning eight subsystems.
Extract the `CommandsProvider` it was always supposed to delegate to
(the architecture reviewer confirmed it was never extracted), a
`useSessionReset` helper for the 5-step reset sequence repeated at
750–756, 849–859, 905–914, 1180–1184 (**keep the per-site error
policies — the differences are intentional**: clear continues on
failure, connect aborts, BLF-map aborts + drops the recent entry,
new-project fire-and-forgets), collapse the five bus-field setters
(1450–1476) into one `onUpdateBus(id, patch)` (the patch shape already
exists at `handleUpdateVirtualBus`), and the five `add*Panel` handlers
(1535–1599) into one `addPanel(kind)` over a kind→component registry
next to `DOCK_COMPONENTS` (App.tsx:174).

## Duplicate implementations to consolidate

### Rust — highest drift risk first

- **1. cannet-spill segment-chain machinery written 3–5×** —
   `IdPostings` (byid.rs) and `SampleSeq` (sample_seq.rs) share
   identical constants, body-identical `seg_capacity()`/`locate()`,
   near-identical push-grow, and a verbatim evict loop (with the same
   Windows unmap-before-delete comment, 5 copies); `FilterIndex` and
   `DiskRawStore` repeat the rebase/evict loop; three hand-rolled
   lower-bound searches (byid.rs:307, filter_index.rs:209,
   signal_cache.rs:283). → one segment-chain module parameterized by
   entry type **and eviction policy** (the policies deliberately
   differ — keep that explicit, don't flatten it).
- **2. CAN-ID extraction copy-pasted 5×** in
   `crates/cannet-blf/src/format/can.rs` (bit-31 test + 11/29-bit
   mask), plus `is_extended_id()`/`can_id()` duplicated on all five
   CAN structs. → one free fn / trait method; test that all callers
   agree.
- **3. BLF object-decode preamble ~11×** across can.rs / text.rs /
   diagnostics.rs / marker.rs: the same ~20-line
   parse-base→type-check→TooSmall/Truncated→parse-V1→body-slice
   skeleton, plus four near-identical error enums (MarkerError has one
   extra variant) and reader.rs's four wrapper variants + From impls.
   → a `decode_framed<T>` helper + one shared error shape.
- **4. DBC bit-walker decode/encode/calc** duplication
   (`cannet-dbc/src/{decode,encode,calc}.rs`) — from the June probe,
   *not re-verified by this audit*; re-confirm, then unify the walker
   under round-trip coverage. Highest correctness risk if real.
- **5. Frame/wire conversions in the wrong layer** —
   `frame_to_object_bytes` (cannet-blf/src/lib.rs:505–675) hand-builds
   wire structs in the adapter crate root, duplicating header knowledge
   the format layer owns; extended/standard `CanId` construction is
   copy-pasted at 8 sites in gui lib.rs. → move framing down, one
   `CanId` constructor helper.
- **6. `record_matches` fabricates a `RawTraceFrame`** (gui
   lib.rs:1556–1575: dummy timestamp/direction/payload, undocumented
   "predicate only touches id/bus/record" invariant) to reuse
   `FilterPredicate::matches`. → change the predicate input to the
   (id, bus, record) view both callers actually have. Fold
   `dbc_applies_to_frame` into filter.rs while there (June item,
   still open); diag.rs stats stay siloed — fine for now.
- **7. Persistence written twice-plus** — settings.rs and state.rs are
   the same JSON-config module twice; the atomic-write-via-temp helper
   lives in trace_store while settings re-implements it and
   project/RBS saves are **non-atomic**; the ADR-0011 schema-version
   gate is encoded twice (project.rs:246–260 vs RBS). → one
   persisted-JSON helper (atomic write + version gate) used by all
   four.
- **8. Session-registration skeleton duplicated** between
   `connect_remote_server` (lib.rs:2717–2897) and
   `connect_local_vbus` (2911–3050), including a redundant re-lock to
   re-read data just inserted. → shared registration fn; collapses
   naturally into the `session.rs` split.
- **9. bridge_client.rs re-implements cannet-client's session
   machinery** — real duplication (subscribe envelope, allocated-id
   wait, pumps, twin error types), **but** the consolidation is gated:
   cannet-client's `allocated_id` only works for `factory`
   subscriptions declared up front, and it waits indefinitely where
   bridge_client's `ALLOCATED_GRACE` timeout is a documented
   constraint (bridge_client.rs:43–48, ADR 0021). → first fix the
   stale module doc; consolidate only after cannet-client grows the
   timeout/dynamic-allocation capability.
- **10. `cannet-wire/src/batch.rs` has zero production consumers** while
    virtual_bus.rs:312–331 re-implements `proto_to_batch`'s semantics
    and all four production senders hand-roll one-frame batches; the
    lib.rs doc ("Application code never deals with batches directly")
    is false. → route senders through it or delete it and fix the doc.
- **11. trace_store internals** — `append()` triplicates the
    rate-sampling block and the aggregate tracker bypasses `RateTrack`
    (502–546, 271–289); three parallel `HashMap<FrameKey, _>` where one
    keyed struct belongs (312–323); the scratch-breakdown facade
    reverse-engineers other modules' private file naming (1189–1279 —
    have each module report its own disk usage instead).
12. Smaller confirmed items: `error_envelope` verbatim in both
    servers; SignalMux/FloatKind wire mapping duplicated in gui lib.rs
    (2430 vs 3970) *and again* inside cannet-dbc
    (`describe_message` vs `dbc_content`, lib.rs:399–413 vs 476–493 —
    note `SignalDescriptorRich` carries `start_value_raw` that
    `DbcSignalContent` lacks, so it's not a strict superset); calc
    override-layering spelled twice (lib.rs:3262 vs 3333); 23 bare
    `.lock().expect(...)` + four first-loaded-DBC-wins scans → small
    `AppState` accessors (`resolve_effective_calc`'s scan is
    bus-scoped — different decision, leave it).

### TypeScript — several double as thin-view wins

- **13. Signal catalog fetched independently in 3+ panels**
    (`list_signals` into local state in PlotPanel, TransmitPanel,
    ColorMapPanel). → lift to a context/provider. *(thin-view)*
- **14. Value-table fetch duplicated 4×** (`list_value_tables` in
    ColorMapPanel, PlotPanel, RbsPanel, TransmitPanel). → shared
    `useValueTables` hook. *(thin-view)*
- **15. Element-panel lifecycle boilerplate ×4 panels** —
    `elementIdFromParams`, savedConfig hydration, dual-write persist,
    `currentSources` kind-narrowing, `availableFilters`, and the
    GOTO_EVENT subscribe-once listener are copy-pasted across
    TracePanel/PlotPanel and inlined in TransmitPanel/RbsPanel
    (TracePanel.tsx:41–197 vs PlotPanel.tsx:428–490, 767–790). → a
    `useElementPanel` hook (+ `useElementSources` for the picker
    wiring).
- **16. TraceView ↔ ByIdTable near-clones** — `DecodedSignalCell` is a
    48-line *verbatim* copy (TraceView.tsx:560–613 =
    ByIdTable.tsx:255–302, under a comment admitting it); the
    rows/spacer/anchor derivation and ResizeObserver effect are
    identical. → share the cell component and the viewport scaffolding;
    note the scroll handlers genuinely differ (TraceView embeds
    auto-scroll suppression) — share the common core only.
- **17. Host-mirror pattern** (snapshot fetch + change-event refetch +
    500 ms poll-while-running) duplicated TransmitPanel:90–115 /
    RbsPanel:93–131 — and TransmitPanel is *missing* the
    post-listener refetch RbsPanel has (launch race; bug entry in
    backlog). → `useHostMirror` hook fixes both at once.
- **18. Dismiss-on-outside-click + Escape effect ×6** (traceTable,
    SourcesPicker, PlotPanel ×2, ProjectGraphPanel, RbsPanel). → one
    `useDismissableMenu` hook.
- **19. Set-toggle helper ×6** (twice verbatim in RbsPanel alone). → one
    util.
- **20. Formatting around `format.ts` instead of in it** —
    RbsPanel:567 is character-identical to `formatData`'s body (blocked
    only by its `TraceFrameRecord` parameter — add `formatBytes`);
    DbcPanel id-label template duplicated in-file (897 vs 953);
    TransmitPanel:1322 re-rolls `formatId`'s width rule. `busLookup()`
    rebuilt inline in PlotPanel/ColorMapPanel (June item, still open).
21. Smaller confirmed items: `buildSinkPredicate`/
    `resolveFilterPredicate` duplicate the sources→predicate
    composition; `recordRecentBlf`/`recordRecentCommand` are the same
    MRU-push twice; `decimatePoints` (plotData.ts:234–268) is a dead
    frontend re-implementation of host decimation — delete;
    commands.ts boot-time binding-conflict check enumerates a
    hand-copied context space that has already drifted — derive it
    from the keybindings data; vestigial `traceStartOffsetSeconds`
    threaded through the whole trace state machine (trace.ts, plus a
    dedicated App.tsx effect) feeding a field trace.ts:246–250 admits
    is unused — remove the thread and fix traceData.ts:33–36's stale
    doc.

### Python sidecar

- **22. `WatchInterfaces` dead re-publish apparatus** — `_watch_seq` is
    written exactly once, so the condition/re-yield loop can never
    fire a second snapshot, and the comments claiming
    `ListInterfaces` re-publishes are false (server.py:666–769). →
    delete the apparatus or actually wire `ListInterfaces` to publish;
    fix cannet.proto:17–21's drifted claim either way.
- **23. Error-broadcast triplicated in `_SharedInterface`**
    (server.py:352, 485, 523). → one `_broadcast_error`; **careful**:
    the reconfigure site fans out while *holding* the non-reentrant
    `self._lock` — the helper must not re-take it.
- **24. Frame kind as three independent bools** (driver.py:104–114) with
    the error>remote>fd priority ladder re-derived at each boundary —
    and `_proto_to_frame` silently maps UNSPECIFIED where the Rust
    side (convert.rs) errors. → a `FrameKind` enum at the seam.

### Architecture-level (deliberate follow-ups, not drive-by)

- **Host model trapped in the app crate**: `cannet-perf-measurement`
  depends on `cannet-gui` via documented `pub mod` escapes — a
  deliberate tradeoff, but trace_store / filter / signal_cache /
  signal_sampler are tauri-free and extractable into a host-model
  crate. Do it *after* the lib.rs split, if at all.
- **IPC contract drift**: 82 stringly-typed commands hand-mirrored
  between Rust and types.ts with no drift check, and types.ts's
  "kept in one place" premise has rotted. Covered by the backlog's
  `tauri-specta` CI item — evaluate that rather than hand-rolling.
- **Checked-in Python proto gencode** has no CI guard against drift
  from `cannet.proto` — added to backlog § CI.
- Task-step numbers (`6d`, `Step 3`) in 24 code comments across 7
  spill/host files violate the no-plan-refs rule — sweep them to ADR
  references or plain rationale in one commit.

## Suggested slicing

Each a standalone reviewable commit; order by risk-reduction:

1. Rust #2 (CAN-ID) — small, high drift-risk, easy test.
2. Rust #4 (bit-walkers) — re-verify, add round-trip coverage, unify.
3. Rust #1 (spill segment-chain) — the biggest single dedup; coverage
   exists, extraction is mechanical but large. Its own commit(s).
4. Rust #3 (BLF preamble), #5 (frame conversions), #7 (persistence
   helper — also fixes non-atomic saves).
5. TS #13/#14/#15 (catalog, value-tables, element-panel hook) —
   thin-view wins; do under DOM-test coverage.
6. TS #16–#20 (shared cell/viewport, host-mirror, menus, format
   helpers) — batch as a few commits; #17 also closes the launch race.
7. God-file splits — lib.rs first (unlocks the architecture items),
   then PlotPanel.tsx, then the rest opportunistically.
8. Python #22–#24 + server.py split.
9. Everything in #12/#21 as trailing small commits.

## Exit criteria

- Each item above is either consolidated/split **or** explicitly
  deferred with a one-line reason in this file (don't silently drop
  items).
- New shared helpers/modules have tests; existing behaviour stays
  green before and after each refactor. Verifier caveats embedded
  above (refresher subsets, error policies, eviction policies,
  bridge-client timeout) are honoured — they are behaviour.
- No new sidecar/thin-view violations; items #13–#15 leave the
  frontend strictly thinner than before.
- Plan-reference comments (the `6d`/`Step 3` sweep) are gone from
  non-plan source.
- This file and the roadmap are updated as items land (CLAUDE.md
  § Planning) — completed items struck through or removed, deferrals
  annotated.
