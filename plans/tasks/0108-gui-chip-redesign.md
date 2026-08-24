# Task 108 — The Chip Language: A GUI Polish Pass

Opened by owner instruction 2026-08-21, during the task 107
prototyping session: prototype a GUI redesign — the top-level button
bar, the plot and trace panel chrome, and the other views. Shrink
buttons, leverage common icons, and polish — **everything shaped like
the existing color chips / chip buttons** established in the
connect-disconnect-chip and toolbar-status-bar prototypes.

## Status

**Code-complete, awaiting acceptance (2026-08-23).** Prototype-first;
grooming closed 2026-08-21 and **all six phases landed 2026-08-22** on
the chain (nothing has merged). The prototype
[`plans/prototypes/gui-chip-redesign.html`](../prototypes/gui-chip-redesign.html)
is durable and was maintained in the same commits. The sixteen checkable
claims are walked at `## Exit criteria, walked (phase 6 close-out)`:
fifteen met, one N/A.

Two statements below are stale and are corrected here rather than in
place, because they were true when they were written: **exit criterion
16 and the phase-6 entry both say task 107 is not implemented.** Task
107 landed all five of its phases on 2026-08-22, after phase 6 ran, so
its event-surface toolbar exists and has never been converted to this
language. Whether that conversion is still owed is the owner's call.

Findings still owed a verdict: owner-review-queue **1.37**, **1.38**,
3.19, 3.20, 3.21, 3.22, 3.23, 3.24, 3.25, 3.26, **3.60**. Nothing in
this task was seen rendered in a browser — jsdom does no layout, so no
test here proves any bar fits or lines up (owner-review-queue 3.44).

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

