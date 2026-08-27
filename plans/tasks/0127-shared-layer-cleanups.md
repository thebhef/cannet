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
