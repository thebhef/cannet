# 0141 — Bench Rework: Owner-Reported Fixes on the Open Stack

> **Opened 2026-09-06** by owner instruction: the fix queue from the
> evening bench pass, captured as one task. **Each item is distributed
> through the existing stack** — amended into the commit whose work it
> reworks (with that commit's message updated to match), or landed as
> its own branch where the reworked code predates the stack. Opus
> agents, per the oversee-roadmap flow as modified this session
> (shared tree, absorption amends, `gt restack` only).
>
> **Items 5–7 were added on 2026-09-07** from a second bench pass over
> the rebuilt stack. Two of them reverse rulings taken in the first
> pass; those reversals are the owner's latest word.

## Items and their distribution targets

1. **Database panel two-stage delete diverges from the app pattern.**
   The math-signal delete hand-rolls an `×`→"delete?" morph with
   panel-managed armed state; the app's pattern is the shared
   `TwoStageRemoveButton` (trash icon, arms red "click again to
   confirm", 3 s auto-disarm — transmit rows, both RBS panels). Swap
   it in, keeping the far-end placement ruling. →
   **amend `task135-editor`**.
2. **Database panel value rows give the comment the space and
   truncate name/value; the unit is often clipped.** `.dbc-row` flex
   items shrink proportionally, so a long comment still claims a big
   share while the value's ellipsis eats the unit. Make the comment
   yield first (high flex-shrink, small floor); name/value hold until
   it is spent. CSS geometry — jsdom cannot measure it; lands with
   commented shrink rules, verified on the owner's bench. →
   **amend `task135-surfaces`** (which introduced the value column;
   its message also gains the earlier computed-values absorption).
3. **Ctrl+F does not focus the settings panel's search box.**
   `FINDABLE_PANEL_KINDS` omits `settings` behind a comment written
   before the search box existed (`3b969a32` added the box; the list
   was never revisited). Add the kind, fix the stale comment,
   register the panel's `panel.find` handler (focus + select, per the
   DBC singleton routing), DOM test. The owning commit is on `main`,
   so this is the one item that lands as **its own branch
   `task141-settings-find` off `feedback-capture`**, restacking the
   stack above it.
4. **Integration cannot produce Ah from an A operand** — groomed as
   **task 139 phase 4**; the ruling and design live in
   `0139-math-units-scaling.md` (time-dimension-aware convertibility,
   rate↔integral pairing, best-effort derived charge/energy unit). →
   **amend `task139-units`** (whose message also gains the earlier
   ratio-rename absorption).

5. **Value rows must spend the comment before the name or the value.**
   `.dbc-row`'s flex items have to give the comment up *completely*
   before either the name or the value cell loses a character: a value
   ellipsized from its tail loses its unit, a truncated name loses the
   row's identity, and a truncated comment loses only prose. CSS
   geometry — jsdom cannot measure it, so it is an eyeball on a narrow
   panel. → **amend `task135-surfaces`**.
6. **The math delete's two-stage confirm and its far-end placement
   both go.** Item 1's two rulings are reversed: the delete is one
   click, not the shared `TwoStageRemoveButton`, and it is pinned
   immediately after the definition's name rather than at the row's
   far end. → **amend `task135-editor`**.
7. **The database panel's search box only takes a click over its
   placeholder.** The chip draws a box that runs to the Details
   button, but the `<input>` inside it is intrinsically sized, so most
   of the drawn rectangle is the chip's dead space. The owning code is
   on `main`, so this lands as **its own branch `task141-dbc-search`
   off `task141-settings-find`**, for the orchestrator to splice.
8. **A math signal dragged from the Computed branch into another math
   signal's operand section does nothing.** Math-on-math is documented
   and works through the operand combobox; only the drop path fails.
   → **amend `task135-surfaces`** (which made a Computed row draggable
   and taught every other drop target the flag).
9. **`cargo clippy -p cannet-gui --all-targets -- -D warnings` fails at
   `task135-engine`** with four pedantic errors in the wide-DBC test
   generator and the bounded-serve loop. Mechanical; the check is its
   own guard. → **amend `task135-engine`**.

## Standing rules for every item

- One opus agent per item, strictly sequential in the shared tree.
- Amends use `--no-verify`; the amended commit's message is updated
  so it still reads as the PR description of what the branch now
  contains; `gt restack` after each amend is the only permitted `gt`.
- TDD where a test can express the behaviour; the CSS item states
  why not.
- Full check tier at the stack tip after the queue drains, then an
  installer build for the owner's bench pass.

## Exit criteria

- [x] Every item implemented at its distribution target, each
      branch still a single commit whose message covers its content.
- [x] Stack linear, `doc-closeout` on top, full suites green at tip —
      item 7's `task141-dbc-search` is built and green but not yet
      spliced in.
- [x] Installer rebuilt from the tip for the owner's visual pass
      (item 5's row layout and item 6's delete read correctly on the
      bench). The first pass's build predates items 5–7.

## Status log

**2026-09-07 — items 1 and 2 absorbed.**

- **Item 1 → `task135-editor`.** The math row's delete is the shared
  `TwoStageRemoveButton` now; `.dbc-row-delete` is down to
  `margin-left: auto` (placement, the owner's far-end ruling) and the
  look/arming come from `.two-stage-remove`. The panel's `armedDelete`
  state, the `deleteArmed` row prop and the context-menu disarm went
  with it — `handleMathDelete` is a plain delete. TDD: the existing
  "takes two clicks — arm, then confirm" test in
  `DatabasePanel.math.dom.test.tsx` was rewritten to the shared
  control's semantics (`click again to confirm`, class
  `two-stage-remove`) and watched fail against the old control before
  the swap. The "keeps the delete away from the disclosure" test still
  passes unchanged — the placement class rides through as the
  component's `className`.
- **Item 2 → `task135-surfaces`.** `.dbc-row-comment` gains
  `flex-shrink: 200` with a `min-width: 6ch` floor, so the comment
  absorbs essentially the whole deficit before the name
  (`.dbc-row-label`) or the value cell (`.dbc-row-value`) — both left
  at the default factor 1 — lose anything; when the comment reaches its
  floor the two share what is left. The unit sits at the value cell's
  tail, which is the end the ellipsis eats, which is why the ordering
  matters; both rules carry that constraint as a comment. **jsdom
  cannot measure flex layout, so there is no test — this needs the
  owner's bench eyeball** on a signal row with a long comment, values
  on, at a narrow panel width.
- Both amends kept their branch a single commit and rewrote its
  message to cover the branch's full content;
  `task135-surfaces`' message also gained the previously unmentioned
  absorption (computed signals in the Database panel's value column,
  over the shared math listing). `gt restack` after each.

**2026-09-07 — item 4 absorbed.**

- **Item 4 → `task139-units`.** Integration produces `Ah` from an `A`
  operand. Convertibility now accounts for the function's time
  dimension exactly as ruling 6 describes: the facade carries the
  rate↔integral pairing (`units::integral_of`), resolve tries the
  operand's own family first and the integral second, and the factor a
  charge target needs rides the **output** affine rather than the
  operand's. The design, the tests and the two decisions taken inside
  the ruling (the derived unit is the integral's *id*, and only where
  it is true of the samples; the manual output scalars compose ahead of
  the time conversion) are written up in
  `plans/tasks/0139-math-units-scaling.md` § Status log. Host lib tests
  1173 → 1190 passing on that branch; no frontend change was needed.
- The amend rewrote `task139-units`' message to cover the branch's full
  content, including the previously unmentioned ratio absorption (the
  bare 0–1 `ratio` unit and percent↔ratio conversion) and this item.
  `gt restack` after it.

**2026-09-07 — items 5–7, the owner's second bench pass.**

- **Item 5 → `task135-surfaces`.** `.dbc-row-comment` carries
  `flex-shrink: 200` against the default factor 1 on `.dbc-row-label`
  and `.dbc-row-value`, with a `min-width: 6ch` stub, so the comment
  absorbs essentially the whole deficit before either of the other two
  gives up a character; only when it reaches the stub do the two share
  what is left. The value cell ellipsizes from its tail, which is where
  the unit sits, so the ordering is the whole point — both rules carry
  that constraint as a stylesheet comment. No test: jsdom cannot
  measure flex layout, so the check is an eyeball on a signal row with
  a long comment, values on, at a narrow panel width.
- **Item 6 → `task135-editor`.** Both of item 1's rulings are
  reversed: the delete is **one click**, not the shared
  `TwoStageRemoveButton`, and it is pinned **immediately after the
  definition's name**, not at the row's far end. Both follow from the
  same two facts — the delete records an undo step carrying the whole
  definition back, so it is not the irreversible removal ADR 0058's
  two-stage control exists for; and a far-end control moves as the
  panel is resized, so what sits under the cursor changes with the
  width. `.dbc-row-delete` is `flex: none` plus the app's quiet inline
  icon-button look; the panel's armed state, the row's `deleteArmed`
  prop and the `TwoStageRemoveButton` import are gone. The DOM tests
  pin the undo path ("takes one click, and the undo step carries the
  definition back") and the placement ("pins the delete to the end of
  the name") — the undo replay, not a confirmation prompt, is the
  safety story now.
- **Item 7 → `task141-dbc-search`**, a branch of its own off
  `task141-settings-find`: the owning code is `main`-era (`72c1f0b6`
  drew the toolbar, `1b70256b` made it a chip-field), so no commit in
  the stack could absorb it, and it is left for the orchestrator to
  splice. The chip `.dbc-panel-search` is `flex: 1 1 0` and draws a box
  the width of the toolbar, while the `<input>` inside it kept the
  browser's ~20-character intrinsic width — so a click past the
  placeholder landed on the chip and focused nothing. The input now
  carries `.dbc-panel-search-input` (`flex: 1 1 0`) through the
  `className` slot `GridviewFilterBox` already exposed, and the drawn
  box and the click target are one rectangle. Scoped to this panel
  deliberately: it is the only chip-field the app stretches, and a
  blanket `.chip-field input { flex: 1 }` would relayout the RBS
  filter, the plot's solo box and the servers search for no gain.
  jsdom cannot measure widths, so the DOM test pins the structure the
  CSS keys on — the input is a direct child of the stretched chip and
  carries the class that fills it; removing the `className` prop was
  watched to fail it.
- Items 5 and 6 landed before their agent was killed mid-round, and
  the orchestrator resolved the restack that left behind. Both amended
  branches are still one commit; their messages were re-read against
  the code at tip and already describe the round-two content (the
  editor's "one click on a quiet trash pinned to the end of the
  definition's name", the surfaces' "the comment yields first … the
  name and the value hold their content until it is spent"), so no
  message fix was needed.
- This entry and the items above land in `doc-closeout` rather than in
  item 7's own commit. A `git merge-file` simulation of the restack
  showed no bottom-of-stack placement is conflict-free: an entry that
  replaces the `(none yet)` placeholder collides with
  `task135-surfaces`' patch, and one appended after it collides with
  `task139-units`'. At the tip the file already carries both, so the
  addition merges with nothing.

**2026-09-08 — items 8 and 9 absorbed.**

- **Item 8 → `task135-surfaces`.** Scientific method:
  - *Observation.* Dropping a Computed row on an operand section fills
    nothing; dropping a DBC signal fills it.
  - *Hypothesis.* The drop handler narrows the dragged
    `DraggableSignalRef` to a `MathOperandRef` field by field and
    forwards only `fileBacked`, so `math` is lost and the pick names a
    DBC identity nothing decodes — which the editor renders as
    "operand missing".
  - *Experiment.* A new DOM test drops a `math: true` payload on the
    `Signal` section and asserts the committed pick.
  - *Data.* The write carried
    `{busId: null, messageId: 0, extended: false, signalName: "m2"}` —
    the flag absent, everything else intact. Confirms the hypothesis
    and falsifies the alternatives (the drag source, which
    `DatabasePanel.math.dom.test.tsx` already pins, and `dragHasSignals`,
    which admitted the drop).
  - *Fix.* Forward `math` beside `fileBacked`, the way the combobox
    path's `mathRef` already does. The two other narrowing sites that
    can see a math ref — `PlotArea`'s side-list drag and
    `SignalsPanel`'s wire selection — already carried it; this drop
    target was the one this branch missed when it added the flag.
- **Item 9 → `task135-engine`.** `wide_dbc_text` builds through
  `write!`/`writeln!` (the file's existing
  `.expect("writing to a String cannot fail")` idiom) instead of
  `push_str(&format!(…))`; the bounded-serve loop's counter is
  `round_trips`, matching the same file's other convergence loop and
  ending the `serves`/`served` collision; the row-count assertion uses
  `usize::try_from`. Test code only, no `#[allow]` added.
  `task139-units` had independently fixed three of the four further up
  the stack — the restack conflict resolved to the engine spelling, so
  that branch's diff no longer carries them.

## Blockers / side effects

- **Splicing item 7 has one ordering constraint.** `git grep
  --untracked -Ein "task [0-9]|plans/" -- apps/ crates/` is clean at
  `doc-closeout`, but returns 17 hits at `task141-settings-find` —
  `(task 129)` citations `main` carries from `24e76fb6` (#450), swept
  by `task136-core-bus`. `task141-dbc-search` branches below that
  sweep, so it shows those 17 at its own level and adds none of its
  own. The intended splice position keeps it below `task136-core-bus`,
  which leaves every commit from there up clean.
