import type { KeyboardEvent, MouseEvent, ReactNode } from "react";

/// The one hit-area/ink/rotation/`aria-expanded` implementation every
/// collapsible section, row, and menu trigger in the GUI shares. A
/// too-small disclosure target had recurred at every site that grew
/// one; this is the fix, not another one-off size bump.
///
/// The default box meets the WCAG 2.5.8 24x24 CSS px target-size
/// floor, with the ink sized to fill it uniformly rather than sitting
/// small inside it. `compact` trades the floor's *height* for the
/// row's own height,
/// for sites where growing the row would bloat it (a fixed row height
/// shared with a virtualizer, or a toolbar line whose siblings set the
/// height) — width still reaches 24px there, since width costs nothing
/// in those layouts.
///
/// `onToggle` receives the activating event, so a site nested inside
/// another clickable element (a gridview row, ADR 0044) can call
/// `stopPropagation` itself; the component takes no view on whether
/// that bubbling is wanted, since sites differ.
export function DisclosureToggle({
  expanded,
  onToggle,
  ariaLabel,
  title,
  children,
  className,
  disabled,
  tabIndex,
  compact,
}: {
  expanded: boolean;
  onToggle: (e: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => void;
  /// Accessible name for the toggle. Omit when `children` already
  /// names it (the button's text becomes its name) — the whole-header
  /// pattern (a section's heading is the toggle).
  ariaLabel?: string;
  title?: string;
  /// Label content rendered after the glyph, inside the same button —
  /// for sites where the toggle is the section's whole clickable
  /// header rather than a bare icon. Omit for an icon-only toggle.
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  /// -1 keeps the toggle out of the tab order, for a site where an
  /// ancestor row is the gridview's own tab stop (ADR 0044) and this
  /// button is a secondary, mouse-only target beside it.
  tabIndex?: number;
  compact?: boolean;
}) {
  const activate = (e: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    onToggle(e);
  };
  return (
    <button
      type="button"
      className={`disclosure-toggle${compact ? " disclosure-toggle-compact" : ""}${className ? ` ${className}` : ""}`}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Suppresses the browser's own native activation (a real
        // <button> fires a synthetic click for both keys), so this
        // handler is the only thing that toggles it — and Space would
        // otherwise scroll an ancestor list out from under the row
        // (the same reason ByIdTable's rows preventDefault it).
        e.preventDefault();
        activate(e);
      }}
    >
      <span className="disclosure-toggle-glyph" aria-hidden="true">
        {expanded ? "▾" : "▸"}
      </span>
      {children}
    </button>
  );
}
