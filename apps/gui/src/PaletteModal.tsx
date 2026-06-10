// The shared palette modal (ADR 0018): one component, two palettes —
// the command palette (Mod+Shift+P) and go-to-view (Mod+P) differ
// only in the items they pass. Types-to-filter through `fzf` (the
// matcher Task 12 adopted for the DBC panel), arrow keys + Enter to
// pick, Esc / backdrop click to close.

import { useMemo, useState } from "react";
import { Fzf } from "fzf";

export interface PaletteItem {
  id: string;
  label: string;
  /// Right-aligned secondary text: a category or a key-binding hint.
  hint?: string;
}

export function PaletteModal({
  placeholder,
  items,
  onPick,
  onClose,
}: {
  placeholder: string;
  items: readonly PaletteItem[];
  onPick: (item: PaletteItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const fzf = useMemo(
    () => new Fzf<readonly PaletteItem[]>(items, { selector: (i) => i.label }),
    [items],
  );
  const filtered = useMemo(
    () => (query.length === 0 ? [...items] : fzf.find(query).map((r) => r.item)),
    [items, fzf, query],
  );
  const clamped = Math.min(selected, Math.max(0, filtered.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(filtered.length === 0 ? 0 : (clamped + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(
        filtered.length === 0 ? 0 : (clamped - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[clamped];
      if (item) onPick(item);
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal palette"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          className="palette-input"
          placeholder={placeholder}
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list" role="listbox">
          {filtered.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={i === clamped}
              className={`palette-item${i === clamped ? " selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => onPick(item)}
            >
              <span className="palette-item-label">{item.label}</span>
              {item.hint && <span className="palette-item-hint">{item.hint}</span>}
            </li>
          ))}
          {filtered.length === 0 && <li className="palette-empty">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
