import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { COMMANDS, addBinding, type BindingSpec, type CommandSpec } from "./commands";
import {
  chordFromEvent,
  chordSuppressedInGridview,
  formatChord,
  isMacPlatform,
  parseChord,
} from "./keybindings";
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
 *
 * A binding is not one global fact, so the view states each one's context
 * (ADR 0044). The editable list is the global one; a chip whose key a
 * gridview consumes is marked, because the dispatcher will hold it back
 * while focus is inside a grid. The two reference sections below the
 * editor say what those grid keys do, and which panels define the
 * per-panel Space action — neither is rebindable, so neither is an editor.
 */
export function ShortcutsPanel(_props: IDockviewPanelProps) {
  const { user, effective, setUser } = useKeybindings();
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
    // The stored list is a snapshot, so a removal has to be *recorded*
    // rather than merely absent — absence now means "this default was
    // shipped after the snapshot" (`resolveBindings`). Earlier
    // tombstones ride along, since `effective` never contains them.
    const tombstones = (user ?? []).filter(
      (b) => b.disabled && !(b.chord === target.chord && b.commandId === target.commandId),
    );
    setUser([
      ...effective.filter((b) => b !== target),
      ...tombstones,
      { chord: target.chord, commandId: target.commandId, disabled: true },
    ]);
  };

  const display = (chord: string) => {
    try {
      return formatChord(parseChord(chord), isMac);
    } catch {
      return chord;
    }
  };

  /// Does a gridview eat this chord before the dispatcher sees it? A
  /// chord that won't parse can't fire at all, so it isn't marked.
  const gridTakes = (chord: string) => {
    try {
      return chordSuppressedInGridview(parseChord(chord));
    } catch {
      return false;
    }
  };

  // ADR 0044's key table, as the user reads it. Only select-all needs
  // platform formatting; the rest are the same keys everywhere.
  const gridviewKeys = [
    { keys: "↑ / ↓", what: "Move the cursor; the selection follows it" },
    {
      keys: "← / →",
      what: "Collapse or expand, or step out to the parent and in to the first child",
    },
    { keys: "Home / End", what: "Jump to the first or last row" },
    { keys: "PageUp / PageDown", what: "Move the cursor one viewport" },
    { keys: display("Mod+A"), what: "Select every selectable row the view holds" },
    { keys: "Tab / Shift+Tab", what: "Move into the cursor row's own controls, first or last" },
    { keys: "Space", what: "Run the panel's primary action, where it defines one" },
    { keys: "Enter", what: "Unbound — free to bind to a command above" },
  ];

  // Panels that define a Space action (ADR 0044). Hand-kept: the action
  // is an argument each panel passes to its own gridview, so there is
  // nothing central to read it off. A panel that gains one belongs here.
  const panelActions = [{ keys: "Space", what: "Transmit — send the cursor's frame once" }];

  return (
    <div className="settings-panel shortcuts-panel">
      <div className="shortcuts-header">
        <p className="settings-hint">
          Click <em>Set shortcut</em> and press a key combination. Reused
          chords are allowed only where they can't both fire at once;
          conflicts are refused. Esc cancels a capture. These shortcuts are
          global — they fire wherever focus is, unless the chip says
          otherwise.
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
                  {bindings.map((b, i) => {
                    const taken = gridTakes(b.chord);
                    return (
                      <span
                        key={`${b.chord}-${i}`}
                        className="shortcut-chip"
                        title={
                          taken
                            ? "Global, except inside a grid view — grids own this key, so the shortcut goes quiet while one has focus."
                            : "Global — fires wherever focus is."
                        }
                      >
                        <kbd>{display(b.chord)}</kbd>
                        {taken && <span className="shortcut-scope">not in grids</span>}
                        <button
                          className="shortcut-remove"
                          aria-label={`Remove ${display(b.chord)} from ${c.label}`}
                          onClick={() => removeBinding(b)}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
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
      <fieldset className="settings-group">
        <legend>In a grid view</legend>
        <p className="settings-hint">
          The trace, the signal view, the DBC and RBS trees and the transmit
          list navigate with these keys, and take them while focus is inside
          one — which is why a shortcut above bound to the same key doesn't
          fire there. They aren't rebindable.
        </p>
        {gridviewKeys.map((k) => (
          <div key={k.what} className="shortcut-row">
            <span className="shortcut-label">{k.what}</span>
            <span className="shortcut-chords">
              <span className="shortcut-chip">
                <kbd>{k.keys}</kbd>
              </span>
            </span>
          </div>
        ))}
      </fieldset>
      <fieldset className="settings-group">
        <legend>Panel actions</legend>
        <p className="settings-hint">
          Space runs the focused grid's primary action, which each panel
          defines for itself. Panels not listed here define none.
        </p>
        {panelActions.map((a) => (
          <div key={a.what} className="shortcut-row">
            <span className="shortcut-label">{a.what}</span>
            <span className="shortcut-chords">
              <span className="shortcut-chip">
                <kbd>{a.keys}</kbd>
              </span>
            </span>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
