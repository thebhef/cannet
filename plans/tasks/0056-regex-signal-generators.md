# Task 56 — Regex-Derived Signal Attributes (Generators)

Owner feature request (2026-08-07): a **project-level** mechanism
that derives per-signal values from regex matches on signal names —
"generators."

## The idea

A generator is a project-scoped rule: a partial-match regex over
signal names plus a derivation of some attribute from the match.

Motivating example — **signal color map**: `/Cell(\d+)/` → the
captured number indexes into the color wheel, so `Cell1…Cell16`
get stable, meaningful wheel slots wherever they appear, instead of
hash- or order-assigned colors.

Second named use: **sort ordering** — the same capture could supply
the sort key for signal lists (the backlog's plot-side-panel sorting
item names this task).

## Scope questions to groom before implementation

- **Carrier: is there a non-hacky DBC extension for this?** (Owner,
  2026-08-07.) The `Cannet*` `BA_` custom-attribute mechanism
  (ADR 0043) already carries counter/CRC/display designations in the
  DBC itself, and ADR 0010 forbids sidecar files — a
  `CannetColorGen` / generator attribute would let the regex travel
  with the DBC the signals come from. Weigh against project-level
  storage (a generator spanning signals from several DBCs can't live
  in one of them); possibly both, with a precedence rule.
- **Regex-acceptance best practices are a requirement, not a nice-to
  have** (owner, 2026-08-07). Arbitrary user regex means ReDoS and
  resource limits are in scope: evaluate in the host with the Rust
  `regex` crate (guaranteed linear-time, no backtracking — the right
  engine for untrusted patterns); cap pattern length and compiled
  size (`RegexBuilder::size_limit`); surface compile errors in the
  UI at entry time, not at match time; never hand the raw pattern to
  a backtracking engine (JS `RegExp`) on unbounded input. If the
  frontend needs to preview matches, it asks the host.
- Where generators live in the project model (a new element kind vs
  a project-level list) and their UI (project panel?).
- Attribute set for v1: color (wheel index from capture) and sort
  key? What wins when a generator, a `signal_colors` override, and
  the theme-derived default all apply (precedence rule; the task-53
  decision "stored user colors render verbatim" suggests explicit
  override > generator > derived).
- Capture semantics: first capture group as integer for wheel index;
  what happens on non-numeric captures, multiple groups, multiple
  matching generators.
- Which surfaces consume it in v1 (plot series colors at minimum;
  signal-view name text and DBC value renderer share the wheel —
  ADR 0026's one-wheel rule means a generator recolors everywhere or
  the rule needs a stated scope).

## Exit criteria

(To be firmed at grooming; provisionally:)

- A project can declare a generator mapping a signal-name regex to a
  color-wheel index derivation; matching signals render with the
  derived color everywhere signal color appears, subject to the
  agreed precedence.
- The sort-key derivation exists or is explicitly deferred with the
  decision recorded here.
- Persistence in the project file, with tests; docs updated
  (CONTEXT.md gains the term "generator" if it survives grooming).
