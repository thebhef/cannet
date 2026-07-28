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

import { type RefObject, useEffect, useRef } from "react";

export function useDismissableMenu<T extends HTMLElement = HTMLElement>(
  open: boolean,
  onClose: () => void,
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
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
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
