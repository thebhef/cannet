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
- **The registry is 36 icons.** (Corrected 2026-08-22: the grooming
  first said 42, from a miscount of the prototype's inventory markup.
  The prototype defines **37** `<symbol>`s and its inventory section
  lists **36** — `reload` is defined but deliberately excluded, because
  the catalog-reload command it serves is retired in phase 4. Phase 1
  built the 36, correctly trusting the prototype over the summary.)
  The prototype's inventory names them:
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
| 1 | The icon registry | Sonnet | The 36-icon module + `<Icon>`, path data copied from the prototype, the set-level tests, and the two audit fixes: `BusHealthLauncher`'s inline ECG zigzag replaced by the registry's `bus` topology (it collides with `signals`), and `db` split from `db-add`. No toolbar changes. |
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


- **2026-08-22 — Phase 2, the command chip and the shared overflow
  planner, landed.** Branch `task-108-phase-2-command-chip` from
  `7c2a8a97`.
  - `9787f94d` replaces `statusBarFit.ts` with `toolbarFit.ts` — the
    planner every bar shares — and points `StatusBar` at it.
  - `00707719` adds `apps/gui/src/ChipButton.tsx`, its CSS block in
    `index.css` and `ChipButton.dom.test.tsx`.
  - `02f9b877` moves `useBusHealth` onto `useHostMirror`, with
    `busHealth.dom.test.tsx`.
  - Frontend tests: 2685/201 files before → 2704/203 files after (all
    green). `tsc --noEmit` and `vite build` clean; the
    `comment-references` grep empty at each commit. No Rust touched.

### The API phases 3–6 consume

**`ChipButton` (`apps/gui/src/ChipButton.tsx`)** — the command chip.
It renders `<button type="button" class="status-chip chip-button …">`:
it *carries* `.status-chip`, so the hairline, the 2px radius, the dot,
the badge and every state tint are the shipped status chip's own
declarations. `.chip-button` adds only the 22px density (at the status
chip's 12px type, not restated), the 13px icon, the icon-only square,
the pressed state, the busy hairline and the focus ring. There is no
parallel chip class; do not add one.

| prop | meaning |
|---|---|
| `icon?: IconName` | a registry icon, drawn left of the label |
| `label?: string` | Title Case words. **Omit for the icon-only form** — the chip then also gets `.chip-button--icon-only` and is a 22px square |
| `state?: StatusChipState` | `idle`/`connecting`/`connected`/`degraded`/`failed`. **Providing it at all is what gives the chip a dot**, in every state including `idle`; a plain command omits it and grows no dot |
| `pressed?: boolean` | a toggle's position → `aria-pressed`. Omit entirely on non-toggles, so nothing announces a state that does not exist |
| `badge?: number` | needs-attention count; absent or `0` renders nothing, capped at `99+` by the shipped `statusChipBadgeText` |
| `busy?: boolean` | the chip's own work is running → `aria-busy`, a pulsing accent hairline (the import chip's treatment) |
| `title?`, `ariaLabel?`, `disabled?`, `className?`, `onPress` | as `StatusChip`. The accessible name falls back `ariaLabel ?? label ?? title`, so **an icon-only chip needs a `title` or an `ariaLabel`** |