Segmented groups (the prototype's `.seg`) were **not** built by this
phase — no phase needed one yet. Phase 4 built one, as `ChipSegment` /
`.chip-seg`; see its status entry for the API.

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
twelve chips, so nothing there needed to give way. `StatusBar` was the
hook's only consumer until phase 4, which added the plot bar and taught
the hook to subtract the bar's own padding.

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
- **What not to copy**: this bar wraps rather than overflowing — a bar
  that must not wrap takes `useToolbarFit`, not `flex-wrap`. (`.seg`
  was unbuilt when this was written; phase 4 built it as
  `ChipSegment`.)

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


- **2026-08-22 — Phase 4, the plot panel toolbar, landed.** Branch
  `task-108-phase-4-plot-toolbar` from `63269d73`.
  - `4b379ad6` adds `apps/gui/src/ChipSegment.tsx`, its `.chip-seg` CSS
    block and `ChipSegment.dom.test.tsx`, and lifts the
    stylesheet-reading half of `ChipButton`'s geometry test into
    `chipCssTestKit.ts` so the second component that needs it does not
    copy it.
  - `6e6ac95f` retires the catalog reload: the button, `refresh` on
    `SignalCatalogContextValue`, and the fallback's no-op.
  - `24260b5d` adds `apps/gui/src/PlotToolbar.tsx` +
    `PlotToolbar.dom.test.tsx`, moves the bar out of `PlotPanel`,
    chips every control, removes the measurements toggle, reworks the
    bar's CSS, gives `ChipButton.onPress` the click event, and follows
    the ADR 0031 interaction script onto the follow-live chip.
  - `38098b7d` hides the performance read-out behind the toolbar's
    existing right-click menu.
  - `ef258a5a` makes the bar spill rather than wrap, through
    `useToolbarFit`, and teaches the shared hook to take the bar's own
    padding off the top.
  - Frontend tests: 2718/205 files before → 2751/207 files after (all
    green). `tsc --noEmit` and `vite build` clean; the
    `comment-references` grep (run as `git grep --untracked`) empty at
    each commit. No Rust touched.

### Ruling by ruling

- **Cursor modes are icon buttons, not a dropdown.** A `ChipSegment`
  of three icon-only `ChipButton`s — `cursor-x` / `cursor-y` / `note` —
  each `pressed` when it is the mode. Pressing the pressed one sends
  `off`; there is no fourth position, deliberately, and that is the
  only way back to off. The `CURSOR_MODE_OPTIONS` combobox is gone.
- **The `.seg` segmented group is built, as a wrapper.** See the API
  below. The chip was not forked: what the segment needed and the chip
  lacked was the *click event* on `onPress` (the solo position chip
  opens its match list at the pointer), and that was added to
  `ChipButton`, widening `() => void` to
  `(event: MouseEvent<HTMLButtonElement>) => void` — every existing
  caller is still assignable.
- **The perf readout is hidden by default, from the existing menu.**
  `showPerf` is view-local state in `PlotPanel`, default `false`, and
  the toolbar's own right-click menu gained one
  `role="menuitemcheckbox"` entry, "show performance readout", beside
  the "show diagnostics" it already carried. No new menu, no visible
  toggle. Deliberately *not* persisted: a diagnostic turned on to look
  at something once is not a preference (`showDiag` is persisted; this
  is a divergence from its sibling, taken on purpose and flagged here).
- **The catalog-reload button is retired.** Verified rather than
  trusted before removing it: `git grep` for `useSignalCatalog` shows
  six consumers, and `PlotPanel` was the only one destructuring
  `refresh`. `refresh` came off the context value and off the
  fallback in the same commit; `refreshCatalog` stays as the effects'
  own driver. The `reload` icon was **never in the app's registry** —
  phase 1 built the 36 the prototype's inventory names and left it
  out — so there was nothing to remove there; the prototype's
  `<symbol id="i-reload">` is **kept and annotated** with why it is
  defined but unlisted, since the prototype is the durable reference
  for the drawn set and deleting a drawing loses information the note
  preserves.
- **The bar never wraps.** One run through `planToolbarFit`, measured
  by `useToolbarFit` — the hook's second consumer, consumed and not
  copied. Removed controls collapse into a `…` `ChipButton` ("More
  Plot Controls") over the shared `.chip-menu` / `.chip-menu-list`,
  anchored right. `.plot-panel-toolbar` lost its `overflow-x: hidden`,
  which is the rule the hook cannot enforce, and a test asserts that
  against `index.css`.
- **The solo cluster is one unbreakable unit, placed left.** Its
  field, its paging segment and its clear are three separate bar items
  carrying one `cluster` id — not one wrapper element, because a
  wrapper would be a single item and the cluster contract would go
  unused, leaving the ruling resting on nothing. They sit third,
  fourth and fifth, so only the run controls and the two fits survive
  them.
- **"Add Plot Area" sits right of the solo cluster.** Item order is
  pinned by a literal list in `PlotToolbar.dom.test.tsx`.
- **The measurements strip stays hidden, with no toggle anywhere.**
  The checkbox and the `MeasurementMenu` trigger are off the bar, and
  — after the overseer's correction, see below — the strip does not
  draw at all, whatever a saved config says. `measEnabled` /
  `measKeys` and their persistence are untouched, so the rework
  inherits each user's real preference.
- **Labels are Title Case; tooltips stay sentence case.** "Area",
  "Follow", "Points: Auto"; every tooltip is the phrase the old
  control carried, or the prototype's where it carried none.

### Overseer review correction, same branch

- `1a557b4c` — **"stays hidden" is the ruling; "no toggle" was only the
  mechanism.** The first reading removed the control but left the
  persisted `measEnabled` driving the strip, so a user who had
  measurements on got a permanent, now-undismissable strip — strictly
  worse than before the change, and the opposite of the ruling, for
  exactly the people the ruling most affects. Corrected: the strip is
  suppressed on *read*.
  - **One switch decides**, at module scope in `PlotPanel.tsx`:
    `const MEASUREMENT_STRIP_DRAWS: boolean = false`, with the reason
    stated inline (no task number, no `plans/` path) and the removal
    instruction for the rework phase — delete the constant and the one
    `&&` that consumes it. `measShowing = measEnabled &&
    MEASUREMENT_STRIP_DRAWS` is what the panel acts on; `measEnabled`
    remains the *stored* preference and is what persists.
  - **The preference is not written away.** Suppression is on the read
    side only, so the value round-trips untouched and the rework
    inherits what each user actually chose.
  - **Both halves proved by mutation.** Flipping the switch to `true`
    failed "draws no measurement strip, even for a config that says it
    was on" and the rehydration test. Separately, the *tempting wrong
    fix* — `useState(false)` instead of reading the saved value, which
    zeroes the field on the next persist — failed **only** "keeps the
    stored measurement preference untouched while it is suppressed",
    which is the half the overseer said would otherwise be passed over.
  - **Coverage this cost, named rather than quietly dropped.** The
    guard "measurement strip lists each signal exactly once in per-unit
    mode" asserted on the strip's rendered per-trace cells. With the
    strip not drawing and `reportSeries` no longer collecting the
    series it read, there is nothing left for it to observe, so it was
    removed and a comment left in its place. The derived-axis id
    mismatch it guarded is worth a failing test first when the rework
    brings the strip back.
  - README and the prototype say the same thing as the code: hidden for
    everyone, saved setting left alone.

### The interaction script, asked and answered

The overseer owns `perfInteract.ts` and its capture. Asked whether this
sweep moved or renamed any *other* control the script drives: **no.**
The script has exactly three targets — `.u-over` (uPlot's own overlay
element, untouched), `.trace-rows` (`ByIdTable.tsx` and the trace-style
views, none of which this phase touched) and the follow-live control,
which is the one that moved. Nothing else on the plot bar is driven by
it.

### The `.seg` API phase 5 consumes

**`ChipSegment` (`apps/gui/src/ChipSegment.tsx`)** — several chips, one
hairline. It renders `<span class="chip-seg" role="group" aria-label=…>`
around `ChipButton` children and adds nothing else.

| prop | meaning |
|---|---|
| `label: string` | Title Case; the group's accessible name, read before the chips ("Cursor Mode") |
| `title?: string` | sentence-case tooltip for the group, for what the individual chips' tooltips leave out |
| `className?: string` | the caller's own hook |
| `children` | `ChipButton`s. Always — the segment is a wrapper, and a segment that needs something a chip lacks grows the chip |

- The class is **`.chip-seg`**, not the prototype's bare `.seg`: a
  one-word global class in a shared stylesheet is too broad.
- The group draws the 1px `--border-wash` hairline and the 2px radius;
  `.chip-seg .chip-button` drops its own border and stands 20px, so the
  group totals the same 22px a lone chip is and a mixed bar keeps one
  baseline. `.chip-seg .chip-button + .chip-button` is the divider.
- **A pressed segment says so with fill and text, not with an edge.**
  The inner chips lose the border rather than having it made
  transparent, so the accent hairline stays the group's to spend —
  and, incidentally, so no ordering fight with
  `.chip-button[aria-pressed="true"]`'s `border-color` can arise.
- A segment is one thing to the fit planner as well: on the plot bar
  each segment is one measurable item, not three.

### The plot bar as it now reads

Run controls · **Fit X** · **Fit Y** │ **solo** (field + paging + clear,
one cluster) · **Area** · **Follow** · **Points: Auto** │ cursor segment
(**x** / **y** / **note**) · **Clear Cursors** │ (perf read-out, off) ·
**…**. Twelve controls where there were fourteen: the catalog reload and
the measurements toggle are gone; the cursor dropdown became three
buttons and the points dropdown became one cycling chip.

`PlotToolbar` is stateless and takes a callback per control, which is
what lets `PlotToolbar.dom.test.tsx` drive the whole bar with spies.
`plotToolbarItems(props)` is exported alongside it — the bar's *order
and clustering* without the render — because jsdom lays nothing out and
that is the only way to check the clustering at this bar directly.

### How the four tests were proved by mutation

1. **The solo cluster never splits, at this bar.** Deleting
   `cluster: item.cluster` from `PlotToolbar`'s run failed two tests —
   "never leaves half the solo control on the bar" (a sweep from 0 to
   1400px asserting the count of solo items on the bar is never 1 or 2,
   *and* that the sweep reached both 0 and 3, so it cannot pass over a
   bar that never drops anything) and "gives up the solo cluster last
   of all, and whole". `toolbarFit.test.ts`'s own 16 tests stayed green
   under the same mutation — which is exactly the gap the phase prompt
   named.
2. **Press-again-turns-it-off.** Changing the segment's handler to
   `onCursorMode(m.mode)` failed *only* "turns the mode off when the one
   that is on is pressed again"; "switches to a mode when it is off"
   passed, confirming that an activation-only test discriminates
   nothing here.
3. **The perf readout stays hidden by default.** `useState(true)` for
   `showPerf` failed both perf tests, including "is hidden by default,
   and the bar carries no toggle for it", which reads the bar's own
   text rather than the menu's.
4. **Retiring catalog reload broke nothing.** Three mutations, one per
   claim. Dropping `dbcPaths` from the provider's effect deps failed
   "refetches when the loaded DBC-path set changes, even if buses stay
   the same"; dropping `dbcGeneration` failed "refetches on the host's
   dbc-changed event"; putting `refresh` back on the context value
   failed the new "offers no way to force a re-fetch — the triggers
   above are all of them". All three restored and re-run green.

Two more, for the shared pieces this phase touched: adding
`border-width` back to `.chip-seg .chip-button` — not run, since the
segment's own "draws the outline once" test reads `border-style`
directly from the sheet; and the hook's new padding subtraction, whose
test ("does not count the bar's own padding as room for items") is the
only one of the hook's that supplies a padding at all.

### What is **not** verified

- **Nothing here proves the bar fits in a browser.** jsdom does no
  layout: `offsetWidth` / `clientWidth` are 0, so every width in the
  overflow tests is supplied and what is under test is the arrangement
  the planner reaches from them. That the hook reads a *real* rendered
  box, that 22px chips and a 20px segment actually line up, that the
  `…` menu opens inside the panel rather than off its edge, and that
  the spill happens at a sensible width — all of that needs the running
  app. The GUI was not launched (phase rule) and the ADR 0031 harness
  was not run (the overseer owns it).
- The perf read-out's own text is built in `PlotPanel` and asserted
  only for `/dpr/`; its numbers are not pinned.

### Prototype

Kept and updated in the same commits, six places: the `.seg` comment
names the app's `.chip-seg` / `ChipSegment.tsx` and records that the
inner chips lose their border rather than going transparent; `.chipfield`
names the app's `.chip-field`; `.solo-group` records that the app does
*not* use a wrapper element and why (the cluster contract would go
unused); the plot-bar note adds the two deliberate divergences (the perf
read-out is a `<span>`, not a button, and the run controls plus "All
Data" are still the shared `TraceControls`, which the trace sweep owns);
the `.ovf` CSS names the app's `.plot-toolbar-overflow` and says the
spill is `toolbarFit.ts`, not a `scrollWidth` loop; and the context-menu
script records that the app's entry reads "show performance readout", to
sit beside the "show diagnostics" the menu already had. The
`<symbol id="i-reload">` gained a comment saying why it is drawn but
absent from the inventory and from the app's registry.

- **2026-08-22 — Phase 5, the trace panel toolbar and the nine
  remaining bars, landed.** Branch `task-108-phase-5-panel-bars` from
  `80ee6534`.
  - `20fd3f54` — trace panel toolbar: `TraceControls` (shared with the
    plot bar and the signals view) becomes a `ChipSegment` of icon-only
    run chips plus an optional "All Data" chip; the mode toggle becomes
    a `ChipSegment`; Auto-Scroll and Events become toggle `ChipButton`s.
  - `23674d64` — signals view: Selection (toggle, dynamic label) and
    Add Section (plus icon).
  - `62b4b282` — transmit panel: "+ frame" → Frame (plus icon).
  - `d582b85d` — RBS panel: Run (toggle), Save, the filter field
    (chip-field), Open, Signals.
  - `1190598b` — RBS signals: six status filters, the bus filter menu,
    Row Highlights, the footer shortcut.
  - `d44f83a2` — database panel: the search field (chip-field), Details
    and Values (toggles).
  - `649fb0b0` — graph panel: Add Filter (plus icon), Reset Layout.
  - `470512ff` — servers panel: the search field (chip-field), Add
    Server (toggle).
  - `0daa7696` — system messages: Source / Min Level (shared Combobox,
    chip-classed trigger), Copy All, Clear.
  - `07ac9a80` — view signals: the same status-filter / bus-menu /
    wash-toggle / footer-shortcut pattern as RBS signals.
  - Frontend tests: 2751/207 files before → 2757/207 files after (all
    green — the file count does not move because every addition landed
    in an existing panel's test file). `tsc --noEmit` and `vite build`
    clean at every commit; the `comment-references` grep
    (`git grep --untracked -Ein "task [0-9]|plans/" -- apps/ crates/`)
    empty at every commit. No Rust touched.

### Bar-by-bar table

| Bar | Commit | Not a straight restyle |
|---|---|---|
| Trace panel | `20fd3f54` | The status read-out (`trace-status`) is untouched chrome, not a chip — see below. |
| Signals view | `23674d64` | The prototype's mock drew a live add-by-pattern field that was never built; the toggle-and-editor control that actually exists was restyled instead, and the mock corrected. |
| Transmit | `62b4b282` | Straight restyle. |
| RBS | `d582b85d` | Straight restyle. |
| RBS signals | `1190598b` | Status chips keep their existing tall swatch (shared with each row's own status cell) rather than the shared round dot. |
| Database | `d44f83a2` | Straight restyle. |
| Graph | `649fb0b0` | Straight restyle. |
| Servers | `470512ff` | Straight restyle. |
| System messages | `0daa7696` | Source / Min Level keep the shared fzf `Combobox` rather than a bespoke chip+menu; its trigger wears `.status-chip .chip-button` directly. |
| View signals | `07ac9a80` | Same swatch divergence as RBS signals. |

### Why the run controls ripple through three bars

`TraceControls` (`apps/gui/src/TraceControls.tsx`) is shared by
`TracePanel`, `SignalsPanel` and `PlotToolbar` — phase 4 deliberately
left it for this phase ("the run controls plus 'All Data' are still
the shared `TraceControls`, which the trace sweep owns"). Chip-ifying
it once therefore restyled all three consumers in the trace-panel
commit; the plot bar needed no code change at all; `PlotToolbar.dom.test.tsx`
needed its `BAR` table and its `chips()` helper's doc comment updated
because the run controls (Start/Pause/Stop/Clear, All Data) are now
real `.chip-button`s the helper's existing selector picks up, where
before it explicitly skipped them ("not chips yet").

### Two patterns repeat across bars

- **A custom-colour status dot the shared chip can't carry.** RBS
  signals' and view signals' status filters each need a *per-status*
  dot colour (six and five colours respectively, already tuned,
  matching a taller swatch shape shared with each row's own status
  cell) — `ChipButton`'s `state` prop only carries the fixed
  `idle/connecting/connected/degraded/failed` vocabulary. Rather than
  widen that vocabulary or fork the chip, both bars apply
  `.status-chip .chip-button` directly to a bespoke `<button>` and keep
  their existing swatch element — the same trick phase 4's perf
  read-out used (`<span className="status-chip chip-button plot-perf">`).
  This is deliberately **not** unified with the registry's icon system:
  it is in-panel content (the row's own status cell uses the identical
  swatch), out of this phase's scope.
- **A shared picker whose trigger, not the picker, gets chipped.**
  System messages' Source / Min Level filters are the shared fzf
  `Combobox` (the app's one select-like control everywhere) — forking
  a second bespoke chip+dropdown just for this bar, as the prototype's
  mock sketches, would be exactly the kind of parallel implementation
  the repo's one-shared-implementation rule forbids. Its trigger
  carries `.status-chip .chip-button` via `className`, same trick as
  above; the `▾` affordance, the fzf popup and the keyboard handling
  are all untouched.

### The status read-out and one other control, kept exactly as they were

`TraceControls`' `trace-status` span (`running`/`paused`/`stopped`,
uppercase, no chip shape) is not a command — it is a read-out — and it
is load-bearing for roughly twenty `App.*.dom.test.tsx` files that use
`.trace-panel .trace-status` as their "the trace panel has mounted"
polling signal, plus one that pins its exact class per state. It is
untouched, and the prototype gained a comment recording why. Nothing
else on any of the ten bars was left un-restyled for a similar reason.

### How the tests were proved by mutation

Two per-bar pins, each proved by breaking the wiring and watching the
right (and only the right) test fail, then restoring it:

1. **Trace panel: Pause vs. Stop.** Both freeze the trace window at the
   current session count, so a test that only checks "the window
   froze" cannot tell one chip from the other wired to the wrong
   handler. `TracePanel.dom.test.tsx`'s new "Pause freezes the window
   but marks it resumable" reads `isPaused` off the registry's `trace`
   state. Pointing the Pause chip's `onPress` at `onStop` failed
   exactly that test (`isPaused` false instead of true); every other
   test in the file, including the sibling "Stop freezes the window
   without leaving it resumable", stayed green — proof the two chips
   are otherwise indistinguishable to a coarser assertion.
2. **System messages: Copy All vs. Clear.** Adjacent chips with
   opposite blast radii (read the clipboard vs. wipe the log). A new
   test asserts `writeText` fires and `clear` does not on a Copy All
   press, and the reverse on a Clear press. Pointing Clear's `onPress`
   at `copyAll` failed "Clear clears without copying" (`clearSpy`
   never called) while leaving the Copy-All half of the same test
   passing — proof the assertion is discriminating the handler, not
   just noticing a click landed.

Mutation was not re-run on all ten bars. Signals view's "opens and
closes the selection editor…" test (added this phase) was separately
proved the same way — re-pointing Selection's `onPress` at
`createSection(null)` failed it while the rest of the suite passed —
and every other bar's status-quo tests (RBS's Run/Save/Signals, the
two status-filter panels' filter/bus/wash/footer clicks, the graph
panel's `create('filter')` check) already assert a *specific* outcome
per control (a distinct invoke call, a distinct row set, a distinct
registry field) rather than "something changed", so they carry the
same discriminating power without a fresh mutation run.

### What is **not** verified

- **Nothing here proves any bar fits, wraps, or lines up in a
  browser.** As every phase before this one: jsdom does no layout. All
  ten bars are single unbroken runs (none needed `useToolbarFit` — the
  ruling's "reach for it only where a bar genuinely needs to
  overflow" — since none of the nine remaining bars packs anywhere
  near the plot bar's density, and the trace panel's own controls are
  few enough that phase 3's `.appbar { flex-wrap: wrap }` treatment,
  already in place, is sufficient).
- The chip-classed `Combobox` trigger (system messages) was not
  visually checked in a browser; only its accessible role/name and its
  class list are asserted in jsdom.
- The GUI was not launched (phase rule) and the ADR 0031 harness was
  not run (the overseer owns it); this phase touched no control
  `perfInteract.ts` drives (confirmed by reading it — its three targets
  are `.u-over`, `.trace-rows` and the plot bar's Follow Live chip,
  none of which moved this phase).

### Prototype

Updated in the same commits as the bars that diverged from it, four
places: the trace-panel section gained a comment on the untouched
status read-out; the signals-view section's illustrative
add-by-pattern chipfield was replaced with the real toggle-and-count
chip the app ships; the RBS signals and view signals sections each
gained a comment recording the swatch-shape divergence and naming the
two controls (Row Highlights, the footer shortcut) the mock never
drew; the system-messages section gained a comment on the shared
`Combobox` in place of a bespoke picker. Every other bar matched the
mock closely enough to need no note.

- **2026-08-22 — Phase 6, icons reach into the panels, landed.** Branch
  `task-108-phase-6-panel-icons` from `bf16000b`.
  - `TraceView.tsx`'s shared `EventRow` — the renderer both the events
    view and the trace panel's interleaved event rows draw from — has
    its goto/rename/remove buttons swap the retired `⇥` / `✎` / `×` text
    glyphs for `<Icon name="goto"/>` / `<Icon name="edit"/>` /
    `<Icon name="x"/>`. One renderer, so both surfaces changed together;
    no fork.
  - **The bounded sweep**, inside the panels phases 3–5 already touched,
    wherever an ad-hoc glyph matched a registry meaning already in use
    elsewhere in the app: `PlotArea.tsx` (remove-area, remove-signal and
    discard-patterns `×` → `x`; the pattern-editor toggle's trailing `✎`
    → `edit`, now a JSX fragment since the label carries a count before
    it), `SignalsPanel.tsx` (remove-from-selection `×`, section rename
    `✎`, section delete `×`), `RbsPanel.tsx` (the per-message
    clear-period-override `×`). Every accessible name was already
    carried by `title`/`aria-label` independent of the glyph text, so
    none moved; one tooltip in `RbsPanel.tsx` that spelled the glyph out
    in prose ("override — × to track GenMsgCycleTime") was reworded
    ("override — clear it to track GenMsgCycleTime") since it would
    otherwise describe a character no longer on screen.
  - **`index.css`**: each swapped button's icon gets `display: block`
    (the `.bus-health-launcher svg` precedent from phase 1) so the
    inline SVG's default baseline gap does not nudge it off-centre in a
    glyph-only button. The one exception is `.plot-area-filter` — its
    icon sits beside "patterns (N)" text in the same button, so it stays
    inline rather than block, or the icon would wrap onto its own line.
  - **No registry growth.** Every glyph swapped already had a covering
    entry (`goto`, `edit`, `x`) from phase 1's 36; nothing new was drawn.
  - **What was left alone, and why**: `EventKindFilter.tsx` (the
    per-kind checkbox list shared by the events, trace and plot panels)
    is a checklist of real `<input type="checkbox">` rows with a colour
    swatch, not a text glyph — there is nothing for the registry to
    replace there, and rebuilding it as chips would be widening a
    *control's shape*, not swapping a glyph for its drawn form, which
    owner call 2's reading puts out of scope ("anything wider is a
    separate task"). The disclosure triangles (`▸`/`▾`) on event rows
    and gridview headers, the pattern-materialize button's `⇨`, and the
    RBS warning `⚠` have no registry entry (disclosure, "convert",
    warning are not among the 36) and were left as they are, per the
    phase's "no registry growth" constraint.
  - **Task 107's event-surface toolbar** (the "ruling" naming it):
    confirmed by reading `plans/tasks/0107-events-point-at-signals.md`
    that task 107 is groomed and approved but **not implemented** —
    there is no shipped 107 control in the app today to convert. The
    ruling is forward-looking (107's own prototype already drew its
    control in chip shape), not a phase-6 deliverable; nothing to do
    here.
  - **Mutation-proved**: a new `EventsPanel.dom.test.tsx` test drives an
    editable event and asserts the goto/rename/remove buttons render an
    empty-text `<svg viewBox="0 0 14 14">` rather than the old glyph
    text. Reverting the goto button to `⇥` (`sed` on `TraceView.tsx`,
    not committed) failed exactly that test with `expected '⇥' to be
    ''`; restoring it re-passed. `PlotPanel.dom.test.tsx`'s existing
    "adds plot areas and exposes a remove affordance per area when >1"
    gained the same style of assertion for the plot area's remove
    button, as one representative instance of the bounded sweep rather
    than one per swapped glyph (the other nine are mechanically
    identical: same handler, same `aria-label`/`title`, only the child
    node changed).
  - Frontend tests: 2757/207 files before (phase 5's log said 2757 but
    two independent runs against that exact commit both counted
    2756/207 in this session — a pre-existing one-test discrepancy in
    the log, not something this phase's diff caused) → 2757/207 after
    (2756 + 1 new `EventsPanel` test), all green, two full runs.
    `tsc --noEmit` and `vite build` clean. `git grep --untracked -Ein
    "task [0-9]|plans/" -- apps/ crates/` empty. No Rust touched.
  - **Perf reading** (ADR 0031, ev-zonal, `--rbs-run-on-start` — a fresh
    `--app-data-dir` has no saved RBS-running state to resume, so the
    first attempt measured a genuinely idle bus, `fps 0`, and was
    discarded before comparing): `docs/performance-measurements/frontend/2026-08-22-bf16000b-phase6.json`,
    `rx_fps` 1606.3, `tx_fps` 1612.4 (`ids_measured` 173, expected
    ~1608), `renderer_mb_peak` 305.5 MB (baseline 316.5), `tree_mb_peak`
    721.7 MB (baseline 741.7), `host_mb_peak` 61.5 MB (baseline 58.5).
    `cannet-perf-measurement check --frontend-report … --expected-rx-fps
    1608 --expected-tx-fps 1608`: **33/33 metrics `ok`**, no metric
    within its skill-§4 thresholds worth leading with (no ≥10 ms
    sustained regression, memory well under 400 MB). Not promoted to
    `baseline.json` — that stays the overseer's call.
  - **What is not verified**: the swapped icons' actual pixel rendering
    (size, centring, hairline alignment) inside the event rows and the
    other bounded-sweep buttons was not screenshot-checked — the
    `cannet-perf-measurement screenshot` fixtures (`ev-demo`,
    `extrapolation`) are deliberately data-free or event-free, so none
    of the conditional controls this phase touched (an editable event
    row, a second plot area, a signal section, an overridden RBS period)
    render in either fixture. The perf run above is stronger evidence
    than no launch at all — the production build ran ~70 s with
    `TraceView`/`PlotArea`/`SignalsPanel` all mounted and rendering
    against a live 1600+ f/s load with no exception — but it is not a
    photograph of the icons themselves. Same caveat every prior phase
    recorded for its own bar.

## Exit criteria, walked (phase 6 close-out)

Task 108 carries no single "Exit criteria" list; the checkable claims
below are drawn from **The design language**, **Rulings (owner,
2026-08-21)**, **Relationship to task 103**, and **Final rulings —
grooming closed**, each cited to the phase(s) that satisfied it.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | One shape for every control (`.color-chip`/`.status-chip` silhouette) | **Met** | `ChipButton` extends `StatusChip` (phase 2); every phase 3–5 bar renders through it. Two named exceptions (RBS/view-signals custom status swatches; the system-messages `Combobox` trigger) apply `.status-chip .chip-button` directly to a bespoke element rather than forking a class — the sanctioned pattern, not a second shape. |
| 2 | Smaller: tighter padding, 12px type, icon+label or icon-only | **Met** | 22px chip / 12px type built phase 2, unchanged through every later phase. |
| 3 | Common icons, our own, in-repo registry | **Met** | 36-icon `Icon.tsx` registry, phase 1; consumed by every phase since. |
| 4 | Icons reach into the panels, not just toolbars | **Met, bounded as groomed** | Event rows (phase 6) plus every ad-hoc glyph the registry already covered inside a phase-3–5 panel (phase 6). Controls that are not glyphs (`EventKindFilter`'s checkbox list) are unchanged by design — owner call 2 scoped the sweep to glyphs, not control shapes. |
| 5 | The prototype is durable, updated in the same commits as any divergence | **Met** | Updated by phases 2–5 wherever implementation diverged; phase 6 introduced no divergence (its icon meanings already matched the prototype's inventory), so no prototype edit was needed this phase. |
| 6 | State on the hairline — nothing resizes or reflows | **Met** | `ChipButton.dom.test.tsx`'s geometry-invariance test (phase 2), proved by mutation. |
| 7 | The status bar stays; toolbar carries no duplicate Connect/System Messages/Signal Mapping/RBS launcher | **Met** | `Toolbar.dom.test.tsx` pins the absence (phase 3); true since task 103, never regressed. |
| 8 | Full icon inventory, reviewable as a set | **Met** | Prototype's inventory section; `Icon.dom.test.tsx` pins the 36-name set (phase 1). |
| 9 | Plot toolbar rulings (cursor icon buttons, perf hidden behind the existing menu, never wraps, solo cluster unbreakable and left, measurements strip stays hidden, catalog reload retired) | **Met** | Phase 4, itemised ruling-by-ruling in its own status entry. |
| 10 | Icon audit — one icon, one meaning; Title Case labels / sentence-case tooltips; RBS Run carries play; project-tree icon a hierarchy; graph icon draws the fanout; text glyphs absorbed as drawn icons | **Met** | `bus`/`db`-`db-add` split (phase 1); Title Case sweep (phases 3–5); `RbsPanel`'s Run chip `icon="play"`, `Toolbar`'s Project chip `icon="tree"`, Graph-panel chip `icon="graph"` (phases 3, 5); `⇥`/`✎`/`×` absorbed as `goto`/`edit`/`x` (phase 6, this entry). |
| 11 | Every panel toolbar gets the treatment (top-level, plot, trace, and the nine remaining bars) | **Met** | Phases 3 (top-level), 4 (plot), 5 (trace + signals, transmit, RBS, RBS signals, database, graph, servers, system messages, view signals). |
| 12 | Icon-only treatment as prototyped stands | **Met** | e.g. the toolbar's Database/Graph/Events/Project launchers (phase 3), the plot bar's cursor segment (phase 4). |
| 13 | Add-menu collapse approved and shipped | **Met** | `Toolbar.tsx`'s Add ▾ menu, seven commands (phase 3). |
| 14 | Density (22px chips, 12px type) is right | **Met** | Unchanged since phase 2; no later phase revisited it. |
| 15 | Task 103 implements first | **Met** | Task 103 shipped before 108 began (see "Relationship to task 103"). |
| 16 | Task 107's event-surface toolbar speaks this language | **N/A to 108** | Task 107 is groomed/approved but **not implemented** (`plans/tasks/0107-events-point-at-signals.md`'s own status line) — there is no shipped 107 control for 108 to convert. The ruling is forward-looking: 107's own prototype already drew its control in chip shape, so 107's eventual implementation needs no rework. |

No criterion above is Not Met. The two intentionally-unfinished threads
this task carries forward are recorded as blockers, not exit-criteria
failures: `useConnectionStates`'s launch race (phase 2, wants an owner
call) and the measurement strip's rework (phase 4, backlogged by owner
ruling, `MeasurementMenu` kept as its orphan).

## Blockers / side effects

- **`useConnectionStates` still hand-rolls fetch-then-listen, and still
  has the launch race** (phase 2). It cannot go through `useHostMirror`
  without changing behaviour a named shipped test pins — see phase 2's
  status entry for the two ways out. It wants an owner call, because it
  changes a shipped connection path rather than chrome.
- ~~**Toolbar width *measurement* is not shared, only the planning is**
  (phase 2).~~ **Closed by phase 3**, which lifted it into
  `useToolbarFit`; phase 4 consumed that hook rather than copying it,
  and extended it with the bar's-own-padding subtraction.
- ~~**The prototype's segmented group (`.seg`) has no implementation**
  (phase 2).~~ **Closed by phase 4**, which needed one for the cursor
  modes and built `ChipSegment` / `.chip-seg` as a wrapper around
  `ChipButton`s. The chip was not forked; what the segment needed and
  the chip lacked (the click event on `onPress`) was added to the chip.

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

- **`MeasurementMenu` is now an orphan, deliberately kept** (phase 4).
  Removing the measurements toggle from the plot bar left
  `PlotMeasurements.tsx`'s `MeasurementMenu` exported and rendered
  nowhere. The "clean up your own orphans" rule says it should go; the
  owner ruling says the strip **needs rework** and the rework is
  backlogged, and the prototype's own note names `MeasurementMenu` as
  part of what is backlogged. Deleting it would throw away the thing to
  be reworked, so it stays — flagged rather than drifted into. The
  strip itself, `measEnabled` / `measKeys` and their persistence are all
  untouched.

- ~~**A saved config with `measEnabled: true` shows a strip that cannot
  be turned off**~~ (phase 4). **Decided and fixed on overseer review**
  (`1a557b4c`): "stays hidden" is the ruling and "no toggle" only the
  mechanism, so the strip is suppressed on read and does not draw
  whatever a saved config says. The persisted value is left intact for
  the rework to inherit. One named switch,
  `MEASUREMENT_STRIP_DRAWS` in `PlotPanel.tsx`, is the whole of it.
  Nothing outstanding.

- **The strip's per-unit regression guard is gone until the rework**
  (phase 4). "Measurement strip lists each signal exactly once in
  per-unit mode" guarded a derived-axis id mismatch in the strip's
  `seriesFor` lookups by reading the strip's rendered cells. With the
  strip suppressed, `reportSeries` no longer collects and the strip no
  longer renders, so the test could only have passed over an empty
  document — it was removed, with a comment in its place. The rework
  should write it again, failing first.

- **The plot bar's perf visibility is view-local, unlike `showDiag`**
  (phase 4). Its sibling on the same menu persists to the panel config;
  this does not. The reading taken is that a diagnostic switched on to
  look at one thing is not a preference — but the two entries now
  behave differently on the same menu, which is a small inconsistency
  someone will notice. One line of `plotPanelConfig` either way.

- **The ADR 0031 interaction script had to follow the follow-live
  control** (phase 4). `perfInteract.ts` resumed follow-live by finding
  `label.checkbox input[type=checkbox]` whose label read "follow live";
  that control is a chip toggle now, so the script finds
  `.plot-panel-toolbar button[aria-label="Follow Live"]` and reads
  `aria-pressed`. Two consequences the overseer owns: the capture must
  be re-run to confirm the gesture still lands, and at a width narrow
  enough for the chip to spill into the `…` menu the script cannot
  reach it at all (it does not open menus). The harness runs at a wide
  window, so this is a caveat rather than a defect.

- **`.plot-window-ctl` is dead CSS, and was before this phase**
  (phase 4). No `.tsx` references it. Left alone under the
  don't-delete-pre-existing-dead-code rule;
  `.plot-cursor-ctl`, which *this* phase orphaned, was removed from the
  same grouped selector.

- **Two custom-colour status swatches did not go through `ChipButton`,
  by choice rather than by extending it** (phase 5). RBS signals' and
  view signals' status filters each need a per-status dot colour (six
  and five colours, already tuned, shared with each row's own status
  cell) that `ChipButton`'s `state` prop can't carry — it only offers
  the fixed `idle/connecting/connected/degraded/failed` vocabulary.
  Rather than widen that prop or fork the chip, both bars apply
  `.status-chip .chip-button` directly to a bespoke `<button>` that
  keeps its existing swatch markup, following the precedent phase 4's
  perf read-out set. The alternative — a `dotColor?: string` escape
  hatch on `ChipButton` — was not taken because it would let a chip
  colour itself outside the state vocabulary silently everywhere else
  it's used, not just here. Flagging per the instruction to say so
  when a bar needs something the shared component lacks; a later phase
  is free to reopen this if the pattern needs to spread further.

- **The Servers "Add Server" chip uses `pressed`, not `menuOpen`, for a
  disclosure it isn't quite either of** (phase 5). It reveals an inline
  address-entry form, not a menu — `menuOpen`'s `aria-haspopup="menu"`
  would misdescribe it — but it is not a toggleable *setting* either.
  `pressed` was the closer fit of the two existing props and is what
  shipped; a dedicated "disclosure" affordance on `ChipButton`, if more
  bars turn out to need one, is a question for whichever phase hits it
  next.

- **The signals-view toolbar's live control diverges from the
  prototype's own earlier sketch** (phase 5). The mock (`plans/prototypes/gui-chip-redesign.html`
  — corrected in this phase's own commit) drew a chipfield that adds
  signals by live pattern typing, matching the plot's solo box's
  dialect; the app has never had that control. What exists — a toggle
  chip that opens an in-panel editor with manual picks and patterns —
  was restyled instead, and the mock corrected to match. If the
  live-add field was actually wanted as new functionality, that is a
  separate, unscoped decision this phase did not make.
