// @vitest-environment jsdom
//
// Bus health is a launcher, not a status chip: with several buses a
// single summary cannot name which one is off, which is the only thing
// worth knowing when one is. So it is an icon that opens the panel,
// neutral while every bus is error-active and tinted with a count when
// one is not.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import css from "./index.css?raw";
import { BusHealthLauncher } from "./BusHealthLauncher";

afterEach(cleanup);

describe("BusHealthLauncher", () => {
  it("is neutral and countless while every bus is error-active", () => {
    render(<BusHealthLauncher concerns={[]} onOpen={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("data-state", "idle");
    expect(btn).toHaveAttribute("title", "Bus health — all buses error-active");
    expect(document.querySelector(".bus-health-launcher-count")).toBeNull();
  });

  it("tints, counts and names the bus when one is not", () => {
    render(
      <BusHealthLauncher
        concerns={[{ bus: "Body", state: "bus-off", busOff: true }]}
        onOpen={() => {}}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("data-state", "failed");
    expect(btn).toHaveAttribute("title", "Bus health — Body is bus-off");
    expect(screen.getByText("1")).toHaveClass("bus-health-launcher-count");
  });

  it("separates a warning from a fault", () => {
    render(
      <BusHealthLauncher
        concerns={[{ bus: "Chassis", state: "error-passive", busOff: false }]}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "degraded");
  });

  it("names every bus that is not error-active, and counts them all", () => {
    render(
      <BusHealthLauncher
        concerns={[
          { bus: "Body", state: "bus-off", busOff: true },
          { bus: "Chassis", state: "error-passive", busOff: false },
        ]}
        onOpen={() => {}}
      />,
    );
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("title", "Bus health — Body is bus-off, Chassis is error-passive");
    expect(btn).toHaveAttribute("data-state", "failed");
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("opens the panel when pressed", () => {
    const onOpen = vi.fn();
    render(<BusHealthLauncher concerns={[]} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("still reports, but does not pretend to be pressable, with no panel to open", () => {
    render(<BusHealthLauncher concerns={[{ bus: "Body", state: "bus-off", busOff: true }]} />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("draws the registry's bus topology icon, not an inline zigzag", () => {
    render(<BusHealthLauncher concerns={[]} onOpen={() => {}} />);
    const svg = screen.getByRole("button").querySelector("svg");
    // The bus icon is two taps off a spine (two circles, two paths); the
    // retired ECG zigzag was a single six-point polyline.
    expect(svg?.querySelector("polyline")).toBeNull();
    expect(svg?.querySelectorAll("circle").length).toBe(2);
    expect(svg?.getAttribute("viewBox")).toBe("0 0 14 14");
  });

  it("draws its state on the icon's own colour, so nothing about it moves", () => {
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
      const open = css.indexOf("{", start);
      return css.slice(open + 1, css.indexOf("}", open));
    };
    expect(rule('.bus-health-launcher[data-state="degraded"]')).toMatch(/color:/);
    expect(rule('.bus-health-launcher[data-state="failed"]')).toMatch(/color:/);
  });
});
