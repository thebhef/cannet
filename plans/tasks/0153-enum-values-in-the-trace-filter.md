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
- 2026-09-23 — **phase 1 (Host: signals ranked, the gate) landed** on
  `task153-host-gate`.
  - **Red first.** The § Findings experiment is now
    `an_enum_value_query_admits_only_the_frames_carrying_that_value`
    (`tests.rs`), asserting the admitted-frame table through
    **both** chronological paths — `apply_filter_records` and the
    filter index's `keep` + decode gate — over a real `AppState`,
    DBC and capture. Its fixture is the survey's: one message
    `FaultStatus` on `Pack CAN` (id `s:300`), signals `FaultID`
    (`VAL_` 0 `NO_FAULT`, 1 `OVERVOLTAGE`, 2 `THERMAL_RUNAWAY`, 3
    `XQZ`) and `String_Overvoltage_Fault`, four frames — one per
    label. It failed to compile against the old API and, once the
    API existed, failed on the numbers.
  - **Three ranked lists, one floor.** `fuzzy_haystacks` now emits a
    `FuzzyCandidate` (message), a `FuzzySignal` per signal name and a
    `FuzzyLabel` per `VAL_` row, all built from the capture's *seen*
    keys through the same "first database assigned to the frame's bus
    wins" rule the decode path uses — so signals and labels are
    bus-scoped exactly as messages already were. **Signal names left
    the message's haystack**: that is what "ranked in their own right"
    has to mean, because a signal name inside the message's haystack
    makes the message *tie* the signal on every query the signal wins
    (measured: 272 = 272 for `overvoltage`), and a tie is not an
    outscore.
  - **The winner.** `FuzzyResolution` records a `FuzzyWinner`
    (`message` / `signal` / `value`) — the kind of the top-scoring
    entry that cleared the floor. Ties: a **message** wins any tie
    (the ruling drops a message only when a more specific match
    *outscores* it, and this is what keeps `fault` a message-name
    match); between a signal and one of that signal's values the
    **value** wins (the narrower reading of the same text, and it
    still names its signal).
  - **Admission is a specificity ladder plus one gate.** message → signal
    → value. An entry admits when it is at least as specific as the
    winner; a **message** below the winner admits only if it scores at
    least `fuzzy::MESSAGE_GATE` of the winner's score; anything else
    less specific is dropped. Under a message winner every kind admits,
    which is task 142's behaviour unchanged (its tests all still pass).
  - **The gate constant** (exit criterion 3) is
    `fuzzy::MESSAGE_GATE = 1.0`, one named value beside
    `MIN_RELATIVE_SCORE`. Fixture scores that set it — the port's own
    scores, `rank` over the fixture's haystacks:

    | Query | Entry | Score | ÷ winner |
    | --- | --- | ---: | ---: |
    | `no_fault` | `NO_FAULT` (value, winner) | 200 | 1.000 |
    | `no_fault` | `Pack CAN s:301 s:769 Node_Fault ECU` (message) | 196 | **0.980** |
    | `no_fault` | `String_Overvoltage_Fault` (signal) | 168 | 0.840 |
    | `overvoltage` | `OVERVOLTAGE` (value, winner) | 272 | 1.000 |
    | `overvoltage` | `String_Overvoltage_Fault` (signal) | 272 | **1.000** |
    | `fault` | message haystack (winner, by the tie rule) | 128 | 1.000 |
    | `fault` | `FaultID`, `String_Overvoltage_Fault`, `NO_FAULT` | 128 | 1.000 |

    A message's own haystack reaches **0.980** of a value winner while
    being the wrong answer, so every gate below ~0.99 readmits it, and
    with it all four of that message's frames. Falsification run:
    `MESSAGE_GATE = 0.97` fails
    `a_message_matched_only_by_its_own_haystack_loses_to_a_value_winner`
    with `[(768,0), (769,0), (769,0), (769,0), (769,0)]` against the
    expected `[(768,0)]`. At `1.0` a message survives a more specific
    winner only by tying it — and a message that ties *is* the winner —
    so the constant states the ruling exactly: dropped when outscored.
    It is the tuning surface if that proves too sharp.
  - **The signal/value tie needs no gate**, and could not use one: the
    fixture's `String_Overvoltage_Fault` scores *identically* to its
    `OVERVOLTAGE` label (272 = 272), so no score threshold separates
    them. The specificity ladder does — a signal is less specific than
    the value winner and only *messages* get a second chance at the
    gate.
  - **By-id is definitional.** `MatchContext` carries a
    `FuzzyMatchMode`; `fetch_by_id_page` resolves in
    `Definitional`, where a label matches when the message *defines* a
    signal whose value table holds it, with no decode — the row is a
    message, not a frame. The chronological paths stay
    `Chronological` (the per-frame decoded test over the whole
    history). `fetch_by_id_page` was split into a thin command over
    `fetch_by_id_page_inner(&AppState, …)`, the split
    `fetch_signal_page` already uses, so the by-id page is testable:
    `the_by_id_page_matches_a_value_against_the_whole_value_table`
    asserts `no_fault` finds the row although the latest frame reads
    `XQZ`.
  - **Returned with the page.** `RowPage<T>` gained
    `fuzzy_winner: Option<FuzzyWinner>` (a property of the query, so it
    rides the envelope, `None` when there is no fuzzy leaf);
    `TraceFrameRecord` gained `matching_signals: Vec<String>`, filled
    on admitted rows of the filtered chronological page, the by-id page
    and `apply_filter_records`, and empty under a message winner. Both
    are host-computed model facts, not things the panel re-derives
    (CLAUDE.md § GUI architecture). Mirrored in `types.ts`
    (`FuzzyWinner`, `matching_signals?`) and on the two hooks' page
    interfaces. No panel behaviour — that is phase 2.
  - **Decode gate.** The label half is still the only part that reads a
    decode, and only in chronological mode; a *signal* winner needs
    none at all, because the database that names the signal is the one
    that decodes the bus. `only_the_enum_label_half_of_a_fuzzy_leaf_asks_for_a_decode`
    now pins the signal half too.
  - The filtered chronological page reads the winner and the matching
    signals off the *index's* cached resolution rather than
    re-resolving per page fetch; `a_signal_name_query_…` asserts that
    path too, since `fetch_filtered_trace` itself needs an `AppHandle`
    and is not directly reachable from the suite.
  - Docs in the same commit: `filter.rs` module docs, the
    `TaggedPredicate::Fuzzy` rustdoc (the three lists, the winner, the
    gate, the two modes), `FuzzyCandidate`'s haystack doc, rustdoc on
    `MESSAGE_GATE`, `FuzzyWinner`, `FuzzyMatchMode` and the two new
    page fields. README is phase 2's.

