import { useEffect } from "react";

/**
 * Confirms the "Clear project colors" command, which discards every
 * color the user picked for a bus or a signal in one step and has no
 * partial undo — so it asks first, the same shape and the same escape
 * routes as the unsaved-changes prompt: Escape, the focused Cancel
 * button, and a backdrop click all mean cancel.
 *
 * The wording states the scope, because the scope is the surprising
 * part: color-map rules are authored data (a value *means* this color),
 * not cosmetic identity, and are left alone.
 */
export function ClearColorsConfirmModal({
  onChoice,
}: {
  onChoice: (confirmed: boolean) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChoice(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onChoice]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onChoice(false)}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className="modal-message">
          Discard every bus color and signal color you have picked? They go back to the
          current theme&apos;s defaults. Color-map rules are not touched, and this cannot
          be undone.
        </p>
        <div className="modal-buttons">
          <button type="button" onClick={() => onChoice(true)}>
            Clear colors
          </button>
          <button type="button" onClick={() => onChoice(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
