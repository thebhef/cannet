# Task 96 — Long Signal and Enum Names Do Not Render Correctly

Opened by owner instruction 2026-08-20, from 0.9.0 usage feedback:

> signal/_VAL names aren't rendered correctly if they're too long.
> There's a DBC extension for longer names we need to properly
> implement. expand our example DBs to include.

## Finding: the DBC extension is already implemented

Grooming checked this before scoping the task. `cannet-dbc` **already
supports the long-name extension**, correctly and at the right layer:

- `parse.rs` recognises `SystemMessageLongSymbol` and
  `SystemSignalLongSymbol` `BA_` attributes and resolves the long name
  onto the entity's `name`.
- `view_builders.rs` suppresses the placeholder attributes from
  displayed metadata — *"they're an implementation detail of the
  long-name extension, not user-authored metadata. The resolved long
  name lands on `name`."*
- `signal_fingerprint.rs` has a test pinning that a
  `SystemSignalLongSymbol` rename is treated as a rename by the decode
  path.

So "we need to properly implement" is already true, and this task must
not re-implement it. **The remaining work is the part the owner
actually saw: rendering.**

## What is left

### 1. Presentation of long names

A resolved long name can be far longer than the 32-character DBC
identifier limit the extension exists to escape — that is its whole
purpose. Every surface that shows a signal or message name has to cope:
the trace's decoded rows, the signals panel, the plot picker and
legend, the RBS and transmit trees, the signal mapping panel (task 89),
the graph view. Truncation, ellipsis, tooltip-on-overflow, column
sizing — currently undefined, which is why it "isn't rendered
correctly".

### 2. Long `VAL_` enum labels

The owner names `_VAL` alongside signal names. Enum labels have no
length limit at all and are rendered in the value column, the enum
overlay, and the plot's enum lanes. Task 97 covers one specific
consequence (enum labels on the axis); this covers the rest.

### 3. No example DBC exercises any of it

`examples/` has nine DBCs — `cannet-demo`, the four `ev-demo` files,
two `ev-zonal`, `extrapolation`, `time-origins` — and **none carries a
`System…LongSymbol` attribute or a long enum label**. So the failure is
invisible during development and in every screenshot and perf run. The
only long-name coverage is a unit-test string in `cannet-dbc/src/tests.rs`.

Extending an example DB is therefore not a nicety; it is what makes the
defect reproducible and keeps it fixed.

## Open questions — grooming

- ~~Which example DB gets the long names?~~ **Resolved 2026-08-20
  (owner): both `ev-zonal` and `ev-demo`.**

  `ev-zonal` is the database the ADR-0031 render-tier harness drives,
  so long names enter the **measured** path and long-name layout cost
  is gated rather than invisible. `ev-demo` is the richer multi-file
  example, so it carries the functional and by-eye coverage across
  several databases and buses.

  **The gate consequence, accepted by this ruling and stated so no
  later phase mistakes it:** if adding long names to `ev-zonal` pushes
  a render-tier metric past its limit, that is a **real regression to
  fix inside this task**. It is not grounds to widen a limit, promote a
  baseline, or move the long names out of `ev-zonal`. Limits ratchet
  down only; raising one needs an owner ruling recorded in ADR 0031,
  and this ruling is not that.

  Practical note for the implementing phase: re-baseline nothing, but
  do run the gate **before** the DBC change as a same-day control, so
  a limit breach can be attributed to the long names rather than to
  machine state.

- ~~What is the truncation rule?~~ **Decided by the overseer
  2026-08-20: middle-ellipsis on names, end-ellipsis on enum labels,
  full text reachable, width driven by the column model.**

  Middle-ellipsis on names because DBC long symbols share prefixes by
  construction — `BMS_PackCurrent_Filtered_HighRes` and
  `BMS_PackCurrent_Filtered_LowRes` differ only at the end, while
  `BMS_PackCurrent_…` and `BMS_PackVoltage_…` differ only in the
  middle, so end-truncation reliably hides the distinguishing part.
  Enum labels are prose-like and read left to right, so they take
  end-ellipsis.

  Column width comes from the column model, never from content — a
  name-driven width is how one pathological signal reflows a whole
  panel.

- **Is there a length beyond which we refuse?** Left open; DBC long
  symbols are bounded in practice but not by the format. Answer it with
  a measurement in the implementing phase rather than a guess.

## Exit criteria (draft — firm at grooming)

- An example DBC carries long message names, long signal names and long
  `VAL_` labels, and is used by an existing test or harness run.
- Every surface listed above renders a long name without overflowing,
  overlapping, or silently hiding the distinguishing part of the name;
  the full text remains reachable.
- No change to long-name *parsing* — the existing tests still pass
  untouched.
