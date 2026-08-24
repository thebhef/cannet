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

## Exit criteria

- A message whose DBC declares a counter or CRC opens the editor with
  those controls populated; tested.
- A file override layers over the DBC default per field, visibly.
- The root cause is stated with the experiment's data that confirmed it.

## Blockers / side effects

Recorded 2026-08-21.

- **A DBC-declared field cannot be suppressed from the project, and
  the seeding change is what makes that reachable.** The override
  layer expresses two things — "replace this field" and "leave this
  field alone" (`merge_calc_override` is `o.counter.or(default)`) —
  and there is no third value meaning "the DBC designates a counter,
  this project wants none". So unchecking a section that is showing a
  DBC `Default` writes no override, and the field is back on reopen.
  That is
  [ADR 0027](../../docs/adr/0027-calculated-fields-counter-crc.md)'s
  model as written, and the editor's own docstring has always said
  clearing a section restores the DBC default; what changed is that
  such a section is now *on*, so its toggle is a live control over a
  DBC-declared field for the first time. Expressing suppression would
  mean a new value in `CalcFieldsSpec` **and** in the `.cannet_rbs`
  document — an ADR-level change to what an override is. Named rather
  than taken.
- **The RBS feed collapses the two layers, so the editor cannot say
  what an override replaced.** `RbsMessageView` carries the
  *effective* `counter` / `crc` plus a `counterOverridden` /
  `crcOverridden` boolean, so `RbsPanel`'s `calcDefaultsOf` can only
  report the DBC layer for fields that are **not** overridden. On an
  overridden field the `Override` chip is right but the
  "DBC default: …" hint beside it is empty, where the transmit panel
  — whose `MessageDescriptorRecord.calcFields` carries the DBC layer
  whole — fills it in. Closing it means carrying both layers on the
  RBS message view rather than the merged one.
- **A section counts as edited from the first keystroke, not from a
  changed value.** Typing into a `Default` section and typing the
  original value back leaves it an `Override` of a designation
  identical to the DBC's. A structural comparison against the default
  would close it; it was not worth a second definition of "these two
  specs are the same", since the numeric fields live as strings in
  the controls and as numbers or `0x…` strings on the wire.

## Status log

### 2026-08-21 — (branch `task-100-calc-fields-dbc-config`)

Branched from `task-99-transmit-controls` at `86e29243`. Baselines:
`cargo test -p cannet-gui` **850 passed, 6 ignored**; `cargo test -p
cannet-dbc --lib` **111**; `npx vitest run` **2504 passed / 189
files**; clippy clean but for the pre-existing `redundant_closure` at
`cannet-dbc/src/tests.rs:615`.

**What task 92 left.** Its phase 1 measured the three
calculated-field sites as already resolving to the *defining*
database, and its phase 3 moved them onto
`DecodeModel::message_source` so a per-signal pick reaches them too.
Both are host-side, and both answer *which* database supplies the
designation. Neither touches whether the answer reaches the frontend.
So task 92 neither narrowed nor moved this defect — the two were
never in the same place. What it did change is the code the
investigation below reads: the resolution sites are phase 3's, not
the pre-92 ones this task file describes.

**Observations, before anything was changed.** Three throw-away
printing tests, each with a control that discriminates. All three
were reverted before anything was written for keeps.

*Host, transmit-panel feed.* `describe_message_inner` against one DBC
declaring `CannetCounter` on `291.AliveCtr` and `CannetCrc` on
`291.Crc8`, with an undeclared message `292` beside it as the
control:

| message | `calc_fields` |
|---|---|
| 291, declared | `Some(counter AliveCtr inc 1 roll 15; crc Crc8 CRC-8/SAE-J1850 range 0:56)` |
| 292, undeclared | `None` |

*Host, RBS feed.* `build_message_view` against the same message,
once with no file entry and once with a file counter override on
`Ctr2`:

| row | `counter` | `counter_overridden` | signal `calc_role` |
|---|---|---|---|
| DBC-declared only | `AliveCtr`, inc 1, roll 15 | **false** | `AliveCtr` = counter |
| file override | `Ctr2`, inc 3 | **true** | `Ctr2` = counter |

*Frontend.* `CalcFieldEditor` rendered directly against the two
layers, reading the checkboxes and the seeded controls:

| layers | counter box | crc box | counter signal |
|---|---|---|---|
| DBC counter + DBC CRC, no override | **false** | **false** | no controls rendered |
| no DBC layer, file counter override | true | false | `Ctr2`, inc 3 |
| DBC counter + DBC CRC, file counter override | true | **false** | `Ctr2`, inc 3 |

**Conclusion: the data stops at the frontend editor's state
initialisation** — not in the host model, and not at the IPC
boundary. The third row is the discrimination: on one message the
file's counter override comes up populated while the DBC's CRC beside
it does not, so the editor is not blind to configuration, it is blind
to the DBC *layer*. The cause is one memo — `effective` read
`current?.counter` / `current?.crc`, the override spec alone, and
`dbcDefaults` fed nothing but the "DBC default: …" hint text beside
the unchecked box. Every seeded control follows `effective`, so a
DBC-declared field produced an off checkbox with no controls behind
it.

