# 0134 — Usage Feedback and Features

> **Opened 2026-09-05** from owner usage feedback. A collection of
> feature requests and observations, grouped but ungroomed — items
> move out into their own tasks (or into existing ones) as they are
> groomed.

## Copy/paste and export

- copy/paste out of cannet (needs prototyping)
  - trace → text tree representing selected message(s)
  - dbc → text — probably just message names/IDs

## File-backed signals

- 'file backed signals' should enter common machinery
- add CSV i/o

## Plotting and signals

- Can we add new signals more quickly? The cache building is slow;
  maybe plot then cache?
- Question: how do we choose values for the pyramid? Do we preserve
  outliers? Maybe always select most-different value from adjacent
  bins?
- Drag resizing across plot areas is a bit weird right now.
- template views: signal or message filter selection for s1, s2, s3 —
  parameterized

## Server and integration

- Version server independent of GUI.
- `(Effective|CellNominal|TemperatureTable|Estimator)Limit(Charge|Discharge)`
  — generator support for more complete capture→sort key syntax —
  server-side message buffer

## Rx correctness

- CRC validation on rx

## Extensions

- Extension — include signals: allow extensions to read/write signals, messages, events.

## Exit criteria

Every item has been groomed into its own task, folded into an
existing task, or explicitly dropped; the task closes when its list
is empty.
