// The dock tab component (ADR 0005): dockview's React default tab,
// plus a direct-manipulation rename — double-click a tab and its title
// becomes an input. This is the affordance, not the action model: the
// `panel.rename` command collects the name in the palette instead
// (ADR 0037), so nothing here is a second command path.
//
// The name itself is model-owned (ADR 0019): the edit writes through
// the element registry — the same `update(id, { name })` mutation the
// project panel's inline rename and the command both perform — and the
// tab title follows from `App`'s title-lockstep effect. Only
// element-backed panels have such a name; a singleton (project,
// settings, …) carries a fixed title and always renders the plain
// default tab.

import { useEffect, useState } from "react";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview";

import { elementLabel } from "./elementLabel";
import { useElementRegistry } from "./projectElements";

/// The element id a dockview panel shows, or `null` for a singleton
/// panel (whose title isn't a model-owned name).
export function tabElementId(params: unknown): string | null {
  const id = (params as { elementId?: unknown } | undefined)?.elementId;
  return typeof id === "string" ? id : null;
}

export function RenamableTab(props: IDockviewPanelHeaderProps) {
  const registry = useElementRegistry();
  const elementId = tabElementId(props.params);
  const element = elementId != null ? registry.get(elementId)?.element : undefined;
  const label = element ? elementLabel(element) : "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  // Re-seed when the tab is reused for another element, or the name
  // changes under us (a commit, or a rename from the project panel or
  // the palette).
  useEffect(() => {
    setEditing(false);
    setDraft(label);
  }, [elementId, label]);

  if (!editing || element == null) {
    return (
      <DockviewDefaultTab
        {...props}
        onDoubleClick={element == null ? undefined : () => setEditing(true)}
      />
    );
  }

  const commit = () => {
    const next = draft.trim();
    // An empty box reverts rather than clearing the name — every
    // element has one (`assignDefaultNames`), and a nameless tab would
    // fall back to a generated label.
    if (elementId != null && next && next !== label) registry.update(elementId, { name: next });
    setEditing(false);
  };

  return (
    <div className="dv-default-tab dock-tab-rename">
      <input
        type="text"
        className="dock-tab-rename-input"
        autoFocus
        aria-label="panel name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(label);
            setEditing(false);
          }
        }}
        onBlur={commit}
        // The tab is a drag handle and a click target — neither should
        // fire while the user is working inside the input.
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
