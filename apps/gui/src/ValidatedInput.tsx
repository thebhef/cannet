// The shared validated text input (ADR 0027 / task 14): draft-while-
// typing, commit on blur or Enter, revert on Escape or when the
// committed text fails `parse`. The pattern originated in
// `TransmitPanel.tsx`'s value / period cells; this is the one shared
// implementation the transmit and RBS panels both use.
//
// Free text only: a value picked from a fixed set is the shared
// `Combobox`'s job, and it commits on the pick.

import { useState } from "react";

export interface ValidatedInputProps<T> {
  /// The committed value, rendered whenever no draft is in progress.
  value: string;
  /// Parse the committed text; `null` rejects (the input reverts).
  parse: (text: string) => T | null;
  onCommit: (value: T) => void;
  className?: string;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  title?: string;
  /// `"select"` selects the committed text on focus (type-to-replace).
  /// Default: leave the caret where clicked.
  focusBehavior?: "select";
}

export function ValidatedInput<T>({
  value,
  parse,
  onCommit,
  className,
  placeholder,
  ariaLabel,
  disabled,
  title,
  focusBehavior,
}: ValidatedInputProps<T>) {
  const [draft, setDraft] = useState<string | null>(null);
  // Ends the edit either way: the draft is dropped, so the box falls
  // back to `value` and a later blur cannot commit the same text twice.
  const commit = (text: string) => {
    const parsed = parse(text.trim());
    setDraft(null);
    if (parsed !== null) onCommit(parsed);
  };
  return (
    <input
      type="text"
      className={className}
      value={draft ?? value}
      placeholder={placeholder}
      disabled={disabled}
      title={title}
      onFocus={(e) => {
        if (focusBehavior === "select") e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        commit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          // Abandon the draft — the committed value re-renders.
          setDraft(null);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
    />
  );
}

/// Parser for a finite decimal number.
export function parseFiniteNumber(text: string): number | null {
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/// Parser for a positive integer (period cells).
export function parsePositiveInt(text: string): number | null {
  const n = Math.floor(Number(text));
  return Number.isFinite(n) && n > 0 ? n : null;
}
