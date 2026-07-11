// The shared fzf-filtered combobox — the one select-like control the
// GUI uses (task 32.8 convention: any new select/combobox is one of
// these). Closed, it renders like a `<select>`: a button showing the
// current option's label, carrying the submitted value on `value`.
// Open, it is a text input that filters the option list through `fzf`
// (the matcher the DBC panel / palette adopted), with arrow-key
// navigation, Enter to pick, Escape / blur to close, and
// type-to-filter straight from the closed state.
//
// Options may be hierarchical: an option's `path` lists its ancestor
// labels (bus → message, server address, …) and renders as indented
// group headers above the leaf rows — the same shape the DBC panel
// tree presents. Fzf matches against the full path text, so filtering
// by an ancestor keeps its leaves visible under their ancestry. Flat
// options (no `path`) render as a plain list — the degenerate case
// the small fixed-enum pickers use.
//
// The dropdown renders through a portal with fixed positioning so it
// escapes overflow-clipped toolbars and stacks above modals.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Fzf } from "fzf";

export interface ComboboxOption {
  /// Submitted value — what `onChange` receives (a `<select>` option's
  /// `value`).
  value: string;
  /// Row text in the dropdown; for hierarchical options, the leaf
  /// label (the signal name, not the whole path).
  label: string;
  /// Ancestor labels, outermost first. Present ⇒ the option renders
  /// under indented group headers and fzf matches the joined path.
  path?: readonly string[];
  /// Listed but not pickable (mirrors `<option disabled>`).
  disabled?: boolean;
  /// Closed-state text override (defaults to `label`) — lets a
  /// hierarchical picker keep its context when closed
  /// ("Chassis · GearBox.Gear") while the dropdown row shows "Gear".
  selectedLabel?: string;
}

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  /// Currently selected value. `""` is fine — when no option carries
  /// it, the trigger shows `placeholder`.
  value: string;
  onChange: (value: string) => void;
  /// Closed-state text when `value` matches no option.
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /// Extra class(es) on the trigger button, for per-site layout CSS.
  className?: string;
  title?: string;
}

/// One rendered dropdown row: an ancestor header or a pickable leaf.
type Row =
  | { kind: "header"; text: string; depth: number }
  | { kind: "option"; opt: ComboboxOption; depth: number; pickIndex: number };

function haystack(o: ComboboxOption): string {
  return o.path ? `${o.path.join(" ")} ${o.label}` : o.label;
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  className,
  title,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const fzf = useMemo(
    () => new Fzf<readonly ComboboxOption[]>(options, { selector: haystack }),
    [options],
  );
  // Visible options in *catalog order* (not fzf rank) so hierarchy
  // grouping stays stable while filtering.
  const visible = useMemo(() => {
    if (query === "") return [...options];
    const matched = new Set(fzf.find(query).map((r) => r.item.value));
    return options.filter((o) => matched.has(o.value));
  }, [options, fzf, query]);

  // Interleave ancestor headers: emit a header for each path level
  // that differs from the previous option's path.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let prevPath: readonly string[] = [];
    let pickIndex = 0;
    for (const opt of visible) {
      const path = opt.path ?? [];
      let common = 0;
      while (common < path.length && common < prevPath.length && path[common] === prevPath[common]) {
        common += 1;
      }
      for (let level = common; level < path.length; level += 1) {
        out.push({ kind: "header", text: path[level], depth: level });
      }
      out.push({
        kind: "option",
        opt,
        depth: path.length,
        pickIndex: opt.disabled ? -1 : pickIndex,
      });
      if (!opt.disabled) pickIndex += 1;
      prevPath = path;
    }
    return out;
  }, [visible]);

  const pickable = useMemo(() => visible.filter((o) => !o.disabled), [visible]);
  const clamped = Math.min(active, Math.max(0, pickable.length - 1));

  const openDropdown = (seedQuery: string) => {
    const r = triggerRef.current?.getBoundingClientRect();
    setPos({ left: r?.left ?? 0, top: r?.bottom ?? 0, width: r?.width ?? 0 });
    setQuery(seedQuery);
    // Start on the current value's option (matching a native select),
    // falling back to the top.
    const enabled = options.filter((o) => !o.disabled);
    const i = seedQuery === "" ? enabled.findIndex((o) => o.value === value) : 0;
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const commit = (v: string) => {
    close(true);
    onChange(v);
  };

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const el = popRef.current?.querySelector('[role="option"][aria-selected="true"]');
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [open, clamped, query]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openDropdown("");
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-to-filter straight from the closed state.
      e.preventDefault();
      openDropdown(e.key);
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Only the dropdown closes — not a modal hosting the combobox.
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(pickable.length === 0 ? 0 : (clamped + 1) % pickable.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(pickable.length === 0 ? 0 : (clamped - 1 + pickable.length) % pickable.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = pickable[clamped];
      if (opt) commit(opt.value);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const selected = options.find((o) => o.value === value);
  const closedLabel = selected ? selected.selectedLabel ?? selected.label : placeholder ?? "";

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`combobox-trigger${className ? ` ${className}` : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        disabled={disabled}
        title={title}
        value={value}
        onMouseDown={(e) => {
          // Keep the filter input focused while open so the ensuing
          // click toggles closed instead of blur-close + click-reopen.
          if (open) e.preventDefault();
        }}
        onClick={() => {
          if (disabled) return;
          if (open) close(false);
          else openDropdown("");
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="combobox-trigger-label">{closedLabel}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="combobox-pop"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width }}
            onMouseDown={(e) => {
              // Clicking rows must not blur the input (blur closes the
              // dropdown before the click could land).
              if (e.target !== inputRef.current) e.preventDefault();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="combobox-input"
              value={query}
              placeholder="type to filter…"
              aria-label={ariaLabel ? `${ariaLabel} filter` : "filter options"}
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              onBlur={(e) => {
                const to = e.relatedTarget as Node | null;
                if (to && (popRef.current?.contains(to) || to === triggerRef.current)) return;
                close(false);
              }}
            />
            <ul className="combobox-list" role="listbox">
              {rows.map((row, i) =>
                row.kind === "header" ? (
                  <li
                    key={`h${i}`}
                    className="combobox-group"
                    role="presentation"
                    style={{ paddingLeft: `${0.5 + row.depth * 0.7}rem` }}
                  >
                    {row.text}
                  </li>
                ) : (
                  <li
                    key={row.opt.value}
                    role="option"
                    aria-selected={row.pickIndex >= 0 && row.pickIndex === clamped}
                    aria-disabled={row.opt.disabled || undefined}
                    data-value={row.opt.value}
                    className={`combobox-option${
                      row.pickIndex >= 0 && row.pickIndex === clamped ? " active" : ""
                    }${row.opt.disabled ? " disabled" : ""}`}
                    style={{ paddingLeft: `${0.5 + row.depth * 0.7}rem` }}
                    onMouseEnter={() => {
                      if (row.pickIndex >= 0) setActive(row.pickIndex);
                    }}
                    onClick={() => {
                      if (!row.opt.disabled) commit(row.opt.value);
                    }}
                  >
                    {row.opt.label}
                  </li>
                ),
              )}
              {visible.length === 0 && <li className="combobox-empty">No matches.</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}
