// The published plot window the export dialog's "Plot window" preset
// reads. A read of panel state, not a second owner of it — so the only
// things worth pinning are that a published window comes back, that
// nonsense never does, and that it can be forgotten.

import { beforeEach, describe, expect, it } from "vitest";

import { clearPlotWindow, plotWindow, publishPlotWindow } from "./plotWindow";

beforeEach(() => clearPlotWindow());

describe("plotWindow", () => {
  it("reports nothing until a plot publishes one", () => {
    expect(plotWindow()).toBeNull();
  });

  it("reports the last window published", () => {
    publishPlotWindow(10, 20);
    publishPlotWindow(30, 45);
    expect(plotWindow()).toEqual({ from: 30, to: 45 });
  });

  it("ignores a window that is not one", () => {
    // uPlot hands back NaN bounds before a scale is initialised, and an
    // empty window would make the preset select nothing at all.
    publishPlotWindow(10, 20);
    publishPlotWindow(Number.NaN, 5);
    publishPlotWindow(5, 5);
    publishPlotWindow(9, 4);
    expect(plotWindow()).toEqual({ from: 10, to: 20 });
  });

  it("can be forgotten", () => {
    publishPlotWindow(10, 20);
    clearPlotWindow();
    expect(plotWindow()).toBeNull();
  });
});
