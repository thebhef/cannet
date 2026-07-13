// @vitest-environment jsdom
/**
 * The keyboard-shortcuts editor (ADR 0018): capturing a free chord adds a
 * binding, a chord that collides in an overlapping context is refused with a
 * message and no state change, removing a chip drops just that binding, and
 * reset clears the whole customisation. Guards the accept / reject / remove /
 * reset wiring against the app-owned keybinding controller.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { ShortcutsPanel } from "./ShortcutsPanel";
import { DEFAULT_BINDINGS, type BindingSpec } from "./commands";
import { KeybindingsContext, type KeybindingsController } from "./keybindingsContext";

function renderPanel(over: Partial<KeybindingsController> = {}) {
  const setUser = vi.fn();
  const controller: KeybindingsController = {
    user: null,
    effective: DEFAULT_BINDINGS,
    setUser,
    ...over,
  };
  const props = {} as Parameters<typeof ShortcutsPanel>[0];
  render(
    <KeybindingsContext.Provider value={controller}>
      <ShortcutsPanel {...props} />
    </KeybindingsContext.Provider>,
  );
  return { setUser };
}

/** The `.shortcut-row` container for a command by its visible label. */
function row(label: string): HTMLElement {
  const el = screen.getByText(label).closest(".shortcut-row");
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${label}`);
  return el;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ShortcutsPanel", () => {
  it("lists a command with its default chord", () => {
    renderPanel();
    // palette.show is bound to Ctrl+Shift+P (non-mac display).
    const paletteRow = row("Show command palette");
    expect(within(paletteRow).getByText("Ctrl+Shift+P")).toBeInTheDocument();
  });

  it("captures a free chord and adds a binding", () => {
    const { setUser } = renderPanel();
    // Clear capture has no default binding.
    fireEvent.click(within(row("Clear capture")).getByText("Set shortcut"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
    expect(setUser).toHaveBeenCalledTimes(1);
    const next = setUser.mock.calls[0][0] as BindingSpec[];
    expect(next).toContainEqual({ chord: "Mod+Shift+K", commandId: "capture.clear" });
    // The whole effective list is materialised, not just the delta.
    expect(next.length).toBe(DEFAULT_BINDINGS.length + 1);
  });

  it("refuses a conflicting chord and reports it without changing state", () => {
    const { setUser } = renderPanel();
    // Bind Ctrl+Shift+P (palette.show's chord) onto an always-available
    // command — overlaps, so it must be rejected.
    fireEvent.click(within(row("Clear capture")).getByText("Set shortcut"));
    fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
    expect(setUser).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Can't bind Mod\+Shift\+P/);
  });

  it("removes a single binding", () => {
    const { setUser } = renderPanel();
    fireEvent.click(
      within(row("Show command palette")).getByLabelText(
        "Remove Ctrl+Shift+P from Show command palette",
      ),
    );
    expect(setUser).toHaveBeenCalledTimes(1);
    const next = setUser.mock.calls[0][0] as BindingSpec[];
    expect(next.some((b) => b.commandId === "palette.show")).toBe(false);
    expect(next.length).toBe(DEFAULT_BINDINGS.length - 1);
  });

  it("resets to defaults with null", () => {
    const { setUser } = renderPanel();
    fireEvent.click(screen.getByText("Reset to defaults"));
    expect(setUser).toHaveBeenCalledWith(null);
  });
});
