"""The fault-recovery bench: an in-process sidecar driven as a
``cannet.v1`` client, with its bus-off recovery swapped per run (ADR
0039, ADR 0060).

- :mod:`.fault_recovery` -- the bench and its CLI.
- :mod:`.strategies` -- the recovery callables it swaps in.
- :mod:`.fake` -- a PEAK-shaped fake wire and its scenarios, so the same
  bench runs without hardware.

Nothing here is imported by the server, so none of it ships in the
frozen sidecar.
"""
