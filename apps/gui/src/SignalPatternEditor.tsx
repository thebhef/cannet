/// Shared regex-pattern list editor (ADR 0038): edits the `patterns`
/// half of a signal selection (`signalSelection.ts`). Each row is an
/// editable pattern with its live match count against the catalog (or
/// "bad regex") and a remove button; the input row appends. The plot
/// panel's per-area filter popover and the signal view's selection
/// editor both render this, so pattern behaviour can't drift between
/// surfaces.
///
/// An existing pattern edits in place through `ValidatedInput`
/// (ADR 0027): draft while typing, apply on blur or Enter, abandon on
/// Escape. Applying per keystroke would re-resolve the selection — and
/// on the signal view re-query the host — for every half-typed regex,
/// which matches a wildly different signal set on the way to the one
/// the user means.

import { useState } from "react";

import type { SignalDescriptorRecord } from "./types";
import { resolvePatterns } from "./signalSelection";
import { ValidatedInput } from "./ValidatedInput";

/// Per-pattern selection + drag wiring (ADR 0045). A pattern chip is a
/// selectable item in the same set as the consuming panel's rows, and
/// drags the pattern *live* — so a mixed selection of rows and chips is
/// one gesture. The row holds a text input, so the drag lives on a
/// dedicated grip rather than on the row (ADR 0045).
export interface PatternGrip {
  selected: (pattern: string) => boolean;
  onSelect: (pattern: string, modifiers: { mod: boolean; shift: boolean }) => void;
  onDragStart: (pattern: string, e: React.DragEvent) => void;
}

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
  /// Makes each pattern a draggable, selectable chip. Omitted ⇒ the
  /// rows are plain editors, which is what the plot panel's per-area
  /// filter popover wants.
  grip?: PatternGrip;
}

export function SignalPatternEditor({
  patterns,
  catalog,
  busNames,
  onChange,
  onMaterialize,
  placeholder,
  grip,
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
          {grip ? (
            <span
              className={`pattern-editor-slash pattern-editor-grip${
                grip.selected(res.pattern) ? " selected" : ""
              }`}
              aria-label={`pattern ${i + 1} grip`}
              title="drag this pattern where it should apply; click to select it with the rows"
              draggable
              onClick={(e) =>
                grip.onSelect(res.pattern, { mod: e.ctrlKey || e.metaKey, shift: e.shiftKey })
              }
              onDragStart={(e) => grip.onDragStart(res.pattern, e)}
            >
              /
            </span>
          ) : (
            <span className="pattern-editor-slash" aria-hidden="true">
              /
            </span>
          )}
          <ValidatedInput
            className="pattern-editor-regex"
            value={res.pattern}
            ariaLabel={`pattern ${i + 1}`}
            title="edit this pattern — Enter or clicking away applies it, Escape abandons the edit"
            // Reject blank (the × removes a pattern) and a duplicate of
            // another row; a rejected edit reverts to the committed text.
            // An *invalid* regex commits: the row says "bad regex", which
            // is the feedback the user needs while writing one.
            parse={(text) => {
              const p = text.trim();
              if (!p) return null;
              return patterns.some((q, j) => j !== i && q === p) ? null : p;
            }}
            onCommit={(p) => onChange(patterns.map((q, j) => (j === i ? p : q)))}
          />
          <span className="pattern-editor-slash" aria-hidden="true">
            /
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
