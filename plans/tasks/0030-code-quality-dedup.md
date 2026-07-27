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
| ~~5701~~ | ~~`apps/gui/src-tauri/src/lib.rs`~~ | **Done — see sketch below** |
| ~~3857~~ | ~~`apps/gui/src/PlotPanel.tsx`~~ | **Done — see sketch below** |
| ~~2650~~ | ~~`crates/cannet-dbc/src/lib.rs`~~ | **Done — see sketch below** |
| ~~2441~~ | ~~`apps/gui/src/App.tsx`~~ | **Done — see sketch below** |
| ~~2158~~ | ~~`apps/gui/src-tauri/src/trace_store.rs`~~ | **Done — see sketch below** |
| ~~2093~~ | ~~`apps/gui/src-tauri/src/rbs.rs`~~ | **Done — see sketch below** |
| ~~1642~~ | ~~`apps/gui/src/TransmitPanel.tsx`~~ | **Done — see sketch below** |
| ~~1603~~ | ~~`apps/gui/src/ProjectPanel.tsx`~~ | **Done — see sketch below** |

The god-files table is now fully addressed — every row above is done.
| ~~1045~~ | ~~`servers/cannet-python-can/.../server.py`~~ | **Done — see below** |

**`server.py` split done (task-0030/19-python-server-split).** The
1,045-line `server.py` became a `server/` package (thin `__init__.py`
facade re-exporting the public + test-driven surface, so
`from cannet_python_can import server` is unchanged). Landed as staged
commits after the three dedup items above, each green (ruff/mypy/pytest
via the pre-commit hook): the package conversion (`7e2c97f`), then one
commit per extracted module — `helpers.py` (`987b8e5`; conversions,
envelope builders, driver resolution), `shared_interface.py` (`99de326`;
`_SharedInterface` + `_InterfaceRegistry` + the rx/pack/state/tx pumps and
their constants), `enumeration.py` (`92d0e85`; `enumerate_interfaces` +
`watch_interfaces` + `_WATCH_LIVENESS_RECHECK_S`, which the servicer now
delegates to), and `service.py` (`3a665c8`; `CannetServerService` + the
`serve`/bind bootstrap). Pure relocation; behavior preserved. **Deviation
from the doc's flat "four modules":** it's a package (`__init__` facade +
four submodules), matching the Rust splits' `mod.rs`-plus-submodules
precedent, because the public entry point is `from cannet_python_can
import server` and the tests reach private names (`_SharedInterface`,
`_proto_to_frame`, `_split_address`, …) through it — the facade re-exports
those so no test moved. Enumeration-watch is a genuine seam but its two
RPCs stay servicer methods (gRPC dispatches them); they delegate to the
free functions in `enumeration.py`. Final: `__init__.py` (45) /
`helpers.py` (152) / `enumeration.py` (76) / `service.py` (347) /
`shared_interface.py` (644).

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

