# CAN Spec Generation (Concept)

Status: **ideation** — not scheduled into a phase. Captured here so the
idea has a stable home before we decide whether to act on it. Promotion
into `phased-implementation.md` requires a separate discussion.

## Why this lives outside the analyzer

The analyzer (cannet) reads CAN traffic at runtime. The generator
described here writes source code consumed by embedded applications.
They share a DBC parser and nothing else. If we build it, it should be
a **sibling tool** — not a feature of the analyzer — to keep the
analyzer's runtime surface free of codegen concerns.

Surveying `cantools generate_c_source` confirmed the boundary: stopping
at pure functions (`pack` / `unpack` / per-signal `encode` / `decode`)
is the right severity. Anything stateful (dispatch tables, scheduled
TX, fault tracking, scheduling assumptions) trends toward AUTOSAR
territory and should stay out.

## Goal

Eliminate the recurring boilerplate in embedded applications that
consume or produce frames described by a DBC — **without** the
generator owning any behavioral code in those applications.

The boundary the user (the embedded developer) sees:

- Generated code is regenerable, never hand-edited, never merged into.
- Application code lives entirely in concrete subclasses and call
  sites. Required updates after a DBC change are surfaced by compile
  errors, not by checklist.

## Shape of the generated artifact

Single C++ header per DBC (or per node, when filtered):

- POD structs per message — one field per signal, raw integral types.
- `pack` / `unpack` free functions: pure, no allocation, no I/O.
- Per-signal `encode` / `decode` applying factor/offset, `is_in_range`,
  and strongly-typed enums for value tables.
- A pure virtual receiver class — one `on<Message>` per RX message —
  that the application subclasses. The dispatcher (`route(id, data,
  dlc)`) is generated and calls into the subclass.
- Compile-time IDs, lengths, cycle times, and extended-frame flags as
  `constexpr`.

Adding a signal adds a pure virtual; the application must override it
or the build breaks. That is the documented update boundary.

## DBC coverage we'd target

Partial coverage makes the generator unusable for real ECU work. At
minimum:

- Signals: byte order, sign, factor, offset, min/max, unit.
- Value tables (`VAL_`) → strongly-typed enums.
- **Multiplexing**, both classic and extended (`SG_MUL_VAL_`).
  Multiplexed groups should produce variant-typed accessors keyed on
  the multiplexor value, so the user can't read a signal that doesn't
  apply to the active mux selection.
- Comments (`CM_`) → doxygen on the generated symbol.
- Attributes (`BA_DEF_`, `BA_`): both standard (cycle time, send type,
  transmitter node) and project-defined.
- Signal groups (`SIG_GROUP_`) for atomic update semantics.
- Node lists (`BU_`) for the `--node` filter.

## Custom attributes as application design surface

DBC's attribute mechanism is extensible, and the generator should
treat it as **the** configuration surface for its own behavior, rather
than inventing a parallel sidecar config. Concrete needs we already
have:

- A signal-level attribute marking a CRC field, so the generator emits
  a pack-time hook the application implements.
- A signal-level attribute marking a sequence-count field, with the
  generator emitting the increment/wrap logic.
- Per-signal naming overrides for legacy code.

Defining and documenting these custom attributes is part of the design
space, not an afterthought.

## Stable regeneration

Two related properties:

- **Deterministic output.** Re-running the generator on the same DBC
  must produce a byte-identical file. No timestamps, no absolute
  paths, no hash-ordered iteration.
- **Stable in-place updates.** Re-running on a *modified* DBC must
  produce a minimal diff: unchanged signals byte-identical in their
  original positions; only changed/added/removed signals affect the
  file. This is what makes regeneration safe to land in a pull request
  and review as a normal diff.

A `--watch` mode for tight inner-loop iteration on bus design is a
natural extension once the above hold.

## Open questions

- Output language: C++ first, or C with a C++ wrapper? `cantools` is
  C-only; our embedded code is C++.
- Build integration: emit a CMake target, or a single header plus one
  cpp?
- Where the tool lives: same binary as the analyzer with a subcommand,
  or a separate binary importing the analyzer's DBC parser as a
  library?
- Whether this is worth doing at all versus adopting `cantools` plus a
  thin hand-written dispatcher.
