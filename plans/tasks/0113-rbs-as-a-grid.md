# 0113 — Is RBS a Grid?

> **Status 2026-08-25 — groomed with the owner.** Queue items **1.6, 1.26
> and 1.13c**, from the 2026-08-24 walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 1. Fully ruled; no
> open questions. No phases yet.

RBS and transmit adopt the gridview contract the trace views already
implement. Grooming turned up a **layer-wide defect** in that contract
(§ 4), which this task fixes because it is what "consistent everywhere"
requires.

## 1. RBS and transmit rows become grid rows · 1.6

> *"RBS rows should let me select them and then tab into the signals.
> There may be views (transmit, perhaps) that are less gridview-y but RBS
> seems exactly the same and it's really weird to use."*

`gridviewContentRows.ts` already makes disclosed content into real rows
with ids, order, cursor and selection.
[`TraceView.tsx`](../../apps/gui/src/TraceView.tsx) and
[`ByIdTable.tsx`](../../apps/gui/src/ByIdTable.tsx) import it.
[`RbsPanel.tsx:315`](../../apps/gui/src/RbsPanel.tsx#L315) and
[`TransmitPanel.tsx:400`](../../apps/gui/src/TransmitPanel.tsx#L400) call
`useGridview` but never adopted it — the transmit hedge names a panel in
the *identical* state, not a different one.

**Ruled 2026-08-25:** *"transmitpanel does the same."* Both panels adopt,
in one pass.

**The keyboard contract is the shipped one, not a new one** — the owner
restated it and it is what `useGridview` implements:

| Key | Does |
|---|---|
| Arrows | move around the grid / tree, disclosed content rows included |
| Tab | moves *within* the cursor row, onto its controls |
| Shift+Tab | from the first control, back out to nav |
| Esc | from a control, back out to nav |

**Work:** adopt `gridviewContentRows` in `RbsPanel` and `TransmitPanel`.

## 2. Space on an RBS signal row does nothing · 1.26

**Ruled 2026-08-24:** *"space on signal rows should do nothing; you can't
send part of a message, and I don't want it to toggle the message."*

**Work:** make it inert. Space on an RBS *message* row is unchanged.

## 3. Row highlighting is the gridview's · 1.13c

> *"the prototype eliminated the row highlighting - it shouldn't be present
> with a toggle in the final GUI."*

**Ruled 2026-08-25:** *"row highlighting is a gridview behavior."* That is
the reason, and it settles the item without reference to the prototype —
which, for the record, **kept** row highlighting and merely omitted drawing
it (its own comments at
[`gui-chip-redesign.html:744`](../prototypes/gui-chip-redesign.html#L744)
and `:802`). The prototype was never the argument.

**The collision is on one DOM node.**
[`ViewSignalsPanel.tsx:547`](../../apps/gui/src/ViewSignalsPanel.tsx#L547)
builds a row's class list as
`view-signals-row--wash-<status>` *and* `selected` together: a
panel-invented row background competing with the gridview's own selection
indication. ADR 0044's 2026-08-23 amendment already rules on that — *"the
row's own cursor styling is the focus indication"* — so the wash is a panel
re-implementing what the layer owns, and which of the two reads is a
question of stylesheet order.

**Work, on both signal-mapping surfaces, which move together or disagree:**

| | Goes |
|---|---|
| The wash | [`ViewSignalsPanel.tsx:419-424`](../../apps/gui/src/ViewSignalsPanel.tsx#L419-L424), [`RbsSignalsPanel.tsx:358-362`](../../apps/gui/src/RbsSignalsPanel.tsx#L358-L362), and the `--wash-*` rules |
| The **Row Highlights** chip | it controls nothing else — its title is *"highlight each row's background by its status; the status column always names it"* |
| `washesOn` as persisted panel state | [`ViewSignalsPanel.tsx:177-189`](../../apps/gui/src/ViewSignalsPanel.tsx#L177-L189) reads it from `params` and writes it back; workspace state for a behaviour the layer owns |

**Stays:** the per-row status chip icon, and the status text at
[`RbsSignalsPanel.tsx:453`](../../apps/gui/src/RbsSignalsPanel.tsx#L453),
which stops being conditional. The **"N of M" footer chip** is a different
control and is untouched.

## 4. Escape must not cascade out of a fullscreened panel

**Found while grooming § 1, and it is not an RBS bug — it is the
`useGridview` layer, so it reaches every grid panel.**

`commands.ts:276` binds plain `Escape` to `view.exitFullscreen`, gated to
`hasMaximizedView`. The dispatcher runs on the **capture phase** and calls
`preventDefault` ([`useCommands.tsx:757`](../../apps/gui/src/useCommands.tsx#L757)),
and the grid's way out of a row's content guards on `!e.defaultPrevented`
([`useGridview.ts:193`](../../apps/gui/src/useGridview.ts#L193)) — so it
stands down.

**Reproduce:** fullscreen a grid panel, Tab into a row's control, press
Escape. Fullscreen exits and focus stays stuck on the control.

**Ruled 2026-08-25:** *"that esc should be swallowed and not cascaded up to
the view, in case it's fullscreened."* Then, on the two-press layering:
*"Yes, that's what I just said I wanted."*

**Work — a narrow inversion, not a rewrite of the rule.** "Content keeps
first claim" stays: a combobox closing its own dropdown on Escape still
wins. The defect is that a **global command** is being counted as content.
Separate the two so the grid beats the global binding:

1. Escape on a row control → focus returns to the container, press
   swallowed, fullscreen untouched.
2. Escape again, now on the container → falls through the existing
   "leaves Escape alone when the container itself has focus" branch and
   exits fullscreen.

[`useGridview.dom.test.tsx:653`](../../apps/gui/src/useGridview.dom.test.tsx#L653)
("leaves an Escape a global command took to that command") pins the
current behaviour and names `view.exitFullscreen` in its comment. **It is
inverted by this change**, and its comment rewritten to say why the grid
now wins.

## 5. A Default column on the RBS signals grid · 3.8

**Ruled 2026-08-26**: *"add default value column. 'none' where we're
currently adding 'detail' saying 'no start value...'"* The RBS feed
collapses the DBC and override layers, so an overridden field's "DBC
default" is invisible and the undefaulted case rides the free-text
detail (`rbs/signals.rs:193` — *"no start value in the DBC — bits are
the file's fill"*). Instead: a **Default** column on the grid
(`rbsSignalsColumns.ts`), showing the DBC's start value where one
exists and `none` where it does not; the detail cell stops carrying
that sentence.

## 6. ADR 0044

Two amendments, in the same commit as the code:

- **The editor-face carve-out is deleted.** It reads *"Content that is an
  editor face rather than a list — a transmit tile's frame-shape and byte
  editors, an RBS message's value cells — stays a block below the row and
  is reached by Tab, not by the cursor."* Those are the only two panels it
  names, and both adopt content-rows here, so it has no occupants left.
  Deleted rather than re-scoped, with a dated amendment note saying the
  distinction did not survive contact with the panels it was drawn for.
- **Escape's precedence is stated** — content beats the grid, the grid
  beats a global binding, and a press that reaches the container is the
  global binding's.
- **Row background belongs to the layer.** Cursor and selection are what
  paint a row; a panel encodes per-row state in a *cell* — a chip, an
  icon, text — never in the row's background, and never ships a toggle
  for doing so. Written from § 3's ruling.

## Exit criteria

1. **Selecting an RBS row and arrowing into its signals works in a running
   build**, matching the trace views. Reading the code is not evidence.
2. **`TransmitPanel` does the same**, in this task.
3. **Space on an RBS signal row does nothing**, pinned by a test; the
   message row's behaviour is unchanged and still pinned.
4. **Escape from a row control returns to nav without leaving fullscreen,
   and a second Escape leaves it**, pinned by a test that replaces
   `useGridview.dom.test.tsx:653`.
5. **Neither signal-mapping surface paints a row background**, and
   neither ships a Row Highlights chip or a `washesOn` param. Pinned by a
   test that the status is still legible with the wash gone.
6. **The RBS signals grid carries a Default column** — the DBC start
   value where one exists, `none` where not — and the detail cell no
   longer says "no start value…". Pinned by a test each way.
7. **ADR 0044 carries all three amendments**, dated, in the same commit.
8. **Queue rows 1.6, 1.26, 1.13c and 3.8 are recorded closed** with the
   date.
9. **Full CI green** — seven jobs, each named with its command.
