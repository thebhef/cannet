// @vitest-environment jsdom
//
// The shared validated text input's commit model: free text commits on
// Enter or blur, a *discrete choice* (one of `choices` — an enum label
// offered by the attached datalist) commits the moment it lands, since
// a choice has nothing left to type.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ValidatedInput, parseFiniteNumber } from "./ValidatedInput";

afterEach(() => cleanup());

function renderInput(choices?: readonly string[]) {
  const onCommit = vi.fn();
  render(
    <ValidatedInput<string | number>
      value="Standby"
      choices={choices}
      parse={(text) => {
        if (text === "") return null;
        if (choices?.includes(text)) return text;
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

  it("commits a discrete choice as soon as it lands", () => {
    const { onCommit, input } = renderInput(["Off", "Standby", "Run"]);
    fireEvent.change(input, { target: { value: "Run" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Run");
  });

  it("does not commit a discrete choice twice when the blur follows", () => {
    const { onCommit, input } = renderInput(["Off", "Standby", "Run"]);
    fireEvent.change(input, { target: { value: "Run" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("keeps free text on the blur commit even when choices exist", () => {
    const { onCommit, input } = renderInput(["Off", "Standby", "Run"]);
    // A raw value outside the table: half-typed text must not go out.
    fireEvent.change(input, { target: { value: "1" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(12);
  });

  it("commits a choice that arrives with surrounding whitespace", () => {
    const { onCommit, input } = renderInput(["Off", "Standby", "Run"]);
    fireEvent.change(input, { target: { value: " Run " } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Run");
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
