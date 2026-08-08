import { useCallback, useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";
import { invoke } from "@tauri-apps/api/core";

import { useElementRegistry } from "./projectElements";
import type { GeneratorRule, ProjectElement } from "./types";

type GeneratorElement = Extract<ProjectElement, { kind: "generator" }>;

/// Joins the rule patterns into the validation effect's dependency. A
/// newline can't occur in a single-line pattern field, so the joined
/// string changes exactly when the set of patterns does.
const PATTERN_SEP = "\n";

/**
 * Editor for a `generator` element (ADR 0026): an ordered list of
 * regex rules over signal *names* whose first capture group, read as an
 * integer, is the signal's color-wheel slot. `Cell(\d+)` gives
 * `Cell1…Cell16` sixteen aligned slots wherever they appear.
 *
 * Order is the evaluation order — the first rule that both matches and
 * yields a usable capture wins — so rows reorder rather than sort, and
 * a rule can be parked with its toggle instead of deleted.
 *
 * Patterns are user input: they are compiled and matched **by the
 * host**, never here. The inline error under a row is the host's own
 * compile message, fetched as the rule is entered.
 */
export function GeneratorPanel(props: IDockviewPanelProps) {
  const registry = useElementRegistry();
  const { ensure, update } = registry;

  const params = props.params as { elementId?: unknown } | undefined;
  const [elementId] = useState(() =>
    typeof params?.elementId === "string" ? params.elementId : crypto.randomUUID(),
  );
  useEffect(() => {
    ensure(elementId, "generator");
  }, [ensure, elementId]);

  const entry = registry.get(elementId)?.element;
  const element: GeneratorElement | null = entry && entry.kind === "generator" ? entry : null;
  const rules = useMemo(() => element?.rules ?? [], [element]);

  const setRules = useCallback(
    (next: GeneratorRule[]) => update(elementId, { rules: next }),
    [update, elementId],
  );

  // Entry-time validation, keyed by pattern rather than row index so
  // reordering or deleting a rule can't mis-attach an error. A blank
  // pattern is unfinished, not wrong, so it is never sent.
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const patternKey = rules.map((r) => r.pattern).join(PATTERN_SEP);
  useEffect(() => {
    const patterns = [...new Set(patternKey.split(PATTERN_SEP).filter((p) => p !== ""))];
    let live = true;
    void Promise.all(
      patterns.map(async (pattern): Promise<[string, string] | null> => {
        try {
          await invoke("validate_signal_generator", { pattern });
          return null;
        } catch (e) {
          return [pattern, typeof e === "string" ? e : String(e)];
        }
      }),
    ).then((pairs) => {
      if (live) setErrors(new Map(pairs.filter((p): p is [string, string] => p !== null)));
    });
    return () => {
      live = false;
    };
  }, [patternKey]);

  if (!element) return <div className="generator-panel">loading…</div>;

  const patchRule = (i: number, patch: Partial<GeneratorRule>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const swap = (i: number, j: number) => {
    const next = rules.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setRules(next);
  };

  return (
    <div className="generator-panel">
      <p className="generator-help">
        Each rule matches part of a signal&apos;s name; its first capture group, read as a
        number, picks the color-wheel slot. <code>Cell(\d+)</code> gives Cell1…Cell16
        sixteen matched colors wherever they appear. Rules are tried top to bottom.
      </p>

      {rules.length === 0 ? (
        <div className="generator-empty">No rules yet — add one to color a signal family.</div>
      ) : (
        <ul className="generator-rules">
          {rules.map((r, i) => {
            const error = r.pattern === "" ? undefined : errors.get(r.pattern);
            return (
              <li key={i} className="generator-rule">
                <div className="generator-rule-row">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label={`rule ${i + 1} enabled`}
                    onChange={(e) => patchRule(i, { enabled: e.target.checked })}
                  />
                  <input
                    type="text"
                    className="generator-pattern"
                    spellCheck={false}
                    value={r.pattern}
                    placeholder="Cell(\d+)"
                    aria-label={`rule ${i + 1} pattern`}
                    aria-invalid={error != null}
                    onChange={(e) => patchRule(i, { pattern: e.target.value })}
                  />
                  <button
                    type="button"
                    aria-label={`move rule ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => swap(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`move rule ${i + 1} down`}
                    disabled={i === rules.length - 1}
                    onClick={() => swap(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="generator-remove"
                    aria-label={`remove rule ${i + 1}`}
                    onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                {error != null && <div className="generator-error">{error}</div>}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        className="generator-add"
        onClick={() => setRules([...rules, { pattern: "", enabled: true }])}
      >
        + rule
      </button>
    </div>
  );
}
