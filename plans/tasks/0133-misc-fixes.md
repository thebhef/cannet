# 0133 — Misc Fixes

> **Opened 2026-09-03** by owner instruction, as the collection point
> for small owner-reported fixes that belong to no open task. Add new
> items here rather than opening a task per fix.

## Items

1. **Hex display: leading zeros are preserved** (owner feedback,
   2026-09-03). A hex value renders at its field's full width — a
   byte is two digits, an id and a raw value the width their bit
   length implies — instead of dropping leading zeros. Grooming
   enumerates the surfaces that render hex and pins each with a test.
2. **The window's own scrollbars flicker on and off** (owner feedback,
   2026-10-26, over RDP at 200 % after the display size changed a few
   times; still visible beneath the closing overlay). The document
   can scroll: `html, body, #root` are `height: 100%` with no
   `overflow`, and `.dock-area` (`flex: 1 1 auto; min-height: 0`) does
   not clip either, so anything a pixel too big in the dock shows a
   window scrollbar. Dockview sizes its grid to
   `Math.round(contentRect.width/height)` (`dockview-core` 6.0.7
   `resizable.js:67`) and writes integer `px` on every group, while the
   dock area's height is fractional (the header's rem padding and
   line heights) and, once one scrollbar shows, so is its width (a
   17-device-px scrollbar is 8.5 CSS px at 200 %). Round up on the
   height → vertical scrollbar → width loses 8.5 px and rounds up →
   horizontal scrollbar → height loses 8.5 px and rounds down → the
   vertical one goes → width is whole again → the horizontal one goes
   → back to the start, one state per resize-observer tick. The same
   integer-vs-fraction shape sits in `useToolbarFit` (`offsetWidth`
   against `clientWidth`) and the uPlot canvases, so the loop has more
   than one way to start. Fix: the app shell never scrolls at the
   document level — `html, body { overflow: hidden }` and
   `.dock-area { overflow: hidden }` — every scroll region is an inner
   one already. Test: a dom test that a dock area of fractional height
   leaves `document.documentElement.scrollHeight` at `clientHeight`
   (or, if jsdom cannot carry it, a stylesheet assertion on the two
   rules). Nothing in `cannet.log` records a display or DPI change,
   and the saved layouts (`state.json` 3840×1909, project 1710×853,
   `.window-state.json` 2406×1607 physical) are only the record of the
   display changing — not corrupt, no action.

## Exit criteria

Each item lands with a test that reproduces the reported behaviour
first; the task closes when its list is empty and the owner has seen
the fixes.
