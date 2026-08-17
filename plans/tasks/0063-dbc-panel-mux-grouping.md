# Task 63 — Group Multiplexed Signals by Mux Arm in the DBC Panel

The DBC discovery panel renders a message's signals in `SG_` declared
order. For a multiplexed message that interleaves the arms: a real BMS
event message with one multiplexor and nine arms (46 signals) reads as
one flat list in start-bit order, `m3, m9, m5, m3, m2, …`. The arm a
signal belongs to is only visible with the panel's **details** toggle
on, and then only as a bare selector number (`mux arm m5`) with no
connection to the multiplexor's `VAL_` label.

Consequences: you cannot see which signals belong together, and the
only bulk drag target is the message row — which hands the plot all 46
signals across all nine arms. Plotting "everything in the AFEStatus
event" is a nine-signal manual multi-select.

## Scope

Insert an optional **mux-arm level** into the panel's tree for arms
that actually group something. The level appears only where it earns
its indent; every other shape renders exactly as before.

- **Only an arm with two or more signals gets an arm row.** A
  single-signal arm groups nothing — the index-style diagnostic shape
  (one self-named signal per selector, e.g. `Cell01_DeltaSOC m0`,
  `Cell02_DeltaSOC m1`, …) would gain a whole layer of one-child
  containers. Its signal renders in the flat list instead; the arm
  stays visible in the signal's details line, and a named arm's `VAL_`
  label still joins the signal's search haystack.
- **Named arms nest under the multiplexor's own row** (which becomes an
  expandable selectable branch); unnamed arms sit directly under the
  message. A `VAL_` table on the selector is what makes it a category
  header (enum-style) rather than an array index (index-style) — and
  the nested shape is the depth-1 case of the extended-multiplexing
  tree, so it extends rather than being redone when that lands.
- Arm label is the bare `VAL_` name, falling back to `m<N>` when the
  DBC declares no (non-empty) `VAL_` entry for that selector. The
  `m<N>` notation stays in the details line.
- The multiplexor signal itself and any `plain` signals stay directly
  under the message (they are present on every frame regardless of the
  selector). Grouped arms are ordered by selector, ascending.
- An arm row is selectable and **drag-drops every signal in that arm**
  — the one-gesture path to a plot panel. It does not include the
  multiplexor: that is a mode indicator on an unrelated scale, and it
  stays draggable on its own row.
- Message-row drag keeps its current meaning (every signal in the
  message). Narrowing it would be a silent regression.
- Search matches arm labels, and a signal's arm is woven into its
  fuzzy-search haystack, so `CellVoltageStatus` reveals that arm and
  its signals.

No host change: `DbcSignalContentRecord.mux` and the multiplexor's
`valueTable` are already in the `list_dbc_content` payload the panel
holds. The grouping is display shaping over a static model snapshot —
the same role `groupByEcu` already plays in this panel — not a
re-derivation of a decode fact.

**Extended multiplexing (`m<N>M`, `SG_MUL_VAL_`) is not grouped at
all** — the message keeps its flat signal list. Each `m<N>` selector
lives in its own multiplexor's namespace and `SignalMuxRecord` carries
no parent link, so bucketing by the bare number would merge unrelated
arms under wrong labels. The message detail row surfaces the caveat via
`usesExtendedMux`; real nesting is the follow-up task 85 (host-side
`SG_MUL_VAL_` modelling).

## Exit criteria

- A multiplexed message renders one arm row per selector that carries
  two or more signals, ascending, labelled from the multiplexor's
  `VAL_` table (bare `m<N>` when absent); named arms nest under the
  multiplexor row, unnamed arms under the message; single-signal arms
  render flat.
- An all-single-arm (index-style) message and a non-multiplexed message
  render identically to the pre-task tree — no extra level, no changed
  depth.
- An extended-mux message renders its flat signal list unchanged.
- Dragging an arm row onto a plot panel adds exactly that arm's
  signals; dragging the multiplexor row adds only the multiplexor.
- Searching an arm's `VAL_` label reveals that arm through the
  multiplexor and prunes the rest; a flattened arm's `VAL_` label still
  finds its signal.
- Keyboard tree navigation walks into and out of the multiplexor and
  arm rows; expand state for both round-trips through the saved layout.
- Tests cover the grouping function directly and each of the above
  through the panel's DOM.
- The panel's rustdoc-equivalent header comment and the README's DBC
  panel description name the new level.
