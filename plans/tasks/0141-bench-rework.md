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

- [x] All four items implemented at their distribution targets, each
      branch still a single commit whose message covers its content.
- [x] Stack linear, `doc-closeout` on top, full suites green at tip.
- [x] Installer rebuilt from the tip for the owner's visual pass
      (items 2's layout and 1's control read correctly on the bench).

## Status log

(none yet)

## Blockers / side effects

(none yet)
