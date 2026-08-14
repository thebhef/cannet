// @vitest-environment jsdom
//
// The one disclosure-toggle implementation every collapsible section,
// row, and menu trigger in the GUI shares — owns hit area, ink,
// rotation, and `aria-expanded`. jsdom does no layout, so the
// hit-area assertion reads the declared CSS as text rather than a
// rendered box (the established idiom in this repo — see
// `dockPanelScrolling.test.ts`), and the "click in the padding toggles"
// case is a DOM-structure assertion (the outer 24x24 element is the
// button itself, not a smaller glyph span with its own handler) rather
// than a real geometric hit test, which jsdom cannot perform either.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import css from "./index.css?raw";
import { DisclosureToggle } from "./DisclosureToggle";

afterEach(cleanup);

/// The declarations of the first top-level rule for `selector`.
function declarations(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no \`${selector}\` rule in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("DisclosureToggle", () => {
  it("is a real <button>, not a decorative glyph span", () => {
    render(<DisclosureToggle expanded={false} onToggle={() => {}} ariaLabel="toggle it" />);
    const toggle = screen.getByRole("button", { name: "toggle it" });
    expect(toggle.tagName).toBe("BUTTON");
  });

  it("the default hit area meets the WCAG 2.5.8 24x24 CSS px floor, with the ink sized to fill it", () => {
    const box = declarations(".disclosure-toggle");
    expect(box).toMatch(/\bmin-width:\s*24px\b/);
    expect(box).toMatch(/\bmin-height:\s*24px\b/);
    const ink = declarations(".disclosure-toggle-glyph");
    // One shared size for every site (owner ruling, 2026-08-14): the
    // glyph fills the box rather than sitting small inside it. 1.1rem
    // (17.6px at the default root size) reaches close to the 24px
    // floor while still clearing the smallest compact row height
    // (`dbcPanelViewport.ts`'s 20px `ROW_HEIGHT`) without clipping.
    expect(ink).toMatch(/\bfont-size:\s*1\.1rem\b/);
  });

  it("the compact variant still reaches the 24px floor in width — only height gives it up, to the row it sits in", () => {
    const compact = declarations(".disclosure-toggle-compact");
    expect(compact).not.toMatch(/\bmin-height:\s*24px\b/);
    // Inherits `.disclosure-toggle`'s min-width: 24px unchanged.
    expect(declarations(".disclosure-toggle")).toMatch(/\bmin-width:\s*24px\b/);
  });

  it("clicking anywhere on the control — not just the glyph — toggles it", () => {
    const onToggle = vi.fn();
    render(<DisclosureToggle expanded={false} onToggle={onToggle} ariaLabel="toggle it" />);
    // The button *is* the hit area (padding included); there is no
    // smaller inner element with its own separate click handler.
    const toggle = screen.getByRole("button", { name: "toggle it" });
    const glyph = toggle.querySelector(".disclosure-toggle-glyph");
    expect(glyph).not.toBeNull();
    expect(glyph?.parentElement).toBe(toggle);
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("activates on Enter and on Space when focused", () => {
    const onToggle = vi.fn();
    render(<DisclosureToggle expanded={false} onToggle={onToggle} ariaLabel="toggle it" />);
    const toggle = screen.getByRole("button", { name: "toggle it" });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(toggle, { key: " " });
    expect(onToggle).toHaveBeenCalledTimes(2);
    // Only Enter/Space — an arbitrary key is not the toggle's to take.
    fireEvent.keyDown(toggle, { key: "a" });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("tracks aria-expanded from the `expanded` prop, both ways", () => {
    const { rerender } = render(<DisclosureToggle expanded={false} onToggle={() => {}} ariaLabel="x" />);
    expect(screen.getByRole("button", { name: "x" })).toHaveAttribute("aria-expanded", "false");
    rerender(<DisclosureToggle expanded={true} onToggle={() => {}} ariaLabel="x" />);
    expect(screen.getByRole("button", { name: "x" })).toHaveAttribute("aria-expanded", "true");
  });

  it("swaps the glyph with the expanded state, hidden from the accessible name", () => {
    const { rerender } = render(<DisclosureToggle expanded={false} onToggle={() => {}} ariaLabel="x" />);
    let toggle = screen.getByRole("button", { name: "x" });
    expect(toggle.querySelector(".disclosure-toggle-glyph")).toHaveTextContent("▸");
    expect(toggle.querySelector(".disclosure-toggle-glyph")).toHaveAttribute("aria-hidden", "true");
    rerender(<DisclosureToggle expanded={true} onToggle={() => {}} ariaLabel="x" />);
    toggle = screen.getByRole("button", { name: "x" });
    expect(toggle.querySelector(".disclosure-toggle-glyph")).toHaveTextContent("▾");
  });

  it("takes its accessible name from children when no ariaLabel is given — the whole-header pattern", () => {
    render(
      <DisclosureToggle expanded={false} onToggle={() => {}}>
        Elements
      </DisclosureToggle>,
    );
    expect(screen.getByRole("button", { name: "Elements" })).toBeInTheDocument();
  });

  it("stays out of the tab order when a caller sets tabIndex -1, for a row that is itself the tab stop (ADR 0044)", () => {
    render(<DisclosureToggle expanded={false} onToggle={() => {}} ariaLabel="x" tabIndex={-1} />);
    expect(screen.getByRole("button", { name: "x" })).toHaveAttribute("tabindex", "-1");
  });

  it("does not toggle, and does not activate on the keyboard, while disabled", () => {
    const onToggle = vi.fn();
    render(<DisclosureToggle expanded={false} onToggle={onToggle} ariaLabel="x" disabled />);
    const toggle = screen.getByRole("button", { name: "x" });
    expect(toggle).toBeDisabled();
    fireEvent.keyDown(toggle, { key: "Enter" });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("lets a nested toggle stop the event reaching an ancestor's own click handler", () => {
    const onAncestorClick = vi.fn();
    const onToggle = vi.fn((e: React.SyntheticEvent) => e.stopPropagation());
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onAncestorClick}>
        <DisclosureToggle expanded={false} onToggle={onToggle} ariaLabel="x" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "x" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onAncestorClick).not.toHaveBeenCalled();
  });
});
