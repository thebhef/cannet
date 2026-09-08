/// A quiet icon-only button: transparent until hover, single click,
/// no confirm step. The companion to `TwoStageRemoveButton` for
/// actions that don't need to arm — a registry-undoable remove, "go
/// to this element", a refresh, the RBS/Logger run toggle. Extra
/// classes (a toggle's running/armed tint) compose via `className`.

import { Icon, type IconName } from "./Icon";

export interface IconButtonProps {
  name: IconName;
  /// Accessible name and tooltip, unless `title` overrides the
  /// tooltip text.
  label: string;
  title?: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
}

export function IconButton({ name, label, title, onClick, className, disabled }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={name} />
    </button>
  );
}
