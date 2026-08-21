import { describe, expect, it } from "vitest";

import type { SerializedDockview } from "dockview";

import {
  DBC_PANEL_ID,
  PROJECT_GRAPH_PANEL_ID,
  PROJECT_PANEL_ID,
  RBS_SIGNALS_PANEL_COMPONENT,
  SYSTEM_MESSAGES_PANEL_ID,
  elementPanelComponent,
  elementPanelTitle,
  panelKindForFocus,
  panelsForElementId,
  showRbsSignalsPanel,
  stripMaximizedNode,
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

describe("stripMaximizedNode", () => {
  const base = {
    grid: { root: {}, width: 800, height: 600, orientation: "HORIZONTAL" },
    panels: { p1: { id: "p1" } },
    activeGroup: "g1",
  } as unknown as SerializedDockview;

  it("drops grid.maximizedNode, leaving the rest untouched", () => {
    const maximized = {
      ...base,
      grid: { ...base.grid, maximizedNode: { location: [0] } },
    } as SerializedDockview;
    expect(stripMaximizedNode(maximized)).toEqual(base);
  });

  it("returns a layout without one unchanged", () => {
    expect(stripMaximizedNode(base)).toBe(base);
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

  it("an RBS signals panel reports its own kind, not the RBS element's — even though its params name the same elementId", () => {
    expect(panelKindForFocus("rbs-signals-el1", "rbs")).toBe("rbs-signals");
  });
});

describe("panelsForElementId", () => {
  it("returns every panel naming the id — the bug fix: an RBS element can have two", () => {
    const panels = [
      { id: "rbs-el1", params: { elementId: "el1" } },
      { id: "rbs-signals-el1", params: { elementId: "el1" } },
      { id: "plot-el2", params: { elementId: "el2" } },
    ];
    expect(panelsForElementId(panels, "el1").map((p) => p.id)).toEqual([
      "rbs-el1",
      "rbs-signals-el1",
    ]);
  });

  it("returns an empty array when nothing matches, including a malformed params shape", () => {
    expect(panelsForElementId([{ id: "a", params: {} }], "el1")).toEqual([]);
    expect(panelsForElementId([{ id: "a", params: undefined }], "el1")).toEqual([]);
    expect(panelsForElementId([], "el1")).toEqual([]);
  });
});

describe("elementPanelTitle", () => {
  it("names an RBS signals panel with the config's own name plus a suffix, never the bare label", () => {
    expect(elementPanelTitle("rbs-signals-el1", "drive-cycle")).toBe("drive-cycle — Signals");
  });

  it("leaves every other element-backed panel's title as the bare model-owned name", () => {
    expect(elementPanelTitle("rbs-el1", "drive-cycle")).toBe("drive-cycle");
    expect(elementPanelTitle("plot-abc", "My plot")).toBe("My plot");
  });
});

describe("showRbsSignalsPanel", () => {
  function fakeApi(existing: { id: string }[] = []) {
    const added: unknown[] = [];
    return {
      panels: existing.map((p) => ({ ...p, api: { setActive: () => {} } })),
      addPanel: (opts: unknown) => added.push(opts),
      added,
    };
  }

  it("adds a new panel keyed by element id, titled with the config name and a Signals suffix", () => {
    const api = fakeApi();
    showRbsSignalsPanel(api as never, "el1", "drive-cycle");
    expect(api.added).toEqual([
      {
        id: "rbs-signals-el1",
        component: RBS_SIGNALS_PANEL_COMPONENT,
        title: "drive-cycle — Signals",
        params: { elementId: "el1" },
      },
    ]);
  });

  it("focuses the existing instance instead of adding a second one", () => {
    let activated = false;
    const api = {
      panels: [{ id: "rbs-signals-el1", api: { setActive: () => (activated = true) } }],
      addPanel: () => {
        throw new Error("must not add a second panel");
      },
    };
    showRbsSignalsPanel(api as never, "el1", "drive-cycle");
    expect(activated).toBe(true);
  });
});
