// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { UnitCustomizations } from "./UnitCustomizations";
import type { SettingDescriptor } from "./settingDescriptors";

const descriptor = { key: "unit_customizations" } as unknown as SettingDescriptor;

function show(value: unknown, onCommit = vi.fn()) {
  render(
    <UnitCustomizations descriptor={descriptor} value={value} onCommit={onCommit} />,
  );
  return onCommit;
}

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
    expect(screen.getByText("percent")).toBeTruthy();
  });

  it("removes one row without touching the others", () => {
    const onCommit = show({ counts: "percent", ticks: "millisecond" });
    fireEvent.click(
      screen.getByRole("button", { name: /Remove the customization for counts/ }),
    );
    expect(onCommit).toHaveBeenCalledWith({ ticks: "millisecond" });
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
