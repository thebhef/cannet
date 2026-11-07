/// Dismiss-on-outside-click + Escape, shared by every floating
/// menu/popover in the frontend (context menus, the measurements
/// picker): while `open`, a `mousedown` outside the returned ref's
/// element or an `Escape` keypress calls `onClose`. `mousedown` (not
/// `click`) so a click on a `<label>`-wrapped control — which fires
/// `click` only after the input's own state has updated — doesn't
/// dismiss the menu before that click lands.
///
/// Attach the returned ref to the menu's own root element; no
/// `stopPropagation()` or CSS-selector `closest()` needed at the call
/// site, since outside-ness is decided by `ref.current.contains`.
///
/// `onClose` is told *why* the menu is closing. A menu holding an
/// uncommitted edit needs it: an outside click is "done here", so the
/// edit commits, while Escape is "never mind", so it does not. The menu
/// cannot rely on its input's `blur` for the outside case — closing on
/// `mousedown` unmounts the input before the browser moves focus, so
/// that `blur` never reaches it.

import { type RefObject, useEffect, useRef } from "react";

/** What dismissed the menu: a `mousedown` outside it, or Escape. */
export type DismissReason = "outside" | "escape";

export function useDismissableMenu<T extends HTMLElement = HTMLElement>(
  open: boolean,
  onClose: (reason: DismissReason) => void,
): RefObject<T> {
  const ref = useRef<T>(null);

  // Read through a ref rather than making `onClose` an effect
  // dependency: callers commonly pass an inline closure, and reacting
  // to its identity would tear down and re-add the listeners on every
  // render while the menu is open.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current("escape");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return ref;
}
