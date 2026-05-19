// @vitest-environment jsdom
//
// SourcesContextMenu covers the consumer's bus-selection UX. The
// normalisation rules — "checking every bus collapses to ['*']",
// "unchecking under the wildcard expands to the explicit complement"
// — are what we exercise here.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SourcesContextMenu } from "./SourcesPicker";
import type { Bus } from "./types";

afterEach(cleanup);

const buses: Bus[] = [
  { id: "p", name: "Powertrain" },
  { id: "c", name: "Chassis" },
];
const POS = { x: 0, y: 0 };

describe("SourcesContextMenu", () => {
  it("unchecking a bus under the wildcard expands to the explicit complement", () => {
    const onChange = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["*"]}
        buses={buses}
        filters={[]}
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Powertrain"));
    expect(onChange.mock.calls[0][0]).toEqual(["c"]);
  });

  it("re-checking the last missing bus normalises back to ['*']", () => {
    const onChange = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["c"]}
        buses={buses}
        filters={[]}
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Powertrain"));
    expect(onChange.mock.calls[0][0]).toEqual(["*"]);
  });

  it("the 'All logical buses' toggle collapses any explicit list to ['*']", () => {
    const onChange = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["c"]}
        buses={buses}
        filters={[]}
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("All logical buses"));
    expect(onChange.mock.calls[0][0]).toEqual(["*"]);
  });

  it("toggling a filter preserves the bus selection and the wildcard state", () => {
    const onChange = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["*"]}
        buses={buses}
        filters={[{ id: "f1", label: "Powertrain id range" }]}
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Powertrain id range"));
    expect(onChange.mock.calls[0][0]).toEqual(["*", "f1"]);
  });

  it("unchecking 'All logical buses' with no explicit buses leaves an empty bus side", () => {
    const onChange = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["*", "f1"]}
        buses={buses}
        filters={[{ id: "f1", label: "F1" }]}
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("All logical buses"));
    expect(onChange.mock.calls[0][0]).toEqual(["f1"]);
  });

  it("renders an 'Insert filter upstream' action when onInsertFilter is provided", () => {
    const onInsertFilter = vi.fn();
    const onClose = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["*"]}
        buses={buses}
        filters={[]}
        onChange={() => {}}
        onInsertFilter={onInsertFilter}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Insert filter upstream/i }));
    expect(onInsertFilter).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("escape key closes the menu", () => {
    const onClose = vi.fn();
    render(
      <SourcesContextMenu
        position={POS}
        value={["*"]}
        buses={buses}
        filters={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
