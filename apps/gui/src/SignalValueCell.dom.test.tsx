// @vitest-environment jsdom
//
// The value and its unit are separate elements on every signal-value
// surface: `SignalValueCell` (signal view + Database panel live value) and
// `DecodedSignalCell` (expanded trace rows). Glued into one string the
// row reads as a single token; a query for the value text must not also
// pick up the unit.

import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SignalValueCell } from "./SignalValueCell";
import { DecodedSignalCell } from "./DecodedSignalCell";
import type { SignalRecord, TraceFrameRecord } from "./types";
import { LONG_ENUM_LABEL } from "./longNameTestKit";

afterEach(cleanup);

const target = {
  messageId: 0x100,
  extended: false,
  signalName: "Current",
  busId: "b1",
};

const frame: TraceFrameRecord = {
  index: 0,
  timestamp_seconds: 0,
  channel: 0,
  id: 0x100,
  extended: false,
  direction: "Rx",
  kind: { kind: "classic" },
  data: [0],
  decoded: null,
  bus_id: "b1",
};

function renderDecoded(sig: SignalRecord) {
  return render(
    <DecodedSignalCell
      frame={frame}
      messageName="Battery"
      sig={sig}
      resolveColor={null}
      top={0}
      rowId={`b1:256:s/${sig.name}`}
      domId={`byid-b1:256:s/${sig.name}`}
      selected={false}
      onSelect={() => {}}
    />,
  );
}

describe("SignalValueCell", () => {
  it("renders the unit as its own element beside the value", () => {
    const { container } = render(
      <SignalValueCell value={12.5} unit="A" target={target} resolveColor={null} />,
    );
    // The value is addressable on its own: an exact-text query for the
    // magnitude must match, which it cannot when the unit is glued on.
    const value = screen.getByText("12.5");
    const unit = screen.getByText("A");
    expect(value).not.toBe(unit);
    expect(value).not.toContainElement(unit);
    expect(unit).not.toContainElement(value);
    // …and both still read in order inside the one cell.
    expect(container.querySelector(".signal-value-cell")).toHaveTextContent(/^12\.5\s*A$/);
  });

  it("renders nothing extra when the caller carries the unit in its own column", () => {
    // The signal view passes `unit=""`; no empty element, no stray
    // spacing may appear in the cell.
    const { container } = render(
      <SignalValueCell value={12.5} unit="" target={target} resolveColor={null} />,
    );
    const cell = container.querySelector(".signal-value-cell");
    expect(cell?.textContent).toBe("12.5");
    expect(cell?.querySelector(".signal-value-unit")).toBeNull();
  });

  it("keeps the enum label separate from the value and the unit", () => {
    const { container } = render(
      <SignalValueCell
        value={1}
        unit="deg/s"
        label="Forward"
        target={target}
        resolveColor={null}
      />,
    );
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("deg/s")).toBeInTheDocument();
    expect(container.querySelector(".signal-value-cell")).toHaveTextContent(
      /^1\s*deg\/s\s*"Forward"$/,
    );
  });

  it("renders a raw bit field in base 10 by default", () => {
    // Hex is a per-signal DBC opt-in (ADR 0043), not what being a raw
    // field means — but the value stays digit-exact, never scientific.
    render(<SignalValueCell value={0xdeadbeef} unit="" target={target} resolveColor={null} />);
    expect(screen.getByText("3735928559")).toBeInTheDocument();
  });

  it("renders a raw bit field's value in hex when the DBC asks for it", () => {
    render(
      <SignalValueCell
        value={0xdeadbeef}
        unit=""
        displayHex
        target={target}
        resolveColor={null}
      />,
    );
    expect(screen.getByText("0xDEADBEEF")).toBeInTheDocument();
  });

  it("renders a raw field's sentinel label alongside the hex value", () => {
    render(
      <SignalValueCell
        value={0xffff}
        unit=""
        label="SNA"
        displayHex
        target={target}
        resolveColor={null}
      />,
    );
    expect(screen.getByText("0xFFFF")).toBeInTheDocument();
    expect(screen.getByText('"SNA"')).toBeInTheDocument();
  });

  it("renders a blank cell for a missing value", () => {
    const { container } = render(
      <SignalValueCell value={null} unit="A" target={target} resolveColor={null} />,
    );
    expect(container.querySelector(".signal-value-cell")?.textContent).toBe("");
  });
});

describe("DecodedSignalCell", () => {
  it("renders the unit as its own element beside the value", () => {
    const { container } = renderDecoded({ name: "Current", value: 12.5, unit: "A" });
    const value = screen.getByText("12.5");
    const unit = screen.getByText("A");
    expect(value).not.toBe(unit);
    expect(value).not.toContainElement(unit);
    expect(container.querySelector(".signal-value")).toHaveTextContent(/^12\.5\s*A$/);
  });

  it("keeps a unitless signal's value alone in the line", () => {
    const { container } = renderDecoded({
      name: "Gear",
      value: 3,
      unit: "",
      label: "Drive",
    });
    const line = container.querySelector(".signal-value");
    expect(line?.querySelector(".signal-value-unit")).toBeNull();
    expect(line).toHaveTextContent(/^3\s*"Drive"$/);
  });
});

describe("a long VAL_ label", () => {
  it("stays reachable as a tooltip when the column ellipsizes it", () => {
    // `VAL_` labels carry no length limit, so the column will cut this
    // one; the tooltip is what keeps the whole of it available. It is
    // not split like a name is — prose reads front-first.
    const { container } = renderDecoded({
      name: "DerateSource",
      value: 1,
      unit: "",
      label: LONG_ENUM_LABEL,
    });
    const label = container.querySelector(".signal-value-label")!;
    expect(label.getAttribute("title")).toBe(LONG_ENUM_LABEL);
    expect(label.querySelector(".name-text")).toBeNull();
  });
});
