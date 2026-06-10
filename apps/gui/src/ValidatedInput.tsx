// The shared validated text input (ADR 0027 / task 14): draft-while-
// typing, commit on blur or Enter, revert on Escape or when the
// committed text fails `parse`. The pattern originated in
// `TransmitPanel.tsx`'s value / period cells; this is the one shared
// implementation the transmit and RBS panels both use.

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
  /// Optional datalist id (enum comboboxes attach suggestions).
  list?: string;
  disabled?: boolean;
  title?: string;
  /// What focusing does to the committed text: `"select"` selects it
  /// (type-to-replace); `"clear"` empties the draft so a datalist
  /// shows *all* its options instead of filtering on the current
  /// value (the combobox lock-in fix) — blurring without typing
  /// reverts. Default: leave the caret where clicked.
  focusBehavior?: "select" | "clear";
}

export function ValidatedInput<T>({
  value,
  parse,
  onCommit,
  className,
  placeholder,
  ariaLabel,
  list,
  disabled,
  title,
  focusBehavior,
}: ValidatedInputProps<T>) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="text"
      className={className}
      value={draft ?? value}
      placeholder={placeholder ?? (focusBehavior === "clear" ? value : undefined)}
      list={list}
      disabled={disabled}
      title={title}
      onFocus={(e) => {
        if (focusBehavior === "clear") setDraft("");
        else if (focusBehavior === "select") e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const parsed = parse(draft.trim());
        setDraft(null);
        if (parsed !== null) onCommit(parsed);
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
