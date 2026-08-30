/// The app's **two-stage remove**: a trash-can button whose first
/// click arms it (red, "click again to confirm") and whose second
/// click acts, disarming by itself after 3s — the transmit panel row's
/// remove pattern, extracted so every non-undoable removal reads and
/// behaves the same. Use it wherever a removal has no way back (values
/// never ride undo — ADR 0058); an undoable or re-enterable clear
/// doesn't need it.

import { useEffect, useState } from "react";

import { Icon } from "./Icon";

export interface TwoStageRemoveButtonProps {
  /// Accessible name and tooltip while unarmed — say what is removed
  /// ("drop override", "remove frame").
  label: string;
  /// Longer unarmed tooltip when the label alone is terse; defaults to
  /// the label.
  title?: string;
  onRemove: () => void;
  className?: string;
}

export function TwoStageRemoveButton({ label, title, onRemove, className }: TwoStageRemoveButtonProps) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`two-stage-remove${armed ? " two-stage-remove-armed" : ""}${className ? ` ${className}` : ""}`}
      aria-label={armed ? "click again to confirm" : label}
      title={armed ? "click again to confirm" : (title ?? label)}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          onRemove();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
    >
      <Icon name="clear" />
    </button>
  );
}
