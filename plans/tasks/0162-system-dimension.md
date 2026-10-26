# Task 162 — System Dimension

Opened 2026-10-03 by owner request. **Ungroomed** — captures the idea
only; scope, design questions and exit criteria come at grooming.

## Why

An application's signals live at different levels of the system, and
the same unit means very different magnitudes at each. Owner's
example: in one application, **string-level**, **cell-level** and
**LV supply** voltages are all volts, but they are different
*dimensions* of the system.

## Idea

Give signals a system **dimension** (e.g. string / cell / LV supply).
In the plot's **per-unit** view, signals of the same unit but different
dimensions are **grouped separately** rather than sharing one lane/axis.

## Open questions

To be raised at grooming.
