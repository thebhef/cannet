// The dock tab component (ADR 0005): dockview's React default tab,
// plus the in-place rename the `panel.rename` command drives (ADR
// 0037 — the command stays the single entry point; this is only where
// the editing happens). A tab renders as an input while its panel is
// the rename target, so the user renames where they already are
// instead of being sent to another view.
//
// The name itself is model-owned (ADR 0019): the edit writes through
// the element registry — the same `update(id, { name })` mutation the
// project panel's inline rename performs — and the tab title follows
// from `App`'s title-lockstep effect. Only element-backed panels have
// such a name; a singleton (project, settings, …) carries a fixed
// title and always renders the plain default tab.

import { createContext, useContext, useEffect, useState } from "react";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview";

import { elementLabel } from "./elementLabel";
import { useElementRegistry } from "./projectElements";

/// Which dockview panel's tab is currently being renamed, and how to
/// leave that mode. `null` means no tab is in edit mode. Owned by the
/// command subsystem (`useCommands`), which sets the target when
/// `panel.rename` runs.
export interface RenameTabController {
  target: string | null;
  end: () => void;
}

export const RenameTabContext = createContext<RenameTabController | null>(null);

/// The element id a dockview panel shows, or `null` for a singleton
/// panel (whose title isn't a model-owned name).
export function tabElementId(params: unknown): string | null {
  const id = (params as { elementId?: unknown } | undefined)?.elementId;
  return typeof id === "string" ? id : null;
}

export function RenamableTab(props: IDockviewPanelHeaderProps) {
  const rename = useContext(RenameTabContext);
  const registry = useElementRegistry();
  const elementId = tabElementId(props.params);
  const element = elementId != null ? registry.get(elementId)?.element : undefined;
  const label = element ? elementLabel(element) : "";
  const editing = element != null && rename != null && rename.target === props.api.id;

  const [draft, setDraft] = useState(label);
  // Re-seed when the tab is reused for another element, or the name
  // changes under us (a commit, or a rename from the project panel).
  useEffect(() => {
    setDraft(label);
  }, [elementId, label]);

  if (!editing) return <DockviewDefaultTab {...props} />;

  const commit = () => {
    const next = draft.trim();
    // An empty box reverts rather than clearing the name — every
    // element has one (`assignDefaultNames`), and a nameless tab would
    // fall back to a generated label.
    if (elementId != null && next && next !== label) registry.update(elementId, { name: next });
    rename.end();
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
            rename.end();
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