**Done (task-0030/11-split-lib-rs).** Landed as staged commits, one per
region, each green (`cargo test`/`clippy -p cannet-gui` + the workspace
pre-commit hook): `app_state.rs` (AppState + `LoadedDbc` + the three
refreshers, kept distinct as directed), `capture.rs` (BLF open/save/scan
+ `raw_to_core_frame` + the scratch clear/restore/restamp lifecycle),
`dbc_commands.rs` (DBC commands + the `decode_against`/`decode_raw_frame`/
`signal_to_wire` decode helpers), `trace_query.rs` (paging, by-id sort,
`ActiveFilterIndex` + candidate machinery), `session.rs` (remote/vbus
connect + pump + `resolve_bus_route`, with dedup #8), `transmit_commands.rs`
(TX commands + scheduler), `sampling.rs`, and `emitters.rs` (the
`trace-grew`/flush timers + the System Messages surface, with
`emit_system_log` re-exported at the crate root so the `sys_*` macros'
`$crate::emit_system_log` is unchanged). Notes commands folded into
`notes.rs`; the local-virtual-bus commands folded into `local_buses.rs`
(sketch didn't place them — the registry they drive is the honest home).
The upward-reach fix covered the four modules named plus `diag` and
`verification`, which also reached into the crate root for `AppState` /
`LoadedDbc`. **Deviation:** the ~1,900-line `#[cfg(test)] mod tests` was
relocated wholesale to a sibling `tests.rs` rather than split per module —
it shares helpers (`test_state`/`loaded`/`tiny_dbc`/…) across the now-many
modules and holds string literals with braces (JSON in `calc_spec_serde`)
that defeat mechanical brace-split, so keeping it one cohesive module
(resolving via `use super::*`) was the safe move; per-module test
co-location is a clean follow-up. Production `lib.rs` is now ~540 lines
(module wiring + `run()`), so the ~700 target is met.

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

**Done (task-0030/12-split-plotpanel).** PlotPanel.tsx: **3,857 → 1,456
lines**. The file had grown and been re-factored well past the
2026-07-02 sketch, so this was reconciled against the current code
(CLAUDE.md § "completing the plan as documented" — divergence noted here
before diverging). Landed as staged commits, each green
(`pnpm test` + `build`):

- `plotPanelConfig.ts` (278) — the shared, uPlot-free config model
  (`SignalRef`, `PlotAreaConfig`, `NoteEvent`, `XSync`, `CursorMode`,
  `PlotPanelParams`, `PlotAreaReports`) + the parse/migration/format
  helpers, with `plotPanelConfig.test.ts` (20 tests) for the previously
  untested `areasFromParams` migration / clamp / formatter helpers.
- **Interface cleanup** — the six `onReport*` callbacks collapsed into
  one `reports: PlotAreaReports` object (panel↔area prop + `liveRef`
  both shrink by five). The three x/y/fit **epoch counters and the
  cursor read values were left individual on purpose**: the epochs carry
  distinct trigger semantics, and the cursor values feed fine-grained
  effect dependency arrays a recreated object prop would churn (§ "keep
  the per-site differences").
- `PlotArea.tsx` (2,127) — the whole `PlotArea` component + its
  `PlotAreaProps`, `drawEnumTiles`, `SignalSwatch`, and area-only render
  helpers, at the natural component seam.
- **Drag/drop consolidation** — the drop-target duplication (area
  surface vs. signal row) folded into two shared `signalDragOver` /
  `signalDrop` functions parameterised by `beforeKey` + `stopEvent`.
- `PlotMeasurements.tsx` (120) — `MeasCell`, the toolbar
  `MeasurementMenu`, and the bottom `PlotMeasurementStrip`.

**Deviations from the sketch (reconciled against current code):**

- The `plotSignalIdentity.ts` extraction and the palette-drift bug were
  **already resolved** by prior work: the palette lives in `palette.ts`
  (ADR 0026), signal identity (`signalKey`) in `plotData.ts`, and
  `plotFilter.ts` was renamed to `signalSelection.ts` (ADR 0038) and
  already imports the shared palette. There is no triplication, no
  "keep in sync" comment, and no palette-drift backlog entry left to
  fix. Only a stale `./plotFilter` source comment remained — corrected.
  This step folded the last duplication in that family by having
  `signalSelection.ts` import the canonical `SignalRef` instead of its
  own structurally-identical `FilterSignalRef`, and `plotAxisDerivation.ts`
  import `signalRefKey` from `plotPanelConfig` instead of duplicating it.
- **"event-log rows" no longer exist in PlotPanel** — note/event
  management moved to the dedicated `EventsPanel` (ADR 0035); the panel
  only draws event vlines in the area draw hook. Nothing to extract.
- The **cursor/marker draw layer was deliberately not split** into its
  own module (§ "extract what's genuinely separable"): uPlot installs
  its hooks at construction time and the `draw` hook closes over
  construction-time locals (enum/lane colour targets, the value-table
  ref), so a separate module would be a bad seam, not a clean one. It
  stays inline in `PlotArea.tsx`'s construction effect. For the same
  reason the "uPlot lifecycle glue" and "signal-list sidebar" stayed
  within `PlotArea.tsx` rather than each becoming its own file — the
  sidebar's per-row value readouts are tightly coupled to the resample
  refs, so a child component would carry a ~20-prop surface for no
  readability gain. The honest split is at the panel↔area seam, which is
  what landed.

**`cannet-dbc/src/lib.rs` sketch** (reconciled against the current
code): the sketch's `decode.rs` / `encode.rs` **already existed** as
sibling files holding the *bit-level* primitives (`decode_signal_bits` /
`sign_extend`, `encode_signal_bits`) — item #4's `bitwalk.rs` work lives
alongside them — and `calc.rs` already held the calculated-field engine.
So lib.rs (drifted to **2,860** lines, of which lines 1578–2860 were the
test module) actually held: DBC parsing, the in-memory model types, the
message-level decode/encode walks and their result types, the descriptor
view-builders, and the calc *query* methods.

**Done (task-0030/13-split-cannet-dbc).** Landed as staged commits, each
green (`cargo test`/`clippy -p cannet-dbc` + the workspace pre-commit
hook). Production `lib.rs` is now **31 lines** (module wiring + the
public re-exports):

- `model.rs` (179) — the indexed `Database`, the private
  `MessageEntry`/`SignalEntry` (widened to `pub(crate)` so the now-sibling
  modules keep field access), the `ValueTableEntry`/`DbcAttribute` value
  types, `is_enum`, the trivial `message_count`/`has_multiplexor`
  accessors, and the shared `message_id_parts`/`canid_to_message_id`
  id-mapping helpers.
- `parse.rs` (434) — `Database::parse`/`parse_warnings`, `DbcError`, and
  every parse-only helper (long-symbol resolution, comment/attribute
  bucketing, FD/BRS/cycle-time/send-type reads, start values,
  `CannetCounter`/`CannetCrc` interpretation, `multiplexor_index`).
- `view_builders.rs` (540) — `message_names`/`signal_names`/`signals`/
  `value_table_for_signal`/`describe_message`/`dbc_content`, their
  descriptor types (`SignalDescriptor`, `MessageDescriptor`,
  `SignalDescriptorRich`, `DbcMessageContent`, `DbcSignalContent`,
  `ByteOrder`, `SignalMux`, `FloatKind`), and `numeric_to_f64`. Per the
  task's ground rule, `describe_message` and `dbc_content` were relocated
  **as-is** — their documented non-superset relationship
  (`SignalDescriptorRich.start_value_raw` vs. `DbcSignalContent`) is left
  intact; that consolidation is item #12, not this split.
- **decode / encode into the existing sibling files** rather than new
  modules: the message-level decode walk + `DecodedMessage`/
  `DecodedSignal` folded into `decode.rs` (158→323), the encode walk +
  `EncodeReport`/`EncodedSignal`/`SkippedSignal`/`SkipReason` into
  `encode.rs` (144→378) — each now next to the bit-level primitive it
  already called.
- **calc query methods into the existing `calc.rs`** (1250→1302):
  `dbc_calculated_fields`, `calculated_field_messages`, and
  `resolve_calculated_fields` became an `impl Database` block beside the
  `resolve` free function the last one wraps; `calc.rs` now imports its
  model types straight from `crate::model` (no crate-root re-export hop).
- **Tests relocated wholesale** to a sibling `tests.rs` (1292) rather
  than split per module — one shared sample DBC + helper set across the
  now-many modules, resolved via `use super::*`, exactly as the gui
  split (task 11) handled its own test module. Its dedicated `#[test]`s
  in `decode.rs`/`encode.rs` (bit-level) stay put.

**Caveats.** (1) `parse` and `model` split cleanly — DBC's
grammar→struct mapping is not entangled; the only mechanical cost was
widening the model structs/fields from crate-root-private to
`pub(crate)`. (2) The split surfaced a **pre-existing misfiled rustdoc**:
`encode_frame`'s whole prose block was physically attached to
`calculated_field_messages` (which had only its four trailing lines of
its own), and `encode_frame` had none. Since the two methods now live in
different modules (encode.rs vs calc.rs), the block was split to its
correct owners — no documentation text lost. A stray leftover doc line
that briefly orphaned onto `decode_message` during the view-builders
step was also dropped.

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

**Done (task-0030/14-split-app-tsx).** App.tsx: **3,000 → 2,437 lines**.
Landed as four staged commits, each green (`pnpm test` — 770 tests — +
`build`). All four sub-tasks completed as sketched:

- **`addPanel(kind)`** (commit `11d3eda`) — the six `add*Panel` handlers
  collapsed into one `addPanel(kind)` over a kind→component registry.
- **`onUpdateBus(id, patch)`** (commit `5f434fd`) — the five bus-field
  setters collapsed into one patch-shaped updater.
- **`useSessionReset`** (commit `53e1111`) — the 5-step session
  (re)start sequence extracted to a shared helper, with each call site
  keeping its own clear-error policy (the differences are intentional:
  clear continues, connect/BLF-map abort, new-project fire-and-forgets).
- **`useCommands`** (commit `18b24a6`) — the command/hotkey/palette
  subsystem (ADR 0018) extracted to the provider App was always meant to
  delegate to: effective-binding resolution + persistence, the global
  keydown dispatcher, the command registry, the singleton view-show
  helpers, the command context, and the three palette modals (~340
  lines, the biggest single chunk — new `useCommands.tsx` is 626 lines).
  App keeps the dockview layout lifecycle and the app-domain command
  implementations, passing the latter in as `appCommands`. An in-progress
  extraction left by an interrupted session was sound and was finished
  (old inline block removed, providers/palettes rewired to the hook's
  return values, dead imports swept) rather than redone.

**`trace_store.rs` sketch** (the file had drifted to **2,637** lines by
the time of the split, impl 60–1567 + tests 1568–2637): five separable
concerns — store facade, rate tracking, scratch breakdown, by-id, flush.

**Done (task-0030/15-split-trace-store).** `trace_store.rs` became a
directory module `trace_store/` (a directory split, not flat siblings,
because the concerns all touch `Inner`'s private fields — the submodules
are descendants of `mod.rs`, so they reach those fields without widening
everything to `pub(crate)`). Landed as staged commits, each green
(`cargo test`/`clippy -p cannet-gui` + the workspace pre-commit hook).
Final production+test line counts:

- `mod.rs` (859) — the facade: `TraceStore`/`Inner`/`PerKey`,
  `FrameKey`/`MuxKey`/`MuxSelectorFn`, construction + `lock_inner`,
  `append` (the write path that coordinates every concern), the core
  read accessors (`len`/`slice`/`frame_timestamps`/`frame_index_at_ns`/
  `buffer_seconds`/`matching_frames_indexed`/`scan_chunk`/`frames_at`/
  `low_water`/`len_and_low_water`/`refresh_filter_index`/
  `session_start_ns`/`frames_dropped_before_session`), the
  `CandidateSource` impl, and the shared `#[cfg(test)] test_support`
  frame-builders.
- `rate.rs` (430) — `RateEstimate` / `RateSample` / `RateTrack`, the
  sample-cadence helpers, the `RATE_WINDOW`/`RATE_SAMPLE_INTERVAL`
  constants, and `frames_per_second{,_by_bus,_by_direction}`.
- `byid.rs` (579) — `LatestById` (re-exported from the module root),
  the mux scan bounds, and `latest_since` / `latest_in_window` /
  `set_mux_extractor` / `latest_mux_in_window` / `scan_latest_mux` /
  `mux_stats` / `seen_bus_ids`.
- `scratch.rs` (209) — `ScratchBreakdown` (re-exported), `dir_footprint`,
  `scratch_breakdown`, and `scratch_footprint_bytes` /
  `scratch_breakdown` / `set_scratch_cap`.
- `flush.rs` (669) — session lifecycle + persistence: the
  IDENTITY/DERIVED sidecar consts, the persisted shapes, the crash-safe
  `write_json`/`read_json` (re-exported `pub(crate)` for notes.rs), and
  `start_session` / `flush` / `flush_async` / `flush_with` /
  `write_scratch_identity` / `try_reload`.

Each region's tests moved with it; the frame-builder fixtures the
several test modules share live in a `#[cfg(test)] test_support` module
in `mod.rs`. **Deviation from the prior two splits (lib.rs, cannet-dbc),
which kept one wholesale `tests.rs`:** here the tests were split
per-module as the god-file table directs, which stays cleaner because
each submodule's tests reach only that submodule's items.

**`rbs.rs` sketch**: directory split along its own section banners —
file model / runtime reconciliation / view shaping / 15 commands. Pure
relocation.

**Done (task-0030/16-split-rbs).** `rbs.rs` (2,184 lines by the time of
the split) became a directory module `rbs/` — a directory split, not
flat siblings, matching the trace_store precedent: the four regions
share private helpers, and as descendants of `mod.rs` the submodules
reach them via `pub(super)` without widening anything to `pub(crate)`.
Landed as staged commits, each green (`cargo test`/`clippy -p
cannet-gui` + the workspace pre-commit hook). The four regions split
**cleanly** — the "pure relocation" claim held; no entanglement forced
a compromise. Final production+test line counts:

- `mod.rs` (69) — the module doc plus wiring: the four `mod`
  declarations and the public re-exports.
- `file_model.rs` (317) — the "File model" banner: `RbsFile` / `RbsBus`
  / `RbsEcu` / `RbsMessage` / `RbsValue`, `RBS_SCHEMA_VERSION`, and
  `parse_message_key` / `format_message_key`, with the three file-model
  parse/key tests.
- `runtime.rs` (976) — the "Runtime state", "Buffer reconstruction",
  and "Registration and schedule reconciliation" banners merged (the
  doc's single "runtime reconciliation" region): `RbsElementState` /
  `RbsRuntime`, `row_id`, `reconstruct_payload`,
  `for_each_scoped_message` + `dbc_scoped_to`, `rebuild_element_rows`,
  `sync_schedules`, `notify_schedule_change`, `refresh_element`,
  `refresh_all_elements`, plus the eight runtime tests + DBC fixtures.
- `view.rs` (379) — the "The view query" banner: the `RbsView` /
  `RbsBusView` / `RbsEcuView` / `RbsMessageView` / `RbsSignalView` data
  model, `MessageViewInputs`, `build_message_view`, and the `rbs_view`
  / `rbs_crc_algorithms` query commands.
- `commands.rs` (523) — the "IPC commands" banner: the other thirteen
  `#[tauri::command]`s + the `edit_file` / `entry_mut` / `write_rbs_file`
  / `write_element` helpers + `RbsTarget` / `RbsDirtyRecord`, with the
  non-atomic-save regression test.

**Deviations / notes.** (1) The doc's `43/257/655/1132` offsets and its
"view shaping / 15 commands" labels described a since-drifted layout: the
current file's banners run **IPC commands (13) then The view query (2
more commands + the view types + the shaper)**. The honest banner-aligned
split therefore keeps the two view-query commands with
`build_message_view` in `view.rs` rather than prying them out to satisfy
a literal "all 15 in one module" — so the fifteen commands live 13-in-
`commands.rs` / 2-in-`view.rs`, all re-exported. (2) `generate_handler`
tolerating re-exported commands needed one explicit step the doc
understated: tauri's `#[command]` emits hidden `__cmd__NAME` /
`__tauri_command_name_NAME` helpers next to each fn, and because lib.rs
names commands through the `rbs` module (`generate_handler![rbs::rbs_load,
…]`), those helpers must be `pub use`-re-exported alongside each command
fn — a plain fn re-export alone does not resolve. (3) `seeded_file`
moved into `runtime.rs` (its only non-test caller is
`RbsRuntime::ensure_seeded`) rather than staying in the commands banner
it was physically filed under — its honest home, same judgment the
lib.rs split used for the local-virtual-bus commands. (4) Tests were
split **per-module** (like the trace_store split, and as the god-file
table directs) rather than into one wholesale `tests.rs`; each
submodule's tests reach only that submodule's items. **`view.rs` has no
tests** — `rbs_view` / `build_message_view` were never directly unit-
tested (they are exercised only indirectly), so the view region carries
no test module; not a regression, just a pre-existing coverage gap noted
here.

**`TransmitPanel.tsx` sketch**: 13 components in one file — extract the
row/editor subcomponents. Re-verified 2026-07-26: the file had drifted
to **1,589** lines (not the 2026-07-02 table's 1,642 — items #14/#15/#17
in this same task had since migrated it onto `useValueTables` /
`useElementPanel` / `useHostMirror` and extracted `formatCanIdHex`). The
"13 components" count held exactly: 13 subcomponents (`TransmitFrameRow`,
`CalcFieldsStrip`, `FrameShapeStrip`, `SignalsTable`, `SignalRow`,
`NumericValueCell`, `EnumValueCell`, `CycleControls`, `PeriodInput`,
`CanIdInput`, `BytesEditor`, `ByteCell`, `FrameDropZone`) plus the
`TransmitPanel` shell.

**Done (task-0030/17-split-transmitpanel).** TransmitPanel.tsx:
**1,589 → 364 lines** (the panel shell: element wiring, the
host-mirrored TX pool, the add/remove/reorder/drop handlers, and the
frame-list composition). Landed as staged commits, each green
(`pnpm test` + `build` via the pre-commit hook). The subcomponents split
**cleanly** — every one was genuinely separable at a component seam; no
prop-explosion forced a compromise, and all existing prop contracts were
preserved verbatim (pure relocation). New files:

- `transmitFrameConfig.ts` (160) — the panel's `TransmitFrameConfig`
  working-shape type + its pure helpers: `configsEqual` /
  `recordToConfig` / `configToFrame`, the `parseHexBytes` /
  `bytesToHexString` codec, and `maxDataBytesForKind` / `zeroDataHex` /
  `resizeDataHexPreserving`. The DOM test now imports the three exported
  helpers from here (their honest home) instead of re-exported through
  the panel.
- `TransmitBytesEditor.tsx` (98) — `BytesEditor` + `ByteCell` (the
  per-byte hex payload grid).
- `TransmitSignalsTable.tsx` (373) — `SignalsTable`, `SignalRow`,
  `NumericValueCell`, `EnumValueCell`, and the `formatPhysical` /
  `formatRange` display helpers (the per-message signal-level
  decode/encode editor).
- `TransmitFrameControls.tsx` (347) — the row's inline controls:
  `CalcFieldsStrip`, `FrameShapeStrip`, `CycleControls` (+ its internal
  `PeriodInput`), and `CanIdInput`.
- `TransmitFrameRow.tsx` (293) — `TransmitFrameRow` (the per-frame tile:
  identity line, the descriptor fetch + DBC-derived kind/brs/length
  effect, expand/remove, and the composition of the four editor
  children), `FrameDropZone`, and the `tx-frame` reorder DnD helpers.

**TDD.** Two editor paths that were being relocated had no prior DOM
coverage — added one green-baseline regression test each *before*
extracting: editing a payload byte cell writes the new payload through
`set_transmit_frame` (byte editor), and a numeric signal commits the
typed physical value through `encode_frame` (signals table; only the
enum path was previously covered). Suite went 770 → 772, green before
and after each extraction. **Coverage gap noted (not a regression):**
the frame-reorder drag/drop path has no direct unit test — jsdom's
`dataTransfer` doesn't carry data across synthetic drag events — so
`reorderFrames` / the `tx-frame` DnD helpers stay exercised only
indirectly, exactly as before this split.

**`ProjectPanel.tsx` sketch**: the 2026-07-02 table's "connection-management
UI (lines 556–1603, two thirds of the file)" — re-verified 2026-07-26, the
file had drifted to **1,572** lines and the region ran lines 525–1571
(`uniqueRemoteServers` through `AddBridgeForm`), still ~two thirds. It is a
run of self-contained discovery/connection subcomponents the panel composes,
so it lifts out at a clean seam.

**Done (task-0030/18-split-projectpanel).** ProjectPanel.tsx:
**1,572 → 497 lines** (the panel shell: project New/Open/Save actions, the
element inventory + `ElementRow`, the logical-bus / virtual-bus / Connection
/ DBC section composition, and the id/basename helpers). The
connection-management region split **cleanly** — pure relocation, every prop
contract preserved verbatim, a one-directional shell→module dependency (the
extracted code references nothing back in the shell). New file:

- `ConnectionManagement.tsx` (1,093) — interface discovery
  (`useInterfaceDiscovery` + `DiscoveryState`/`DiscoveryRegistry`), the
  per-bus interface combo and hardware-config row (`BusInterfaceCombo` /
  `BusHardwareConfig` + the option encode/decode/label helpers), the inline
  "Add server…" form (`AddServerInline`), the Connection-section rows
  (`LocalInterfacesRow` / `LocalInterfaceList` / `RemoteServerRow` /
  `SelectedInterfaceList` + `labelForBinding`), the virtual-bus rows
  (`VirtualBusRow` + `AddBridgeForm`), and the shared helpers
  `uniqueRemoteServers` / `samePick` / `ComboPick`.

**TDD.** The moved components already carried DOM coverage in
`ProjectPanel.dom.test.tsx` (`BusInterfaceCombo`, `AddServerInline`,
`LocalInterfaceList`, `uniqueRemoteServers`) — no gap to backfill, so no new
tests were needed. That coverage was repointed at the new module;
`ElementRow`'s cases stay on `ProjectPanel`. Suite held at 772, green before
and after the extraction (`pnpm test` + `build` via the pre-commit hook).

With this, the **God-files worth splitting** table is fully addressed — every
row is done.

## Duplicate implementations to consolidate

### Rust — highest drift risk first

- ~~**1. cannet-spill segment-chain machinery written 3–5×** —
   `IdPostings` (byid.rs) and `SampleSeq` (sample_seq.rs) share
   identical constants, body-identical `seg_capacity()`/`locate()`,
   near-identical push-grow, and a verbatim evict loop (with the same
   Windows unmap-before-delete comment, 5 copies); `FilterIndex` and
   `DiskRawStore` repeat the rebase/evict loop; three hand-rolled
   lower-bound searches (byid.rs:307, filter_index.rs:209,
   signal_cache.rs:283). → one segment-chain module parameterized by
   entry type **and eviction policy** (the policies deliberately
   differ — keep that explicit, don't flatten it).~~ **Done
   (task-0030/03-spill-segment-chain).** Re-confirmed the "3–5×" shape:
   `IdPostings`/`SampleSeq` did share identical geometric constants,
   `seg_capacity()`/`locate()`, and push-grow; the leading-segment
   evict loop (with the Windows unmap-before-delete comment) really
   was copy-pasted 5× (those two, `FilterIndex`, and `DiskRawStore`'s
   meta *and* payload families); the three lower-bound searches were
   the same "binary search from a floor" shape, one of them
   (`signal_cache.rs`, since renamed from the doc's line reference but
   same file) living in the GUI crate rather than cannet-spill itself.
   New `crates/cannet-spill/src/seg_chain.rs` holds the shared pieces
   as plain functions — `geometric_seg_capacity`/`geometric_locate`/
   `geometric_push_grow` (the geometric chains), `grow_fixed` (a
   fourth duplicate found while extracting, beyond the doc's own
   wording: `FilterIndex::push`/`DiskRawStore::ensure_meta_seg`/
   `ensure_payload_seg` shared the same fixed-size "grow while short"
   loop), `evict_leading` (the 5-copy mechanical unmap-and-delete
   step), and a public `lower_bound` (re-exported so the GUI's
   `signal_cache.rs` uses it too). Per the doc's own instruction,
   eviction *policy* — what target base each type computes before
   calling `evict_leading` — was deliberately **not** unified: it
   stays inline in each type's own `evict_below`, visibly different
   per type (a binary search for by-id/filter-index, a
   directly-supplied slot for the sample sequence, a live-tail-
   protecting clamp for the disk store's two families). The two
   segment *geometries* (doubling vs. fixed-size) were likewise kept
   as separate function families rather than forced under one trait,
   since their addressing schemes genuinely differ (a `cum_cap` search
   vs. plain arithmetic division).
- ~~**2. CAN-ID extraction copy-pasted 5×** in
   `crates/cannet-blf/src/format/can.rs` (bit-31 test + 11/29-bit
   mask), plus `is_extended_id()`/`can_id()` duplicated on all five
   CAN structs. → one free fn / trait method; test that all callers
   agree.~~ **Done (task-0030/01-canid-dedup).**
- ~~**3. BLF object-decode preamble ~11×** across can.rs / text.rs /
   diagnostics.rs / marker.rs: the same ~20-line
   parse-base→type-check→TooSmall/Truncated→parse-V1→body-slice
   skeleton, plus four near-identical error enums (MarkerError has one
   extra variant) and reader.rs's four wrapper variants + From impls.
   → a `decode_framed<T>` helper + one shared error shape.~~ **Done
   (task-0030/04-blf-preamble).** Re-confirmed the "~11×" count exactly:
   5 in can.rs (`CAN_MESSAGE`, `CAN_MESSAGE2`, `CAN_FD_MESSAGE`,
   `CAN_FD_MESSAGE_64`, `CAN_ERROR_EXT`), 2 in text.rs
   (`EVENT_COMMENT`, `APP_TEXT`), 3 in diagnostics.rs (`CAN_STATISTIC`,
   `DATA_LOST_BEGIN`, `DATA_LOST_END`), 1 in marker.rs
   (`GLOBAL_MARKER`). Extracted `format::object::decode_framed()` (a
   plain fn, not generic over `T` — it returns a `FramedObject<'_>`
   with the parsed headers + body slice, so each caller's own `?`
   does the per-type conversion; genericising over the return type
   would have added a type parameter for no behavioural gain) plus
   `PreambleError` covering the five shared failure modes. All 11
   call sites migrated. Per-type error enums (`CanObjectError`,
   `TextError`, `DiagnosticError`, `MarkerError`) keep their existing
   public shapes — each gets a `From<PreambleError>` impl instead of
   being reshaped to match; `MarkerError::WrongObjectType`'s impl
   drops `PreambleError`'s `expected` half since marker.rs's expected
   type is always `GLOBAL_MARKER`, confirming the doc's note that it
   doesn't uniformly mirror the other three. **Not consolidated:**
   reader.rs's four `BlfReadError` wrapper variants (`CanObject`,
   `Marker`, `Text`, `Diagnostic`) + their `From` impls — each maps a
   real, distinct decode-failure domain into its own `Display`
   message; collapsing them would either lose that distinction or
   need a macro/`thiserror` dependency, which is a new-dependency
   decision out of this item's scope. Left as the honest boilerplate
   Rust error enums require.
- ~~**4. DBC bit-walker decode/encode/calc** duplication
   (`cannet-dbc/src/{decode,encode,calc}.rs`) — from the June probe,
   *not re-verified by this audit*; re-confirm, then unify the walker
   under round-trip coverage. Highest correctness risk if real.~~
   **Done (task-0030/02-bitwalker-dedup).** Re-confirmed 2026-07-26:
   real duplication — the big-endian bit-stepping recurrence was
   copy-pasted 4×, little-endian position math 2×. Unified into
   `bitwalk::walk`, consumed by decode/encode/calc; existing
   round-trip coverage (both byte orders, signed/float/offset/muxed)
   served as the green baseline.
- ~~**5. Frame/wire conversions in the wrong layer** —
   `frame_to_object_bytes` (cannet-blf/src/lib.rs:505–675) hand-builds
   wire structs in the adapter crate root, duplicating header knowledge
   the format layer owns; extended/standard `CanId` construction is
   copy-pasted at 8 sites in gui lib.rs. → move framing down, one
   `CanId` constructor helper.~~ **Done (task-0030/05-frame-conversions).**
   Re-confirmed the header-duplication shape: `frame_to_object_bytes`
   hand-assembled `CanMessage2`/`CanFdMessage64`/`CanErrorExt` plus
   their `ObjectHeaderBase`/`ObjectHeaderV1` in the crate root. Added
   `build_can_fd_message_64` and `build_can_error_ext` to
   `format::can` alongside the pre-existing (but previously
   test-only) `build_can_message2`, each with a round-trip test;
   `frame_to_object_bytes` now only derives cannet-side framing values
   (relative timestamp, 1-based channel, wire id, TX flag) and calls
   the three builders. For the `CanId` half, the audit undercounted:
   re-locating found **10** sites in gui lib.rs branching between
   `CanId::extended`/`CanId::standard` on a runtime `extended` flag,
   not 8 (`raw_to_core_frame`, the mux-extractor closure,
   `decode_snapshot_frame`, `decode_raw_frame`,
   `resolve_effective_calc`, `rebuild_verification`'s calc-override
   scan, `build_and_confirm`, `describe_message_inner`,
   `decode_frame_inner`, `encode_frame_inner`). Added
   `CanId::new(raw, extended)` to cannet-core (TDD, its own unit
   tests) as the one shared constructor and migrated all 10, each
   keeping its existing error-handling idiom (per-mode `map_err`
   message, `.ok()?`, or `let-else` on the `Result`).
   `describe_message_inner`/`decode_frame_inner` had no prior direct
   test coverage; added one regression test per function (both
   addressing modes) ahead of the refactor. The other 8 sites were
   already covered (BLF save round-trip, `decode_against` via the
   snapshot/tx-confirm tests, and `resolve_effective_calc`'s /
   `encode_frame_inner`'s own direct tests). **Not touched:** a
   structurally identical `if extended {...} else {...}` pair inside
   an `rbs.rs` unit test helper (`ev_zonal_fixture_...`'s `resolve`
   closure) — out of this item's stated scope (gui lib.rs only) and
   left as-is per the "surgical changes" rule.
- ~~**6. `record_matches` fabricates a `RawTraceFrame`** (gui
   lib.rs:1556–1575: dummy timestamp/direction/payload, undocumented
   "predicate only touches id/bus/record" invariant) to reuse
   `FilterPredicate::matches`. → change the predicate input to the
   (id, bus, record) view both callers actually have. Fold
   `dbc_applies_to_frame` into filter.rs while there (June item,
   still open); diag.rs stats stay siloed — fine for now.~~ **Done
   (task-0030/11-split-lib-rs).** Added `FilterPredicate::matches_fields(id,
   bus_id, decoded)` — the fields a predicate actually reads — and had the
   `RawTraceFrame`-shaped `matches` delegate to it; `record_matches` now
   evaluates the `TraceFrameRecord` it already holds directly, no dummy
   frame. Folded `dbc_applies_to_frame` into `filter::dbc_applies(buses,
   bus_id)` (expressed over the fields, not a `LoadedDbc`) and routed
   `decode_against` + the mux extractor's inline scoping through it. Added
   a `matches_fields`/`matches` parity test and a `dbc_applies` scoping
   test. `diag.rs` stats left siloed as noted.
- ~~**7. Persistence written twice-plus** — settings.rs and state.rs are
   the same JSON-config module twice; the atomic-write-via-temp helper
   lives in trace_store while settings re-implements it and
   project/RBS saves are **non-atomic**; the ADR-0011 schema-version
   gate is encoded twice (project.rs:246–260 vs RBS). → one
   persisted-JSON helper (atomic write + version gate) used by all
   four.~~ **Done (task-0030/06-persistence-helper).** Re-confirmed:
   settings.rs/state.rs each hand-rolled the identical temp-file-then-
   rename write, JSON-or-default parse, and `app_config_dir`
   resolution; `project.rs::save_project` and `rbs.rs::write_element`
   both wrote straight to the target path with `std::fs::write` — a
   real bug, not just duplication, since a write failure partway could
   leave a truncated file in place of the last good save. Added
   `persisted_json.rs` with `write_json_atomic` (the trace_store-proven
   temp+rename pattern), `parse_or_default` (best-effort config files),
   and `parse_versioned` (the ADR 0011 schema-version gate, previously
   encoded separately in `project.rs` and `rbs.rs`); routed all four
   call sites through it. TDD: added a regression test per fixed save
   path (project, RBS) that blocks the temp-file step and asserts the
   original on-disk file is untouched by a failed write; confirmed each
   failed against the prior `std::fs::write`-direct implementation
   before applying the fix. **Caveat:** settings.rs and state.rs stay
   two separate modules rather than merging into one — `Settings` and
   `UiState` are different documents by design (user-chosen
   preferences vs. machine-recorded state, ADR 0034), so only the
   shared plumbing (atomic write, default-on-corrupt parse, config
   dir) moved to `persisted_json`; each module keeps its own thin
   `parse_settings`/`parse_state` and `read_settings`/`read_state`
   wrappers so their existing tests and doc comments (which explain
   *why* the split from IO exists) stayed intact.
- ~~**8. Session-registration skeleton duplicated** between
   `connect_remote_server` (lib.rs:2717–2897) and
   `connect_local_vbus` (2911–3050), including a redundant re-lock to
   re-read data just inserted. → shared registration fn; collapses
   naturally into the `session.rs` split.~~
   **Partial (2026-07-25, task 29b):** the session-*map* mutation is
   now a choke point — `AppState::register_session` /
   `unregister_sessions` / `remove_vbus_session_if_dead`; no raw
   insert/remove at call sites (29b needed one place to emit the
   scheduler's route-up hint). Remaining: the wider skeleton (subscribe
   flow, pump spawn, status events) and the redundant re-lock.
   **Done (task-0030/11-split-lib-rs).** The remaining skeleton now goes
   through one `register_session_or_warn(app, state, address, session)`
   seam in `session.rs` — the register + duplicate-address warn + return,
   the only session-map insert either connect path does — shared by both
   paths. The pump-spawn/status differences (one pump vs. one per
   participant; different cleanup + status text) stay per-path: an honest
   boundary rather than a forced merge. Dropped the redundant re-lock in
   `connect_remote_server` that re-read the just-inserted `channel_to_bus`
   under a second lock; the pump clones the value already in scope.
   Covered by the existing `register_session_*` / `full_vbus_session_tx`
   tests (the connect commands themselves need a live server/app).
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
- ~~**11. trace_store internals** — the sample-due/prune rate-sampling
    block now appears four times (aggregate, per-bus, per-direction in
    `append()`, and `RateEstimate::observe` since the 2026-07-25
    windowed per-id rewrite) and the aggregate tracker bypasses
    `RateTrack`; three parallel `HashMap<FrameKey, _>` where one
    keyed struct belongs (312–323); the scratch-breakdown facade
    reverse-engineers other modules' private file naming (1189–1279 —
    have each module report its own disk usage instead).~~ **Done
    (task-0030/15-split-trace-store), alongside the split above.**
    All three parts landed as separate commits under green tests:

  + **Rate sampling unified.** The sample-due/prune block collapsed
    into one `sample_if_due` helper + `RateTrack::observe`, used by the
    aggregate, per-bus, and per-direction trackers. The aggregate no
    longer bypasses `RateTrack`: `Inner.rate_samples` (a bare
    `VecDeque` counted off the raw index) became `Inner.agg_rate:
    RateTrack`. **Confirmed not load-bearing** — all four counts
    advanced by 1 per accepted append, so `agg_rate.count` tracks the
    former `idx+1` in lockstep and the reported rate is byte-identical;
    the bypass was historical. `RateEstimate::observe` keeps its extra
    last-delta/last-wall bookkeeping but shares the same `sample_if_due`
    gate for its own deque. Added a green-baseline test for the
    aggregate `frames_per_second()` first (only its zero case was
    covered).
  + **Three maps → one keyed struct.** `latest` / `latest_frame` /
    `rates` (all `HashMap<FrameKey, _>`, advanced in lockstep) folded
    into `HashMap<FrameKey, PerKey { last_index, last_frame, rate }>` —
    one hash lookup + one entry per append, and the follow-live by-id
    path reads a single entry instead of an index-map iter plus an
    overlay get.
  + **Scratch-breakdown self-reporting.** Each family's file naming
    moved to its owning module: `cannet_spill::is_raw_frame_segment`
    (with `META_PREFIX`/`PAYLOAD_PREFIX` now the single source, used by
    the path builders + `clear()`) for the raw family, and
    `signal_cache::{PYRAMID_SUBDIR, pyramid_scratch_usage}` (the moved
    `.l{n}` level-grammar walk) for the pyramids; `lib.rs`'s
    `signal_cache_dir` roots at the const. `trace_store::scratch`'s
    `scratch_breakdown` now orchestrates — ask each owner, sum the rest
    ("other": by-id, `filter/`, JSON sidecars) generically — instead of
    hard-coding foreign prefixes. **Caveat:** full per-instance
    self-reporting (each live `SignalCacheStore`/`FilterIndex` summing
    itself) is out of scope — the `TraceStore` facade doesn't own those
    instances (they live on `AppState`), and the diagnostic is a single
    dir walk with only the scratch path in hand; that would be the
    "host model trapped in the app crate" architecture item, not this
    one. What landed removes the reverse-engineering (no module's
    private naming is re-derived by the facade) while keeping the one
    efficient walk.

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

- ~~**13. Signal catalog fetched independently in 3+ panels**
    (`list_signals` into local state in PlotPanel, TransmitPanel,
    ColorMapPanel). → lift to a context/provider. *(thin-view)*~~ **Done
    (task-0030/07-signal-catalog-context).** Re-confirmed the shape and
    found a fourth site the doc didn't name: SignalsPanel also ran its
    own `list_signals` fetch (its "add signal" picker). Added
    `signalCatalogContext.tsx` — `SignalCatalogProvider` fetches once,
    scoped to the project's bus ids, and `useSignalCatalog()` is the
    single read path; wired into `App.tsx` inside `ProjectContext`
    (which the provider reads `buses`/`dbcPaths` from) and around
    `ElementRegistryContext`, so it's live for every dockview panel.
    All four panels migrated to it in their own commits. The four
    panels' refetch triggers had already drifted: PlotPanel and
    SignalsPanel refetched on a `dbcPaths` change and listened for the
    host's `dbc-changed` filesystem-watch event; ColorMapPanel and
    TransmitPanel only refetched when the project's bus list itself
    changed. The shared provider fetches on the *union* of every
    trigger any panel relied on, so ColorMapPanel and TransmitPanel
    gain the `dbcPaths`/`dbc-changed` refresh they were missing — a
    latent staleness fix, not a behaviour regression. One divergence
    survives: PlotPanel's toolbar has a manual "↻ reload signal list"
    button no other panel has, so the context exposes a `refresh()`
    escape hatch used only by that one caller. TDD: PlotPanel and
    ColorMapPanel already had DOM coverage of their catalog-derived UI
    (picker options); TransmitPanel and SignalsPanel didn't (both
    tests hard-mocked `list_signals` to return `[]`) — added one test
    per panel first as a green baseline before extracting, plus a
    dedicated `signalCatalogContext.dom.test.tsx` for the provider's
    fetch/refetch/failure semantics.
- ~~**14. Value-table fetch duplicated 4×** (`list_value_tables` in
    ColorMapPanel, PlotPanel, RbsPanel, TransmitPanel). → shared
    `useValueTables` hook. *(thin-view)*~~ **Done
    (task-0030/08-value-tables-hook).** Re-confirmed, with a wrinkle
    the doc predates: `useValueTables.ts` already existed, fetching by
    `(busId, messageId, extended, signalName)` and keying its returned
    `Map` by `signalKey` — it was added in PR #87 (2026-07-25, after
    this audit's 2026-07-02 line numbers) to dedupe *two* call sites
    inside PlotPanel itself, but never propagated to the other three
    panels. So this item's actual remaining work was three migrations
    onto the pre-existing hook, not building one from scratch: a
    plain hook (not a context) is the right shape here, since each
    caller wants a different single-signal (or zero-signal) subset,
    unlike the catalog's one-shared-list-for-everyone case in #13.
    ColorMapPanel, TransmitPanel (`EnumValueCell`), and RbsPanel
    (`SignalRow`) each migrated their hand-rolled fetch+local-state
    onto `useValueTables`, preserving their existing gates (RbsPanel's
    `hasValueTable` skip; TransmitPanel's cell is only mounted for
    `hasValueTable` signals already). **Not touched:** ColorMapPanel's
    second `list_value_tables` call in `onPickSignal` — an imperative
    one-shot fetch to seed color rules the instant a signal is picked,
    not reactive display state, so it isn't the pattern this item
    targets. TDD: TransmitPanel's `EnumValueCell` and RbsPanel's
    `SignalRow` fetch had no DOM coverage that actually exercised the
    fetched labels driving a commit (mocks existed but nothing typed a
    fetched-only label) — added one green-baseline test per panel
    before extracting, plus a hook-level test for the empty-signal-list
    gate the three panels now rely on. ColorMapPanel already had DOM
    coverage of the display effect (no new test needed).
- ~~**15. Element-panel lifecycle boilerplate ×4 panels** —
    `elementIdFromParams`, savedConfig hydration, dual-write persist,
    `currentSources` kind-narrowing, `availableFilters`, and the
    GOTO_EVENT subscribe-once listener are copy-pasted across
    TracePanel/PlotPanel and inlined in TransmitPanel/RbsPanel
    (TracePanel.tsx:41–197 vs PlotPanel.tsx:428–490, 767–790). → a
    `useElementPanel` hook (+ `useElementSources` for the picker
    wiring).~~ **Done (task-0030/09-element-panel-hook).** Re-confirmed
    against current line numbers; the doc's shape mostly held, with two
    wrinkles. First, `currentSources`/`availableFilters` never applied
    to TransmitPanel/RbsPanel at all — their element kinds
    (`transmit`: `sinks`/`frameIds`; `rbs`: `path`/`run`) carry no
    `sources` field, so "inlined in TransmitPanel/RbsPanel" describes
    only the id-resolution/ensure/persist slice, not a sources-picker
    gap. `useElementSources` (currentSources kind-narrowing +
    availableFilters + handleSourcesChange) is genuinely verbatim
    between TracePanel and PlotPanel and is used only by those two.
    Second, the GOTO_EVENT listener resists a shared implementation
    despite the doc grouping it with the rest: TracePanel resolves the
    payload timestamp to a display *row* (via `frame_indices_at_ns` /
    `filtered_positions_at_ns` + the event merge) and scrolls to it;
    PlotPanel resolves it to an x-axis *window centre*
    (`gotoNote`/`baseSecondsRef`) and re-centres the plot. Different
    targets, different host calls — left panel-local in both, per the
    task's own escape hatch. `useElementPanel` covers id resolution +
    registry `ensure` + `config` hydration + dual-write persist
    (`persist(config?)`) for all 4 panels: TracePanel/PlotPanel pass a
    config object (unifying their identical dual-write bodies, and
    fixing nothing — behavior preserved bit-for-bit, including each
    panel's own persist-effect dependency array, which `persist`'s
    memoization keeps intact); TransmitPanel/RbsPanel call `persist()`
    with no config (elementId-only into params, no registry write —
    matching their pre-existing behavior, since neither element kind
    has a `config` field to write). TDD: TracePanel and PlotPanel
    already had DOM coverage of config hydration + dual-write persist
    (`TracePanel.dom.test.tsx`, `PlotPanel.dom.test.tsx`); no panel had
    coverage of the id-resolution fallback (fresh uuid when `params`
    carries none) or of the elementId-only persist path — added
    `useElementPanel.dom.test.tsx` as the canonical coverage for the
    shared hooks themselves (id resolution, ensure, config hydration
    priority, both persist shapes, currentSources kind-narrowing,
    availableFilters, handleSourcesChange) rather than duplicating it
    per panel.
- ~~**16. TraceView ↔ ByIdTable near-clones** — `DecodedSignalCell` is a
    48-line *verbatim* copy (TraceView.tsx:560–613 =
    ByIdTable.tsx:255–302, under a comment admitting it); the
    rows/spacer/anchor derivation and ResizeObserver effect are
    identical. → share the cell component and the viewport scaffolding;
    note the scroll handlers genuinely differ (TraceView embeds
    auto-scroll suppression) — share the common core only.~~ **Done
    (task-0030/10-ts-shared-batch).** Re-confirmed exactly: `DecodedSignalCell`
    was a verbatim copy (ByIdTable's own comment admitted it); the
    rows/spacer/anchor derivation and the resize effect were identical
    modulo one diag-counter call TraceView made and ByIdTable didn't.
    Extracted `DecodedSignalCell.tsx` (the shared cell) and
    `useTraceViewport` (the shared scaffolding — takes an optional diag
    key so TraceView keeps its counter and ByIdTable stays silent, exactly
    matching prior behavior). Scroll handling (auto-scroll, wheel
    stepping, re-pin) stayed panel-local as directed — TraceView's
    auto-scroll suppression has no ByIdTable equivalent. TDD: both views
    already had DOM coverage of the cell (TraceView.signals.dom.test.tsx,
    ByIdTable.dom.test.tsx); added `useTraceViewport.dom.test.tsx` as
    dedicated coverage for the extracted derivation itself.
- ~~**17. Host-mirror pattern** (snapshot fetch + change-event refetch +
    500 ms poll-while-running) duplicated TransmitPanel:90–115 /
    RbsPanel:93–131 — and TransmitPanel is *missing* the
    post-listener refetch RbsPanel has (launch race; bug entry in
    backlog). → `useHostMirror` hook fixes both at once.~~ **Done
    (task-0030/10-ts-shared-batch).** Confirmed the missing post-listener
    refetch was real: added a regression test that reproduces the race
    (a pool change landing in the async `listen()` attach gap is lost)
    against the prior inline effect, confirmed it failed, then migrated
    both panels onto `useHostMirror` (fetch/fallback/event/optional
    payload `matches`/optional `pollWhile` predicate), which always does
    the post-listener refetch. Backlog's `TransmitPanel.tsx` launch-race
    entry removed (fixed, not just tracked). TDD: hook has its own
    `useHostMirror.dom.test.tsx` (fetch, reject-fallback, post-listener
    refetch, event-payload filtering, poll-while-true/stops-when-false,
    unmount cleanup) plus the panel-level regression test.
- ~~**18. Dismiss-on-outside-click + Escape effect ×6** (traceTable,
    SourcesPicker, PlotPanel ×2, ProjectGraphPanel, RbsPanel). → one
    `useDismissableMenu` hook.~~ **Done (task-0030/10-ts-shared-batch).**
    Re-confirmed ×6, but not identically shaped: 5 sites (traceTable,
    SourcesPicker, PlotPanel's toolbar menu, PlotPanel's
    `MeasurementMenu`, ProjectGraphPanel) already closed on outside
    mousedown + Escape, via three different outside-detection tricks
    (`closest()` selector, `stopPropagation()` on the menu root, or a
    ref + `contains()`) that the shared hook's ref-based `contains()`
    check replaces uniformly. RbsPanel's signal context menu didn't
    match: it closed on *any* `window` "click" (inside or outside) with
    no Escape handling at all — outside-dismiss still worked (its two
    menu items already call the close setter themselves), but Escape was
    a silent no-op. Migrating it onto the shared hook is a small
    behavior gain, not pure dedup: Escape now closes it too, consistent
    with the other 5. TDD: hook has `useDismissableMenu.dom.test.tsx`
    (outside-mousedown closes, inside doesn't, Escape closes, closed
    while `open=false` is inert, listeners drop on unmount); added two
    RbsPanel tests (Escape closing the new-to-it path, and an
    inside-menu mousedown not pre-empting its own click).
- ~~**19. Set-toggle helper ×6** (twice verbatim in RbsPanel alone). → one
    util.~~ **Done (task-0030/10-ts-shared-batch).** Re-confirmed exactly
    ×6: TraceView/TracePanel row-expansion, DbcPanel's tree-expansion and
    multi-select, and RbsPanel's `toggleSet`/`toggleSet2` — two
    identically-bodied local helpers under different names. Added
    `toggleInSet` (own unit test) and migrated all 6 call sites.
- ~~**20. Formatting around `format.ts` instead of in it** —
    RbsPanel:567 is character-identical to `formatData`'s body (blocked
    only by its `TraceFrameRecord` parameter — add `formatBytes`);
    DbcPanel id-label template duplicated in-file (897 vs 953);
    TransmitPanel:1322 re-rolls `formatId`'s width rule. `busLookup()`
    rebuilt inline in PlotPanel/ColorMapPanel (June item, still open).~~
    **Done (task-0030/10-ts-shared-batch).** All four re-confirmed: added
    `formatBytes` (RbsPanel's message-payload hex, now sharing
    `formatData`'s body) and `formatCanIdHex` (the id-hex-width rule
    `formatId` wraps, now shared by TransmitPanel's editable `CanIdInput`,
    which needs the bare hex text since its `s:`/`x:` prefix is its own
    toggle button); factored DbcPanel's duplicated `0x<hex>[x]` id-label
    template into a local `dbcIdLabel` helper (distinct from `formatId`'s
    trace-view convention, so left local rather than moved into
    `format.ts`); routed PlotPanel's and ColorMapPanel's inline
    bus-id→name `Map` builds through `traceColumns.ts`'s existing
    `busLookup()`, closing the June item. PlotPanel's separate
    bus-id→*colour* map (`busColorLookup`) is a different lookup and
    untouched.
- **21. Smaller confirmed items: `buildSinkPredicate`/
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

- ~~**22. `WatchInterfaces` dead re-publish apparatus** — `_watch_seq` is
    written exactly once, so the condition/re-yield loop can never
    fire a second snapshot, and the comments claiming
    `ListInterfaces` re-publishes are false (server.py:666–769). →
    delete the apparatus or actually wire `ListInterfaces` to publish;
    fix cannet.proto:17–21's drifted claim either way.~~ **Done
    (task-0030/19-python-server-split, commit `d336933`).** Re-confirmed:
    `_watch_seq` was written exactly twice — `0` in `__init__`, `1` in the
    seed — and never advanced again, so the re-yield loop was dead, and
    nothing touched `_watch_snapshot`/`_watch_seq` after seeding (the
    "`ListInterfaces` re-publishes into a shared cache" claim was false).
    **Deleted** the apparatus (prefer-deletion per CLAUDE.md simplicity;
    no Rust consumer needs live push — the sidecar's tested behavior was
    already "yield once, park", and the wire contract permits a server
    that only emits the initial snapshot). `WatchInterfaces` now
    enumerates once, yields, and parks on a `threading.Event` woken by
    the disconnect callback. Each subscribe re-enumerates fresh instead of
    returning a process-lifetime-stale seed (strictly fresher, still a
    one-shot, no timer). Fixed cannet.proto's drifted discovery comment
    (it described a nonexistent server-side polling cache/cadence) to
    state that pushing past the initial snapshot is the server's choice
    and clients must not assume every change is pushed.
- ~~**23. Error-broadcast triplicated in `_SharedInterface`**
    (server.py:352, 485, 523). → one `_broadcast_error`; **careful**:
    the reconfigure site fans out while *holding* the non-reentrant
    `self._lock` — the helper must not re-take it.~~ **Done
    (task-0030/19-python-server-split, commit `575c12f`).** The fan-out
    was actually spelled **four** times (the doc named three): reconfigure's
    failed-reopen branch (under `self._lock`), the rx-pump crash handler,
    the pack-pump unencodable-frame drop, and the pack-pump crash handler.
    Consolidated into `_SharedInterface._broadcast_error(level, message, *,
    lock_held=False)`: the three pump sites call it lock-free (it snapshots
    via `_outbox_snapshot`), and reconfigure passes `lock_held=True` so the
    helper reads `self._outboxes` directly instead of re-taking the
    non-reentrant lock (which would deadlock). TDD: added a
    held-lock regression guard on a worker thread with a join timeout (a
    reentrant-lock regression fails cleanly rather than hanging the suite),
    a fan-out unit test, and an end-to-end reconfigure-failure test.
- ~~**24. Frame kind as three independent bools** (driver.py:104–114) with
    the error>remote>fd priority ladder re-derived at each boundary —
    and `_proto_to_frame` silently maps UNSPECIFIED where the Rust
    side (convert.rs) errors. → a `FrameKind` enum at the seam.~~ **Done
    (task-0030/19-python-server-split, commit `bbb19cf`).** Added
    `driver.FrameKind` (CLASSIC/FD/REMOTE/ERROR) with a single
    `from_flags` classmethod owning the priority ladder; `Frame` now
    carries one `kind` field (brs/esi/dlc stay). `_msg_to_frame` collapses
    python-can's booleans via `from_flags` (the one ladder site);
    `_frame_to_msg` / `_reject_if_incompatible` read `frame.kind`; the
    server's `_frame_to_proto` / `_proto_to_frame` are straight lookups
    through `_KIND_TO_PROTO` / `_PROTO_TO_KIND` (no ladder). **Real
    fix:** `_proto_to_frame` now raises `ValueError` on
    UNSPECIFIED/unrecognised kind (mirroring convert.rs's `UnknownKind`)
    and `_handle_tx` turns it into `CODE_TX_REJECTED` — a malformed TX
    frame is rejected, not silently sent as classic. TDD: wrote the
    UNSPECIFIED/unknown-tag rejection tests first and confirmed they failed
    against the silent-classic code before fixing.

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
