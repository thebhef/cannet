// @vitest-environment jsdom
//
// The one colour-picking / colour-identity control the app renders
// everywhere it renders one (`ColorChip.tsx`). jsdom does no layout, so
// the shape assertions read the declared CSS as text rather than a
// rendered box — the established idiom in this repo (see
// `DisclosureToggle.dom.test.tsx`).

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import css from "./index.css?raw";
import { ColorChip } from "./ColorChip";

afterEach(cleanup);

/// The declarations of the first top-level rule for `selector`.
function declarations(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("ColorChip", () => {
  it("renders a plain, non-interactive swatch when onChange is omitted", () => {
    render(<ColorChip color="#ff0000" swatchAriaLabel="derived marker" />);
    const swatch = screen.getByLabelText("derived marker");
    expect(swatch.tagName).toBe("SPAN");
    expect(swatch).toHaveStyle({ background: "rgb(255, 0, 0)" });
    expect(document.querySelector('input[type="color"]')).toBeNull();
  });

  it("a display-only swatch with no label is hidden from the accessibility tree", () => {
    render(<ColorChip color="#00ff00" />);
    const swatch = document.querySelector(".color-chip") as HTMLElement;
    expect(swatch).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a button + hidden native picker when onChange is given", () => {
    render(<ColorChip color="#123456" onChange={() => {}} swatchAriaLabel="pick a colour" />);
    const swatch = screen.getByRole("button", { name: "pick a colour" });
    expect(swatch).toHaveStyle({ background: "rgb(18, 52, 86)" });
    const picker = document.querySelector('input[type="color"]') as HTMLInputElement;
    expect(picker).not.toBeNull();
    expect(picker.value).toBe("#123456");
  });

  it("clicking the swatch opens the picker by default", () => {
    render(<ColorChip color="#123456" onChange={() => {}} swatchAriaLabel="pick a colour" />);
    const picker = document.querySelector('input[type="color"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(picker, "click");
    fireEvent.click(screen.getByRole("button", { name: "pick a colour" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("an onSwatchClick override replaces the default open-picker click — the plot series' toggle-hidden behaviour", () => {
    const onSwatchClick = vi.fn();
    render(
      <ColorChip
        color="#123456"
        onChange={() => {}}
        swatchAriaLabel="pick a colour"
        onSwatchClick={onSwatchClick}
      />,
    );
    const picker = document.querySelector('input[type="color"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(picker, "click");
    fireEvent.click(screen.getByRole("button", { name: "pick a colour" }));
    expect(onSwatchClick).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("onChange fires with the new hex value from the native input", () => {
    const onChange = vi.fn();
    render(<ColorChip color="#123456" onChange={onChange} swatchAriaLabel="pick a colour" />);
    fireEvent.change(document.querySelector('input[type="color"]')!, {
      target: { value: "#abcdef" },
    });
    expect(onChange).toHaveBeenCalledWith("#abcdef");
  });

  it("the hidden modifier dims the chip", () => {
    render(<ColorChip color="#123456" hidden swatchAriaLabel="pick a colour" />);
    expect(screen.getByLabelText("pick a colour")).toHaveClass("color-chip-hidden");
  });

  it("hideBox renders only the invisible input, and a forwarded ref reaches it directly", () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(
      <span data-testid="host">
        <ColorChip ref={ref} color="#123456" onChange={onChange} hideBox pickerAriaLabel="named signal" />
      </span>,
    );
    // No visible box — the swatch button never renders.
    expect(screen.queryByRole("button")).toBeNull();
    expect(ref.current).not.toBeNull();
    expect(ref.current?.tagName).toBe("INPUT");
    expect(ref.current).toBe(screen.getByLabelText("named signal"));
    // The caller's own trigger opens it externally, not via a swatch click.
    const clickSpy = vi.spyOn(ref.current as HTMLInputElement, "click");
    ref.current?.click();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("swatchClassName and inputClassName pass through as identity hooks, carrying no styling of their own", () => {
    render(
      <ColorChip
        color="#123456"
        onChange={() => {}}
        swatchAriaLabel="pick a colour"
        swatchClassName="my-site-swatch"
        inputClassName="my-site-input"
      />,
    );
    expect(screen.getByRole("button", { name: "pick a colour" })).toHaveClass("my-site-swatch");
    expect(document.querySelector('input[type="color"]')).toHaveClass("my-site-input");
  });

  describe("shape", () => {
    it("the bar variant is the events panel's shape: 1.5rem wide, stretched, 2px radius, a border-wash hairline", () => {
      const bar = declarations(".color-chip-bar");
      expect(bar).toMatch(/\bwidth:\s*1\.5rem\b/);
      expect(bar).toMatch(/\balign-self:\s*stretch\b/);
      const base = declarations(".color-chip");
      expect(base).toMatch(/\bborder-radius:\s*2px\b/);
      expect(base).toMatch(/\bborder:\s*1px solid var\(--border-wash\)/);
    });

    it("the dot variant is a small inline identity marker, not a picker shape", () => {
      const dot = declarations(".color-chip-dot");
      expect(dot).toMatch(/\bdisplay:\s*inline-block\b/);
      expect(dot).not.toMatch(/\balign-self:\s*stretch\b/);
    });

    it("carries the macOS anchor fix to every editable site: the picker input covers the swatch's own footprint rather than collapsing to a point", () => {
      const input = declarations(".color-chip-input");
      expect(input).toMatch(/\binset:\s*0\b/);
      expect(input).not.toMatch(/\bwidth:\s*0\b/);
      expect(input).not.toMatch(/\bheight:\s*0\b/);
    });
  });
});
