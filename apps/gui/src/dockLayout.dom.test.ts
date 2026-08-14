// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DockviewComponent } from "dockview";

import {
  DBC_PANEL_ID,
  isTabMiddlePress,
  normalizeSingletonTitles,
  validateLayout,
} from "./dockLayout";

describe("isTabMiddlePress", () => {
  const tab = document.createElement("div");
  tab.className = "dv-tab";
  const inner = document.createElement("span");
  tab.appendChild(inner);
  document.body.appendChild(tab);
  const outside = document.createElement("div");
  document.body.appendChild(outside);

  it("matches a middle press on a tab or anything inside it", () => {
    expect(isTabMiddlePress(1, tab)).toBe(true);
    expect(isTabMiddlePress(1, inner)).toBe(true);
  });

  it("ignores other buttons and non-tab targets", () => {
    expect(isTabMiddlePress(0, tab)).toBe(false);
    expect(isTabMiddlePress(2, tab)).toBe(false);
    expect(isTabMiddlePress(1, outside)).toBe(false);
    expect(isTabMiddlePress(1, null)).toBe(false);
  });
});

// --- singleton tab titles against REAL dockview serialization ---

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

function createDock(): DockviewComponent {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => {
      const element = document.createElement("div");
      return { element, init: () => {} };
    },
  });
  dock.layout(100, 100);
  return dock;
}

/// A saved layout holding the Database panel under `title` — the shape
/// dockview serializes for a 100×100 container (`fromJSON` rejects a
/// grid whose sizes don't add up).
function savedDbcLayout(title: string): unknown {
  return {
    grid: {
      root: {
        type: "branch",
        data: [
          { type: "leaf", data: { views: [DBC_PANEL_ID], activeView: DBC_PANEL_ID, id: "1" }, size: 100 },
        ],
        size: 100,
      },
      width: 100,
      height: 100,
      orientation: "HORIZONTAL",
    },
    panels: {
      [DBC_PANEL_ID]: {
        id: DBC_PANEL_ID,
        contentComponent: "dbc",
        tabComponent: "props.defaultTabComponent",
        title,
      },
    },
    activeGroup: "1",
  };
}

describe("singleton tab titles on restore", () => {
  it("takes a restored panel's title from the saved layout", () => {
    // The mechanism: dockview's `fromJSON` titles each panel from the
    // blob, so a workspace saved under an older name keeps showing it —
    // there is no other carrier to blame.
    const dock = createDock();
    dock.fromJSON(validateLayout(savedDbcLayout("DBC"))!);
    expect(dock.getGroupPanel(DBC_PANEL_ID)?.title).toBe("DBC");
  });

  it("heals a stale singleton title to the code-defined one", () => {
    const dock = createDock();
    dock.fromJSON(normalizeSingletonTitles(validateLayout(savedDbcLayout("DBC"))!));
    expect(dock.getGroupPanel(DBC_PANEL_ID)?.title).toBe("Database");
  });

  it("leaves element-backed panel titles alone", () => {
    // Those are model-owned names (ADR 0019), not code-defined ones.
    const layout = validateLayout(savedDbcLayout("DBC"))! as unknown as {
      panels: Record<string, { id: string; title?: string }>;
    };
    const renamed = {
      ...layout,
      panels: { "plot-abc": { id: "plot-abc", title: "Cell voltages" } },
    };
    expect(
      (normalizeSingletonTitles(renamed as never) as unknown as typeof renamed).panels[
        "plot-abc"
      ].title,
    ).toBe("Cell voltages");
  });
});
