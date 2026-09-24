// Puts a scrolled container's offset back across a settings-panel hide
// and show.
//
// dockview's default renderer detaches a hidden panel's element from
// the document (`ContentContainer.renderPanel`'s `onlyWhenVisible`
// branch); a detached box keeps no `scrollTop` of its own, so a plain
// CSS scroller reopens at the top. `SettingsPanel.tsx` first worked
// around this for `.settings-list` by saving `scrollTop` in a ref and
// restoring it in a layout effect keyed on the view's re-attach signal
// (`SettingsShownContext`'s count). This is that mechanism, shared: the
// settings view's own list and its two inner row spaces
// (`UnitCustomizations`, `ProjectCachesList`) all reopen at the top
// without it, and a second hand-rolled copy per view is the drift
// CLAUDE.md's GUI architecture section calls out.
import { useLayoutEffect, useRef, type RefObject, type UIEvent } from "react";

/// Saves `container`'s `scrollTop` on every scroll and puts it back
/// whenever `shownCount` changes. `shownCount` is a parameter rather
/// than read from context here, because the settings view itself is
/// `SettingsShownContext`'s provider and so is not inside its own
/// subtree — it passes its local counter directly, while the row
/// spaces reached through the custom-setting renderer table read it
/// via `useContext(SettingsShownContext)` and pass that through.
///
/// Returns the `onScroll` handler to wire onto `container`; the caller
/// still owns the ref itself, since the row spaces already need one for
/// their own "scroll a row into view" arithmetic.
export function useScrollRestore<T extends HTMLElement>(
  container: RefObject<T | null>,
  shownCount: number,
): (e: UIEvent<T>) => void {
  const scrollTopRef = useRef(0);
  useLayoutEffect(() => {
    if (container.current) container.current.scrollTop = scrollTopRef.current;
  }, [container, shownCount]);
  return (e) => {
    scrollTopRef.current = e.currentTarget.scrollTop;
  };
}
