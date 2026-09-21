# Ungroomed user feedback

Feedback from real use, by any user — the owner or anyone in the
initial user network. Feature requests, friction, and observations
that could improve the experience and help adoption, grouped but
ungroomed. Not a task and not the backlog — the backlog holds things
noticed *while building*; this file holds things noticed *while
using*. Items leave this file when they are groomed into a task of
their own, folded into an existing task, or explicitly dropped.
Items are numbered for reference; the list is reindexed whenever
items leave.
Opened 2026-09-05 (as task 134; tasks 135–137 were split out the same
day).

## Copy/paste and export

1. copy/paste out of cannet (needs prototyping)
    - trace → text tree representing selected message(s)
    - dbc → text — probably just message names/IDs

## File-backed signals

2. 'file backed signals' should enter common machinery
3. add CSV i/o

## Plotting and signals

4. Can we add new signals more quickly? The cache building is slow;
    maybe plot then cache?
5. Question: how do we choose values for the pyramid? Do we preserve
    outliers? Maybe always select most-different value from adjacent
    bins?
6. Drag resizing across plot areas is a bit weird right now.
7. template views: signal or message filter selection for s1, s2, s3 —
    parameterized

## Server and integration

8. `(Effective|CellNominal|TemperatureTable|Estimator)Limit(Charge|Discharge)`
    — generator support for more complete capture→sort key syntax —
    server-side message buffer

## Rx correctness

9. CRC validation on rx

## Extensions

10. Extension — include signals: allow extensions to read/write signals, messages, events.

## Palette and dialogs

11. No mouse cursor when opening a project from the palette (Windows,
    2026-09-21): the pointer is hidden while the palette has the
    keyboard, and it stays hidden through the native Open dialog the
    command raises.
