# Task 85 — Model Extended Multiplexing (`SG_MUL_VAL_`) End to End

The Database panel groups a multiplexed message's signals by mux arm
(task 63), but extended multiplexing is deliberately excluded: such a
message falls back to its flat signal list, with only the
`usesExtendedMux` details line as a hint. That is the honest floor, not
the feature. A nested DBC's structure — which selector switches which
signals, over which value ranges, through how many levels — is exactly
the kind of relationship the tree view exists to show.

## Background: what the format allows

Extended multiplexing (`SG_MUL_VAL_`, DBC 4+) generalises the classic
one-`M`-per-message scheme:

- A signal marked `m<N>M` is both multiplexed (rides arm `N` of its
  parent multiplexor) and a multiplexor for further signals — nesting
  to arbitrary depth.
- Each multiplexed signal's `SG_MUL_VAL_` record names **which**
  multiplexor switches it and the selector **value ranges** it rides:
  `SG_MUL_VAL_ <id> <signal> <switch> 2-4, 7-7;`. The `m<N>` number in
  the `SG_` line is meaningless without it — each multiplexor has its
  own selector namespace.
- Ranges mean arms are **not a partition**: a signal can be present for
  several selector values, overlapping other signals' ranges.
- A message may carry more than one independent multiplexor.

`can-dbc` 9 already parses all of this (`ExtendedMultiplex {
message_id, signal_name, multiplexor_signal_name, mappings: [{
min_value, max_value }] }`); `cannet-dbc` currently drops the table.

## Scope

Host first, then the view:

1. **`cannet-dbc`**: consume `Dbc::extended_multiplex()`; derive, per
   signal, its switching multiplexor and value ranges. Decide the
   in-memory shape (parent link + ranges on the signal, or a per-message
   mux tree). Decode must respect it too: a nested signal is present on
   a frame only when *every* multiplexor on its path carries a matching
   selector value — verify what the current decode does for
   `MultiplexorAndMultiplexed` signals and fix if it decodes
   unconditionally.
2. **IPC**: extend `SignalMuxRecord` (and the TS `DbcSignalMux` mirror)
   with the parent-multiplexor name and ranges. `usesExtendedMux` stays
   as the message-level summary flag.
3. **Database panel**: replace the flat fallback with a recursive
   render of the mux tree — the task-63 shape applied at each level
   (named arms nest under their multiplexor, single-signal arms
   flatten, range arms labelled from the switching multiplexor's `VAL_`
   or as `m2–m5`). Decide overlap presentation: a signal riding several
   values under one arm row per *distinct range*, not duplicated per
   value.
4. **Transmit / RBS surfaces**: `TransmitSignalsTable` currently drops
   `multiplexor_and_multiplexed` rows entirely; with real parent+range
   data it can render them under their active selector path.

## A rich example is part of the task

Neither the repo examples nor the reference test data exercise extended
mux — which is how the task-63 fallback stayed honest but also how a
wrong implementation would have gone unnoticed. This task adds a
worked example to `examples/` (a diagnostic-style message with at least:
two levels of nesting, a ranged mapping like `2-4, 7-7`, an arm whose
inner multiplexor has its own `VAL_` labels, and a single-signal inner
arm), used by both the Rust fixture tests and the panel's DOM tests,
and documented in the example's README.

## Design questions

- In-memory shape: ranges-on-signal vs a message-level mux tree — which
  serves decode and the view without re-derivation in JS (the paged-
  model rule: domain computation belongs in the model)?
- Does per-frame decode gating on the full multiplexor path change any
  existing decode behavior users rely on (extended-mux signals that
  today decode unconditionally)?
- How do range arms interact with expand-state node ids (task 63 keys
  arms by raw selector; a range needs a stable key too)?

## Exit criteria

- `cannet-dbc` parses `SG_MUL_VAL_` and exposes parent + ranges;
  decode emits a nested signal only when its whole selector path
  matches, with regression tests either way.
- The example DBC described above exists, loads, and drives both Rust
  and DOM tests.
- The Database panel renders the example as a nested tree (correct
  parents, range labels, flattening at each level) with search, drag,
  keyboard, and expand-state persistence working at depth ≥ 2 — the
  task-63 exit criteria, recursively.
- The task-63 flat fallback and its "unresolvable here" comments are
  removed in the same change (no stale caveat).
- README and the panel header comment describe the nested rendering.
