# Task 100 — Counter / CRC From the DBC Does Not Reach the Fields Editor

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> if the counter or CRC is in the DBC, our 'fields' model in the
> frontend doesn't get populated correctly. The edit controls/checkboxes
> don't come up with the DBC config.

## What the host already does

The host side looks correct, which localises the defect:

- `cannet-dbc/src/calc.rs` parses the `CannetCounter` and `CannetCrc`
  `BA_` attributes (ADR 0027), both the named-algorithm and raw forms,
  with tests covering defaults, typos and malformed input.
- `Database::dbc_calculated_fields(can_id)` returns the parsed config
  per message.
- `app_state.rs` resolves the DBC default and layers the file's
  override over it per field (`merge_calc_override`), and the same
  resolution happens in `rbs/view.rs`, `rbs/signals.rs`,
  `dbc_commands.rs` and `transmit_commands.rs`.
- `CalcFieldsSpec` (`ipc.rs`) is the wire shape, with round-trip tests.

So the parse, the resolution and the IPC type exist. The gap is between
that resolution and what `CalcFieldEditor.tsx` renders — the editor
fetches `rbs_crc_algorithms` on mount but the investigation needs to
establish what it does (or does not) receive for the message's own
resolved config.

## Sequencing: this lands after task 92

**Three of the resolution sites above are task 92's Shape A sites** —
`app_state.rs`, `verification.rs` and `transmit_commands.rs` all reach
for the calculated-field default with
`dbs.iter().filter(dbc_applies).find_map(...)`, which task 92 identifies
as taking the attribute from *the first eligible database that has one*
rather than from the database that actually decodes the message.
[ADR 0054](../../docs/adr/0054-a-decoded-value-has-one-definition.md)
part 3 forbids that.

So task 92 will be **moving this exact code**, and it may also change
the answer: a project with two databases on a bus could today be
populating the editor from the wrong file's counter config. Running
this task first would mean writing tests against resolution behaviour
that is about to change.

## Scope

- Investigation first: is the resolved config reaching the frontend at
  all, reaching it in the wrong shape, or reaching it and being ignored
  by the editor's state initialisation? Each has a different fix and
  the status log must record which, with the data.
- The editor's controls and checkboxes reflect the DBC's config when
  the file supplies no override, and reflect the layered result when
  it does — `merge_calc_override` is per-field, so a message with a
  DBC counter and a file CRC override must show both.
- A regression test at whichever layer the defect turns out to live in.

## Open questions — grooming

- ~~Should the editor distinguish "from the DBC" from "overridden
  here"?~~ **Decided by the overseer 2026-08-20: yes, reusing the
  existing vocabulary.** The host already tracks it —
  `RbsMessageView` carries `counterOverridden` and `crcOverridden` —
  and the RBS signals grid (task 89 phase 6) already names this
  distinction *Default* versus *Override*. A second vocabulary for the
  same fact is the drift this repo keeps paying for; reuse it.
- ~~Does an unparseable DBC attribute surface anywhere?~~ **Decided by
  the overseer 2026-08-20: in scope, and it warns.** `calc.rs` returns
  a descriptive `Err` for a typo like `rolover=15`, and `app_state.rs`
  then `continue`s past the failure silently — so a user with a typo'd
  attribute sees no counter and is given no reason, which is
  indistinguishable from the defect this task exists to fix. One system
  log entry naming the file, message and attribute text. Found while
  scoping; fixed here rather than recorded, per the standing rule that
  small bugs found get fixed with a test.

## Exit criteria (draft — firm at grooming)

- A message whose DBC declares a counter or CRC opens the editor with
  those controls populated; tested.
- A file override layers over the DBC default per field, visibly.
- The root cause is stated with the experiment's data that confirmed it.
