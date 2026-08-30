# 0113 — Is RBS a Grid?

> **Status 2026-08-25 — groomed with the owner.** Queue items **1.6, 1.26
> and 1.13c**, from the 2026-08-24 walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 1. Fully ruled; no
> open questions. No phases yet.

RBS and transmit adopt the gridview contract the trace views already
implement. Grooming turned up a **layer-wide defect** in that contract
(§ 4), which this task fixes because it is what "consistent everywhere"
requires.

## 1. RBS and transmit rows become grid rows · 1.6

> *"RBS rows should let me select them and then tab into the signals.
> There may be views (transmit, perhaps) that are less gridview-y but RBS
> seems exactly the same and it's really weird to use."*

`gridviewContentRows.ts` already makes disclosed content into real rows
with ids, order, cursor and selection.
[`TraceView.tsx`](../../apps/gui/src/TraceView.tsx) and
[`ByIdTable.tsx`](../../apps/gui/src/ByIdTable.tsx) import it.
[`RbsPanel.tsx:315`](../../apps/gui/src/RbsPanel.tsx#L315) and
[`TransmitPanel.tsx:400`](../../apps/gui/src/TransmitPanel.tsx#L400) call
`useGridview` but never adopted it — the transmit hedge names a panel in
the *identical* state, not a different one.

**Ruled 2026-08-25:** *"transmitpanel does the same."* Both panels adopt,
in one pass.

**The keyboard contract is the shipped one, not a new one** — the owner
restated it and it is what `useGridview` implements:

| Key | Does |
|---|---|
| Arrows | move around the grid / tree, disclosed content rows included |
| Tab | moves *within* the cursor row, onto its controls |
| Shift+Tab | from the first control, back out to nav |
| Esc | from a control, back out to nav |

**Work:** adopt `gridviewContentRows` in `RbsPanel` and `TransmitPanel`.

## 2. Space on an RBS signal row does nothing · 1.26

**Ruled 2026-08-24:** *"space on signal rows should do nothing; you can't
send part of a message, and I don't want it to toggle the message."*

**Work:** make it inert. Space on an RBS *message* row is unchanged.

## 3. Row highlighting is the gridview's · 1.13c

> *"the prototype eliminated the row highlighting - it shouldn't be present
> with a toggle in the final GUI."*

**Ruled 2026-08-25:** *"row highlighting is a gridview behavior."* That is
the reason, and it settles the item without reference to the prototype —
which, for the record, **kept** row highlighting and merely omitted drawing
it (its own comments at
[`gui-chip-redesign.html:744`](../prototypes/gui-chip-redesign.html#L744)
and `:802`). The prototype was never the argument.

**The collision is on one DOM node.**
[`ViewSignalsPanel.tsx:547`](../../apps/gui/src/ViewSignalsPanel.tsx#L547)
builds a row's class list as
`view-signals-row--wash-<status>` *and* `selected` together: a
panel-invented row background competing with the gridview's own selection
indication. ADR 0044's 2026-08-23 amendment already rules on that — *"the
row's own cursor styling is the focus indication"* — so the wash is a panel
re-implementing what the layer owns, and which of the two reads is a
question of stylesheet order.

**Work, on both signal-mapping surfaces, which move together or disagree:**

| | Goes |
|---|---|
| The wash | [`ViewSignalsPanel.tsx:419-424`](../../apps/gui/src/ViewSignalsPanel.tsx#L419-L424), [`RbsSignalsPanel.tsx:358-362`](../../apps/gui/src/RbsSignalsPanel.tsx#L358-L362), and the `--wash-*` rules |
| The **Row Highlights** chip | it controls nothing else — its title is *"highlight each row's background by its status; the status column always names it"* |
| `washesOn` as persisted panel state | [`ViewSignalsPanel.tsx:177-189`](../../apps/gui/src/ViewSignalsPanel.tsx#L177-L189) reads it from `params` and writes it back; workspace state for a behaviour the layer owns |

**Stays:** the per-row status chip icon, and the status text at
[`RbsSignalsPanel.tsx:453`](../../apps/gui/src/RbsSignalsPanel.tsx#L453),
which stops being conditional. The **"N of M" footer chip** is a different
control and is untouched.

## 4. Escape must not cascade out of a fullscreened panel

**Found while grooming § 1, and it is not an RBS bug — it is the
`useGridview` layer, so it reaches every grid panel.**

`commands.ts:276` binds plain `Escape` to `view.exitFullscreen`, gated to
`hasMaximizedView`. The dispatcher runs on the **capture phase** and calls
`preventDefault` ([`useCommands.tsx:757`](../../apps/gui/src/useCommands.tsx#L757)),
and the grid's way out of a row's content guards on `!e.defaultPrevented`
([`useGridview.ts:193`](../../apps/gui/src/useGridview.ts#L193)) — so it
stands down.

**Reproduce:** fullscreen a grid panel, Tab into a row's control, press
Escape. Fullscreen exits and focus stays stuck on the control.

**Ruled 2026-08-25:** *"that esc should be swallowed and not cascaded up to
the view, in case it's fullscreened."* Then, on the two-press layering:
*"Yes, that's what I just said I wanted."*

**Work — a narrow inversion, not a rewrite of the rule.** "Content keeps
first claim" stays: a combobox closing its own dropdown on Escape still
wins. The defect is that a **global command** is being counted as content.
Separate the two so the grid beats the global binding:

1. Escape on a row control → focus returns to the container, press
   swallowed, fullscreen untouched.
2. Escape again, now on the container → falls through the existing
   "leaves Escape alone when the container itself has focus" branch and
   exits fullscreen.

[`useGridview.dom.test.tsx:653`](../../apps/gui/src/useGridview.dom.test.tsx#L653)
("leaves an Escape a global command took to that command") pins the
current behaviour and names `view.exitFullscreen` in its comment. **It is
inverted by this change**, and its comment rewritten to say why the grid
now wins.

## 5. A Default column on the RBS signals grid · 3.8

**Ruled 2026-08-26**: *"add default value column. 'none' where we're
currently adding 'detail' saying 'no start value...'"* The RBS feed
collapses the DBC and override layers, so an overridden field's "DBC
default" is invisible and the undefaulted case rides the free-text
detail (`rbs/signals.rs:193` — *"no start value in the DBC — bits are
the file's fill"*). Instead: a **Default** column on the grid
(`rbsSignalsColumns.ts`), showing the DBC's start value where one
exists and `none` where it does not; the detail cell stops carrying
that sentence.

## 6. ADR 0044

Two amendments, in the same commit as the code:

- **The editor-face carve-out is deleted.** It reads *"Content that is an
  editor face rather than a list — a transmit tile's frame-shape and byte
  editors, an RBS message's value cells — stays a block below the row and
  is reached by Tab, not by the cursor."* Those are the only two panels it
  names, and both adopt content-rows here, so it has no occupants left.
  Deleted rather than re-scoped, with a dated amendment note saying the
  distinction did not survive contact with the panels it was drawn for.
- **Escape's precedence is stated** — content beats the grid, the grid
  beats a global binding, and a press that reaches the container is the
  global binding's.
- **Row background belongs to the layer.** Cursor and selection are what
  paint a row; a panel encodes per-row state in a *cell* — a chip, an
  icon, text — never in the row's background, and never ships a toggle
  for doing so. Written from § 3's ruling.

## Exit criteria

1. **Selecting an RBS row and arrowing into its signals works in a running
   build**, matching the trace views. Reading the code is not evidence.
2. **`TransmitPanel` does the same**, in this task.
3. **Space on an RBS signal row does nothing**, pinned by a test; the
   message row's behaviour is unchanged and still pinned.
4. **Escape from a row control returns to nav without leaving fullscreen,
   and a second Escape leaves it**, pinned by a test that replaces
   `useGridview.dom.test.tsx:653`.
5. **Neither signal-mapping surface paints a row background**, and
   neither ships a Row Highlights chip or a `washesOn` param. Pinned by a
   test that the status is still legible with the wash gone.
6. **The RBS signals grid carries a Default column** — the DBC start
   value where one exists, `none` where not — and the detail cell no
   longer says "no start value…". Pinned by a test each way.
7. **ADR 0044 carries all three amendments**, dated, in the same commit.
8. **Queue rows 1.6, 1.26, 1.13c and 3.8 are recorded closed** with the
   date.
9. **Full CI green** — seven jobs, each named with its command.


## Status log

### 2026-08-27 — the whole task, one phase (`task-113-rbs-grid`)

All six work items and the three ADR amendments landed together; the
Escape fix came first because the other items put the cursor inside
rows where it bites.

| § | What landed |
|---|---|
| 1 | `RbsPanel` and `TransmitPanel` disclose their signals as **rows of the space** |
| 2 | Space on an RBS signal row is inert, pinned |
| 3 | Both signal-mapping grids paint no row background; the wash, the chip and `washesOn` are gone |
| 4 | The dispatcher stands down on plain Escape inside a row, so the grid beats a global binding |
| 5 | A **Default** column on the RBS signals grid, `none` where the DBC declares no start value |
| 6 | ADR 0044 carries the three amendments, dated 2026-08-27 |

**§ 4 first, and by the scientific method.**

- *Observation.* `useGridview.dom.test.tsx`'s "leaves an Escape a global
  command took to that command" passed while the grid's way out of a row
  was dead under a fullscreened panel.
- *Hypothesis.* The grid cannot distinguish "content consumed it" from
  "a global binding consumed it", because both arrive as
  `e.defaultPrevented`.
- *Experiment.* Made the test's dispatcher faithful — `useCommands`
  calls `stopPropagation` as well as `preventDefault` on a consumed
  stroke, and the harness had omitted it — then asserted the two-press
  layering the ruling asks for.
- *Data.* With the suppression disabled the new test fails with
  `expected [ 'view.exitFullscreen' ] to deeply equal []`: the global
  binding takes the press. With it enabled, press one returns focus to
  the container with the cursor intact and press two exits fullscreen.
- *Conclusion.* The fix is a **dispatch-side** stand-down, not a
  container-handler change: `dispatchStroke` gains `inGridviewContent`
  and refuses plain Escape when the target is inside a gridview but is
  not the container (`isGridviewContentTarget`,
  `isGridviewContentKey`). `useGridview`'s `!e.defaultPrevented` guard
  is untouched, which is what keeps *content* first in line — pinned by
  a second test where the combobox stand-in consumes the press and
  neither the grid nor the binding takes it. `chordSuppressedInGridview`
  is deliberately unchanged: Escape still fires from the container, so
  the shortcuts view is right to show it as live in a grid.

**§ 1, RBS.** `makeRbsRowSpace` now takes the expansion predicate and
splices an open message's signals in at depth 3, ids spelled through the
layer's own `contentRowId`. The `<tr>`s carry `role="treeitem"` and the
`<table>` around them `role="presentation"`, so the table's implicit
row/cell semantics don't fight the tree's. `arrayRowSpace` already
answers everything the adapter needs, so `contentRowSpace`'s index
arithmetic — which exists for host-paged spaces — is not used here; the
panel holds its whole row set and builds the rows into its array
directly, which is the same adoption the ADR's node model asks for.

**§ 1, transmit.** The tile's *disclosed* content splits: the DBC
signals table is a list and its lines are rows; the frame-shape and
calculated-field strips are not lists and stay controls the row carries.
Which signals are on screen is the **table's** answer, not the panel's —
the active mux arm depends on the decoded switch value, which only
`SignalsTable` holds — so the table reports what it disclosed
(`SignalContentRows.onRows`) and the panel splices that into the row
space. A row space derived from the panel's signal catalog instead would
disagree with the DOM on every muxed message, naming rows the cursor
cannot reach. The report is keyed on the names themselves, not on the
callback, or the panel's per-render closure would report in a loop.
`.tx-panel-list` gained `role="tree"` and the tiles `role="treeitem"` —
owed by the 2026-08-27 roles amendment and not applied when it landed.

**§ 2.** Falls out of ids: `findRbsEnableToggle` matches a message id,
never a `…/<signal>` one, so the press resolves to nothing. Pinned both
ways — nothing fires, and the press is not redirected to the message
either.

**§ 3.** Both panels lost `washesOn` (state, param, chip) and the
`--wash-*` rules; the status word in the status cell is unconditional.
Pinned on both grids by a test that reads the status text and asserts no
row class matches `/wash/`.

**§ 5.** `RbsSignalRow` gains `default_value: Option<f64>` — the DBC
start value in **physical** units, `raw.mul_add(factor, offset)`, the
same scaling `reconstruct_payload` encodes with. The undefaulted
`Default` branch's detail becomes empty; "DBC start value" stays on the
defaulted one. The column sits beside `value`, since that is what it
explains, and sorts with `none` after every row that has a number.

Tests: frontend 3101 passing (225 files), Rust workspace 1742.

### 2026-08-27 — CI, all seven run locally

| Job | Command | Result |
|---|---|---|
| comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | green (no matches) |
| frontend | `pnpm --dir apps/gui test` then `pnpm --dir apps/gui build` | green |
| python | `uv sync --extra dev --frozen`, `ruff check`, `ruff format --check`, `mypy`, `pytest` | green (223 passed) |
| rust | `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings` | green (1742 passed) |
| mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample`, then `validate_export.py` | green |
| rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | green |
| sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | green (smoke ok) |

### 2026-08-27 — render capture (ADR 0031), three runs

Release host (`pnpm --dir apps/gui tauri build --no-bundle`), `ev-zonal`,
`--connect-on-start --rbs-run-on-start --perf-interact scrub`, 60 s each,
seeded window geometry in an isolated `--app-data-dir`. Reports:
`docs/performance-measurements/frontend/2026-08-27-fd11ff7c-rbs-grid-run{1,2,3}.json`.
`fd11ff7c` is the code commit measured — this commit is that one with
the reports and this log amended in, so the tree under measurement is
the shipped one.

Load sanity first: `rx_gap.ids_measured` 174 on every run, rx 1605–1607
f/s against the expected 1608, tx 1607–1612, and the `interact` tally
`performed: 266, missing: 0` with an empty `missing_by_gesture` — a real
load and a real gesture stream, not an idle bus.

| run | rx f/s | tx f/s | lag ms max | longtask ms/s max | jank s | tree MB | renderer MB | host MB |
|---|---|---|---|---|---|---|---|---|
| 1 | 1605.6 | 1607.4 | 17.3 | 0.0 | 0 | 731 | 312 | 62 |
| 2 | 1606.5 | 1611.9 | 13.3 | 0.0 | 0 | 723 | 309 | 59 |
| 3 | 1605.2 | 1612.1 |  4.4 | 0.0 | 0 | 723 | 310 | 62 |

`check` over all three, with `--expected-rx-fps 1608 --expected-tx-fps
1608`: **passed, 69 metrics gated**. Nothing promoted, no limit widened.

One false alarm worth recording, by the method:

- *Observation.* The first `check` invocation reported
  `grpc append_ms_max` 7.689 ms against a 6.440 limit — REGRESSED — with
  every frontend metric ok.
- *Hypothesis.* Machine contention at the moment of that run, not a code
  regression: this phase touches no host ingest path, and `check`
  re-runs the host modes live — here, seconds after three 60 s GUI
  captures.
- *Experiment.* Re-ran the `grpc` mode alone, three times, on an idle
  machine.
- *Data.* 0.797 / 0.910 / 0.857 ms — an order of magnitude under the
  failing reading and well under the limit. A repeat `check` on the same
  three reports then passed with `grpc append_ms_max` at 0.869.
- *Conclusion.* Transient contention. Not chased further.

**Exit criterion 1 is the overseer's / owner's to close.** "Works in a
running build" cannot be shown from here without UI automation, which is
barred on this machine, and the ADR 0031 harness's self-driving script
drives the plot and the trace, not the RBS tree. The build runs and the
capture is clean; the keyboard walk itself is on the acceptance
checklist.

## Blockers / side effects

- **A combobox dropdown still loses Escape to a global binding.** Found
  while fixing § 4 and deliberately left: the dropdown renders through a
  **portal** to `document.body`, so it is not inside the gridview
  container in the DOM and `isGridviewContentTarget` cannot see it. The
  capture-phase dispatcher therefore still fires first, and on a
  fullscreened panel Escape in an open dropdown exits fullscreen instead
  of closing the dropdown. This is content-vs-global, not the grid's way
  out of a row, so it is outside § 4's ruling — but the precedence the
  ADR now states ("content beats the grid, the grid beats a global
  binding") implies content should win here too. Fixing it means marking
  a portal as belonging to its host surface, which is a layer decision
  of its own.
- **The columned gridviews still carry no ARIA roles.** `GridviewRow` /
  `GridviewHeader` render plain `div`s, so the view-signals and RBS
  signals grids have neither `role="tree"` on the container nor
  `treeitem` on the rows — what ADR 0044's 2026-08-27 roles amendment
  requires. The transmit list is fixed here because its content rows
  needed the markup anyway; the two columned panels are untouched, and
  their `aria-activedescendant` names an element with no role.
