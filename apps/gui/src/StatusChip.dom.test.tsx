// @vitest-environment jsdom
//
// The shared status chip — the one control that reports a state and
// takes you to where that state is managed. jsdom does no layout, so
// the shape assertions read the declared CSS as text rather than a
// rendered box, the established idiom in this repo (see
// `ColorChip.dom.test.tsx`).

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import css from "./index.css?raw";
import { STATUS_CHIP_STATES, StatusChip } from "./StatusChip";

afterEach(cleanup);

/// The declarations of the first top-level rule for `selector`.
function declarations(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("StatusChip", () => {
  it("carries its state on the element, for every state in the vocabulary", () => {
    for (const state of STATUS_CHIP_STATES) {
      cleanup();
      render(<StatusChip state={state} label="Connected" onPress={() => {}} />);
      expect(screen.getByRole("button")).toHaveAttribute("data-state", state);
    }
  });

  it("defaults to the idle state when none is given", () => {
    render(<StatusChip label="System messages" onPress={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("data-state", "idle");
  });

  it("shows a count and a badge, and hides an absent or zero badge", () => {
    render(<StatusChip label="Connected" count="4 / 5" badge={3} onPress={() => {}} />);
    expect(screen.getByText("4 / 5")).toBeInTheDocument();
    expect(screen.getByText("3")).toHaveClass("status-chip-badge");
    cleanup();
    render(<StatusChip label="Signal mapping" badge={0} onPress={() => {}} />);
    expect(document.querySelector(".status-chip-badge")).toBeNull();
  });

  it("caps a badge at 99+ the way the launcher badges already do", () => {
    render(<StatusChip label="System messages" badge={412} onPress={() => {}} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });

  it("presses through to the handler, and cannot be pressed when disabled", () => {
    const onPress = vi.fn();
    render(<StatusChip label="RBS mapping" onPress={onPress} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onPress).toHaveBeenCalledTimes(1);
    cleanup();
    render(<StatusChip label="RBS mapping" onPress={onPress} disabled />);
    const chip = screen.getByRole("button");
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("takes the shared colour chip's shape — 2px radius over a --border-wash hairline", () => {
    const decls = declarations(".status-chip");
    expect(decls).toContain("border-radius: 2px");
    expect(decls).toContain("border: 1px solid var(--border-wash)");
    // The indicator is a rounded square, not a circle: same family as
    // the colour chip's swatch.
    expect(declarations(".status-chip-dot")).toContain("border-radius: 2px");
  });

  it("carries every non-idle state on the outline alone — no weight change, no movement", () => {
    for (const state of STATUS_CHIP_STATES.filter((s) => s !== "idle")) {
      const decls = declarations(`.status-chip[data-state="${state}"]`);
      expect(decls, state).toMatch(/border-color:/);
      // A width or padding change here would move the bar as a
      // connection progresses, which is the thing uniform width exists
      // to stop.
      expect(decls, state).not.toMatch(/border-width|padding|width/);
    }
  });

  it("gives the connection chip one width across every state", () => {
    // Uniform width is within one chip's state set, sized to its
    // longest state rather than padded out. The longest is "Not
    // connected" beside a "0 / 3" count — 8.75rem fit only
    // "Connecting…" and ellipsised it to "Not connec…".
    expect(declarations(".status-chip--connection")).toContain("width: 10rem");
  });
});
