// @vitest-environment jsdom
//
// The command chip: the status chip's silhouette with a press
// affordance. The invariant it exists to keep is the status chip's own
// — **state tints the hairline and the dot, and nothing else moves** —
// so the test that matters is not "does this state add a class" but
// "does any state change the chip's geometry".
//
// jsdom does no layout, so geometry is read from the stylesheet rather
// than from a rendered box: the sheet is put in the document and every
// rule that actually matches the element (the DOM's own selector
// matching) is collected, then the geometry declarations among them are
// compared across states. A state rule that grew a padding, a border
// weight or a width would show up as a difference.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import css from "./index.css?raw";
import { ChipButton } from "./ChipButton";
import { geometryOf, installStylesheet } from "./chipCssTestKit";
import { STATUS_CHIP_STATES } from "./StatusChip";

afterEach(cleanup);

beforeAll(() => installStylesheet(css));

/// The chip's markup with the attributes a state writes stripped out,
/// so "this state added an element" is caught as well as "this state
/// changed a length".
function shapeOf(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const attr of ["data-state", "aria-pressed", "aria-busy", "disabled", "class"]) {
    clone.removeAttribute(attr);
  }
  return clone.outerHTML;
}

function renderChip(props: Partial<Parameters<typeof ChipButton>[0]> = {}) {
  cleanup();
  render(<ChipButton icon="play" label="Start" onPress={() => {}} {...props} />);
  return screen.getByRole("button");
}

describe("ChipButton", () => {
  it("extends the shipped status chip rather than paralleling it", () => {
    // Carrying `.status-chip` is what makes the hairline, the 2px
    // radius, the dot and every state tint the *same* declarations the
    // status chip already ships — not a second copy of them.
    const chip = renderChip();
    expect(chip).toHaveClass("status-chip");
    expect(chip).toHaveClass("chip-button");
  });

  it("draws a registry icon beside its label, and the label alone is optional", () => {
    const chip = renderChip();
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("Start")).toHaveClass("status-chip-label");

    // Icon-only: no label element at all, and the chip is square.
    const iconOnly = renderChip({ label: undefined, title: "Start" });
    expect(iconOnly.querySelector(".status-chip-label")).toBeNull();
    expect(iconOnly).toHaveClass("chip-button--icon-only");
    // The icon is decorative, so the name has to come from the chip.
    expect(iconOnly).toHaveAccessibleName("Start");
  });

  it("presses through to the handler, and cannot be pressed when disabled", () => {
    const onPress = vi.fn();
    fireEvent.click(renderChip({ onPress }));
    expect(onPress).toHaveBeenCalledTimes(1);
    const disabled = renderChip({ onPress, disabled: true });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("says whether it is on, and says nothing at all when it is not a toggle", () => {
    expect(renderChip({ pressed: true })).toHaveAttribute("aria-pressed", "true");
    expect(renderChip({ pressed: false })).toHaveAttribute("aria-pressed", "false");
    expect(renderChip()).not.toHaveAttribute("aria-pressed");
  });

  it("announces the menu it opens, and nothing at all when it opens none", () => {
    // A menu trigger is not a toggle: it says "there is a menu, and it
    // is open", never "on". The two must not be confused, or a screen
    // reader calls an open Add menu a pressed button.
    const open = renderChip({ menuOpen: true });
    expect(open).toHaveAttribute("aria-haspopup", "menu");
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(open).not.toHaveAttribute("aria-pressed");
    const shut = renderChip({ menuOpen: false });
    expect(shut).toHaveAttribute("aria-haspopup", "menu");
    expect(shut).toHaveAttribute("aria-expanded", "false");
    const plain = renderChip();
    expect(plain).not.toHaveAttribute("aria-haspopup");
    expect(plain).not.toHaveAttribute("aria-expanded");
  });

  it("shows a badge the way the status chip does, capped and hidden at zero", () => {
    expect(renderChip({ badge: 3 }).querySelector(".status-chip-badge")).toHaveTextContent("3");
    expect(renderChip({ badge: 412 }).querySelector(".status-chip-badge")).toHaveTextContent(
      "99+",
    );
    expect(renderChip({ badge: 0 }).querySelector(".status-chip-badge")).toBeNull();
    expect(renderChip().querySelector(".status-chip-badge")).toBeNull();
  });

  it("carries a state on the dot, and only when the caller asked for one", () => {
    // A plain command chip has nothing to report, so it grows no dot.
    expect(renderChip().querySelector(".status-chip-dot")).toBeNull();
    expect(renderChip()).not.toHaveAttribute("data-state");
    const reporting = renderChip({ state: "degraded" });
    expect(reporting).toHaveAttribute("data-state", "degraded");
    expect(reporting.querySelector(".status-chip-dot")).not.toBeNull();
    // Idle is a state like any other — the dot is there in every one of
    // them, or the chip would resize as its state settled.
    expect(renderChip({ state: "idle" }).querySelector(".status-chip-dot")).not.toBeNull();
  });

  it("changes nothing about its geometry in any state", () => {
    const baseline = renderChip({ state: "idle", badge: 2 });
    const want = geometryOf(baseline);
    const shape = shapeOf(baseline);
    // Enough of the sheet has to reach the chip for this to mean
    // anything: an empty map would compare equal to an empty map.
    expect(Object.keys(want).length).toBeGreaterThan(4);

    for (const state of STATUS_CHIP_STATES) {
      const chip = renderChip({ state, badge: 2 });
      expect(geometryOf(chip), state).toEqual(want);
      expect(shapeOf(chip), state).toEqual(shape);
    }
  });

  it("changes nothing about its geometry when pressed, busy or disabled", () => {
    const want = geometryOf(renderChip({ state: "idle", badge: 2 }));
    for (const props of [
      { pressed: true },
      { pressed: false },
      { busy: true },
      { disabled: true },
    ]) {
      const chip = renderChip({ state: "idle", badge: 2, ...props });
      expect(geometryOf(chip), JSON.stringify(props)).toEqual(want);
    }
  });

  it("does the same in the icon-only form, which has its own geometry", () => {
    // The square form is a different shape from the labelled one — but
    // it is just as fixed across states.
    const want = geometryOf(renderChip({ label: undefined, title: "Start", state: "idle" }));
    expect(want.width).toBe("22px");
    for (const state of STATUS_CHIP_STATES) {
      const chip = renderChip({ label: undefined, title: "Start", state });
      expect(geometryOf(chip), state).toEqual(want);
    }
    for (const props of [{ pressed: true }, { busy: true }, { disabled: true }]) {
      const chip = renderChip({ label: undefined, title: "Start", state: "idle", ...props });
      expect(geometryOf(chip), JSON.stringify(props)).toEqual(want);
    }
  });

  it("is the density the chrome is drawn at: a 22px chip at the status chip's 12px type", () => {
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
      const open = css.indexOf("{", start);
      return css.slice(open + 1, css.indexOf("}", open));
    };
    expect(rule(".chip-button")).toContain("height: 22px");
    // The type size is not restated here — it is the status chip's,
    // which is the point of extending it.
    expect(rule(".status-chip")).toContain("font-size: 0.75rem");
  });
});
