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

/**
 * A binding is no longer one global fact (ADR 0044): grids consume the
 * navigation keys before the dispatcher sees them, and Space runs a
 * per-panel action. The view has to say so, or a user whose ↓ shortcut
 * goes quiet inside the trace has nothing to read.
 */
describe("ShortcutsPanel binding contexts", () => {
  /** The `.shortcut-chip` wrapping a rendered chord inside one row. */
  function chip(rowLabel: string, chord: string): HTMLElement {
    const el = within(row(rowLabel)).getByText(chord).closest(".shortcut-chip");
    if (!(el instanceof HTMLElement)) throw new Error(`no chip for ${chord}`);
    return el;
  }

  /** The `<fieldset>` a group legend heads. */
  function group(legend: string): HTMLElement {
    const el = screen.getByText(legend).closest("fieldset");
    if (!(el instanceof HTMLElement)) throw new Error(`no group for ${legend}`);
    return el;
  }

  it("marks the bindings a grid takes and leaves the rest plainly global", () => {
    // No default binding uses a grid key, so the suppressed case is one
    // the user could add — which is exactly when they need to be told.
    renderPanel({
      effective: [...DEFAULT_BINDINGS, { chord: "ArrowDown", commandId: "capture.clear" }],
    });
    const claimed = chip("Clear capture", "↓");
    expect(claimed).toHaveTextContent("not in grids");
    expect(claimed.getAttribute("title")).toMatch(/grid/i);

    const global = chip("Show command palette", "Ctrl+Shift+P");
    expect(global).not.toHaveTextContent("not in grids");
    expect(global.getAttribute("title")).toMatch(/^Global —/);
  });

  it("lists the keys a grid view owns, Enter among them as unbound", () => {
    renderPanel();
    const grid = group("In a grid view");
    for (const keys of ["↑ / ↓", "← / →", "Home / End", "PageUp / PageDown", "Ctrl+A", "Tab / Shift+Tab", "Space", "Enter"]) {
      expect(within(grid).getByText(keys)).toBeInTheDocument();
    }
    expect(within(grid).getByText(/Unbound/)).toBeInTheDocument();
    // Reference, not an editor — these keys belong to the layer and are
    // not rebindable in place.
    expect(within(grid).queryByRole("button")).toBeNull();
  });

  it("names the panel that defines a Space action", () => {
    renderPanel();
    const actions = group("Panel actions");
    expect(within(actions).getByText(/Transmit/)).toBeInTheDocument();
    expect(within(actions).getByText("Space")).toBeInTheDocument();
  });
});
