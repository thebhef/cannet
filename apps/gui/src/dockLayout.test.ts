import { describe, expect, it } from "vitest";

import {
  DBC_PANEL_ID,
  PROJECT_GRAPH_PANEL_ID,
  PROJECT_PANEL_ID,
  SYSTEM_MESSAGES_PANEL_ID,
  elementPanelComponent,
  panelKindForFocus,
  validateLayout,
} from "./dockLayout";

describe("validateLayout", () => {
  it("returns null for missing input", () => {
    expect(validateLayout(null)).toBeNull();
    expect(validateLayout(undefined)).toBeNull();
  });

  it("returns null for a value that isn't a layout object", () => {
    expect(validateLayout(42)).toBeNull();
    expect(validateLayout("a string")).toBeNull();
    expect(validateLayout([1, 2, 3])).toBeNull();
    expect(validateLayout({ grid: {} })).toBeNull();
    expect(validateLayout({ panels: {} })).toBeNull();
  });

  it("returns the value when it has the dockview layout shape", () => {
    const layout = { grid: { root: {}, width: 800, height: 600 }, panels: {} };
    expect(validateLayout(layout)).toEqual(layout);
  });
});

describe("elementPanelComponent", () => {
  it("maps trace / plot / transmit to their own panel components", () => {
    expect(elementPanelComponent("trace")).toBe("trace");
    expect(elementPanelComponent("plot")).toBe("plot");
    expect(elementPanelComponent("transmit")).toBe("transmit");
  });

  it("returns null for a filter — it has no panel of its own", () => {
    // Regression guard: a filter must never resolve to a trace/plot
    // panel. Opening a filter in a trace panel let that panel's
    // `ensure(id, "trace")` retype — and destroy — the filter element.
    expect(elementPanelComponent("filter")).toBeNull();
  });
});

describe("panelKindForFocus", () => {
  it("an element-backed panel reports its element kind", () => {
    expect(panelKindForFocus("trace-abc", "trace")).toBe("trace");
    expect(panelKindForFocus("plot-abc", "plot")).toBe("plot");
    expect(panelKindForFocus("transmit-abc", "transmit")).toBe("transmit");
  });

  it("singleton panels report their fixed id", () => {
    expect(panelKindForFocus(PROJECT_PANEL_ID, null)).toBe("project");
    expect(panelKindForFocus(SYSTEM_MESSAGES_PANEL_ID, null)).toBe("system-messages");
    expect(panelKindForFocus(PROJECT_GRAPH_PANEL_ID, null)).toBe("project-graph");
    expect(panelKindForFocus(DBC_PANEL_ID, null)).toBe("dbc");
  });

  it("anything else (including a filter) is null", () => {
    expect(panelKindForFocus("mystery", null)).toBeNull();
    expect(panelKindForFocus("trace-abc", "filter")).toBeNull();
  });
});
