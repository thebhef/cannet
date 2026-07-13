import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { COMMANDS, addBinding, type BindingSpec, type CommandSpec } from "./commands";
import { chordFromEvent, formatChord, isMacPlatform, parseChord } from "./keybindings";
import { useKeybindings } from "./keybindingsContext";

/**
 * Keyboard-shortcuts editor (ADR 0018): lists every command with its
 * current binding(s) and lets the user add, remove, or reset them. It reads
 * and mutates the app-owned keybinding state through `useKeybindings`; App
 * sanitises, re-resolves, and persists to `settings.json`. A singleton
 * dockview panel, opened from the command palette.
 *
 * Conflicts are refused, not resolved: a new chord that would collide with
 * an existing binding in an overlapping context is rejected with the
 * colliding binding named (`addBinding`). A chord reused in a *disjoint*
 * context (e.g. a plot-only vs a trace-only command) is accepted — the same
 * per-context freedom the dispatcher already relies on.
 */
export function ShortcutsPanel(_props: IDockviewPanelProps) {
  const { effective, setUser } = useKeybindings();
  const isMac = useMemo(() => isMacPlatform(), []);

  // Which command is currently capturing a chord (null = none), and the
  // last rejected-edit message.
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bindings grouped by command id, for the per-row chip list.
  const byCommand = useMemo(() => {
    const map = new Map<string, BindingSpec[]>();
    for (const b of effective) {
      const list = map.get(b.commandId) ?? [];
      list.push(b);
      map.set(b.commandId, list);
    }
    return map;
  }, [effective]);

  // Commands grouped by category in first-seen order.
  const groups = useMemo(() => {
    const out: { category: string; commands: CommandSpec[] }[] = [];
    for (const c of COMMANDS) {
      const category = c.category ?? "Other";
      let group = out.find((g) => g.category === category);
      if (!group) {
        group = { category, commands: [] };
        out.push(group);
      }
      group.commands.push(c);
    }
    return out;
  }, []);

  // While recording, intercept the next keystroke before the global
  // dispatcher sees it. The dispatcher listens on `document` (capture); a
  // `window`-capture listener runs first, so the chord being bound never
  // fires its own command. Escape cancels; a bare modifier keeps waiting.
  useEffect(() => {
    if (recording == null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(
        { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey },
        isMac,
      );
      if (chord == null) return;
      const result = addBinding(effective, { chord, commandId: recording }, COMMANDS);
      setRecording(null);
      if (!result.ok) {
        setError(`Can't bind ${chord}: ${result.conflict}`);
        return;
      }
      setError(null);
      setUser(result.bindings);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, isMac, effective, setUser]);

  const removeBinding = (target: BindingSpec) => {
    setError(null);
    setUser(effective.filter((b) => b !== target));
  };

  const display = (chord: string) => {
    try {
      return formatChord(parseChord(chord), isMac);
    } catch {
      return chord;
    }
  };

  return (
    <div className="settings-panel shortcuts-panel">
      <div className="shortcuts-header">
        <p className="settings-hint">
          Click <em>Set shortcut</em> and press a key combination. Reused
          chords are allowed only where they can't both fire at once;
          conflicts are refused. Esc cancels a capture.
        </p>
        <button className="shortcuts-reset" onClick={() => { setError(null); setUser(null); }}>
          Reset to defaults
        </button>
      </div>
      {error && (
        <p className="shortcuts-error" role="alert">
          {error}
        </p>
      )}
      {groups.map((group) => (
        <fieldset key={group.category} className="settings-group">
          <legend>{group.category}</legend>
          {group.commands.map((c) => {
            const bindings = byCommand.get(c.id) ?? [];
            return (
              <div key={c.id} className="shortcut-row">
                <span className="shortcut-label">{c.label}</span>
                <span className="shortcut-chords">
                  {bindings.map((b, i) => (
                    <span key={`${b.chord}-${i}`} className="shortcut-chip">
                      <kbd>{display(b.chord)}</kbd>
                      <button
                        className="shortcut-remove"
                        aria-label={`Remove ${display(b.chord)} from ${c.label}`}
                        onClick={() => removeBinding(b)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {recording === c.id ? (
                    <span className="shortcut-recording">Press keys… (Esc to cancel)</span>
                  ) : (
                    <button
                      className="shortcut-record"
                      onClick={() => {
                        setError(null);
                        setRecording(c.id);
                      }}
                    >
                      Set shortcut
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
