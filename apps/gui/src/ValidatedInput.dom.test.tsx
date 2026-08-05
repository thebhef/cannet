// @vitest-environment jsdom
//
// The shared validated text input's commit model: free text, committed
// on Enter or blur. Values picked from a fixed set belong to the shared
// `Combobox` instead, which commits on the pick.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ValidatedInput, parseFiniteNumber } from "./ValidatedInput";

afterEach(() => cleanup());

function renderInput() {
  const onCommit = vi.fn();
  render(
    <ValidatedInput<string | number>
      value="Standby"
      parse={(text) => {
        if (text === "") return null;
        return parseFiniteNumber(text);
      }}
      onCommit={onCommit}
      ariaLabel="cell"
    />,
  );
  return { onCommit, input: screen.getByLabelText("cell") };
}

describe("ValidatedInput", () => {
  it("commits free text on blur, not per keystroke", () => {
    const { onCommit, input } = renderInput();
    fireEvent.change(input, { target: { value: "12" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "127" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(127);
  });

  it("Escape abandons the draft without committing", () => {
    const { onCommit, input } = renderInput();
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input).toHaveValue("Standby");
  });
});
