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

## Grooming (2026-08-07)

- **Carrier (owner ruling): project-level for v1, stored in the
  project like the color maps.** The DBC-carried form (a database-
  level `Cannet*` `BA_` attribute — confirmed parseable today via
  `can-dbc`'s `attribute_values_database`, which `parse.rs` never
  reads) is **backlogged**, not rejected: it remains the way to ship
  coloration with a DBC, and the project-level rules land first.
- **Capture semantics (owner ruling): start simple.** First capture
  group parsed as an integer → wheel index directly; same index =
  same slot across rules (`Cell5` and `CellTemperature5` share a
  hue — index alignment is the point). No per-rule offset ("not
  better, just confusing"). A rule whose capture is missing or
  non-numeric doesn't apply to that signal; rules evaluate in list
  order, first match wins; no match → today's fallback. (Per-family
  line *style* was floated as the eventual differentiator, but it's
  project-wide and needs more thought — out of scope.)
- **Precedence / one-wheel (owner confirmed):** this task creates
  the shared color resolver ADR 0026 implies but the code lacks:
  **explicit user pick → generator → hash**, consumed by the signal
  view and the plot alike. Plot `SignalRef.color` survives only as
  an explicit per-series pick; the add/drop area-position seeding is
  removed — unpicked series always render through the resolver, so
  generator/override changes recolor live everywhere ("persist only
  on customize"). Accepted side effect: previously position-seeded
  unpicked plot series re-resolve on upgrade; this is also the fix
  for the 4-areas×16-signals color inconsistency from the owner's
  test drive.
- **Sort key (owner agreed): v1 is a one-shot "sort area" action,
  accessed via context menu on the plot area's signal panel** —
  reorders `area.signals` by (generator index, then name) once,
  persisting through the normal list; drag order stays the primary
  model. The signal-view sort column on generator keys is
  **deferred** (needs the derived key in the host's sort path; no
  driving ask yet).

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

- A project can declare generator rules (ordered `generator`
  project elements) mapping a signal-name regex capture to a
  color-wheel index; matching signals render the derived color
  everywhere signal color appears, through the new shared resolver
  (explicit pick → generator → hash), plot included.
- Plot add/drop area-position color seeding is removed; unpicked
  series resolve live.
- Rules validate and evaluate host-side (Rust `regex`,
  `size_limit`, entry-time compile errors surfaced in the editor);
  the frontend never executes user-supplied regex.
- Sort: a one-shot "sort area" context-menu action on the plot
  area's signal panel orders by (generator index, name). The
  signal-view sort column is deferred (recorded above).
- Persistence in the project file, with tests; docs updated
  (CONTEXT.md gains the term "generator"; README's plot/project
  sections updated).
