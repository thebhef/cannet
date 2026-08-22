// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PaletteModal, PalettePrompt, type PaletteItem } from "./PaletteModal";

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

  it("matches on keywords a renamed/merged item doesn't display", () => {
    const items: PaletteItem[] = [
      { id: "trace.import", label: "Import trace…", keywords: "Open BLF Open MDF" },
      { id: "connection.connect", label: "Connect" },
    ];
    const { input } = renderPalette({ items });
    fireEvent.change(input, { target: { value: "Open BLF" } });
    expect(screen.getByText("Import trace…")).toBeInTheDocument();
    expect(screen.queryByText("Open BLF")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
  });
});

describe("PalettePrompt", () => {
  function renderPrompt(over: Partial<Parameters<typeof PalettePrompt>[0]> = {}) {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <PalettePrompt
        label="Go to time (s)"
        initialValue=""
        onSubmit={onSubmit}
        onClose={onClose}
        {...over}
      />,
    );
    return { onSubmit, onClose, input: screen.getByLabelText("Go to time (s)") };
  }

  it("Enter submits the current text when there is no validator", () => {
    const { onSubmit, input } = renderPrompt();
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("12");
  });

  it("Escape closes without submitting", () => {
    const { onSubmit, onClose, input } = renderPrompt();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // The defect this closes: a bad value used to be silently discarded
  // (the prompt just closed). Invalid input must instead show the
  // error inline and keep the prompt open — pin the re-prompt, not
  // just the parse, by asserting the modal is still there and a
  // second, valid Enter is what finally submits.
  it("invalid input shows an inline error and keeps the prompt open, instead of silently closing", () => {
    const validate = (v: string) => (Number.isFinite(Number(v)) ? null : "Enter a number.");
    const { onSubmit, onClose, input } = renderPrompt({ validate });
    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a number.")).toBeInTheDocument();
    // The prompt is still open and usable: fixing the value and
    // pressing Enter again submits it.
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("12");
  });

  it("clears a shown error once the user edits the value again", () => {
    const validate = (v: string) => (v === "bad" ? "bad value" : null);
    const { input } = renderPrompt({ validate });
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("bad value")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "b" } });
    expect(screen.queryByText("bad value")).not.toBeInTheDocument();
  });
});
