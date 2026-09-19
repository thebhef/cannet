# 0141 — Bench Rework: Owner-Reported Fixes on the Open Stack

> **Opened 2026-09-06** by owner instruction: the fix queue from the
> evening bench pass, captured as one task. **Each item is distributed
> through the existing stack** — amended into the commit whose work it
> reworks (with that commit's message updated to match), or landed as
> its own branch where the reworked code predates the stack. Opus
> agents, per the oversee-roadmap flow as modified this session
> (shared tree, absorption amends, `gt restack` only).

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

5. **A math signal dragged from the Computed branch into another math
   signal's operand section does nothing.** Math-on-math is documented
   and works through the operand combobox; only the drop path fails.
   → **amend `task135-surfaces`** (which made a Computed row draggable
   and taught every other drop target the flag).
6. **`cargo clippy -p cannet-gui --all-targets -- -D warnings` fails at
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
- [x] Stack linear, `doc-closeout` on top, full suites green at tip.
- [x] Installer rebuilt from the tip for the owner's visual pass
      (items 2's layout and 1's control read correctly on the bench).

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

**2026-09-08 — items 5 and 6 absorbed.**

- **Item 5 → `task135-surfaces`.** Scientific method:
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
- **Item 6 → `task135-engine`.** `wide_dbc_text` builds through
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

(none yet)
