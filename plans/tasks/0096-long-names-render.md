# Task 96 — Long Signal and Enum Names Do Not Render Correctly

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> signal/_VAL names aren't rendered correctly if they're too long.
> There's a DBC extension for longer names we need to properly
> implement. expand our example DBs to include.

## Finding: the DBC extension is already implemented

Grooming checked this before scoping the task. `cannet-dbc` **already
supports the long-name extension**, correctly and at the right layer:

- `parse.rs` recognises `SystemMessageLongSymbol` and
  `SystemSignalLongSymbol` `BA_` attributes and resolves the long name
  onto the entity's `name`.
- `view_builders.rs` suppresses the placeholder attributes from
  displayed metadata — *"they're an implementation detail of the
  long-name extension, not user-authored metadata. The resolved long
  name lands on `name`."*
- `signal_fingerprint.rs` has a test pinning that a
  `SystemSignalLongSymbol` rename is treated as a rename by the decode
  path.

So "we need to properly implement" is already true, and this task must
not re-implement it. **The remaining work is the part the owner
actually saw: rendering.**

## What is left

### 1. Presentation of long names

A resolved long name can be far longer than the 32-character DBC
identifier limit the extension exists to escape — that is its whole
purpose. Every surface that shows a signal or message name has to cope:
the trace's decoded rows, the signals panel, the plot picker and
legend, the RBS and transmit trees, the signal mapping panel (task 89),
the graph view. Truncation, ellipsis, tooltip-on-overflow, column
sizing — currently undefined, which is why it "isn't rendered
correctly".

### 2. Long `VAL_` enum labels

The owner names `_VAL` alongside signal names. Enum labels have no
length limit at all and are rendered in the value column, the enum
overlay, and the plot's enum lanes. Task 97 covers one specific
consequence (enum labels on the axis); this covers the rest.

### 3. No example DBC exercises any of it

`examples/` has nine DBCs — `cannet-demo`, the four `ev-demo` files,
two `ev-zonal`, `extrapolation`, `time-origins` — and **none carries a
`System…LongSymbol` attribute or a long enum label**. So the failure is
invisible during development and in every screenshot and perf run. The
only long-name coverage is a unit-test string in `cannet-dbc/src/tests.rs`.

Extending an example DB is therefore not a nicety; it is what makes the
defect reproducible and keeps it fixed.

## Open questions — grooming

- ~~Which example DB gets the long names?~~ **Resolved 2026-08-20
  (owner): both `ev-zonal` and `ev-demo`.**

  `ev-zonal` is the database the ADR-0031 render-tier harness drives,
  so long names enter the **measured** path and long-name layout cost
  is gated rather than invisible. `ev-demo` is the richer multi-file
  example, so it carries the functional and by-eye coverage across
  several databases and buses.

  **The gate consequence, accepted by this ruling and stated so no
  later phase mistakes it:** if adding long names to `ev-zonal` pushes
  a render-tier metric past its limit, that is a **real regression to
  fix inside this task**. It is not grounds to widen a limit, promote a
  baseline, or move the long names out of `ev-zonal`. Limits ratchet
  down only; raising one needs an owner ruling recorded in ADR 0031,
  and this ruling is not that.

  Practical note for the implementing phase: re-baseline nothing, but
  do run the gate **before** the DBC change as a same-day control, so
  a limit breach can be attributed to the long names rather than to
  machine state.

- ~~What is the truncation rule?~~ **Decided by the overseer
  2026-08-20: middle-ellipsis on names, end-ellipsis on enum labels,
  full text reachable, width driven by the column model.**

  Middle-ellipsis on names because DBC long symbols share prefixes by
  construction — `BMS_PackCurrent_Filtered_HighRes` and
  `BMS_PackCurrent_Filtered_LowRes` differ only at the end, while
  `BMS_PackCurrent_…` and `BMS_PackVoltage_…` differ only in the
  middle, so end-truncation reliably hides the distinguishing part.
  Enum labels are prose-like and read left to right, so they take
  end-ellipsis.

  Column width comes from the column model, never from content — a
  name-driven width is how one pathological signal reflows a whole
  panel.

- **Is there a length beyond which we refuse?** Left open; DBC long
  symbols are bounded in practice but not by the format. Answer it with
  a measurement in the implementing phase rather than a guess.

## Exit criteria (draft — firm at grooming)

- An example DBC carries long message names, long signal names and long
  `VAL_` labels, and is used by an existing test or harness run.
- Every surface listed above renders a long name without overflowing,
  overlapping, or silently hiding the distinguishing part of the name;
  the full text remains reachable.
- No change to long-name *parsing* — the existing tests still pass
  untouched.

## Status log

### 2026-08-21 — (branch `task-96-long-names`)