## Exit criteria verdicts (2026-09-23, after phase 1)

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | Label query shows exactly the frames carrying it, chronologically, through `apply_filter_records` *and* the filter index; by-id finds the message whatever the latest frame reads | **Met** — `an_enum_value_query_admits_only_the_frames_carrying_that_value` (both paths, six queries), `the_by_id_page_matches_a_value_against_the_whole_value_table` |
| 2 | A signal winner shows the carrying messages' frames and hides messages below the gate; a message winner keeps task 142's behaviour and tests | **Met** — `a_signal_name_query_admits_the_frames_of_the_messages_carrying_it`, `a_message_matched_only_by_its_own_haystack_loses_to_a_value_winner`, `fault` row of the table; all five task-142 fuzzy tests pass unchanged in intent |
| 3 | The gate is one named value and the status log records the fixture scores | **Met** — `fuzzy::MESSAGE_GATE = 1.0`; scores table above, with the falsification run |
| 4 | Disclosure opens on a signal/value winner — DOM tests | **Phase 2** (host half only here: `fuzzy_winner` + `matching_signals` are returned and tested) |
| 5 | README / CONTEXT.md | **Phase 2** |
| 6 | Tests cover 1–4 | **Host half met** — five new Rust tests plus two extended; the DOM half is phase 2's |
