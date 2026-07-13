# ADR 0037 — Commands are the single model for every action; surfaces are views

Status: accepted (2026-07-12)

## Context

The GUI exposes user actions through several surfaces: the top-bar
toolbar, the command palette (`Ctrl/Cmd+Shift+P`), the go-to-view and
go-to-event palettes (`Ctrl/Cmd+P` and its sibling), and keyboard
chords. [ADR 0018](0018-command-keybinding-framework.md) introduced the
command registry, the dispatcher, and the context-predicate machinery.
This ADR records the *binding principle* those pieces imply — one that
was violated in passing and is easy to violate again — and the
chord-reuse invariant that the context predicates make possible.

The toolbar originally called its handlers directly (`onClick={handleX}`),
bypassing the registry: a toolbar click got neither the recent-command
tracking nor the context gate that the palette and keyboard did, and
some toolbar actions had no command at all, so they were unreachable
from the palette. That divergence is the failure mode this ADR exists to
prevent.

## Decision

1. **Every user-triggerable action is a registered command.** No action
   surface has a bespoke handler path that bypasses the registry.
   Toolbar buttons, palette entries, and key chords all resolve to a
   command id and dispatch through the single `runCommand` chokepoint,
   so recent-tracking and the context gate apply uniformly. Adding an
   action means adding a `CommandSpec` (and wiring its handler once),
   not attaching a new ad-hoc click handler.

2. **Surfaces are declarative views over the registry.** The toolbar is
   an ordered list of command ids (plus separators); rendering maps each
   id to a button whose `onClick` is `runCommand(id)`. Buttons that
   carry view-extras — a conditional label (Connect ⇄ Disconnect), a
   disabled state (Clear/Save while the capture is empty), an unread
   badge, an argument-bearing dropdown (Recent BLFs) — are escape
   hatches, rendered bespoke and interleaved in the same ordered list,
   but they still dispatch commands. The list is data, not a config
   language: the escape hatches are plain code, not declarative rules.

3. **Context-aware chord reuse is a first-class invariant.** A chord may
   bind *different* commands as long as their context predicates are
   disjoint (the two commands can never be available at the same time).
   A conflict is only a same-chord — or prefix — collision in an
   *overlapping* context. Conflicts are refused (a build-time assertion
   over the shipped defaults, and edit-time validation for user
   bindings; see ADR 0018). The overlap test is decided by enumerating
   the whole finite context space, so it is context-aware by
   construction. **It must never be weakened to a naive "is this chord
   already bound?" string test** — that would forbid the legal
   per-context bindings this invariant exists to allow (e.g. `f` fitting
   the x-axis while a plot is focused and meaning something else while a
   trace is focused).

## Why

- **One model, one chokepoint, buys discoverability, consistency, and
  testability.** Every action is in the palette; every dispatch is
  recent-tracked and context-gated the same way; the whole set is
  enumerable and assertable in a test. A surface that calls a handler
  directly silently loses all three — exactly what the old toolbar did.
- **A data-driven toolbar keeps order and membership in one readable
  list.** Reordering or adding a button is a one-line list edit, and the
  reviewer sees the whole toolbar at a glance. The few stateful buttons
  stay honest as small bespoke branches rather than forcing a
  declarative DSL for disabled-state / badges / dropdowns that only a
  handful of buttons need.
- **Context-aware reuse is what makes a small keyboard vocabulary go
  far.** Per-panel chords (a plot's `f`/`l`) reuse keys that mean nothing
  elsewhere. Writing the invariant down guards it against a future
  "simplification" that treats a chord as globally unique and breaks
  per-context bindings — a real risk now that users can create their own
  reuse in the shortcuts panel.

## Rejected alternatives

- **Bespoke handlers per surface (the status quo ante for the toolbar).**
  Each surface diverges silently — different tracking, different gating,
  actions missing from the palette. The bug this ADR closes.
- **Disabled-state via command context.** Moving each button's disabled
  predicate into `CommandContext` (so "disabled" means "command
  unavailable") is appealing — a single source of truth — but it is a
  larger change that expands the context shape and was deferred (a
  Task 37 non-goal). Disabled state stays view-local for now; the
  toolbar list carries a computed `disabled` per entry.
- **A declarative toolbar config language.** Encoding conditional
  labels, badges, and dropdowns as data would need a DSL and an
  interpreter for four one-off buttons — an abstraction for single-use
  code. Escape hatches as plain code are smaller to read.
- **Naive chord-uniqueness (one command per chord, globally).** Simpler
  to implement, but forbids legal disjoint-context reuse and throws away
  the leverage the context predicates provide.

## Consequences

- New actions land as a command plus, where they belong on the toolbar,
  one entry in the ordered list. Panel-local actions dispatch through the
  focused panel's command registry (ADR 0018).
- The shortcuts panel, the command palette, and the go-to-view /
  go-to-event palettes are all views over the same registry.
- Source code cites this ADR for the "action = command, surface = view"
  principle and ADR 0018 for the binding / conflict mechanics.
- The context enumeration that powers the overlap test must list every
  `FocusedPanelKind` and context dimension; an omission silently makes a
  genuinely-overlapping pair look disjoint. Keeping it complete is part
  of honoring invariant (3).
