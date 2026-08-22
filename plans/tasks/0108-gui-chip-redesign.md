# Task 108 — The Chip Language: A GUI Polish Pass

Opened by owner instruction 2026-08-21, during the task 107
prototyping session: prototype a GUI redesign — the top-level button
bar, the plot and trace panel chrome, and the other views. Shrink
buttons, leverage common icons, and polish — **everything shaped like
the existing color chips / chip buttons** established in the
connect-disconnect-chip and toolbar-status-bar prototypes.

## Status

Prototype-first, being groomed. The prototype:
[`plans/prototypes/gui-chip-redesign.html`](../prototypes/gui-chip-redesign.html).

## The design language

- **One shape for every control**: the `.color-chip` silhouette —
  2px radius, `--border-wash` hairline — so buttons, toggles, status
  chips and color swatches read as one species (the ruling the
  connection-chip prototype already carries).
- **Smaller**: tighter padding, 12px type in chrome, icon+label or
  icon-only where the icon is unambiguous.
- **Common icons — our own** (owner ruling 2026-08-21): the
  hand-drawn inline-SVG icons are adopted as the app's icon
  language; no external icon set (`rejected` in
  `plans/technology-inventory.md`). Implementation ships them as an
  **in-repo icon registry** — one shared SVG sprite the frontend
  consumes — so the set stays cohesive and grows deliberately. The
  prototype's inventory section is the registry's reference sheet.
- **Icons reach into the panels, not just the toolbars** (owner
  ruling 2026-08-21): the registry's icons are used throughout the
  existing view panels wherever a control or affordance they cover
  appears — the event rows' text glyphs (⇥ ✎ ×) adopt their drawn
  forms, and new in-panel affordances draw from the registry first.
  Not prototyped — the style is established here and reinforced
  opportunistically as panels are touched, under the same
  one-icon-one-meaning rule.
- **The prototype is durable** (owner ruling 2026-08-21): it is
  kept after implementation as the living reference for the icon
  registry and the chrome design, to support fast iteration — like
  `plans/plot-panel-reference.html` before it.
- **State on the hairline**: as in the approved chip prototypes,
  state tints the 1px border and the dot — nothing resizes, nothing
  reflows.

## Rulings (owner, 2026-08-21)

- **The status bar stays.** The bus-health / status-bar design
  (tasks 103 / 101) is not dropped or superseded by this pass. It
  has since **shipped** (`StatusBar.tsx` / `StatusChip.tsx`,
  ADR 0055; its prototypes deleted by the phase that built them),
  and its rulings hold: the connection control lives in the bar
  (the toolbar keeps no Connect button), and System messages /
  Signal mapping / RBS are pinned right in the bar (the toolbar
  carries no duplicate badged launchers). The 108 prototype mirrors
  the implementation.
- The prototype carries a **full icon inventory** section: every
  icon by name and command assignment, so the set is reviewable as
  a set.
- **Plot toolbar rulings:** cursor modes are icon *buttons* (x / y /
  note segment, press again for off), not a dropdown; the perf
  readout is hidden by default and toggled from the toolbar's
  existing right-click menu; the bar never wraps — controls spill
  right-to-left into a `…` overflow (the status bar's pattern); the
  solo cluster (field + paging + clear) is one unbreakable unit,
  placed left so it spills only when it really must; the
  measurements strip **needs rework and stays hidden** (owner
  ruling 2026-08-21 — no toggle anywhere until reworked; the rework
  is backlogged, not 108 scope); and the **catalog-reload button is
  retired** — it
  has outlived its usefulness (implementation removes the command).
- **Icon audit — one icon, one meaning** (2026-08-21): the
  bus-health icon collided with the signals zigzag and is redrawn
  as a bus topology; `db` split from `db-add` (panel vs. action).
  One icon may serve several commands only when it is the same
  *verb* (save / add / search / clear), with the label or tooltip
  naming the object. "Add plot area" sits right of the solo
  cluster. Labels are **Title Case** everywhere; tooltips stay
  sentence case. RBS Run carries the play icon. The set also
  absorbs the app's existing text glyphs (⇥ goto, ✎ rename,
  × remove) as drawn icons; the project-tree icon is a hierarchy,
  and the graph icon draws the bus→views fanout the view graph
  actually shows. All icons in the prototype are hand-drawn inline
  SVG placeholders (14px grid, 1.4px stroke) — no library; the
  real set is the recorded dependency decision.
- **Every panel toolbar gets the treatment**: the prototype sweeps
  all nine remaining bars (signals, transmit, RBS, RBS signals,
  database, graph, servers, system messages, view signals) onto the
  chip shape — same controls, same order, per panel.

## Relationship to task 103 — now implemented

Task 103 **shipped** (2026-08-21, rebased in): `StatusChip.tsx`
(state vocabulary `idle / connecting / connected / degraded /
failed`, hairline-and-dot tinting, badge, a test that no state
changes geometry), `StatusBar.tsx` + `statusBarFit.ts` (lead never
gives way; metrics drop and chips collapse alternating from the
right), ADR 0055; the toolbar lost Connect / System messages / View
signals to the bar, and the two accepted status-bar prototypes were
deleted by the phase that built them. Consequences for this task,
reviewed 2026-08-21:

- This language **extends the shipped `.status-chip`** from status
  to commands — implementation reuses its silhouette and tokens
  (`--danger-badge` badge, state tints), never a parallel chip.
- The shipped `BusHealthLauncher` draws the ECG-zigzag icon inline —
  exactly the `signals` collision the icon audit resolved. 108
  replaces it with the registry's `bus` icon. (The launcher is
  built but not yet mounted, and bus load has no producer — task
  101's business, tracked in `plans/owner-review-queue.md`.)
- Shipped chip labels are sentence case ("System messages"); 108's
  Title Case ruling re-cases them in the sweep.

## Surfaces in the prototype

- The top-level toolbar (all ~20 items as they exist in `App.tsx`,
  regrouped and chip-shaped; the connection chip as approved; the
  badge treatment for system messages / view signals).
- The trace panel toolbar (run controls, mode toggle, auto-scroll /
  events toggles).
- The plot panel toolbar (catalog reload, add area, fit controls,
  points cycle, solo box, cursors, perf badge).

## Final rulings (owner, 2026-08-21) — grooming closed

- Icon-only treatment as prototyped stands.
- The Add-menu collapse is approved.
- Density (22px chips, 12px type) is right.
- **Task 103 implements first**; its shared chip component is what
  this language styles (roadmap reordered accordingly).
- **Task 107's event-surface toolbar speaks this language** — it
  appears in the prototype's all-views sweep, and the 107 prototype
  renders its control in the chip shape.