Branched from `task-97-enum-axis-ticks` (`f22b1b2a`). Five commits:
`b6fca9c8` (the example DBCs), `9efe555b` (the `NameText` primitive,
the stylesheet guard and the three CSS defects it found), `6a2a5935`
(the primitive applied to every name surface), `a2425b7e` (long `VAL_`
labels — the lane tile, the prose comboboxes, the tooltips) and
`4c79b21b` (the axis label, and the answer to the length question).

#### The parse layer really was already correct — the evidence

Grooming's claim was checked before anything was built, with a
throwaway `cannet-dbc` integration test (deleted before commit) parsing
a DBC that carries the extension **and controls that discriminate**: a
short-named signal in the same message, and a whole second message with
no long symbols at all. Data printed by the probe:

```
warnings: []
MSG 0x100 name="BatteryManagementSystemThermalDerateAdvisoryReport" (len 50)
          comment="comment on the long-named message"
   SIG name="BatteryPackThermalDerateRequestLevelPercentage" (len 46)
       comment="comment on the long-named signal"
       table=[(0,"ThermalDerateInactiveNominalOperatingEnvelope"),(1,"Warm")]
   SIG name="ControlSig" (len 10) comment="" table=[(0,"Zero"),(1,"One")]
MSG 0x101 name="PlainMsg"   SIG name="PlainSig"
FLAT BatteryManagementSystemThermalDerateAdvisoryReport.BatteryPack...
```

Three things that could each have been wrong are right: the rename
lands on `name` for both message and signal; the `VAL_` table and the
`CM_` comment, which `can-dbc` keys on the **short** name, still attach
after the rename (`parse.rs` looks them up with `s.name` before the
rename is applied — lines 72–100); and `db.signals()`, the flat list
the plot picker reads, carries the long names too. The controls stayed
short, so this is a discrimination and not the probe reporting itself.
No parsing code was touched by this task; `resolves_long_symbol_...` and
`signal_fingerprint.rs`'s rename test are untouched and green.

#### What "not rendered properly" actually is — four failures, not one

A throwaway probe (deleted before commit) read `index.css` as text —
the `dockPanelScrolling.test.ts` idiom, because jsdom does no layout —
and printed the overflow declarations of every name-bearing selector,
with `.col-data` and `.rbs-data` as **controls** (numeric columns, not
names). The failures separate into four kinds:

| Kind | Surfaces | Declarations today | What a long name does |
| --- | --- | --- | --- |
| **F1 nothing clips** | `.signal-name`, `.signal-value` (disclosed trace rows); `.rbs-sig-name`; `.signal-value-label` | `color` only; `.rbs-sig-name` adds `min-width: 140px` | the flex item will not shrink below its content, so the name pushes the value out of the 32 rem line; the `<td>` widens and the table scrolls sideways |
| **F2 clipped, unmarked** | `.dbc-row-label` (no rule at all), `.dbc-row-value` | clipped by `.dbc-row`'s `overflow: hidden` | cut mid-glyph with nothing to say it continues |
| **F3 end-ellipsis** | `.trace-row span`, `.trace-header > span`, `.plot-signal-name`, `.plot-signal-message`, `.plot-area-axis-label`, `.tx-col-name`, `.tx-dbc-name`, `.combobox-trigger-label`, `.combobox-option`, `.graph-node-title`, `.graph-node-sub`, `.colormap-enum-label`, `.palette-item-label` | `overflow: hidden; text-overflow: ellipsis` | hides the tail — which for a DBC symbol is the distinguishing part; most carried no tooltip either, so the full text was unreachable |
| **F4 the label vanishes** | the plot's enum lane tiles (canvas) | `tileLabelX` returns `null` when the visible tile is narrower than the label, and the caller drew nothing | a long `VAL_` label is not truncated, it is **absent** — and with the axis ticks now bare numbers, the tiles are the only thing naming a value |

F4 is the one worth calling out: it is a *regression in reading*, not
just in looks, and it interacts with the task landed immediately before
this one.

#### The rule, and where it does not apply

The overseer's ruling — middle-ellipsis on names, end-ellipsis on enum
labels, full text reachable, width from the column model — lands as
`NameText` over the pure `splitName`:

- **Below the classic 32-character identifier limit it is a no-op**,
  rendering the same single text node as before. That is what let it go
  in at every name site in one commit without moving a single existing
  assertion, and it is why every new test carries a short name beside
  the long one: the control is that the short one is *not* split.
- Past the limit the name is a shrinkable head plus a fixed tail, and
  only the head carries `text-overflow`. The split lands on the word
  boundary nearest ten characters from the end, searched **outward** in
  both directions — searching only backwards gave `...yBroadcast` where
  the boundary one character forward gives `...Broadcast`.
- The width is `max-width: 100%`, never content. A flex or grid item's
  automatic minimum size is 0 once its overflow is not `visible`, so
  the `overflow: hidden` the guard already demands is the same
  declaration that stops a name deciding a track's width — which is why
  `nameOverflow.test.ts` asserts the one and not, redundantly, the
  other.
