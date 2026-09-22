# Task 153 — Enum Values in the Trace Filter

Opened by owner feedback 2026-09-22 on task 142's trace filter.
**Executes now, on the current stack.** Grooming in progress; one
question open.

## Why

From the owner, 2026-09-22: "feedback on the trace filtering: I would
actually like to search for enum values as well. My use case is a
fault enum value in a view filtered to only show fault messages."

## Findings (2026-09-22 survey)

- **Task 142 ruled enum labels into the haystack and shipped it.**
  `fuzzy_haystacks` (`trace_query.rs`) emits one `FuzzyLabel` per
  `VAL_` row of every bus-assigned database; `FuzzyResolution::
  resolve` ranks the labels together with the id-keyed candidates
  under the one relative floor; `admits` then reads the decoded
  signal's `label` per frame, and the filter index's decode gate is
  widened to the ids defining a surviving label. Tests at each layer:
  `an_enum_label_query_needs_the_decoded_value_to_be_that_label`
  and `only_the_enum_label_half_of_a_fuzzy_leaf_asks_for_a_decode`
  (`filter.rs`), `a_fuzzy_query_over_an_enum_label_reads_the_decoded_
  value` (host `tests.rs`).
- **So the report is either a gap on real data or a different
  meaning.** Candidate gaps the tests do not cover: a query that also
  lands on a message or signal name, where the single floor is cut
  by the haystack's higher score and the label falls beneath it; a
  label carrying spaces or punctuation; a multiplexed arm; the
  by-id snapshot (`fetch_by_id_page` resolves the same context, but
  the row is the latest frame only); a value not in the `VAL_` table
  at all. The other meaning: the enum's **numeric** value — task 142
  ruled numeric values and payload bytes out of the haystack.
- **README does not say what the filter box matches**: no trace
  passage names the fuzzy field or its haystack (task 142 exit
  criterion 7 asked for one). A user has no way to learn that labels
  are searchable.

## Rulings

(none yet.)

## Open questions

1. **Which failed?** Did a label query (the fault's `VAL_` text) miss
   frames the view showed, or is the ask for the enum's numeric value
   (`3`, `0x03`)? *Recommend* answering with the query typed and one
   frame it should have found; phase 1 reproduces from that.

## Phases

1. **Reproduce.** From the owner's answer, a red host test over a DBC
   whose fault signal carries a value table, through the filter index
   (`fetch_filtered_trace`) and the by-id page, narrowed by a sources
   filter the way the owner's view is; the gap named in the task
   file. If the ask is the numeric value, this phase instead grooms
   its haystack rule (per-frame raw value, decode-dependent like the
   label half) for the owner before any code.
2. **Fix.** The reproduced gap closed; README's trace section names
   the filter box and what it matches — bus, message, id, transmitter,
   signal, enum label (and the numeric value if ruled in).

## Exit criteria

1. Typing a fault enum's label into a trace panel narrowed to fault
   messages shows exactly the frames whose decoded signal carries
   that label, in both modes — asserted by the phase-1 test.
2. If the owner rules the numeric value in: the same for the value
   as spelled in the row.
3. README names the filter box and its haystack; `docs/CONTEXT.md`
   if a term is coined.
4. Tests cover 1–2.

## Blockers / side effects

(none yet)

## Status log

- 2026-09-22 — opened; survey above, question 1 to the owner.
