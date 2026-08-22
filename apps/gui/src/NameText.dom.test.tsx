// @vitest-environment jsdom
//
// The one long-name renderer (`NameText.tsx`). jsdom does no layout, so
// what is asserted here is the *structure* the middle-ellipsis needs —
// which half ellipsizes, which half is kept, and the tooltip — while
// `nameOverflow.test.ts` asserts the declarations that make that
// structure behave in a browser.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";


import { NameText } from "./NameText";

afterEach(cleanup);

const LONG = "HighVoltageBatteryPackCoolantInletTemperature";
const SHORT = "PackVoltage";

describe("NameText", () => {
  it("renders a name within the DBC identifier limit as a plain text node", () => {
    // The control. A short name must reach the DOM exactly as it did
    // before this component existed — one text node, no wrapper — so
    // the split can be read as a response to length and not as the
    // component always firing.
    const { container } = render(
      <span className="cell">
        <NameText name={SHORT} />
      </span>,
    );
    const cell = container.querySelector(".cell")!;
    expect(cell.textContent).toBe(SHORT);
    expect(cell.querySelector(".name-text")).toBeNull();
    expect(screen.getByText(SHORT)).toBe(cell);
  });

  it("splits a longer name into an ellipsizing head and a kept tail", () => {
    const { container } = render(<NameText name={LONG} />);
    const wrap = container.querySelector(".name-text")!;
    const head = wrap.querySelector(".name-text-head")!.textContent!;
    const tail = wrap.querySelector(".name-text-tail")!.textContent!;
    expect(head + tail).toBe(LONG);
    expect(tail).toBe("Temperature");
  });

  it("keeps the whole name reachable as a tooltip", () => {
    const { container } = render(<NameText name={LONG} />);
    expect(container.querySelector(".name-text")!.getAttribute("title")).toBe(LONG);
  });

  it("lets a caller keep its own tooltip wording", () => {
    const { container } = render(<NameText name={LONG} title={`${LONG} — drag me`} />);
    expect(container.querySelector(".name-text")!.getAttribute("title")).toBe(
      `${LONG} — drag me`,
    );
  });

  it("shows the distinguishing tail of two names that share a prefix", () => {
    const tails = ["BmsPackCurrentFilteredMeasuredHighRes", "BmsPackCurrentFilteredMeasuredLowRes"].map(
      (n) => {
        const { container } = render(<NameText name={n} />);
        return container.querySelector(".name-text-tail")!.textContent;
      },
    );
    expect(tails[0]).not.toBe(tails[1]);
  });
});
