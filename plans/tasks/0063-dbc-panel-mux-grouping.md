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

Insert an optional **mux-arm level** between message and signal in the
panel's tree, so it reads bus → DBC → ECU → message → mux arm → signal.
The level appears only for messages that actually multiplex; every
other message renders exactly as before.

- The multiplexor signal itself and any `plain` signals stay directly
  under the message (they are present on every frame regardless of the
  selector). One group per selector, ascending.
- Arm label is `m<N> · <VAL_ label>` resolved from the multiplexor
  signal's own value table, falling back to bare `m<N>` when the DBC
  declares no `VAL_` entry for that selector.
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

Extended multiplexing (`m<N>M`, `SG_MUL_VAL_`) buckets by its single
selector. `SignalMuxRecord` carries no nested-range representation
today, and the message detail row already surfaces the caveat via
`usesExtendedMux`.

## Exit criteria

- A multiplexed message renders one row per selector, in ascending
  selector order, labelled from the multiplexor's `VAL_` table (bare
  `m<N>` when absent), with the multiplexor and plain signals directly
  under the message.
- A non-multiplexed message renders identically to before — no extra
  level, no changed depth.
- Dragging an arm row onto a plot panel adds exactly that arm's
  signals.
- Searching an arm's `VAL_` label reveals that arm and its signals and
  prunes the other arms.
- Keyboard tree navigation walks into and out of arm rows; expand state
  for arms round-trips through the saved layout.
- Tests cover the grouping function directly and each of the above
  through the panel's DOM.
- The panel's rustdoc-equivalent header comment and the README's DBC
  panel description name the new level.
