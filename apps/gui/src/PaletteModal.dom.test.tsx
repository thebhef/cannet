// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PaletteModal, type PaletteItem } from "./PaletteModal";

const ITEMS: PaletteItem[] = [
  { id: "project.open", label: "Open project…", hint: "Project" },
  { id: "blf.open", label: "Open BLF…", hint: "File" },
  { id: "connection.connect", label: "Connect", hint: "Connection" },
];

afterEach(cleanup);

function renderPalette(over: Partial<Parameters<typeof PaletteModal>[0]> = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <PaletteModal
      placeholder="Run a command…"
      items={ITEMS}
      onPick={onPick}
      onClose={onClose}
      {...over}
    />,
  );
  return { onPick, onClose, input: screen.getByPlaceholderText("Run a command…") };
}

describe("PaletteModal", () => {
  it("lists every item when the query is empty", () => {
    renderPalette();
    for (const item of ITEMS) {
      expect(screen.getByText(item.label)).toBeInTheDocument();
    }
  });

  it("filters as the user types", () => {
    const { input } = renderPalette();
    fireEvent.change(input, { target: { value: "blf" } });
    expect(screen.getByText("Open BLF…")).toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });

  it("Enter picks the selected item (first by default)", () => {
    const { onPick, input } = renderPalette();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(ITEMS[0]);
  });

  it("arrow keys move the selection before Enter", () => {
    const { onPick, input } = renderPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(ITEMS[1]);
  });

  it("Escape closes without picking", () => {
    const { onPick, onClose, input } = renderPalette();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("clicking an item picks it; clicking the backdrop closes", () => {
    const { onPick, onClose } = renderPalette();
    fireEvent.click(screen.getByText("Connect"));
    expect(onPick).toHaveBeenCalledWith(ITEMS[2]);
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the hint next to each item", () => {
    renderPalette();
    expect(screen.getByText("Connection")).toBeInTheDocument();
  });
});