Segmented groups (the prototype's `.seg`) are **not** built — no phase
needed one yet. A phase that wants one adds `.seg` to `index.css`
around `ChipButton`s; it must not fork the chip.

**`toolbarFit.ts`** — the one overflow planner. Exports
`planToolbarFit(input): ToolbarFit`, `toolbarRemovalOrder(runs)`, and
the types `ToolbarRun`, `ToolbarRunUnits`, `ToolbarFitInput`,
`ToolbarFit`. `statusBarFit.ts` and its `planStatusBarFit` /
`statusBarRemovalOrder` / `StatusBarFit` / `StatusBarFitInput` /
`StatusBarRemoval` names are **gone** — nothing may reintroduce a
per-bar copy.

- A bar is one or more **runs**, left to right:
  `{ id, widths, clusters?, overflow? }`. `widths[i]` is the item's
  natural width *including the gap that precedes it*. `overflow: true`
  means items removed from that run collapse into the `…` menu (and
  charge `overflowWidth`, once); the default `false` means they simply
  drop off the bar, which is only right when the value survives
  elsewhere.
- The plan is `Readonly<Record<runId, keptCount>>` — how many items of
  each run stay, counted from the left. `StatusBar` reads
  `fit.metrics` / `fit.chips`; a single-run panel bar reads its own id.
- Runs give way **in turn** (rightmost of run 0, rightmost of run 1, …,
  continuing with whichever still has something), and always from the
  right. Put a cluster **left** and it spills last, which is how the
  plot's solo box gets its ruling for free.
- **Cluster contract**: `clusters` is index-parallel to `widths`;
  consecutive items sharing an id are one unbreakable unit, `undefined`
  stands alone, and two spans of the same id with something between
  them are two units. A cluster is removed whole, in one step, so a
  kept count always lands on a cluster boundary — the planner can never
  hand back "the solo field and its paging, but not its clear".
- `available <= 0` means "not measured yet" and returns everything, so
  a bar does not flash empty on mount.

**Measuring is still each bar's own job.** `StatusBar.tsx` is the
reference: `data-sb-measure` attributes on the droppable items, a
`Map` of last-measured widths kept across the renders in which an item
is off the bar (a dropped item cannot be measured, and its last width
is what says whether it would fit again), `getComputedStyle(bar).columnGap`
added per item, a `useLayoutEffect` re-measure after every render and a
`ResizeObserver` on the bar. Two rules it learned the hard way: the bar
must **not** be `overflow: hidden` (it swallows its own absolutely
positioned menu), and the lead region is subtracted from `available`
rather than being a run — the lead never gives way. Phase 3 and phase 4
both need this plumbing; **the second one to arrive lifts the first's
into a shared hook rather than copying it.**

### `useConnectionStates`: it cannot move, and why

`useBusHealth` moved onto `useHostMirror` cleanly.
`useConnectionStates` — the hook `useBusHealth` was copied from —
**cannot, without changing behaviour.** `useHostMirror` treats the host
event as a *nudge to re-read*; it has no "the payload is the value"
mode. `useConnectionStates` uses the payload directly, and
`ProjectPanel.connectionState.dom.test.tsx` pins exactly that, by name:
*"follows the host's change event without a refetch"*. Migrating it as
it stands would turn that assertion false.

That leaves `useConnectionStates` with the launch race still open (a
connection state that moves in `listen`'s attach gap is lost until the
next event). Closing it needs one of: a `fromPayload` option on
`useHostMirror` that keeps the payload path while still doing the
post-listener refetch — which would let both hooks share the
implementation and preserve every current expectation — or accepting
the refetch and re-pinning that test. Recorded under blockers rather
than decided here; it is a behaviour change to a shipped connection
path, not chrome.

### How the three tests were proved by mutation

1. **No reflow.** `ChipButton.dom.test.tsx` does not assert a class. It
   puts `index.css` in the document, collects every rule the rendered
   chip actually `matches()`, and compares the *geometry* declarations
   among them (width/height/padding/margin/border-width/font-size/
   line-height/gap/display/…, deliberately not colour, outline or
   animation) across all five states, pressed, busy and disabled, in
   both the labelled and the icon-only form — plus the chip's markup
   with state attributes stripped, so "this state added an element" is
   caught too. Proved three ways: adding `border-width: 2px` to
   `.status-chip[data-state="failed"]` failed the across-states test;
   adding `padding` to `.chip-button[aria-pressed="true"]` failed the
   affordance test; making the component render an extra span only in
   the `failed` state failed the markup comparison. All three restored
   and re-run green.
2. **The unbreakable cluster.** `toolbarFit.test.ts` sweeps every width
   from 1 to 700 over a five-item run whose middle three are one
   cluster and asserts the set of reachable kept-counts is exactly
   `{0, 1, 4, 5}` — 2 and 3 would each leave half the cluster on the
   bar. Proved by deleting the cluster back-off from `unitStarts` (one
   unit per item): that test and the two other cluster tests failed,
   while every status-bar expectation stayed green (correctly — the
   status bar has no clusters).
3. **The launch race.** `busHealth.dom.test.tsx` holds `listen`'s
   promise open, changes the host's snapshot while it is held, releases
   it, and fires no event at all — so only the post-listener refetch
   can find the change. It was written and run **before** the
   migration, against the shipped hand-rolled hook: that one arm failed
   and the other three passed. It passes after.

### Prototype

Kept and updated in the same commits, three places:
`statusBarFit.ts` → `toolbarFit.ts` in the status-bar note, with the
"every bar shares it" wording; a note on the plot-bar CSS that both
bars go through the one planner and that it keeps the solo cluster
whole; and the `.chip` comment now records that the app's command chip
is `.status-chip` + `.chip-button` rather than a second class, and that
the dot appears only on a chip carrying a state. Two numbers in the
prototype's own `.chip` were drifting from the shipped chip it claims
to extend and were aligned to it: `gap` `.35rem` → `.4rem`, and
`:disabled` from `color: var(--text-dim)` to `opacity: .7`.

- **2026-08-22 — Phase 3, the top-level toolbar and the shared
  measurement, landed.** Branch `task-108-phase-3-top-toolbar` from
  `df04fedd`.
  - `f7dfc799` adds `apps/gui/src/useToolbarFit.ts` +
    `useToolbarFit.dom.test.tsx` and moves `StatusBar` onto it.
  - `87bb566d` gives `ChipButton` a `menuOpen` prop — a menu trigger is
    not a toggle.
  - `29a9d0eb` adds `apps/gui/src/Toolbar.tsx` + `Toolbar.dom.test.tsx`
    and the shared chip-menu CSS.
  - `6ed0b251` mounts it in `App`, retires the legacy toolbar CSS, adds
    `toolbarTestKit.ts`, migrates the 20 App tests that clicked the old
    buttons, amends ADR 0055 and updates the README and the prototype.
  - `ab92c24c` drops a task number from a comment in the new test file.
    The `comment-references` gate was run before each commit and read
    clean — wrongly: `git grep` without `--untracked` cannot see a file
    that is still new. Run it as `git grep --untracked`.
  - **Overseer review corrections, same branch.** `45e7b559` restores
    ADR 0055's superseded rule instead of overwriting it — "do not
    convert a command into a chip" is back, dated and annotated the way
    ADR 0026 carries its own reversal, and the status line now reads
    `accepted (2026-08-21); amended (2026-08-22)`. The rule itself is
    unchanged. `5e142f53` adds `--untracked` to the
    `comment-references` CI job (`.github/workflows/ci.yml`): the flag
    is a no-op on CI, where a fresh checkout has everything tracked,
    but CI is the spelling every phase copies for its pre-commit check,
    and without it the check is blind to a file it has just written.
    Verified by canary: a new untracked `apps/` file containing
    `// task 999` is found by `git grep --untracked -Ein …` (exit 0,
    the job would fail) and missed by the old spelling (exit 1, the job
    would pass). The job body run verbatim on the clean tree passes.
  - Frontend tests: 2704/203 files before → 2718/205 files after (all
    green). `tsc --noEmit` and `vite build` clean; the
    `comment-references` grep empty at each commit. No Rust touched.

### The bar as it now reads

Twelve chips where there were twenty buttons, same commands, same
order: **Open** · **Save** │ **Import** · **Recent** · **DBC** │
**Clear** · **Capture** │ **Add ▾** (Trace, Plot Panel, Signal View,
Transmit Panel, RBS Panel, Color Map, Generator) │ four icon-only
launchers (Database / Graph / Events / Project panel). Every tooltip is
the exact phrase its old button carried. The toolbar carries no
connection, System Messages, Signal Mapping or RBS launcher — it never
did after task 103, so there was no defect to report, and
`Toolbar.dom.test.tsx` now holds that it stays that way.

### The measurement hook phases 4–6 consume

**`useToolbarFit` (`apps/gui/src/useToolbarFit.ts`)** — the DOM half of
the fit, lifted out of `StatusBar` before a second bar could copy it.
`planToolbarFit` still does the arithmetic; this gets it its numbers.

```ts
const { barRef, fit } = useToolbarFit<HTMLDivElement>({
  runs,               // ToolbarFitRun[]: { id, items, overflow? }
  overflowFallback,   // px to assume for the overflow control unmeasured
  reserve,            // () => px the runs never get (the lead)
});
```

- `runs[].items[]` is `{ key, fallback?, cluster? }` — the planner's
  `widths` / `clusters` with the widths not yet filled in. `key` is also
  the value of the item's `data-toolbar-fit` attribute, which is how the
  hook finds the element to measure. `TOOLBAR_FIT_ATTR` and
  `TOOLBAR_FIT_OVERFLOW_KEY` (`"overflow"`) are exported; the old
  `data-sb-measure` name is gone.
- `fit` is `planToolbarFit`'s plan —
  `Readonly<Record<runId, keptCount>>` — and is everything-kept before
  the first measurement, so no bar flashes empty on mount.
- `reserve()` is read at measure time, so it may look at the caller's
  own refs (`StatusBar` returns its lead width plus the notice's
  guaranteed slice). The lead is **not** a run: it never gives way.
- The hook re-measures in a `useLayoutEffect` after *every* render and
  from a `ResizeObserver` on the bar, both reached through a ref, so a
  re-rendering bar does not churn observers.
- The one rule it cannot enforce: **the bar must not be
  `overflow: hidden`** — a clipping bar swallows its own absolutely
  positioned menu. `StatusBar.dom.test.tsx` asserts that against
  `index.css`; a bar adopting the hook should assert the same about its
  own class.
- **What jsdom cannot check**: `offsetWidth` / `clientWidth` are always
  0 there, so `useToolbarFit.dom.test.tsx` supplies every width and
  tests the arithmetic (the width map, the gap, the reserve, the
  overflow charge). Nothing in the suite proves the hook reads a real
  rendered box; only the running app does.

**The top toolbar does not use it.** The prototype gives `.appbar` (the
header) `flex-wrap: wrap` and reserves the no-wrap-plus-overflow
treatment for `.plotbar`; the Add-menu collapse leaves the header at
twelve chips, so nothing there needed to give way. `StatusBar` is the
hook's only consumer until phase 4.

### The pattern a sweep phase should copy

- **Extract the bar into its own component** taking `onRun(commandId)`
  plus the few view facts its chips need (`captureEmpty`, `importing`),
  and render it from the owner. `Toolbar.tsx` is 200 lines that came out
  of `App.tsx`, and the point is not tidiness: a bar that renders from
  props can be pinned by a test with a spy for `onRun`, which is what
  makes "every command still reachable" checkable at all.
- **Pin the bar against a literal table in the test file** — order,
  label, tooltip, and the command each chip dispatches — never against
  the array the component renders from. `Toolbar.dom.test.tsx`'s `BAR`
  and `ADD_MENU` are the shape to copy.
- **Labels are Title Case and short; the tooltip is the old full
  phrase, sentence case.** Every tooltip on this bar is the exact words
  its old button carried, which is why the README needed only its
  labels changing. Keep that property — it is what makes a sweep
  reviewable.
- **Icon-only chips need a `title` or an `ariaLabel`** (`ChipButton`
  falls back `ariaLabel ?? label ?? title`), and tests find chips by
  accessible name — see `toolbarTestKit.ts`.
- **Menus hang off `ChipButton`'s `menuOpen` prop** and the shared
  `.chip-menu` / `.chip-menu-list` classes. Do not add a caret element:
  `aria-haspopup` carries it. (The Add chip's caret is a character in
  its label, matching the prototype, with `ariaLabel` keeping the
  accessible name clean.)
- **Delete the bar's legacy `button` CSS in the same commit.** A
  `.toolbar button { … }` rule out-specifies `.status-chip` (0,1,1 beats
  0,1,0) and silently restyles every chip on that bar. Each remaining
  bar has one: `.plot-panel-toolbar button`, `.tx-panel-toolbar button`,
  `.system-messages-toolbar button`.
- **Expect the test migration to be most of the diff.** Twenty files
  clicked the old toolbar by `textContent`. Two things bite: the new
  short labels collide with dialog buttons (the toolbar's "Open" chip
  vs. the channel-map dialog's "Open" confirm), so each file's local
  `findButton` now skips `.toolbar`; and a menu opened inside an outer
  `act(...)` has not rendered yet when the same statement looks for its
  entry, so `addPanelChip` opens it inside `flushSync`.
- **What not to copy**: `.seg` is still unbuilt (phase 4 needs it
  first), and this bar wraps rather than overflowing — a bar that must
  not wrap takes `useToolbarFit`, not `flex-wrap`.

### How the tests were proved by mutation

1. **Every command still reachable.** `Toolbar.dom.test.tsx` renders the
   bar with a spy for `onRun` and clicks every chip. Proved three ways:
   pointing the Graph-panel chip at `panel.show.events` failed
   "dispatches its own command from every chip"; deleting Color Map from
   the Add menu failed "collapses the seven Add commands into one menu";
   adding a System Messages launcher back to the bar failed three tests
   including "carries no launcher for anything the status bar already
   reports". All restored and re-run green.
2. **The hook's dropped-item memory.** The width map is exercised with a
   deliberately absurd `fallback` (1000 against a real 100), so a
   forgetful hook cannot bring a dropped item back and stays *stably*
   wrong at one item rather than flapping to the right answer. Replacing
   `widthsRef.current` with a fresh `Map` per measure failed four of the
   five tests — including the gap and reserve ones, which is right:
   without the memory those bars oscillate.
3. **The gap and the reserve.** Dropping `+ gap` from the per-item cost
   failed only "charges every item for the gap in front of it";
   dropping `- reserve()` failed only "takes the reserved lead off the
   top". Both restored and re-run green.
4. **The menu-trigger prop.** Forcing `aria-haspopup` to `undefined`
   failed `ChipButton`'s new "announces the menu it opens" test.

### Prototype

Kept and updated in the same commit, three places: the before-shot
section is retitled "before this pass" and says why it still shows
Connect / View signals / System messages; the `.menu-wrap` comment names
the app's `.chip-menu` / `.chip-menu-list` classes and the
`aria-haspopup` trigger; and the busy-chip rule records that the app's
import chip is *also* disabled while it runs, so it keeps full contrast
and takes the progress cursor rather than dimming.

## Blockers / side effects

- **`useConnectionStates` still hand-rolls fetch-then-listen, and still
  has the launch race** (phase 2). It cannot go through `useHostMirror`
  without changing behaviour a named shipped test pins — see phase 2's
  status entry for the two ways out. It wants an owner call, because it
  changes a shipped connection path rather than chrome.
- **Toolbar width *measurement* is not shared, only the planning is**
  (phase 2). `StatusBar.tsx` measures its own items; phases 3 and 4
  each need the same plumbing. Whichever lands second should lift the
  first's into a shared hook rather than copy it — phase 2's API
  section lists what that plumbing has to get right.
- **The prototype's segmented group (`.seg`) has no implementation**
  (phase 2). The command chip covers icon-only, icon+label, toggle and
  badge; nothing in phase 2's scope needed a segmented run of chips
  sharing one hairline, so none was built. The phase that first needs
  one (the trace mode toggle, the plot's cursor segment) adds the
  wrapper class around `ChipButton`s — it must not fork the chip.

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

- **The import chip no longer relabels itself to "Loading trace…"**
  (phase 3). The shipped button swapped its own label mid-load; the chip
  keeps the label "Import" and says it is loading with the pulsing
  accent hairline, the disabled state, and a tooltip naming the status
  bar's Cancel. That is the prototype's own treatment of this chip
  (`#importChip` toggles `aria-busy` and nothing else) and the reason
  `ChipButton` has a `busy` prop at all — but it is still a change to a
  shipped, user-visible string, taken deliberately rather than drifted
  into. `App.importTraceGuard` / `App.traceOpenCancel` now pin the
  tooltip and the state instead of the label.

- **ADR 0055 §1 said "Do not convert a command into a chip"**
  (phase 3). That sentence and this task's chip language cannot both
  stand, and the owner rulings are the newer decision, so the ADR was
  amended: the silhouette is shared, and the dot — present only on a
  chip with a state to report — is what keeps the distinction readable.
  The superseded rule is kept and annotated rather than overwritten
  (`45e7b559`, after overseer review), and the status line records the
  amendment. Flagged because it is an amendment to an accepted ADR made
  by an implementation phase.

- **The top-level toolbar wraps rather than overflowing** (phase 3), per
  the prototype (`.appbar` is `flex-wrap: wrap`; only `.plotbar` is
  `nowrap` with the overflow menu). The shared measurement hook this
  phase was asked to build therefore has one consumer, `StatusBar`,
  until phase 4 arrives. If the header is meant to overflow too, that is
  a design decision the prototype does not currently carry.

- **`README.md` still named a toolbar Connect button** (phase 3) — doc
  rot from task 103, which moved the control to the status bar. The line
  was corrected in passing because it names the toolbar; nothing else in
  that section was touched.
