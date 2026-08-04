// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  CUSTOM_SETTING_RENDERERS,
  SettingControl,
  type CustomRendererProps,
} from "./settingControls";
import type { SettingControl as Control, SettingDescriptor } from "./settingDescriptors";

afterEach(cleanup);

/// A descriptor of the given control shape. The point of these tests is
/// that nothing downstream knows *which* setting this is — only its type.
function descriptor(control: Control, key = "some_key"): SettingDescriptor {
  return {
    key,
    label: "Some setting",
    help: "What it does.",
    surfaces: ["general"],
    kind: "behaviour",
    backing: "field",
    control,
    scope: "user",
    default: null,
  };
}

function renderControl(control: Control, value: unknown) {
  const onCommit = vi.fn();
  render(
    <SettingControl descriptor={descriptor(control)} value={value} onCommit={onCommit} />,
  );
  return onCommit;
}

describe("generated controls", () => {
  it("renders a bool as a checkbox and commits the new state", () => {
    const onCommit = renderControl({ type: "bool" }, false);
    const box = screen.getByRole("checkbox");
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it("renders an enum as a select over its options", () => {
    const onCommit = renderControl(
      { type: "enum", options: ["Shared", "Individual"] },
      "Shared",
    );
    const select = screen.getByRole("combobox");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Shared",
      "Individual",
    ]);
    fireEvent.change(select, { target: { value: "Individual" } });
    expect(onCommit).toHaveBeenCalledWith("Individual");
  });

  it("renders a text setting and commits on Enter, not per keystroke", () => {
    const onCommit = renderControl({ type: "text", placeholder: "none" }, "abc");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "abcd" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("abcd");
  });

  // A scaled integer is edited in its display unit and stored in the
  // file's unit; the descriptor is the only place that conversion lives.
  it("edits a scaled integer in its display unit and stores the file's", () => {
    const onCommit = renderControl(
      { type: "int", unit: "MB", scale: 1048576, min: 104857600, unset: "unbounded" },
      4 * 1024 * 1024 * 1024,
    );
    const box = screen.getByRole("spinbutton");
    expect(box).toHaveValue(4096);
    expect(box).toHaveAttribute("min", "100");
    expect(screen.getByText("MB")).toBeInTheDocument();

    fireEvent.change(box, { target: { value: "500" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(onCommit).toHaveBeenCalledWith(500 * 1024 * 1024);
  });

  it("commits null when an optional number is cleared", () => {
    const onCommit = renderControl(
      { type: "int", unit: "MB", scale: 1048576, min: null, unset: "unbounded" },
      1048576,
    );
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("keeps the stored value when a mandatory number is cleared", () => {
    const onCommit = renderControl(
      { type: "int", unit: null, scale: 1, min: null, unset: null },
      15,
    );
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a fractional number unrounded", () => {
    const onCommit = renderControl({ type: "number", unit: "s", min: 0 }, 10);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2.5" } });
    fireEvent.blur(screen.getByRole("spinbutton"));
    expect(onCommit).toHaveBeenCalledWith(2.5);
  });
});

describe("the custom-renderer dispatch table", () => {
  // The entire extension surface: a setting is either a generated
  // control or one named renderer looked up here.
  it("dispatches a custom control through the table", () => {
    const spy = vi.fn((_props: CustomRendererProps) => <p>rendered by the table</p>);
    CUSTOM_SETTING_RENDERERS["test-renderer"] = spy;
    try {
      render(
        <SettingControl
          descriptor={descriptor({ type: "custom", renderer: "test-renderer" })}
          value={42}
          onCommit={vi.fn()}
        />,
      );
      expect(screen.getByText("rendered by the table")).toBeInTheDocument();
      expect(spy.mock.calls[0][0]).toMatchObject({ value: 42 });
    } finally {
      delete CUSTOM_SETTING_RENDERERS["test-renderer"];
    }
  });

  it("says so when a descriptor names a renderer nothing registered", () => {
    render(
      <SettingControl
        descriptor={descriptor({ type: "custom", renderer: "not-a-renderer" })}
        value={null}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText(/No renderer registered/)).toBeInTheDocument();
  });

  // The column-default rows are the one custom renderer that *edits*.
  // A table header adjusts the panel in front of you; there is nowhere
  // else to say what the next one should open as.
  function renderColumnDefaults(value: unknown, key = "trace_columns") {
    const onCommit = vi.fn();
    render(
      <SettingControl
        descriptor={descriptor({ type: "custom", renderer: "column-defaults" }, key)}
        value={value}
        onCommit={onCommit}
      />,
    );
    return onCommit;
  }

  it("edits a column default through the same moves the table header makes", () => {
    // An unset value shows the built-in layout, so the first edit
    // starts from what a fresh panel actually opens with.
    const onCommit = renderColumnDefaults(null);
    fireEvent.click(screen.getByLabelText("show data"));
    const hidden = onCommit.mock.calls[0][0] as { key: string; visible: boolean }[];
    expect(hidden.find((c) => c.key === "data")?.visible).toBe(false);
    // Every other column survives the edit — the row commits a whole
    // layout, not a patch.
    expect(hidden).toHaveLength(11);

    const width = screen.getByLabelText("data width");
    fireEvent.change(width, { target: { value: "420" } });
    expect(onCommit).toHaveBeenCalledTimes(1); // not per keystroke
    fireEvent.blur(width);
    const resized = onCommit.mock.calls[1][0] as { key: string; width: number }[];
    expect(resized.find((c) => c.key === "data")?.width).toBe(420);

    fireEvent.click(screen.getByLabelText("move data up"));
    const moved = onCommit.mock.calls[2][0] as { key: string }[];
    expect(moved.map((c) => c.key).indexOf("data")).toBe(7);
  });

  it("commits null to go back to the built-in layout", () => {
    const onCommit = renderColumnDefaults([{ key: "id", width: 200, visible: true }]);
    fireEvent.click(screen.getByText("Use the built-in layout"));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it("edits the signal table's own column set for its own key", () => {
    // One renderer, two settings: the row it offers must come from the
    // column set the *descriptor* names.
    renderColumnDefaults(null, "signal_columns");
    expect(screen.getByLabelText("show signal")).toBeInTheDocument();
    expect(screen.queryByLabelText("show data")).not.toBeInTheDocument();
  });

  // The shortcuts panel is the one editor for bindings (ADR 0018); this
  // row points at it and must never grow into a second one.
  it("renders keybindings as a pointer to the shortcuts panel, not an editor", () => {
    render(
      <SettingControl
        descriptor={descriptor({ type: "custom", renderer: "keybindings" }, "keybindings")}
        value={[{ chord: "Mod+k", commandId: "palette.show" }]}
        onCommit={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 binding customised/)).toBeInTheDocument();
    expect(screen.getByText(/Keyboard Shortcuts panel/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
