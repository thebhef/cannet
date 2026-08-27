# 0128 — Shared-Layer Holdouts

> **Opened 2026-08-27** by owner instruction while walking the
> residual-cleanup run's open items: one task for the last cleanup
> items that run surfaced.

## 1. `serverList.ts` onto `useHostMirror` · ruled

**Owner ruling 2026-08-27: option (a).** `fromPayload` grows an
ignore signal — returning `undefined` means "keep the current value" —
so `useServerList` and `useAddressesNeedingTrust` migrate with no
behaviour change: a malformed event payload still keeps the list, and
the launch race (fetch → listen, nothing re-read after the listener
attaches) closes. These are the pattern's last two holdouts; task
127's nine-file survey (its status log) is the evidence. Exposure was
small — a change racing a mount could leave a stale row until the next
event — but the fix is cheap and ends the pattern's exceptions.

## 2. A portal names its host surface, so Escape reaches it

From task 113's Blockers: combobox dropdowns render through a portal
to `document.body`, so `isGridviewContentTarget` cannot claim them and
Escape in an open dropdown on a fullscreened panel exits fullscreen.
ADR 0044's precedence (content beats grid beats global) implies the
dropdown should win. Needs a layer-level way for portalled content to
declare its host surface.

## 3. The columned gridviews get their ARIA roles

From task 113's Blockers: ADR 0044's 2026-08-27 amendment requires
`tree`/`treeitem`; the trace views (127) and RBS/transmit (113)
comply, but `GridviewRow`/`GridviewHeader` render plain `div`s, so
view-signals and rbs-signals carry none.

## Exit criteria

1. `fromPayload` supports ignore; both `serverList.ts` hooks sit on
   `useHostMirror`; keep-on-invalid pinned unchanged; a launch-race
   test pins the post-listen refetch; no hand-rolled host-mirror
   remains (re-run 127's survey).
2. Escape in a portalled dropdown on a fullscreened panel closes the
   dropdown and does not exit fullscreen — regression test failing
   first; the portal mechanism recorded in ADR 0044.
3. View-signals and rbs-signals carry the roles the ADR requires,
   pinned by test.
4. Full local CI green — six jobs plus the hand-run
   comment-references grep, each named with its command.
