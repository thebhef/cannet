# common-scale — the task-98 defect, as a file

A 10 s synthetic capture and project that deterministically reproduce
the 0.9.0 observation behind task 98: *a signal valued at -200..0 A
rendered as -1.5..0* on a common y scale. On a build with the fix, the
same project shows the corrected behaviour; on a pre-fix build it shows
the defect. Open `common-scale.cannet_prj` and import
`common-scale.blf` — the plot panel is pre-configured.

## What it carries

Two messages, two signal pairs, both pairs sweeping their full declared
range so amplitude is checkable against the axis by eye:

| Area | Signals (in list order) | Unit | Range | Mode |
| --- | --- | --- | --- | --- |
| `mixed` | `SmallVolts`, then `BigAmps` | V / A | -1.5..0 / -200..0 | unified |
| `unitless` | `SmallBare`, then `BigBare` | none | -1.5..0 / -200..0 | unified |

The two shapes are the rows of task 98's experiment matrix that
reproduced the defect (the others bounded it):

- **`mixed`** — mixed units with the small-ranged signal listed first
  is the owner's observation verbatim: pre-fix, the axis labelled
  itself from the first ranged signal (-1.5..0) while `BigAmps` was
  normalised against its own unit group, so the -200..0 series read as
  -1.5..0 — both endpoints and the sign.
- **`unitless`** — no units at all also broke **per-unit** mode
  (unitless signals shared one axis but each got a private scale
  group), and is the likelier shape in the wild: a DBC that declares
  no unit is the common case. Toggle the area to per-unit to check
  that mode too.

## What correct looks like

One axis, one scale (ADR 0026 as amended): the axis range is the union
of every visible series on it, so both areas label -200..0 and the
small series draws flat against it. That flattening is the deliberate
consequence of the fix — separating series too different to share a
scale is what `per-unit` and `individual` modes are for, not a second
scale hidden under one set of labels.

## Regenerating

```sh
uv run --with python-can --with cantools examples/common-scale/generate_blf.py
```

Deterministic — no RNG, no wall clock; the file is byte-identical
across runs.
