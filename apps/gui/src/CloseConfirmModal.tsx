import { useEffect } from "react";

export type CloseChoice = "save" | "discard" | "cancel";

/**
 * Shown when the user tries to close the window with unsaved project
 * changes. Resolves (via `onChoice`) to **Save & close** / **Discard &
 * close** / **Cancel**; Escape, Enter (the focused Cancel button), and
 * a backdrop click all mean Cancel.
 */
export function CloseConfirmModal({ onChoice }: { onChoice: (choice: CloseChoice) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onChoice("cancel");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onChoice]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => onChoice("cancel")}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="modal-message">You have unsaved changes to the project.</p>
        <div className="modal-buttons">
          <button type="button" onClick={() => onChoice("save")}>
            Save &amp; close
          </button>
          <button type="button" onClick={() => onChoice("discard")}>
            Discard &amp; close
          </button>
          <button type="button" onClick={() => onChoice("cancel")}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
