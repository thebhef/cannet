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

## Grooming — phases and the detail they need (overseer, 2026-08-22)

Answers the codebase could give, given here rather than asked. The
three that are genuinely judgement calls are marked **owner call**;
each carries the reading implementation takes if no ruling arrives.

### Implementation detail settled by reading the code

- **The overflow planner already exists.** `statusBarFit.ts`
  (`planStatusBarFit`, `statusBarRemovalOrder`, 108 lines) is the
  right-to-left drop planner task 103 shipped. Panel toolbars get the
  *same* planner generalized — never a second copy per bar. The repo's
  one-shared-implementation rule decides this; the shipped names widen
  to a neutral toolbar vocabulary, `StatusBar` keeps consuming them.
- **Retiring catalog reload orphans a context export.**
  `PlotPanel.tsx:2378` is the only consumer of `useSignalCatalog()`'s
  `refresh`, and `signalCatalogContext.tsx` already re-fetches on
  `dbcPaths` / `dbcGeneration` and on two event subscriptions — the
  button is genuinely redundant, not merely unloved. Removing it makes
  `refresh` unused, so it comes out of the context value in the same
  commit (the "clean up your own orphans" rule), leaving the internal
  `refreshCatalog` callback as the effect's driver.
- **The registry is 42 icons.** The prototype's inventory names them:
  folder, save, import, clock, db, db-add, bus, plug, clear, plus,
  rows, chart, signals, send, loop, palette, wave, eye, graph, flag,
  tree, bell, play, pause, stop, fit-x, fit-y, search, cursors,
  cursor-x, cursor-y, note, goto, edit, link, x (plus the audit's
  splits). That is the set phase 1 lands; the prototype's path data is
  the source, copied verbatim so prototype and app cannot drift on
  day one.
- **`.status-chip` is the silhouette to extend**, not to parallel —
  `StatusChip.tsx` (101 lines) already carries the hairline-and-dot
  tinting, the `--danger-badge` badge and the no-state-changes-geometry
  test. The command chip is that component's shape with a press
  affordance, sharing its tokens.

### Owner call 1 — the registry's mechanism

The rulings say "one shared SVG sprite the frontend consumes".
**Recommended reading: one module exporting `<Icon name="…"/>` over a
single `name → path-data` record**, rather than a `<symbol>` sprite
plus `<use>`. Same single source of truth and the same
reviewable-as-a-set property, but no sprite mount point in `index.html`,
no `href` indirection that a test cannot see through, and a test can
assert the set directly (every registry name renders; every name used
in the app exists in the registry). If the owner meant a literal
`<symbol>` sprite, say so and phase 1 takes that instead — the
consuming code is identical either way.

### Owner call 2 — how far "icons reach into the panels" goes in this task

