# Task 159 — Math Pyramids Persist Like Any Other Series

Opened 2026-10-02 by owner ruling on task 135's one open deviation.
**Executes now, on the current stack.** Groomed the same day; one
phase.

## Why

Task 135 phase 1 left math series **session-scoped**: `persist` skips
them and `invalidate_dbcs` drops rather than parks them, so every
reopen recomputes every math series from its operands' level-0
samples. The owner's reaction on 2026-09-06 was "almost certainly not
ok, at least long term"; on 2026-10-02, with the rationale in front of
them: "Recompute isn't free, so I think I don't accept the rationale
at all. Should just be values + fingerprint like any other signal."

## Findings (2026-10-02 survey)

The rationale recorded in `persist_reporting` gave two reasons; neither
survives the code.

- **"Resume state would be a second serialisation format."** The state
  a math fill carries beyond its samples is `MathFill { cursors, held,
  carry }` (`signal_cache.rs`) with `MathCarry` (`math_kernels.rs`): a
  filter output, an integrator, a last slope, the previous sample, a
  trailing window bounded by its duration, and two running totals.
  **None of it needs persisting**, because all of it is derivable from
  what *is* persisted:
  - each operand's `cursor` is the slot of its first level-0 sample
    after the math series' last sample time, a `partition_by_t`;
  - each `held` value is that operand's sample before the cursor;
  - the filter's output and the integrator's accumulator *are* the
    series' last value;
  - the slope, the previous sample and the trailing-window totals come
    back from replaying the kernel over at most one window of operand
    samples ending at the last sample time, into a throwaway carry.
- **"Recompute is cheap."** Never measured; the reopen-recompute number
  has been owed since 2026-09-06. A math series re-reads every operand's
  level 0, so the cost scales with operand sample count and the plot
  shows a partial curve until it lands. The owner does not accept it as
  free.
- **The fingerprint exists.** A math series' encoding fingerprint is
  compositional (`signal_fingerprint::math_encoding`: function,
  parameters, operands' own fingerprints, affines) and is stamped at
  build like every other row's. It is exactly what `restore` judges a
  row by, so a definition or operand change parks the old pyramid and
  mints a new one with no further work (ADR 0047).
- **File-backed series are the precedent.** `SignalOrigin::File` rows
  carry no DBC and no decode, yet persist through the same manifest
  with a provenance-specific field (`PersistedSignal::file`) and a key
  arm in `PersistedSignal::key`. `SignalOrigin::BusErrors` (task 158)
  did the same with a flag. Math is the one origin `key()` cannot
  express today — its slot and message id are "zero, and meaningless".
- **Constants.** An `hline` or a `statistic` is rewritten whole each
  round (`MathFill::constant`); a statistic over the capture is the one
  kernel whose state is a fold over everything. It persists like any
  row and its restore cost is a re-fold if the operands grew.

## Rulings

- **Math pyramids persist, restore and park like every other series**
  (owner, 2026-10-02): values plus the compositional fingerprint, no
  resume record. The warm-up replay on restore is the implementation's
  business.
- **Measure anyway.** The restore path records, at debug level, how
  long each math series' warm-up took and how many operand samples it
  replayed, so the reopen cost that was never measured is in the log
  from now on.

## Open questions

(none)

## Phases

1. **Persist, restore, park.** `PersistedSignal` gains a math arm
   (definition id and the compositional fingerprint already in
   `encoding`); `persist_reporting` stops filtering math rows;
   `restore` rebuilds each restored math row's `MathFill` by deriving
   cursors and held values from the operands and warming the carry with
   a bounded replay; `invalidate_dbcs` parks math rows like decoded
   ones; a restored series whose operands no longer cover its last
   sample (front-trimmed) rebuilds. ADR 0047 amended (math rows are in
   the manifest; the session-scoped exception goes), `persist_reporting`'s
   comment replaced, README's math section if it mentions the reopen.
   Tests: for every stateful kernel (`expfilter`, `integration`,
   `derivative`, `duty`, `frequency`, `rms`) and one pointwise one, a
   series filled continuously equals one persisted mid-capture,
   restored and extended over the remainder, sample for sample; a
   definition change parks the old row; a missing operand drops to a
   rebuild; the warm-up timing reaches the log.

## Exit criteria

1. A reopened project serves every math series it had from the
   manifest without recomputing it; the first serve is complete at the
   persisted extent — host test on a generated capture.
2. Persist-restore-extend equals continuous fill, sample for sample,
   for each stateful kernel and one pointwise kernel — host tests.
3. A changed definition or operand parks the old row in the retention
   pool like a decoded series; a restored row whose operands no longer
   cover its tail rebuilds — host tests.
4. The warm-up's duration and replayed sample count are logged per
   series on restore.
5. ADR 0047 and the `persist_reporting` comment describe the rule;
   README matches; task 135's criterion-2 deviation is closed by
   reference to this task.

## Blockers / side effects

(none yet)

## Status log

- 2026-10-02 — opened by owner ruling on task 135's criterion 2
  (review queue § 3 item deleted; ruling recorded in 0135). Survey
  above; one phase.
