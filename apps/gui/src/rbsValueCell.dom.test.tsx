// @vitest-environment jsdom
//
// The shared RBS value cell: both the RBS panel's tree and the RBS
// signals grid edit an override through this one component, so
// clamp-on-entry only has to be proven here once.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "list_value_tables" ? [] : undefined)),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { RbsValueCell, parseSignalText } from "./rbsValueCell";

afterEach(() => cleanup());

const NUMERIC_SIGNAL = {
  name: "EngineSpeed",
  unit: "rpm",
  value: 4000,
  label: null,
  overridden: false,
  overrideText: null,
  calcRole: null,
  factor: 1,
  offset: 0,
  min: 0,
  max: 8000,
  size: 16,
  signed: false,
  hasValueTable: false,
};

describe("RbsValueCell", () => {
  it("clamps a plain numeric commit into the signal's range before calling onCommit", () => {
    const onCommit = vi.fn();
    render(
      <RbsValueCell
        signal={NUMERIC_SIGNAL}
        busId="p1"
        messageId={0x100}
        extended={false}
        disabled={false}
        onCommit={onCommit}
        onClear={() => {}}
      />,
    );
    const input = screen.getByRole("textbox", { name: "EngineSpeed value" });
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(8000);
  });

  it("passes a value already in range through unchanged", () => {
    const onCommit = vi.fn();
    render(
      <RbsValueCell
        signal={NUMERIC_SIGNAL}
        busId="p1"
        messageId={0x100}
        extended={false}
        disabled={false}
        onCommit={onCommit}
        onClear={() => {}}
      />,
    );
    const input = screen.getByRole("textbox", { name: "EngineSpeed value" });
    fireEvent.change(input, { target: { value: "500" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(500);
  });

  it("does not clamp a 0x… raw override — raw bits have no physical range", () => {
    const onCommit = vi.fn();
    render(
      <RbsValueCell
        signal={NUMERIC_SIGNAL}
        busId="p1"
        messageId={0x100}
        extended={false}
        disabled={false}
        onCommit={onCommit}
        onClear={() => {}}
      />,
    );
    const input = screen.getByRole("textbox", { name: "EngineSpeed value" });
    fireEvent.change(input, { target: { value: "0xFFFF" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("0xFFFF");
  });

  it("renders a calc-role destination read-only, with no input at all", () => {
    render(
      <RbsValueCell
        signal={{ ...NUMERIC_SIGNAL, calcRole: "counter" }}
        busId="p1"
        messageId={0x100}
        extended={false}
        disabled={false}
        onCommit={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("(counter)")).toBeInTheDocument();
  });

  it("clears an override through onClear, not onCommit", () => {
    const onClear = vi.fn();
    render(
      <RbsValueCell
        signal={{ ...NUMERIC_SIGNAL, overridden: true, overrideText: "500" }}
        busId="p1"
        messageId={0x100}
        extended={false}
        disabled={false}
        onCommit={() => {}}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByTitle(/clear override/));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("parseSignalText", () => {
  it("accepts a known VAL_ label verbatim", () => {
    expect(parseSignalText("Standby", [{ raw: 1, label: "Standby" }])).toBe("Standby");
  });

  it("accepts a finite number", () => {
    expect(parseSignalText("403.2", [])).toBe(403.2);
  });

  it("accepts a 0x… raw string", () => {
    expect(parseSignalText("0xA", [])).toBe("0xA");
  });

  it("rejects anything else", () => {
    expect(parseSignalText("nonsense", [])).toBeNull();
    expect(parseSignalText("", [])).toBeNull();
  });

  // Bug found while extracting this function into shared code:
  // `Number("0xA")` is a valid JS numeric literal (10), so checking it
  // before the hex-prefix regex silently reinterpreted every
  // well-formed hex override as a physical number and never reached
  // the raw-bits path `reconstruct_payload` expects for a `0x…`
  // string. Regression-guarded at both levels.
  it("reads a hex-shaped override as the raw string, not the number JS would parse it as", () => {
    expect(parseSignalText("0xA", [])).toBe("0xA");
    expect(parseSignalText("0x1F", [])).toBe("0x1F");
  });
});

describe("the hex-override bug, end to end through the input", () => {
  it("commits a 0x… entry as the raw string rather than its decimal value", () => {
    const onCommit = vi.fn();
    render(
      <RbsValueCell
        signal={NUMERIC_SIGNAL}
        busId="p1"
        messageId={0x100}
        extended={false}
        disabled={false}
        onCommit={onCommit}
        onClear={() => {}}
      />,
    );
    const input = screen.getByRole("textbox", { name: "EngineSpeed value" });
    fireEvent.change(input, { target: { value: "0xA" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith("0xA");
  });
});
