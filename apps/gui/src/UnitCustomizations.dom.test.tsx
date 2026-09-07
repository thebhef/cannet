// @vitest-environment jsdom
//
// DOM tests for the settings view's units section: the library's units
// as a selectable list, the add path (a DBC unit string → a library
// unit), and the rows the project already declares. Every write goes out
// through the settings renderer's own `onCommit`, which the panel hands
// to `updateSettings` — there is no second store here.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/// The unit library, as `list_units` serves it.
const UNITS = [
  { id: "volt", display: "V", dimension: "voltage", dimensionLabel: "voltage", spelling: "V" },
  {
    id: "milliampere",
    display: "mA",
    dimension: "current",
    dimensionLabel: "current",
    spelling: "mA",
  },
  {
    id: "percent",
    display: "%",
    dimension: "ratio",
    dimensionLabel: "ratio",
    spelling: "%",
  },
];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "list_units" ? UNITS : undefined)),
}));

import { UnitCustomizations } from "./UnitCustomizations";
import { hydrateUnits } from "./unitLibrary";
import type { SettingDescriptor } from "./settingDescriptors";

const descriptor = { key: "unit_customizations" } as unknown as SettingDescriptor;

function show(value: unknown, onCommit = vi.fn()) {
  render(
    <UnitCustomizations descriptor={descriptor} value={value} onCommit={onCommit} />,
  );
  return onCommit;
}

beforeAll(async () => {
  await hydrateUnits();
});

afterEach(cleanup);

describe("UnitCustomizations", () => {
  it("says so when the project customizes nothing", () => {
    // The shipped state of every project: the built-in recognitions
    // cover it, and the dict is empty rather than absent.
    show({});
    expect(screen.getByText(/built-in recognitions/i)).toBeTruthy();
  });

  it("lists what the project declares, in a stable order", () => {
    show({ zz: "volt", counts: "percent" });
    const spellings = screen
      .getAllByText(/^(zz|counts)$/)
      .map((el) => el.textContent);
    expect(spellings).toEqual(["counts", "zz"]);
    // The library's own name for the unit an id points at, so a row
    // reads as the thing the picker offered.
    expect(screen.getByText("% (percent)")).toBeTruthy();
  });

  it("shows a stored unit the library does not carry as it stands", () => {
    // A hand-edit, or an id a later build dropped. The host recognises
    // nothing for it; the row says what the file says.
    show({ counts: "furlong" });
    expect(screen.getByText("furlong")).toBeTruthy();
  });

  it("removes one row without touching the others", () => {
    const onCommit = show({ counts: "percent", ticks: "millisecond" });
    fireEvent.click(
      screen.getByRole("button", { name: /Remove the customization for counts/ }),
    );
    expect(onCommit).toHaveBeenCalledWith({ ticks: "millisecond" });
  });

  it("adds a customization from a unit string and a unit chosen from the library", () => {
    const onCommit = show({ ticks: "millisecond" });
    fireEvent.change(screen.getByLabelText(/unit string/i), {
      target: { value: "mAmp " },
    });
    fireEvent.click(screen.getByRole("combobox", { name: /library unit/i }));
    // The library groups by the dimension the host labelled.
    expect(screen.getByText("current")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /^mA/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    // The *id* is what the dict stores, and the spelling is trimmed —
    // a DBC's padding is not part of what the user typed.
    expect(onCommit).toHaveBeenCalledWith({ ticks: "millisecond", mAmp: "milliampere" });
  });

  it("cannot add until both halves are there", () => {
    show({});
    const add = () => screen.getByRole("button", { name: "Add" });
    expect(add()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/unit string/i), { target: { value: "counts" } });
    expect(add()).toBeDisabled();
    fireEvent.click(screen.getByRole("combobox", { name: /library unit/i }));
    fireEvent.click(screen.getByRole("option", { name: /^%/ }));
    expect(add()).toBeEnabled();
  });

  it("treats a hand-edited non-object as no customizations at all", () => {
    // The file is hand-editable, so the renderer has to survive junk
    // rather than throwing inside the settings view.
    for (const junk of [null, 7, "counts", ["counts"]]) {
      show(junk);
      expect(screen.getByText(/built-in recognitions/i)).toBeTruthy();
      cleanup();
    }
  });
});
