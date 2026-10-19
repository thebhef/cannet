# Task 168 — Duplicate a Project Element

> **Opened 2026-10-13** from feedback item 18; groomed 2026-10-14 (Q1
> ruled). Both phases landed 2026-10-14; awaiting the owner's acceptance.

## Why

> Add copy button for project elements — owner, 2026-10-13

## Survey (2026-10-13)

Nothing duplicates a project element. Elements (`trace, plot, signals,
transmit, filter, rbs, colormap, generator, logger`) are frontend-owned
opaque records with `crypto.randomUUID()` ids (`App.tsx::create`,
`buildFreshElement`; the host stores `elements: Vec<serde_json::Value>`
unread). `ProjectPanel.tsx::ElementRow` carries Open and Remove icon
buttons, where a Duplicate would sit. Per-kind wrinkles:
`transmit.frameIds` index the shared host TX pool (a shallow copy shares
frames — `removeElement` already tolerates sharing — a deep copy needs
new host frames); `plot.config` holds areas with their own UUIDs
(`plotAreaTransfer.ts::copyOfArea` rekeys one); `rbs.path` is per
element on the host. One undo gesture. Not the clipboard copy of
feedback item 1.

## Grooming (2026-10-14)

Design, standing: a **Duplicate** icon button on the Project panel's
element row (`ProjectPanel.tsx::ElementRow`) beside Remove. The copy
gets a fresh `crypto.randomUUID()` id, the name `<original> (copy)`,
lands directly after the original in the registry, opens no panel, and
is one undo gesture (the shape `removeElement` already has). `plot`
configs rekey their area ids (`plotAreaTransfer.ts::copyOfArea` per
area, axis scales re-keyed); `rbs` copies its `path` reference (the
host loads per element id on open); `logger` copies `enabled: false`.

**Q1 — a transmit element's frames. Ruling (owner, 2026-10-14):**
**deep** — "Obviously deep. The alternative is useless." The copy gets
its own host TX frames: each frame the original references is cloned
on the host (a `clone_transmit_frame` command, or the existing add path
re-registered with the frame's current definition) and the copy's
`frameIds` point at the clones. Shared frames between two elements are
never created by Duplicate.

## Phases

Branches beneath `doc-closeout-2`, sequential in the shared tree.

1. The button and duplication for every kind but `transmit` (trace,
   plot, signals, filter, rbs, colormap, generator, logger) — Sonnet,
   `task168-duplicate`.
2. `transmit`: deep copy of the referenced host TX frames — Sonnet,
   `task168-duplicate-transmit`.

## Exit criteria

- [x] Every element row has Duplicate; the copy is a fresh element
      named `<original> (copy)`, placed after the original, undoable in
      one step; editing the copy never changes the original (plot areas
      re-keyed, nothing shared). (phases 1–2)
- [x] A duplicated transmit element owns its own host frames; removing
      either element leaves the other's frames intact. (phase 2,
      b378b2d7)
- [x] README's Project panel section mentions Duplicate; CONTEXT.md
      does not list the row's actions (unchanged). (phases 1–2)
- [x] Each phase: six-job local CI green, `comment-references` grep
      clean. (Rust lanes on phase 2; Python unreachable)

## Status log

- **2026-10-14 — Phase 1 landed on `task168-duplicate` @ d4dcf138**
  (44efb144 before the trailer amend). A Duplicate icon button (`plus`
  — the 40-icon set has no copy icon, none added) on every element row
  beside Remove. `projectElements.ts::duplicateElement` makes a
  structural deep copy with a fresh id and the name `<name> (copy)`
  (kind label fallback); plot areas re-keyed via `copyOfArea`, the four
  area-keyed config maps (`axisScales`, `axisWeights`, `axisCollapsed`,
  `cursorYByArea`) via `rekeyAxisScales`; an rbs copy carries its
  `path` and App's existing reconciler loads it; a logger copy is
  disabled. `ElementRegistry.duplicate` splices the copy directly after
  the original, opens no panel, one undo gesture (shape of
  `removeElement`). Transmit refused in the registry (`""`) and its row
  button disabled with "Duplicating a transmit element is not yet
  available" — phase 2 lifts both and updates the README sentence.
  Tests: 6 `duplicateElement` units, ProjectPanel dom (click, transmit
  disabled), a real-App undo/redo test. Tests written first but not run
  red before implementing. Full frontend suite 3929/3929, tsc, build,
  grep 0 hits; Rust/Python lanes unreachable. 11 files, +275/−3. README
  has mixed line endings; the agent redid its edit byte-exact.

- **2026-10-14 — Phase 2 landed on `task168-duplicate-transmit` @
  b378b2d7** (single commit). Q1 (deep) implemented: host command
  `clone_transmit_frames(pairs)` on `TransmitFrameRegistry::clone_frames`
  clones each referenced TX frame under a fresh id (request, period,
  mode, description, calc override); a clone is a fresh entry —
  stopped, counter 0 — whatever the original is doing; the batch is
  atomic (unknown or RBS-owned source, taken or repeated new id → the
  whole batch fails, nothing inserted); listed in `command_surface.rs`.
  `ElementRegistry.duplicate` is async: the clone round-trip precedes
  the splice, a failure adds nothing, one undo step. Row button
  enabled; README sentence replaced. **Undo withdraws the clones:**
  ADR 0050 makes element undo registry-only, which would have orphaned
  the cloned frames in the pool and in saved projects, so
  `applyElementHistory` removes the frames a Duplicate cloned when its
  copy is undone (skipping any another element still groups) —
  withdrawal only; redo restores an empty transmit element per ADR
  0050's existing rule. ADR 0050 gains one sentence (queued § 1 as a
  behaviour change); ADR 0027 notes Duplicate clones, never shares.
  Tests: 3 Rust units (`clone_frames`), a `duplicateElement` unit, the
  flipped ProjectPanel test, a real-App clone-and-undo test; the
  TransmitPanel independence test not written (covered host-side).
  Not strictly red-first. Full lanes: vitest 3931/3931, build, `cargo
  test -p cannet-gui` 1453, clippy, fmt, rustdoc clean, grep 0 hits;
  Python unreachable. 16 files, +259/−33. `transmit_frames.rs` and ADR
  0050 were CRLF in the working tree; normalised to LF. **Finding:** a
  stale `frameIds` entry makes the whole Duplicate fail silently (no
  user-visible message — the frontend has no error-reporting path for
  a failed command; same class as the manual-send gap, queued § 3).

- 2026-10-19 — **Owner ruling (queue § 1): the ADR 0050 sentence
  stands.** Asked whether this was just "stop sending the message when
  we remove the transmit message" — nearly: Remove already withdraws an
  element's host frames (`App.tsx::removeElement`); this is the same
  rule applied to *undoing a Duplicate*, whose clones are created
  stopped, so what leaves with the copy is pool and saved-project
  residue, not a running send. "Obviously necessary if so."

## Blockers / side effects

- **Duplicate icon is `plus`** — the icon set has no copy glyph. FYI;
  a dedicated glyph is a one-SVG change if wanted.
- **Silent failure on a stale frame id** (phase 2 finding) — folded
  into the failed-send reporting item, queue § 2 (2026-10-19).
- **ADR 0050 amended** (undo withdraws cloned frames) — accepted
  2026-10-19.
