// The go-to-view catalogue (ADR 0018 / 0037): which views the Ctrl+P
// palette can reach. Pure list-building, split out so it is unit-testable
// without dockview — App attaches the open/focus thunks and appends the
// singleton views. The key property: a view is listed whether or not its
// panel is currently open, so a closed element view (e.g. a colour map) is
// still reachable.

import { elementPanelComponent } from "./dockLayout";
import { elementKindLabel, elementLabel } from "./elementLabel";
import type { ProjectElement } from "./types";

/// One go-to-view row: the dockview panel id it opens/focuses, and the
/// model-owned label to show (ADR 0019).
export interface ViewEntry {
  id: string;
  label: string;
}

/// The element views for go-to-view: every project element that has a panel
/// of its own, by its `${component}-${id}` dockview id and a `"Kind: name"`
/// label (the model-owned `elementLabel` prefixed with its kind, so the type
/// is visible and — since the palette filters on the same `label` string —
/// searchable). A `filter` has no panel (it is edited on the graph) and is
/// omitted.
export function elementViewEntries(elements: readonly ProjectElement[]): ViewEntry[] {
  const out: ViewEntry[] = [];
  for (const el of elements) {
    const component = elementPanelComponent(el.kind);
    if (component === null) continue;
    out.push({
      id: `${component}-${el.id}`,
      label: `${elementKindLabel(el.kind)}: ${elementLabel(el)}`,
    });
  }
  return out;
}
