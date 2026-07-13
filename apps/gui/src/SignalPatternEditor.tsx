/// Shared regex-pattern list editor (ADR 0038): edits the `patterns`
/// half of a signal selection (`signalSelection.ts`). Each row shows
/// the pattern, its live match count against the catalog (or "bad
/// regex"), and a remove button; the input row appends. The plot
/// panel's per-area filter popover and the signal view's selection
/// editor both render this, so pattern behaviour can't drift between
/// surfaces.

import { useState } from "react";

import type { SignalDescriptorRecord } from "./types";
import { resolvePatterns } from "./signalSelection";

interface SignalPatternEditorProps {
  patterns: readonly string[];
  catalog: readonly SignalDescriptorRecord[];
  busNames: ReadonlyMap<string, string>;
  onChange: (patterns: string[]) => void;
  /// Convert regex → manual (one-way): the caller materializes the
  /// current matches into its manual list and clears the patterns.
  /// Omitted ⇒ no convert affordance.
  onMaterialize?: () => void;
  /// Placeholder for the add-pattern input; defaults to a canonical
  /// path example.
  placeholder?: string;
}

export function SignalPatternEditor({
  patterns,
  catalog,
  busNames,
  onChange,
  onMaterialize,
  placeholder,
}: SignalPatternEditorProps) {
  const [draft, setDraft] = useState("");
  const resolutions = resolvePatterns(patterns, catalog, busNames);
  const add = () => {
    const p = draft.trim();
    if (!p || patterns.includes(p)) return;
    onChange([...patterns, p]);
    setDraft("");
  };
  return (
    <div className="pattern-editor">
      {resolutions.map((res, i) => (
        <div className="pattern-editor-row" key={`${res.pattern}-${i}`}>
          <span className="pattern-editor-regex" title={res.pattern}>
            /{res.pattern}/
          </span>
          {res.valid ? (
            <span className="pattern-editor-count">
              {res.matches.length} signal{res.matches.length === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="pattern-editor-error">bad regex</span>
          )}
          <button
            className="pattern-editor-remove"
            title="remove this pattern"
            onClick={() => onChange(patterns.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="pattern-editor-add">
        <input
          type="text"
          value={draft}
          placeholder={placeholder ?? "^bus/ecu/message/signal (regex, Enter to add)"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="pattern-editor-append" onClick={add} disabled={!draft.trim()}>
          add
        </button>
        {onMaterialize && patterns.length > 0 && (
          <button
            className="pattern-editor-materialize"
            title="convert to manual: keep the currently matched signals as explicit picks and clear the patterns (one-way)"
            onClick={onMaterialize}
          >
            ⇨ manual
          </button>
        )}
      </div>
    </div>
  );
}
