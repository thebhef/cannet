# Ungroomed user feedback

Feedback from real use, by any user — the owner or anyone in the
initial user network. Feature requests, friction, and observations
that could improve the experience and help adoption, grouped but
ungroomed. Not a task and not the backlog — the backlog holds things
noticed *while building*; this file holds things noticed *while
using*. Items leave this file when they are groomed into a task of
their own, folded into an existing task, or explicitly dropped.
Opened 2026-09-05 (as task 134; tasks 135–137 were split out the same
day).

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
- 'All points' in the plot: the rendered points don't align with the
  extrema in the signals and it looks weird, as if we're extrapolating.
- Bus markers in the plot panel should follow enable/disable in the
  events panel.
- Empty plot areas should still render the grid and cursors.
- Cursor handles/labels appearing over signals is unfortunate; maybe
  add gutters?
- Point markers still don't show up right on enum lanes.

## DBC panel

- Not being able to collapse DBC items when a filter string is present
  sucks.

## Server and integration

- Version server independent of GUI.
- `(Effective|CellNominal|TemperatureTable|Estimator)Limit(Charge|Discharge)`
  — generator support for more complete capture→sort key syntax —
  server-side message buffer

## Connection

- Bring back the ability to connect with missing interfaces, when
  'no interface' is explicitly selected.

## Rx correctness

- CRC validation on rx

## Extensions

- Extension — include signals: allow extensions to read/write signals, messages, events.
