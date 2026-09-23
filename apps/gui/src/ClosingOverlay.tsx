import { useEffect } from "react";

import { formatBytes } from "./statusLine";
import type { ClosingProgress } from "./types";

/// The step line for a `closing-progress` report: what the host is doing,
/// and, where the step has a measurable length, how much.
export function closingStepText(progress: ClosingProgress): string {
  switch (progress.step) {
    case "disconnecting":
      return "disconnecting…";
    case "finishing_loggers":
      return "finishing loggers…";
    case "clearing_capture":
      return "clearing the capture cache…";
    case "writing_capture":
      return progress.bytes == null
        ? "writing the capture cache…"
        : `writing the capture cache (${formatBytes(progress.bytes)})…`;
    case "writing_signals":
      return progress.total > 0
        ? `writing the signal cache (${progress.done} of ${progress.total} signals)…`
        : "writing the signal cache…";
  }
}

/**
 * Full-window closing state: the window stays up while the host finishes
 * the shutdown sequence (ADR 0002 DS-7), and this says what it is on.
 * Nothing here takes input — the overlay covers the pointer, and keys
 * are swallowed before the command keybindings see them — because the
 * app is on its way out and the host exits it when the sequence is done.
 */
export function ClosingOverlay({ progress }: { progress: ClosingProgress }) {
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Window-level capture runs before the keybindings' document-level
    // capture listener.
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, []);

  return (
    <div className="splash-overlay" role="status" data-testid="closing-overlay">
      <div className="splash-card">
        <p className="closing-step">Closing — {closingStepText(progress)}</p>
      </div>
    </div>
  );
}
