// @vitest-environment jsdom
//
// Canonical coverage for the shared dismiss-on-outside-click +
// Escape hook (task 0030 item #18): a mousedown outside the menu's
// own root, or an Escape keypress, closes it; a mousedown inside
// (e.g. a checkbox) does not. Each call site's own DOM test still
// covers its integration; this is the hook's contract.

import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { useDismissableMenu } from "./useDismissableMenu";

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useDismissableMenu<HTMLDivElement>(open, onClose);
  return (
    <div>
      <div data-testid="outside">outside</div>
      {open && (
        <div ref={ref} data-testid="menu">
          <button type="button">inside</button>
        </div>
      )}
    </div>
  );
}

afterEach(() => cleanup());

describe("useDismissableMenu", () => {
  it("closes on a mousedown outside the menu", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness open onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a mousedown inside the menu", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness open onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("menu").querySelector("button")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a non-Escape key", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does nothing while closed", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Harness open={false} onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("outside"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted while open", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness open onClose={onClose} />);
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
