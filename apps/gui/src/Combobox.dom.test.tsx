// @vitest-environment jsdom
//
// The shared fzf combobox (the control every <select> in the GUI now
// uses): closed it renders like a select (label + value), open it is a
// text input filtering the option list through `fzf`, with arrow-key
// navigation, Enter to pick, Escape / blur to close. Hierarchical
// options (bus → message → signal) render group headers; flat options
// render a plain list.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { Combobox, type ComboboxOption } from "./Combobox";

afterEach(cleanup);

const FLAT: ComboboxOption[] = [
  { value: "off", label: "off" },
  { value: "x", label: "X (A / B)" },
  { value: "y", label: "Y (H1 / H2)" },
];

const TREE: ComboboxOption[] = [
  { value: "s1", label: "EngineSpeed", path: ["Powertrain", "EngineData"] },
  { value: "s2", label: "EngineTemp", path: ["Powertrain", "EngineData"] },
  { value: "s3", label: "Gear", path: ["Chassis", "GearBox"] },
];

function renderFlat(over: Partial<Parameters<typeof Combobox>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <Combobox
      options={FLAT}
      value="x"
      onChange={onChange}
      ariaLabel="cursor mode"
      {...over}
    />,
  );
  return { onChange, trigger: screen.getByLabelText("cursor mode") };
}

function optionLabels(): string[] {
  return Array.from(document.querySelectorAll('[role="option"]')).map(
    (el) => el.textContent ?? "",
  );
}

