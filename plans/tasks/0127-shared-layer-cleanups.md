# 0127 — Shared-Layer Cleanups

> **Opened 2026-08-26** by owner ruling on the review queue's § 3G
> ("accepted new task"). Three findings, one theme: the frontend's
> shared layer exists and these are the places that still sidestep it.
> 3.13 (`useBusHealth`) was closed the same day — already migrated by
> task 108 phase 2 (`02f9b877`).

## 1. Editing an event's tag or description leaves the keyboard dead · 3.51

**A live defect, reachable today by anyone who edits a tag.** Enter or
Escape unmounts the editor input while it is still
`document.activeElement`, so the gridview layer's focus recovery —
which checks for `body` during the keypress — never fires, and the
arrow keys do nothing until the user clicks. Task 19 step 2 fixed
exactly this one level up for the F2 rename field; `EventBody`'s tag
and description editors keep their own local `editing` state and were
missed. Fix with the regression test the sibling bug got, failing
first.

## 2. `useConnectionStates` still hand-rolls the host mirror · 3.19

The launch race `useHostMirror` exists to close (fetch, then listen,
no post-listen refetch) is still open on a shipped connection path. It
cannot move as-is: the shared hook treats an event as a nudge to
re-read, while this consumer *uses the payload*, pinned by name in
`ProjectPanel.connectionState.dom.test.tsx` ("follows the host's change
event without a refetch"). The two concerns are separable moments — a
`fromPayload` option on `useHostMirror` closes the race and keeps that
expectation intact. Last call site of the pre-hook pattern.

## 3. One focus model in the trace gridviews · 3.18

Event rows are `tabIndex={0}` by an explicit earlier decision with a
test behind it — a click focuses the row — beside the
container-plus-`aria-activedescendant` model everything else uses. And
no trace gridview container or row carries an ARIA `role`, which
leaves `aria-activedescendant` inert to assistive tech. Unify on the
container model (per ADR 0044's keyboard contract) and add the roles;
the earlier decision's test is turned around with its reason recorded.

## Exit criteria

1. After editing an event's tag or description, Enter/Escape returns
   focus to the grid and the arrow keys work — pinned by a regression
   test written failing first (§ 1).
2. `useHostMirror` gains a `fromPayload` option; `useConnectionStates`
   sits on it; the "follows the host's change event without a refetch"
   expectation still passes; a launch-race test pins the post-listen
   refetch (§ 2).
3. Trace gridview containers and rows carry ARIA roles and one focus
   model; `aria-activedescendant` is honoured by construction; the
   turned-around test records why (§ 3).
4. No panel hand-rolls the host-mirror pattern — pinned by a grep-style
   check or reviewed statement in the status log.
5. Full local CI green — seven jobs, each named with its command.

## Status log

- 2026-08-27: All three sections implemented on `task-127-shared-layer`
  off `task-122-file-keeps` (a95c1634), test-first where there was a
  defect to reproduce. Full local CI run, all seven jobs green.

  **1. The dead keyboard after a tag or description edit.** Reproduced
  first: `TraceView.gridview.dom.test.tsx` gained "hands the keyboard
  back to the grid when a body field's edit ends", which opens an event
  row's body, edits the tag and the description, and presses Escape and
  Enter — it failed with `document.activeElement` on `<body>` where the
  grid was expected, exactly as the sibling rename bug did.

  The recovery is now the layer's rather than the view's:
  `useEditorFocusRecovery(editing, containerRef)` in `useGridview.ts`
  holds what `TraceView` had open-coded — the `wasEditing` ref, the
  layout effect, and the "only where focus went nowhere" guard.
  `TraceView` calls it for the row's label editor and `EventBodyField`
  calls it for its own local `editing`, so the two copies cannot drift
  apart again. `EventBody` and `EventBodyField` take the gridview
  container as a prop for it. A second test pins the other half: a click
  into another control ends the edit too, and that focus stays the
  user's.

  **2. `useConnectionStates` onto the shared mirror.** `useHostMirror`
  gained `fromPayload?: (payload: P) => T` — where the host event
  publishes the whole new state rather than a nudge to re-read it, the
  listener applies the payload and skips the refetch. The snapshot pair
  around listener registration still runs, because a payload only
  reaches a listener that exists; that is what closes the race, and a
  hook test pins it ("still closes the launch race when the value comes
  from the payload").

  `useConnectionStates` is now nine lines over the hook. The pinned
  expectation "follows the host's change event without a refetch" passes
  unchanged — it pushes a payload and asserts synchronously, which only
  a payload read can satisfy. The launch-race test the criterion asks
  for is "picks up a change emitted while the listener was still
  registering" in `ProjectPanel.connectionState.dom.test.tsx`: it holds
  the `listen` promise open, settles the bus behind it, releases the
  registration, and expects the row to read `connected`. It failed
  before the migration.

  `useSidecarStatus` moved onto the same option in the same pass — it is
  the other payload-reading hand-roll, its own launch-race tests already
  exist and still pass, and leaving one copy behind while adding the
  option that exists for it would have been the drift this task is
  about.

  **3. One focus model, and real roles.** Both trace gridviews'
  containers are `role="tree"`, the scroll spacer and sticky viewport
  between them are `role="presentation"`, and every row of the space is
  a `treeitem` — message rows and event rows at `aria-level={1}`,
  disclosed content rows (decoded signals, event body fields) at `2`.
  Until now nothing in either view carried a role, so the container's
  `aria-activedescendant` named an element with no reportable identity:
  the attribute was there and inert.

  Two row-level tab stops went with it. `EventRow`'s `tabIndex={0}` is
  the decision § 3 names; `ByIdRow`'s `tabIndex={expandable ? 0 :
  undefined}` plus its own Enter/Space `onKeyDown` is the same
  divergence in the sibling view, and "one focus model in the trace
  gridviews" is not met with either standing. Both are gone, both
  panels' click handlers now hand the keyboard to the container the way
  `makeRowGridPropsCache` does, and by-id disclosure from the keyboard
  is the layer's Right/Left. `.trace-row:focus-visible` died with them
  and was removed.

  Both tests are turned around in place with the reason written into
  them: `EventsPanel.dom.test.tsx` "focuses the row that was clicked"
  now asserts no `tabindex`, `role="treeitem"`, focus on the container
  and `aria-activedescendant` naming the row; `ByIdTable.dom.test.tsx`
  "makes the row the disclosure control" and "toggles from the keyboard
  on the layer's Right and Left" record that a row tab stop was a second
  focus model and put every decoded message in the page's tab order.

  **4. Who still hand-rolls the host mirror** (exit criterion 4,
  reviewed statement). Every `listen` call under `apps/gui/src`, minus
  tests and `useHostMirror.ts` itself, is nine files. Their
  dispositions:

  | Site | Shape | Verdict |
  | --- | --- | --- |
  | `connectionStates.ts` | snapshot + payload event | **migrated** |
  | `sidecarStatus.ts` | snapshot + payload event + refetch | **migrated** |
  | `serverList.ts` `useServerList` | snapshot + payload event, no post-listen refetch | the pattern, race open — see Blockers |
  | `serverList.ts` `useAddressesNeedingTrust` | argument-keyed ask + nudge event, no post-listen ask | the pattern, race open — see Blockers |
  | `ConnectionManagement.tsx` | keyed map, one listener over many addresses | not the pattern: the mirror holds one value |
  | `DatabasePanel.tsx`, `signalCatalogContext.tsx`, `ViewSignalsPanel.tsx` | refresh-on-event, no snapshot pair | not the pattern: nothing to race |
  | `App.tsx`, `TracePanel.tsx`, `PlotPanel.tsx`, `dbcChanged.ts` | append / broadcast streams | not a mirror at all |

  No *panel* hand-rolls it: the two that remain are hooks in
  `serverList.ts`, and both need a behavioural ruling before they can
  move (Blockers).

  Docs in the same commit: ADR 0044 gains a 2026-08-27 amendment stating
  the ARIA-role requirement and its corollary that no row is a tab stop;
  rustdoc-style doc comments on `useHostMirror`'s new option,
  `useEditorFocusRecovery`, `useConnectionStates`, `useSidecarStatus`,
  `EventRow` and `ByIdRow` move with the code.

  | CI job | Command | Result |
  | --- | --- | --- |
  | comment-references | `git grep --untracked -Ein "task [0-9]\|plans/" -- apps/ crates/` | no hits |
  | frontend | `pnpm --dir apps/gui test`; `pnpm --dir apps/gui build` | 3048 passed / 223 files; built |
  | python | `uv sync --extra dev --frozen`, `uv run ruff check .`, `ruff format --check .`, `mypy`, `pytest` | 200 passed, no findings |
  | rust | `cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings` | 1686 passed, 0 failed; clean |
  | mdf-export-oracle | `cargo run -p cannet-mdf --example export_sample`; `validate_export.py` | 30 frames, 3 signals, 3 events — OK |
  | rustdoc | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --no-deps` | clean |
  | sidecar-freeze | `uv run --no-project scripts/build-sidecar.py` | smoke ok |

- 2026-08-27: Exit criteria 1-5 met.

## Blockers / side effects

- **`serverList.ts` carries the same open launch race § 2 was opened
  for, in two hooks.** `useServerList` and `useAddressesNeedingTrust`
  both fetch, then attach a listener, and never re-read after the
  attach — so a server appearing (or a trust decision landing) in the
  registration gap is lost until the next event. Not migrated, because
  the fix implies a behavioural choice the owner has not made:
  `useServerList` guards its payload with `Array.isArray(payload
  ?.servers)` and *keeps the list it has* when the guard fails, which
  `fromPayload` — which must return a value — cannot express. "Malformed
  payload ⇒ empty list" would be a behaviour change; "⇒ ignore it" needs
  `fromPayload` to grow an ignore signal. Recorded on the checklist.
- **§ 2's premise that `useConnectionStates` is the last call site of
  the pre-hook pattern is not right.** Three others were found; two are
  now migrated and two remain (above). The survey table in the status
  log is the record.
- **§ 3 covered a second turned-around decision the task does not
  name.** `ByIdRow`'s tab stop and its Enter/Space handler are the same
  divergence as `EventRow`'s, in the other trace gridview, so exit
  criterion 3 could not be met while it stood. Its two tests are turned
  around with the reason recorded, the same way § 3 asks for the event
  row's.
- **The queue rows the task's provenance cites (3.51, 3.19, 3.18) no
  longer exist.** Same reframe tasks 115, 117, 114 and 122 hit:
  `owner-review-queue.md` became an acceptance checklist on 2026-08-26.
  Followed their precedent — a `127` row in the `## Acceptance` list,
  closures in this status log.
- No perf capture taken (harness under repair) and no installer built —
  both per the overseer's standing constraints for this phase.