**The typo case, measured rather than assumed.** This task file
records `app_state.rs` as `continue`ing silently past a bad
attribute. That reading is stale: the `continue`s there are on
`CalcFieldsSpec::to_config` — the *file override's* parse, not the
DBC attribute's — and the DBC attribute's failure has had a path to
the log since `Database::parse_warnings` arrived. Measured:
`install_dbc` on a DBC carrying
`BA_ "CannetCounter" SG_ 291 AliveCtr "rolover=15";` returns one
warning, `Status.AliveCtr: bad CannetCounter attribute: unknown
CannetCounter key "rolover"`, which `load_dbc` prints as
`sys_warn!("dbc", "{path}: {w}")`. The entry the overseer asked for
already existed and already named the file, the message and the
signal — the attribute *text* was the only half missing, and it is
the only half that changed.

**What landed.**

- `f7eb0cdd` — **the editor opens on the effective designation.**
  `effective` is now `current?.field ?? dbcDefaults?.field` per
  field, so a message with an overridden counter and a DBC-declared
  CRC comes up with both sections populated. Each populated section
  carries a `Default` / `Override` chip — the vocabulary
  `RbsSignalsPanel`'s `STATUS_LABEL` already uses for the same fact,
  per the 2026-08-20 ruling — and the "DBC default: …" hint now shows
  only where it says something the chip does not, i.e. on an override
  with a DBC default behind it. Seeding from the DBC must not turn a
  section into an override behind the user's back, so Apply writes a
  field only when it is already an override, has been edited since
  the modal opened, or has no DBC default behind it.
  `TransmitPanel.dom.test.tsx`'s "carries the calc override through
  `set_transmit_frame`" pinned the defect from the other side — it
  clicked the counter *on* over a DBC-declared designation — and now
  asserts the section opens on, populated, and authors its override
  through an edit.
- `521f509c` — **a malformed attribute names the value it choked
  on.** `collect_calc_fields` quotes `attr.value` verbatim beside the
  parse error, so the warning reads `Status.AliveCtr: bad
  CannetCounter attribute "rolover=15": unknown CannetCounter key
  "rolover"`. A GUI-side test walks it from the parse through
  `install_dbc` to the warnings the DBC log prints, with a clean load
  of the same file as its control.
- `54522ab2` — **a regression the seeding change caused, found while
  reviewing its own diff.** The RBS signal menu's "Configure as
  sequence counter…" opens the editor with a `preset` destination. On
  a message whose DBC already declares that field elsewhere the
  section was now on, populated and *untouched*, so the override gate
  read it as tracking the default and Apply wrote nothing — the pick
  showed in the control and vanished on Apply. A `preset` counts as an
  edit from the moment the modal opens; naming a destination is an
  authoring act whether or not the DBC has already designated the
  field. Pinned by "\"configure as …\" overrides a DBC-declared field
  it moves".

**Falsification control.** Each knob turned off in turn and the
suites re-run:

| knob off | tests reddened |
|---|---|
| `effective` back to the override layer alone | **5** — three editor cases, the RBS panel's and the transmit panel's |
| Apply writes every on section (the override gate dropped) | **4** — all four Apply cases |
| the warning drops the attribute text | **2** — `malformed_and_duplicate_designations_warn_but_load` and the GUI-side walk |
| a `preset` no longer counts as an edit | **1** — the "configure as …" case |

No other test moves under any of the three, so the suite
discriminates the change rather than describing it.

**Gates.** `cargo test -p cannet-gui` 850 → **851 passed, 6
ignored**; `cargo test -p cannet-dbc --lib` 111 → **112**; `cargo
test --workspace` **47 binaries, 0 failures**; `cargo clippy
--workspace --all-targets` clean but for the pre-existing
`redundant_closure`; `cargo fmt --all -- --check` clean. Frontend:
`npx tsc --noEmit` clean, `npx vitest run` 2504 → **2513 passed / 190
files**, `npx vite build` clean.
`git grep -Ein "task [0-9]|plans/" -- apps/ crates/` empty. The
render-tier perf harness was **not** run — the overseer owns it.

**Exit criteria.**

| criterion | verdict | what earns it |
|---|---|---|
| A message whose DBC declares a counter or CRC opens the editor with those controls populated; tested | **met** | `CalcFieldEditor.dom.test.tsx` "comes up populated from the DBC when the project overrides nothing" reads back both boxes, the counter signal, increment and rollover, and the CRC signal, algorithm and range; the two consumers are covered by `RbsPanel.dom.test.tsx` "opens the editor on the message's DBC-declared counter and CRC" and by the transmit panel's override case |
| A file override layers over the DBC default per field, visibly | **met** | "shows a message's overridden counter beside its DBC-declared CRC" — both sections populated, chips reading `["Override", "Default"]` — and "makes an edited DBC default an override of that field alone", where the untouched CRC stays out of the written spec |
| The root cause is stated with the experiment's data that confirmed it | **met** | the three observation tables above; the third frontend row is the discrimination, and the three falsification knobs bound what the tests pin |
