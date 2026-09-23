# Task 153 — Enum Values in the Trace Filter

Opened by owner feedback 2026-09-22 on task 142's trace filter.
**Executes now, on the current stack.** Reproduced and ruled; two
phases.

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

- **The score decides** (owner, 2026-09-22, option c): a message's
  haystack admission is dropped when a more specific match outscores
  it. The gate is a score threshold, expected to need tuning: one
  named constant beside the floor, tuned in phase 1 against the
  fixture and recorded with the scores that set it.
- **Signals are matches in their own right** (owner, 2026-09-22; a
  scope expansion the owner named as such): "hide messages when we
  match signals better", and "expand messages when the search winner
  (or winners) is a signal or a signal value". Overseer's reading:
  - a signal *name* is ranked as its own entry, like a label, instead
    of only as words in its message's haystack — so the winner of a
    query is identifiable as a message, a signal or a signal value;
  - the gate applies whenever the winner is a signal or a value:
    messages admitted only by their own haystack below the gate are
    hidden; a message-level winner (bus, id, name, transmitter)
    keeps task 142's behaviour;
  - when the winner is a signal or a value, the admitted trace rows
    open their signal disclosure so the matching signal is on screen,
    in both modes; the disclosure closes again when the query changes
    to a message-level winner or clears.
- **Results hide, parents stay** (owner, 2026-09-22): "hide results
  that don't match the filter, and keep the parent messages of
  results that do match." The opened disclosure lists only the
  matching signal(s); the message's other signals are hidden while
  the query stands; the parent row stays.
- **Chronological mode searches the history** (owner, 2026-09-22): a
  value query over a historical trace shows every frame whose decoded
  signal carries that value.
- **By-id mode searches the whole value list** (owner, 2026-09-22):
  the by-id row is one message, so a value query matches against the
  signal's entire `VAL_` table, not the latest frame's value — the
  row shows when the message defines a signal that can carry the
  value, opened to that signal.

## Open questions

(none — ruled 2026-09-22.)

## Phases

1. **Host: signals ranked, the gate.** The experiment above as the
   red host test, through `apply_filter_records` and the filter index
   path; signal names as their own ranked entries; the gate constant
   and the "winner kind" (message / signal / value) settled per query
   in `FuzzyResolution` and returned to the frontend with the page,
   together with the matching signal names per row; the by-id page's
   value match reads the `VAL_` table (definitional, no decode) while
   the chronological paths keep the per-frame decoded test; the
   constant tuned against the fixture and the scores recorded in the
   status log; `filter.rs` module docs and the `TaggedPredicate::Fuzzy`
   rustdoc updated.
2. **Panel: expand on a signal winner; README.** The trace panel
   opens the admitted rows' signal disclosure when the winner kind is
   a signal or a value, in both modes, listing only the matching
   signals, and closes it when the winner kind changes or the query
   clears; DOM tests; README's trace section
   names the filter box, what it matches — bus, message, id,
   transmitter, signal, enum label — and that a signal or value match
   hides weaker message matches and opens the row.

## Exit criteria

1. Typing a fault enum's label into a trace panel narrowed to fault
   messages shows, in chronological mode, exactly the frames whose
   decoded signal carries that label across the whole history —
   asserted through `apply_filter_records` and the filter index —
   and, in by-id mode, the message whose signal's value list holds
   it whatever the latest frame reads, asserted through the by-id
   page.
2. A query whose best match is a signal name shows the frames of the
   messages carrying that signal and hides messages matched only by
   their own haystack below the gate; a query whose best match is a
   message keeps task 142's behaviour (its tests still pass).
3. The gate constant is one named value, and the status log records
   the fixture scores that set it.
4. When the winner is a signal or a value, the admitted rows show
   their signal disclosure open in both modes with only the matching
   signals listed and the parent row kept; a message winner or a
   cleared query leaves the disclosure as the user had it — DOM
   tests.
5. README names the filter box, its haystack and the signal-winner
   behaviour; `docs/CONTEXT.md` if a term is coined.
6. Tests cover 1–4.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened; reproduced by experiment (table above); the
  precedence question to the owner.
- 2026-09-22 — owner ruled option c with a tunable gate, and expanded
  scope: signals ranked in their own right, weaker message matches
  hidden behind a signal or value winner, rows expanded to the
  matching signal. Two phases.
- 2026-09-22 — owner clarified: the disclosure shows only matching
  signals (parents kept); chronological mode searches the history;
  by-id mode matches a value against the signal's whole `VAL_` table.
