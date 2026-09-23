# Task 153 — Enum Values in the Trace Filter

Opened by owner feedback 2026-09-22 on task 142's trace filter.
**Executes now, on the current stack.** Reproduced; one design
question open.

## Why

From the owner, 2026-09-22: "feedback on the trace filtering: I would
actually like to search for enum values as well. My use case is a
fault enum value in a view filtered to only show fault messages."
And, asked what failed: "I think it may have matched every fault
message, not just the one whose signal value matched the search
term."

## Findings (2026-09-22 survey and experiment)

- **Task 142 ruled enum labels into the haystack and shipped it.**
  `fuzzy_haystacks` (`trace_query.rs`) emits one `FuzzyLabel` per
  `VAL_` row of every bus-assigned database; `FuzzyResolution::
  resolve` ranks the labels together with the id-keyed candidates
  under the one relative floor; `admits` then reads the decoded
  signal's `label` per frame. The labels are **not** in a message's
  haystack (that is bus, both id spellings, message name,
  transmitter, signal names), so the owner's guess at the mechanism
  is not it — but the effect is exactly what they saw.
- **The defect: a message-level match swamps the value-level one.**
  `admits` is `by_key || label`: if the query clears the floor
  against a message's *own haystack*, every frame of that message is
  admitted and the label test never narrows. In a fault DBC the
  label's words are the signal names' words (`OVERVOLTAGE` beside a
  flag signal `String_Overvoltage_Fault`; `NO_FAULT` beside anything
  named `…Fault`), and a long haystack of many signal names clears a
  relative floor on a scattered subsequence, so a label query
  practically always also hits its own message.
- **Experiment** (throwaway host test, reverted): one message,
  signals `FaultID` (labels `NO_FAULT`, `OVERVOLTAGE`,
  `THERMAL_RUNAWAY`, `XQZ`) and `String_Overvoltage_Fault`; four
  frames, one per label; rows admitted per query through
  `resolve_match_context` + `apply_filter_records`:

  | Query | Frames admitted | Frames carrying the label |
  | --- | --- | --- |
  | `overvoltage` | 4 | 1 |
  | `no_fault` | 4 | 1 |
  | `thermal_runaway` | 1 | 1 |
  | `runaway` | 1 | 1 |
  | `xqz` | 1 | 1 |
  | `fault` | 4 | (message-name match, correct) |

  The label half works on its own (`thermal_runaway`, `xqz`); it is
  overridden whenever the haystack also clears the floor
  (`overvoltage` by the sibling signal's name, `no_fault` by a
  scattered subsequence with a `Fault` boundary bonus).
- **The filter index path is untested for labels**: the three
  existing tests go through `apply_filter_records`, not
  `fetch_filtered_trace`'s index build (`keep` + decode gate). The
  fix's tests cover both.
- **README does not say what the filter box matches**: no trace
  passage names the fuzzy field or its haystack (task 142 exit
  criterion 7 asked for one).

## Rulings

(none yet.)

## Open questions

1. **Which reading wins when a query matches both a message and a
   label?** Options: (a) *label precedence per message* — a message
   that defines a surviving label is admitted only by the label
   test, other messages keep the haystack rule (local to
   `FuzzyResolution`; `fault` keeps meaning "messages named fault",
   but a sibling fault message whose haystack scatters a match still
   shows whole); (b) *value query* — when any label survives the
   cut, the id-keyed half is dropped and only frames carrying a
   surviving label show (`no_fault` shows exactly the `NO_FAULT`
   frames across every message, but `fault` stops meaning message
   names wherever a `FAULT` label exists); (c) (a) plus a score
   test — a message's haystack admission is dropped when a label of
   its own outscores it. *Recommend* (b): the box is a search, a
   label hit is the most specific thing it can find, and the user
   who wanted the message can type its name; phase 1 measures (c)
   against the fixture before settling if (b) reads too blunt.

## Phases

1. **Fix.** The experiment above as the red host test (both the
   `apply_filter_records` path and the filter index path), the ruled
   precedence in `FuzzyResolution`, `filter.rs` module docs and the
   `TaggedPredicate::Fuzzy` rustdoc updated; README's trace section
   names the filter box and what it matches — bus, message, id,
   transmitter, signal, enum label — and which wins.

## Exit criteria

1. Typing a fault enum's label into a trace panel narrowed to fault
   messages shows exactly the frames whose decoded signal carries
   that label, in both modes, under the ruled precedence — asserted
   through `apply_filter_records` and the filter index.
2. A query over a message or signal name with no label hit behaves as
   task 142 left it (its tests still pass).
3. README names the filter box and its haystack; `docs/CONTEXT.md`
   if a term is coined.
4. Tests cover 1–2.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened; reproduced by experiment (table above); the
  precedence question to the owner.