describe("Combobox", () => {
  it("closed: renders the selected option's label, exposes the value, lists no options", () => {
    const { trigger } = renderFlat();
    expect(trigger).toHaveTextContent("X (A / B)");
    expect((trigger as HTMLButtonElement).value).toBe("x");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it("closed: shows the placeholder when the value matches no option", () => {
    const { trigger } = renderFlat({ value: "", placeholder: "pick a signal…" });
    expect(trigger).toHaveTextContent("pick a signal…");
    expect((trigger as HTMLButtonElement).value).toBe("");
  });

  it("open: click lists every option and focuses the filter input", () => {
    const { trigger } = renderFlat();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(optionLabels()).toEqual(["off", "X (A / B)", "Y (H1 / H2)"]);
    const input = screen.getByLabelText("cursor mode filter");
    expect(document.activeElement).toBe(input);
  });

  it("open: the current value's option starts active", () => {
    renderFlat({ value: "y" });
    fireEvent.click(screen.getByLabelText("cursor mode"));
    const active = document.querySelector('[role="option"][aria-selected="true"]');
    expect(active).toHaveTextContent("Y (H1 / H2)");
  });

  it("clicking an option commits its value, closes, and refocuses the trigger", () => {
    const { onChange, trigger } = renderFlat();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "off" }));
    expect(onChange).toHaveBeenCalledWith("off");
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
  });

  it("typing filters the list through fzf (subsequence match)", () => {
    const { trigger } = renderFlat();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("cursor mode filter"), {
      target: { value: "yh1" },
    });
    expect(optionLabels()).toEqual(["Y (H1 / H2)"]);
  });

  it("shows a no-matches note when the query matches nothing", () => {
    const { trigger } = renderFlat();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("cursor mode filter"), {
      target: { value: "zzzz" },
    });
    expect(optionLabels()).toEqual([]);
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });

  it("arrow keys move the active option (wrapping) and Enter picks it", () => {
    const { onChange, trigger } = renderFlat({ value: "" });
    fireEvent.click(trigger);
    const input = screen.getByLabelText("cursor mode filter");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("x");
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it("ArrowUp from the top wraps to the last option", () => {
    const { onChange, trigger } = renderFlat({ value: "" });
    fireEvent.click(trigger);
    const input = screen.getByLabelText("cursor mode filter");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("y");
  });

  it("Enter picks the top match after filtering", () => {
    const { onChange, trigger } = renderFlat({ value: "" });
    fireEvent.click(trigger);
    const input = screen.getByLabelText("cursor mode filter");
    fireEvent.change(input, { target: { value: "yh1" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("y");
  });

  it("Escape closes without committing and refocuses the trigger", () => {
    const { onChange, trigger } = renderFlat();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText("cursor mode filter"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("blurring the filter input closes the dropdown", () => {
    const { trigger } = renderFlat();
    fireEvent.click(trigger);
    fireEvent.blur(screen.getByLabelText("cursor mode filter"));
    expect(document.querySelector('[role="option"]')).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("typing a character on the closed trigger opens pre-filtered", () => {
    const { trigger } = renderFlat();
    fireEvent.keyDown(trigger, { key: "x" });
    const input = screen.getByLabelText("cursor mode filter") as HTMLInputElement;
    expect(input.value).toBe("x");
    expect(optionLabels()).toEqual(["X (A / B)"]);
  });

  it("Enter / ArrowDown on the closed trigger opens unfiltered", () => {
    const { trigger } = renderFlat();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(optionLabels()).toEqual(["off", "X (A / B)", "Y (H1 / H2)"]);
  });

  it("hierarchical options render ancestor group headers; leaves are the options", () => {
    render(<Combobox options={TREE} value="" onChange={() => {}} ariaLabel="signal" />);
    fireEvent.click(screen.getByLabelText("signal"));
    expect(optionLabels()).toEqual(["EngineSpeed", "EngineTemp", "Gear"]);
    const headers = Array.from(document.querySelectorAll(".combobox-group")).map(
      (el) => el.textContent ?? "",
    );
    expect(headers).toEqual(["Powertrain", "EngineData", "Chassis", "GearBox"]);
  });

  it("filtering matches against the full path text and keeps the ancestry visible", () => {
    render(<Combobox options={TREE} value="" onChange={() => {}} ariaLabel="signal" />);
    fireEvent.click(screen.getByLabelText("signal"));
    fireEvent.change(screen.getByLabelText("signal filter"), {
      // Matches via the ancestor text ("GearBox") — the leaf "Gear"
      // stays visible under its headers.
      target: { value: "gearbox" },
    });
    expect(optionLabels()).toEqual(["Gear"]);
    const headers = Array.from(document.querySelectorAll(".combobox-group")).map(
      (el) => el.textContent ?? "",
    );
    expect(headers).toEqual(["Chassis", "GearBox"]);
  });

  it("closed: a hierarchical option can override its closed-state label", () => {
    const opts: ComboboxOption[] = [
      {
        value: "s3",
        label: "Gear",
        path: ["Chassis", "GearBox"],
        selectedLabel: "Chassis · GearBox.Gear",
      },
    ];
    render(<Combobox options={opts} value="s3" onChange={() => {}} ariaLabel="signal" />);
    expect(screen.getByLabelText("signal")).toHaveTextContent("Chassis · GearBox.Gear");
  });

  it("disabled options are skipped by arrow navigation and are not pickable", () => {
    const onChange = vi.fn();
    const opts: ComboboxOption[] = [
      { value: "a", label: "alpha" },
      { value: "b", label: "(no interfaces)", disabled: true },
      { value: "c", label: "charlie" },
    ];
    render(<Combobox options={opts} value="a" onChange={onChange} ariaLabel="iface" />);
    fireEvent.click(screen.getByLabelText("iface"));
    fireEvent.click(screen.getByRole("option", { name: "(no interfaces)" }));
    expect(onChange).not.toHaveBeenCalled();
    const input = screen.getByLabelText("iface filter");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // a → c, skipping b
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("a disabled combobox does not open", () => {
    const { trigger } = renderFlat({ disabled: true });
    fireEvent.click(trigger);
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it("passes className and title through to the trigger", () => {
    const { trigger } = renderFlat({ className: "tx-bus", title: "destination" });
    expect(trigger).toHaveClass("combobox-trigger", "tx-bus");
    expect(trigger).toHaveAttribute("title", "destination");
  });
});
