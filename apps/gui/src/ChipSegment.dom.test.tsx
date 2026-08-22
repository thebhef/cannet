// @vitest-environment jsdom
//
// The segmented chip group: several chips, one hairline. What it must
// not be is a second chip — the whole point of the group is that the
// things inside it are ordinary `ChipButton`s that happen to share an
// outline, so a test that only checked "the group renders" would pass
// over a fork.
//
// Geometry is read from the stylesheet the way `ChipButton`'s own test
// reads it (see `chipCssTestKit.ts`): jsdom does no layout, so the
// question "does pressing a segment move anything" is answered by the
// rules the element matches, not by a rendered box.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import css from "./index.css?raw";
import { ChipButton } from "./ChipButton";
import { ChipSegment } from "./ChipSegment";
import { geometryOf, installStylesheet } from "./chipCssTestKit";

afterEach(cleanup);

beforeAll(() => installStylesheet(css));

/// A three-position segment, the shape the plot toolbar's cursor modes
/// take.
function renderSegment(pressed: "x" | "y" | null = null) {
  cleanup();
  render(
    <ChipSegment label="Cursor Mode" title="cursor placement mode — press again for off">
      <ChipButton
        icon="cursor-x"
        title="x cursors"
        ariaLabel="X Cursors"
        pressed={pressed === "x"}
        onPress={() => {}}
      />
      <ChipButton
        icon="cursor-y"
        title="y cursors"
        ariaLabel="Y Cursors"
        pressed={pressed === "y"}
        onPress={() => {}}
      />
    </ChipSegment>,
  );
  return screen.getByRole("group", { name: "Cursor Mode" });
}

describe("ChipSegment", () => {
  it("is a named group of ordinary command chips, not a chip of its own", () => {
    const seg = renderSegment();
    expect(seg).toHaveClass("chip-seg");
    // Nothing inside is a fork: every child is the shipped chip,
    // carrying both of its classes.
    const chips = Array.from(seg.querySelectorAll("button"));
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip).toHaveClass("status-chip");
      expect(chip).toHaveClass("chip-button");
    }
    // Announced as one thing, so a reader says "Cursor mode" before the
    // three icons rather than listing three unrelated buttons.
    expect(seg).toHaveAccessibleName("Cursor Mode");
  });

  it("draws the outline once — the group has the hairline, the chips inside have none", () => {
    const seg = renderSegment();
    const group = geometryOf(seg);
    expect(group.border).toBe("1px solid var(--border-wash)");
    expect(group.height).toBe("22px");

    const [first, second] = Array.from(seg.querySelectorAll("button"));
    expect(geometryOf(first)["border-style"]).toBe("none");
    // …except for the divider between them, which is the only edge a
    // segment draws inside itself.
    expect(geometryOf(second)["border-left"]).toBe("1px solid var(--border-wash)");
  });

  it("is the same 22px tall as a chip standing alone, so a mixed bar keeps one baseline", () => {
    const seg = renderSegment();
    // The group's own 1px edges plus the 20px chips inside come to the
    // 22px a lone chip is. Getting this wrong is what makes a toolbar
    // of mixed chips and segments look ragged.
    expect(geometryOf(seg).height).toBe("22px");
    expect(geometryOf(seg.querySelector("button")!).height).toBe("20px");
  });

  it("moves nothing when a segment is pressed", () => {
    const off = geometryOf(renderSegment().querySelectorAll("button")[0]);
    expect(Object.keys(off).length).toBeGreaterThan(4);
    const on = geometryOf(renderSegment("x").querySelectorAll("button")[0]);
    expect(on).toEqual(off);
  });

  it("passes a press through to the chip that was pressed", () => {
    const onX = vi.fn();
    render(
      <ChipSegment label="Cursor Mode">
        <ChipButton icon="cursor-x" ariaLabel="X Cursors" pressed={false} onPress={onX} />
      </ChipSegment>,
    );
    fireEvent.click(screen.getByRole("button", { name: "X Cursors" }));
    expect(onX).toHaveBeenCalledTimes(1);
  });
});