- Enum labels stay end-ellipsis with a tooltip: prose reads front-first.
  `Combobox` therefore takes `proseLabels`, since the same component
  lists signal names in one place and `VAL_` labels in another.

#### Surfaces, and the test that earns each

| Surface | Was | Now | Test |
| --- | --- | --- | --- |
| Trace message column (both trace views) | F3 | `NameText` | `TraceView.signals.dom.test.tsx` → "splits the message column's name so its tail survives" |
| Disclosed signal rows | F1 | CSS fix + `NameText` | same file → "splits a disclosed signal's name, and leaves a short one alone" |
| Signals grid | F3 | `NameText`, keeping the drag/recolor hint as the tooltip | `SignalsPanel.dom.test.tsx` |
| Plot legend (name + message line) | F3 | `NameText` | `PlotPanel.dom.test.tsx` → "splits a long signal name and the message line beneath it" |
| Plot axis label | F3 | `NameText` | `PlotPanel.dom.test.tsx` → "splits the signal name an individual axis is labelled with" |
| Plot enum lane tiles | **F4** | `fitTileLabel` | `PlotArea.draw.test.ts` (4 cases) + `plotEnumLanes.test.ts` (4) |
| Signal-mapping panel | F3 | `NameText` | `ViewSignalsPanel.dom.test.tsx` |
| RBS signals panel | F3 | `NameText` | `RbsSignalsPanel.dom.test.tsx` |
| RBS tree | F1 | CSS fix + `NameText` | `RbsPanel.dom.test.tsx` |
| Transmit frame row + signal table | F3 | `NameText` | `TransmitPanel.dom.test.tsx` |
| Dropdowns | F3 | `NameText`, or a tooltip under `proseLabels` | `Combobox.dom.test.tsx` (2 cases) |
| Database panel tree + value column | **F2** | CSS fix + `NameText` | `DatabasePanel.dom.test.tsx` |
| Project graph nodes | F3 | `NameText` | `ProjectGraphPanel.dom.test.tsx` |
| Goto palette | F3 | `NameText` | covered by `nameOverflow.test.ts` + `NameText.dom.test.tsx` |
| `VAL_` label in a value cell | F1 | CSS fix + tooltip | `SignalValueCell.dom.test.tsx` |
| Colormap enum list | F3 (correct for a label) | tooltip added | `ColorMapPanel.dom.test.tsx` |

`ProjectGraphPanel.dom.test.tsx`'s `@xyflow/react` stub had to grow a
`nodes` / `nodeTypes` render: without it the panel's nodes never reach
the DOM and nothing about a node's markup was testable at all.

#### The example DBCs, and their blast radius

`zonal.dbc` gains `CentralComputeThermalDerateAdvisoryBroadcast`
(`0x6F0`, 100 ms) with three long-named signals, two short-named
controls, and an enum whose `VAL_` labels reach 44 characters.
`bms.dbc` gains `BmsThermDerateAdv` (`0x303`, 200 ms) of the same
shape. The generator learned a `long_name` on both `Sig` and `Msg` and
derives the truncated identifier from the real name, so the two cannot
drift; `pack.dbc` regenerates byte-identical, which is the determinism
the generator promises.

What the change touches, checked rather than assumed:

- `crates/cannet-dbc/tests/ev_zonal_fixture.rs` — a new test pinning
  the long names, the long labels, the short controls, and that the
  `System...LongSymbol` placeholders stay out of displayed metadata.
  The existing "150+ messages" assertions still hold (zonal: 151 → 152
  messages, 536 → 541 signals; the README's table updated).
- `crates/cannet-perf-measurement/tests/example_artifacts.rs` — same
  test for `bms.dbc`. Its `schedule_is_periodic_and_realistic` asserts
  every DBC message is scheduled and the aggregate rate stays in the
  300–600 f/s band; the new message adds 5 f/s to a ~515 f/s workload,
  and `colormaps_match_dbc_enum_value_tables`,
  `example_parses_and_is_consistent` and
  `layout_opens_representative_views` are unaffected (no RBS override,
  no colormap, no project element references it). All six pass.
- No project, RBS or layout file was edited, so no saved view changes.
- **The perf gate**: `ev-zonal` is the ADR-0031 render-tier project, so
  it now carries long names in the measured path — the ruling's stated
  intent. The harness is the overseer's and was **not run** by this
  phase, so the same-day control the grooming note asked for was not
  taken either. Recorded under blockers.

#### The length question, answered by measurement

*Is there a length beyond which we refuse?* **No.** Measured with a
throwaway test (deleted): `splitName` costs 0.0003 ms at 100 000
characters (its search window is bounded, so it is flat in the name's
length); `fitTileLabel` makes the same **three** `measureText` calls at
100 000 as at 45, because it starts from a proportional guess; and the
rendered box is the same size at every length, since only the tail is
unshrinkable and the tail is capped at 16 characters. The one cost that
is *not* flat is the engine's — `text-overflow: ellipsis` shapes the
whole line to place the mark — so the head is capped at 200 characters,
which is more than the app's widest column can show, with the full name
still on the tooltip. Nothing is refused and nothing is lost.

#### Verification

- `npx tsc --noEmit` clean; `npx vite build` clean.
- `npx vitest run` — **2495 passed / 189 files** (baseline 2457 / 186;
  +38 tests, +3 files: `nameEllipsis.test.ts`, `NameText.dom.test.tsx`,
  `nameOverflow.test.ts`).
- `cargo test -p cannet-gui` 837 passed / 6 ignored (unchanged);
  `cargo test -p cannet-dbc --lib` 112 (unchanged);
  `cargo test --workspace` — 47 test binaries, 0 failures;
  `cargo clippy -p cannet-dbc -p cannet-perf-measurement --all-targets`
  clean apart from one pre-existing `redundant closure` in
  `cannet-dbc/src/tests.rs:615` (untouched);
  `cargo fmt --all -- --check` clean.
- `git grep -Ein "task [0-9]|plans/" -- apps/ crates/` empty.
- The render-tier perf harness was **not** run — the overseer owns it.

#### Exit-criterion verdicts

| Criterion | Verdict | Earned by |
| --- | --- | --- |
| An example DBC carries long message names, long signal names and long `VAL_` labels, and is used by an existing test or harness run | **met** | both do. `ev_zonal_fixture.rs` → `zonal_dbc_carries_the_long_name_example`; `example_artifacts.rs` → `example_carries_the_long_name_case`. `ev-zonal` is the render-tier harness's project and `ev-demo` the rest-of-bus workload's, so both enter a harness run as well as a test |
| Every surface renders a long name without overflowing, overlapping, or silently hiding the distinguishing part; the full text remains reachable | **met** | the per-surface table above — sixteen surfaces, each with a named test. Overflow/overlap: `nameOverflow.test.ts` → "clips it, and says so with an ellipsis" walks all eighteen selectors, and was red on five before the fix. Hiding the distinguishing part: `NameText.dom.test.tsx` → "shows the distinguishing tail of two names that share a prefix", and every panel test asserts the tail. Reachability: the tooltip is asserted on `NameText`, on the `VAL_` label in a value cell, in the colormap list and on a prose combobox |
| No change to long-name *parsing* — the existing tests still pass untouched | **met** | no file under `crates/cannet-dbc/src/` was modified (the branch's diff touches only `crates/cannet-dbc/tests/`), and `resolves_long_symbol_message_and_signal_names` plus `signal_fingerprint.rs`'s `SystemSignalLongSymbol` rename test pass unmodified in the workspace run |

## Blockers / side effects

- **The perf gate was not run, so the same-day control the grooming
  note asked for does not exist.** The note asked the implementing
  phase to run the render-tier gate *before* the DBC change so a limit
  breach could be attributed to the long names rather than to machine
  state; the phase contract forbids running the harness (the overseer
  owns it). Both instructions cannot be honoured, so the contract won:
  the harness was not run at all, before or after. If the overseer's
  next run shows a breach on `ev-zonal`, there is no same-day
  pre-change reading to compare it against — a second run on
  `b6fca9c8~1` would supply one.
- **`Combobox` gained a `proseLabels` flag rather than inferring it.**
  The ruling splits names from enum labels, but the component is
  generic and its options are `{value, label}` strings — it cannot tell
  one from the other. The two enum value pickers (`rbsValueCell`,
  `TransmitSignalsTable`'s `EnumValueCell`) opt in; every other
  combobox lists names and takes the default. A picker added later that
  lists prose will middle-ellipsize it until someone sets the flag.
- **One test's premise was deliberately reversed.**
  `PlotArea.draw.test.ts`'s "draws no box on a tile too narrow to
  label" asserted exactly the behaviour F4 is: it is now "boxes the
  ellipsized label on a tile too narrow for the whole one", with a new
  case keeping a genuinely-too-narrow tile bare.
- **User-authored text was left alone**, deliberately: event labels
  (`.trace-event-label`), signal-view section names, DBC comments and
  file paths are prose or paths, not entity names, and the ruling is
  about names. They keep whatever they had.
- **`examples/ev-zonal/dbc/pack.dbc` shows as modified in the working
  tree with an empty diff** — the generator writes LF and the checkout
  is CRLF. It is byte-identical content, was not staged, and is the
  same class of noise as the pre-existing
  `apps/gui/src-tauri/Cargo.toml` entry. Left alone, along with the two
  untracked `scratch-perf*` directories.
