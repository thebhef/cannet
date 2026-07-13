# ADR 0020 — Pattern-defined signal selections: regex patterns combined with manual picks, re-evaluated on DBC change

Status: accepted (2026-05-26, revised 2026-07-12 — patterns now
*combine* with manual picks and match the ADR 0038 canonical path;
the original mode-exclusive single-regex design is superseded)

Defines a signal collection by regex over signal identity rather than
by adding signals one at a time. First shipped for plot areas as a
mode-exclusive single `signalFilter` regex; revised when the signal
view arrived and the selection model was commonized
(`signalSelection.ts`, host `signal_snapshot.rs`).

## Decision

**A selection is manual picks + regex patterns, OR-combined.** A plot
area (and a signal view) persists a manual `signals` list *and* an
optional `patterns: string[]`. The effective collection is the manual
picks plus every catalog signal matching any pattern, deduped on the
descriptor key — **manual wins**, so a manual pick's colour, order,
and hidden state are authoritative over a pattern match of the same
signal. Adds, drops, removes, and recolours keep working alongside
patterns; mutating a pattern-derived entry (recolour, hide, drag)
*materializes* it as a manual pick so the choice persists across
re-evaluations.

**Convert is one-way: regex → manual.** Materializing a selection
replaces the patterns with their current matches as explicit picks.
There is no manual → regex direction (generated alternations aren't
wanted).

**The regex subject is the canonical signal path**
`bus/ecu/message/signal` ([ADR 0038](0038-canonical-signal-path.md)),
so the same pattern selects the same signals in the plot, the signal
view, and any future surface. The candidate set is scoped by the
consumer's `sources` wiring before patterns evaluate (a panel wired to
one bus never matches another bus's signals, regardless of pattern).

**Re-evaluation triggers.** Patterns re-evaluate whenever a DBC is
added, removed, or reloaded (`dbc-changed`); whenever the consumer's
`sources` change; and on app launch (the project stores the patterns;
the matching set is derived fresh).

**Bus rename invalidates patterns that referenced the old name.** A
change that drops a pattern's match count to zero (when it wasn't
zero before) surfaces a warn-level System Messages entry naming the
pattern. The user re-edits it; we don't try to rewrite it for them.

**An invalid pattern is data, not a crash.** The editor flags it
("bad regex"); host-side evaluation returns the error for the panel
to surface.

## Why

- **Combined, not mode-exclusive (the revision).** The original
  design made filter-mode exclusive to avoid two-sources-drift. In
  practice the exclusivity blocked ordinary gestures (drop a signal
  onto a filtered area, recolour one matched series) and forced a
  modal UI. The drift problem is solved structurally instead:
  manual-wins dedup plus materialize-on-mutate means every entry's
  provenance is explicable — it's either a pick or a live match, and
  touching a match turns it into a pick.
- **One subject, one implementation.** With two pattern-selecting
  surfaces (plot, signal view), per-surface subjects or semantics
  would make the same pattern mean different things (ADR 0038).
- **Re-evaluate on DBC change because the user expects "set it and
  forget it".** Adding a new DBC populates the selection with
  matching signals without manual re-add.
- **Bus renames invalidate, don't auto-migrate.** Rewriting a
  non-trivial regex is ambiguous; aliasing old names into the matcher
  leaks rename history into its contract. We warn and let the user
  fix it.

## Rejected alternatives

- **Mode-exclusive filter vs manual (the original decision).**
  Superseded — see Why. The migration path: a persisted
  `signalFilter` string loads as a one-entry `patterns` list.
- **Generator at panel creation, then plain areas.** Loses the
  "pattern *defines* the collection" semantics: a DBC loaded later
  wouldn't update existing areas.
- **Narrower regex subjects (message-only, signal-only).** Strictly
  less expressive; the bus/ecu segments are what make "one bus's CRC
  signals" or "everything this ECU sends" easy.
- **Manual → regex conversion.** A generated alternation over N picks
  is noise the user then has to maintain as if they wrote it.

## Consequences

- `PlotPanel` area config carries `patterns?: string[]` (legacy
  `signalFilter` migrates to a one-entry list on load — note the
  *subject* changed with ADR 0038, so a pre-revision filter may need
  a manual touch-up; it is preserved verbatim rather than guessed at).
- The shared implementation lives in `signalSelection.ts` (resolution,
  dedup, sources scoping) + `SignalPatternEditor.tsx` (the list
  editor); the signal view's evaluation runs host-side over the same
  subject (`signal_snapshot.rs`).
- Pattern-derived series are coloured stable-by-identity from the
  shared wheel (`palette.ts`), so a match keeps its colour across
  re-evaluations and surfaces.