The ruling makes it opportunistic ("reinforced opportunistically as
panels are touched"). **Recommended reading: one bounded sweep as
phase 6** — the event rows' three text glyphs (⇥ ✎ ×) adopt their drawn
forms, and any control in a panel this task already touches that the
registry covers switches to the icon. New affordances draw from the
registry first, from now on, as a standing rule rather than a phase.
Anything wider is a separate task.

### Owner call 3 — Title Case re-casing reaches shipped strings

Re-casing the shipped chips ("System messages" → "System Messages") is
named in the rulings and touches user-visible strings and their tests.
**Recommended: take it, in the phase that sweeps each surface** rather
than as one string-only commit, so each diff shows the label beside the
control it labels.

### Phases

| # | Phase | Model | What lands |
|---|---|---|---|
| 1 | The icon registry | Sonnet | The 42-icon module + `<Icon>`, path data copied from the prototype, the set-level tests, and the two audit fixes: `BusHealthLauncher`'s inline ECG zigzag replaced by the registry's `bus` topology (it collides with `signals`), and `db` split from `db-add`. No toolbar changes. |
| 2 | The command chip and the shared overflow | Opus | `ChipButton` extending `StatusChip`'s silhouette (icon-only / icon+label, 22px chip, 12px type, badge, state on the hairline, press affordance); `statusBarFit` generalized into the toolbar overflow planner both the status bar and panel bars consume, with `…` spill and unbreakable-cluster support. Tests: no state changes geometry; a cluster never splits; drop order. |
| 3 | The top-level toolbar | Opus | All ~20 `App.tsx` items regrouped onto chips, the Add-menu collapse, the badge treatment, Title Case. The connection / System Messages / Signal Mapping / RBS chips stay in the status bar — the toolbar gains no duplicate launcher. |
| 4 | The plot panel toolbar | Opus | Cursor modes as icon buttons (x / y / note segment, press again for off) rather than a dropdown; the perf readout hidden by default behind the toolbar's existing right-click menu; catalog reload retired (button, command, and the orphaned context export); the solo cluster (field + paging + clear) one unbreakable unit placed left, with "Add Plot Area" to its right; overflow rather than wrap. The measurements strip **stays hidden** — no toggle anywhere. |
| 5 | The trace panel toolbar and the nine remaining bars | Sonnet | Trace run controls / mode toggle / auto-scroll / events toggles, then signals, transmit, RBS, RBS signals, database, graph, servers, system messages and view signals — same controls, same order, chip shape, per the prototype's sweep. |
| 6 | Icons reach into the panels | Sonnet | The event rows' ⇥ ✎ × adopt their drawn forms; registry icons replace ad-hoc glyphs in the panels this task touched. |

**The prototype is durable and is maintained in the same commits.**
Where implementation diverges from
[`plans/prototypes/gui-chip-redesign.html`](../prototypes/gui-chip-redesign.html),
the phase updates the prototype so it stays the living reference for
the icon set and the chrome — it is not deleted at the end (owner
ruling 2026-08-21, restated 2026-08-21 evening). This is a standing
instruction in every phase prompt, not a phase of its own.

## Status log

- **2026-08-22 — Phase 1, the icon registry, landed.** Branch
  `task-108-phase-1-icon-registry` from `3c560f70`.
  - `3837937f` adds `apps/gui/src/Icon.tsx` (`ICON_NAMES`,
    `ICON_REGISTRY`, `<Icon name=".."/>`) and `Icon.dom.test.tsx`.
  - `13e90c6c` points `BusHealthLauncher` at the registry's `bus` icon
    in place of its inline ECG-zigzag `<polyline>`, with a test
    pinning that the rendered SVG has the bus icon's shape (two
    circles, no polyline, `viewBox="0 0 14 14"`).
  - Frontend tests: 2682/200 files before → 2685/201 files after (all
    green). `tsc --noEmit` and `vite build` clean.
    `comment-references` grep (`task [0-9]|plans/` over `apps/`,
    `crates/`) empty as of `3c904146` — it initially caught this
    phase's own registry comments naming the prototype's `plans/`
    path (describing it verbatim, "copied from
    `plans/prototypes/gui-chip-redesign.html`"), which
    `3c904146` reworded to "the design prototype" instead.
  - **Mechanism**: took the overseer's reading — an `Icon` component
    over a plain `name -> shape data` record, not a `<symbol>`/`<use>`
    sprite. Shape data is typed (`path`/`circle`/`ellipse`/`rect`
    variants with numeric/string fields) rather than a markup string,
    so no icon can carry an attribute the registry doesn't model, and
    copying stayed verbatim (same numbers, same path `d` strings) from
    the prototype's `<symbol>` bodies.
  - **Set-level test, proved by mutation**: `Icon.dom.test.tsx` pins
    the exact 36-name set against a literal array copied from the
    prototype's inventory, independent of whatever `ICON_NAMES` holds
    at read time. Verified by temporarily (a) deleting `"x"` from
    `ICON_NAMES`+registry and (b) adding an unnamed `"spare"` icon to
    both — the pin test failed both times (the "renders every
    registered icon" test did not, as expected, since it only walks
    whatever the registry currently contains) — then restored both
    mutations and re-ran green.
  - **Registry inventory as built** (36 icons; name — for): folder —
    open project; save — save project / save capture; import — import
    trace; clock — recent captures; db — database panel; db-add — add
    DBC; bus — bus health launcher (now wired); plug — connection
    (spare, unused so far); clear — clear capture / trace clear; plus —
    add menu / add area / add-frame-style buttons; rows — trace panel;
    chart — plot panel; signals — signal view / RBS signals list; send
    — transmit panel; loop — RBS panel; palette — color map; wave —
    generator; eye — view signals; graph — graph panel (bus→views
    fanout); flag — events panel / events toggle; tree — project panel;
    bell — system messages; play — start/run; pause — pause; stop —
    stop; fit-x — plot fit x axis; fit-y — plot fit y axes; search —
    solo box / filter fields; cursors — clear cursors; cursor-x — x
    cursor mode; cursor-y — y cursor mode; note — note-placement mode;
    goto — event row go-to (today's ⇥); edit — inline rename (today's
    ✎); link — events view link-events; x — remove / clear-solo
    (today's ×).
  - **Prototype**: not changed. Its "icon set — full inventory" section
    already used `i-bus` (not a zigzag) for bus health and already
    carried `i-db` separate from `i-db-add` — both audit fixes were
    already reflected there, so the divergence to fix was in the app
    code only.

## Blockers / side effects

- **"42 icons" vs. the prototype's actual inventory (36).** Both the
  task's main description and the grooming section's "Implementation
  detail settled by reading the code" say the registry is 42 icons.
  Counting the prototype's own "icon set — full inventory" section
  (the explicitly named source of truth, not the summary list) gives
  36 named icons. The `<defs>` sprite itself defines 37 `<symbol>`s —
  36 of the inventory plus `i-reload`, which the inventory section
  does not list and whose command (catalog reload) the rulings retire
  in phase 4. Per the instruction to "take the inventory from the
  prototype, not from this list," phase 1 built the 36 named in the
  inventory section and left `reload` out of the registry, since it
  names no surviving command and isn't part of the reviewable set the
  prototype documents. Flagging the "42" discrepancy rather than
  silently reconciling it — if a wider or different set was intended,
  say so and a later phase can add to the registry (additive, not a
  rework of phase 1's shape).
